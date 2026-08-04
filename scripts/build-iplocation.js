#!/usr/bin/env node

'use strict';

// Builds iplocation.bin.gz - the IP -> (organisation, country, region) table
// FluxOS uses to compute placement fault domains. The wire format is format 2,
// specified in fluxModels workstreams/placement-and-election/
// GEO_TABLE_BASELINE_FORMAT.md; this script and the FluxOS reader implement
// exactly that.
//
// Two sources, each authoritative for what it knows:
//   1. The five RIRs' delegated-extended files: allocation boundaries and the
//      registry-scoped organisation id. An allocation is the block rung of the
//      fault-domain ladder, so these boundaries are the artifact's structure.
//   2. DB-IP City Lite: country and region per address range, the region name
//      resolved to ISO 3166-2 through data/region-map.json. Country and region
//      come from here alone - measured against the fleet's self-reports it is
//      right where the registries' holder country is not. That same map is
//      carried in the artifact's header, so a node can resolve a region an app
//      names the way ip-api does back to the code the rows use.
//
// data/iplocation-overrides.json then corrects the blocks where neither source
// is right and the fleet says so; see scripts/overrides.js.
//
// The build then validates the result against the live fleet's self-reported
// geolocation and writes a report. Only the fleet fetches need the network;
// `--offline` builds from the cached files alone.
//
// db-ip.com IP to City Lite database, CC BY 4.0 (https://db-ip.com).
//
// Usage:
//   node scripts/build-iplocation.js [--out iplocation.bin.gz]
//     [--cache-dir .cache] [--offline] [--report data/iplocation-build-report.json]

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const { CONTINENTS } = require('./continents');
const overrides = require('./overrides');
const sources = require('./sources');

const ROOT = path.join(__dirname, '..');

const RIRS = [
  { registry: 'ripencc', url: 'https://ftp.ripe.net/pub/stats/ripencc/delegated-ripencc-extended-latest' },
  { registry: 'arin', url: 'https://ftp.arin.net/pub/stats/arin/delegated-arin-extended-latest' },
  { registry: 'apnic', url: 'https://ftp.apnic.net/stats/apnic/delegated-apnic-extended-latest' },
  { registry: 'lacnic', url: 'https://ftp.lacnic.net/pub/stats/lacnic/delegated-lacnic-extended-latest' },
  { registry: 'afrinic', url: 'https://ftp.afrinic.net/pub/stats/afrinic/delegated-afrinic-extended-latest' },
];

const NODELIST_URL = 'https://api.runonflux.io/daemon/viewdeterministiczelnodelist';
const STATS_URL = 'https://stats.runonflux.io/fluxinfo?projection=geolocation,ip';

const MAX_IPV4 = 4294967295;

// The country agreement the DB-IP layer measured against the fleet's self-reports
// when this pipeline was adopted. A build materially below it is a regression in
// the input, not a new normal.
const EXPECTED_COUNTRY_AGREEMENT = 98.5;

// How many disputed blocks the report names. The list is what an overrides entry
// is written from, and a month's worth of real disputes is a couple of dozen.
const MAX_DISAGREEMENT_BLOCKS = 30;

// ip-api still speaks Norway's pre-2020 county codes, while the artifact speaks
// current ISO 3166-2: Norway restored Østfold, Akershus and Buskerud in 2024 with
// new codes, and ISO never brought the old ones back. A node self-reporting the
// retired code is naming the same county the table names with the current one, so
// on the fleet side of the join a retired report counts as agreement with its
// successor. This is never applied to the artifact - the table carries current ISO
// alone.
const SELF_REPORT_REGION_ALIASES = {
  'NO-01': 'NO-31', // Østfold
  'NO-02': 'NO-32', // Akershus
  'NO-06': 'NO-33', // Buskerud
};

// ---------------------------------------------------------------------------
// small utilities

function parseArgs(argv) {
  const args = {
    out: path.join(ROOT, 'iplocation.bin.gz'),
    cacheDir: path.join(ROOT, '.cache'),
    regionMap: path.join(ROOT, 'data', 'region-map.json'),
    overrides: path.join(ROOT, 'data', 'iplocation-overrides.json'),
    report: path.join(ROOT, 'data', 'iplocation-build-report.json'),
    offline: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--out') { args.out = argv[i += 1]; } else if (flag === '--cache-dir') { args.cacheDir = argv[i += 1]; } else if (flag === '--region-map') { args.regionMap = argv[i += 1]; } else if (flag === '--overrides') { args.overrides = argv[i += 1]; } else if (flag === '--report') { args.report = argv[i += 1]; } else if (flag === '--offline') { args.offline = true; } else { throw new Error(`Unknown argument ${flag}`); }
  }
  return args;
}

// Interval columns held as parallel typed arrays: the geo layer alone is a couple
// of million rows, and an object per row costs two orders of magnitude more
// memory than the interval it describes.
function createColumns(capacity, fields) {
  const columns = { length: 0, capacity };
  columns.start = new Uint32Array(capacity);
  columns.end = new Uint32Array(capacity);
  for (const field of fields) columns[field] = new Int32Array(capacity);
  columns.fields = fields;
  return columns;
}

function growColumns(columns) {
  const capacity = columns.capacity * 2;
  const copy = (array, Type) => { const next = new Type(capacity); next.set(array); return next; };
  columns.start = copy(columns.start, Uint32Array);
  columns.end = copy(columns.end, Uint32Array);
  for (const field of columns.fields) columns[field] = copy(columns[field], Int32Array);
  columns.capacity = capacity;
}

function appendRow(columns, start, end, values) {
  if (columns.length === columns.capacity) growColumns(columns);
  const i = columns.length;
  columns.start[i] = start;
  columns.end[i] = end;
  for (let f = 0; f < columns.fields.length; f += 1) columns[columns.fields[f]][i] = values[f];
  columns.length = i + 1;
}

// Index of the row covering value, or -1. Rows are sorted and non-overlapping.
function findRow(columns, value) {
  let lo = 0;
  let hi = columns.length - 1;
  let hit = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (columns.start[mid] <= value) { hit = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return hit !== -1 && columns.end[hit] >= value ? hit : -1;
}

function interner() {
  const index = new Map();
  const values = [];
  return {
    values,
    of(value) {
      if (value === null || value === undefined) return -1;
      const existing = index.get(value);
      if (existing !== undefined) return existing;
      index.set(value, values.length);
      values.push(value);
      return values.length - 1;
    },
  };
}

// ---------------------------------------------------------------------------
// organisation layer: the RIRs' delegated-extended files

function parseDelegated(registry, text, serials, report) {
  const ranges = [];
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const fields = line.split('|');
    if (/^\d/.test(fields[0])) { // version header, e.g. "2|ripencc|serial|..." or "2.3|arin|..."
      serials[registry] = fields[2] ?? null;
      continue;
    }
    if (fields[1] === '*' || fields.length < 7) continue; // summary lines
    const [, cc, type, start, value, , status] = fields;
    if (status !== 'allocated' && status !== 'assigned') continue;
    if (type !== 'ipv4') continue; // no Flux node holds a v6 address; a v6 lookup falls back strict
    const org = fields.length >= 8 && fields[7] ? `${registry}:${fields[7]}` : null;
    const startInt = sources.ipv4ToInt(start);
    const count = Number(value);
    if (startInt === null || !Number.isInteger(count) || count <= 0 || startInt + count - 1 > MAX_IPV4) {
      report.malformedRows.push(`${registry}: ${line.slice(0, 120)}`);
      continue;
    }
    ranges.push({
      start: startInt, end: startInt + count - 1, cc: /^[A-Z]{2}$/.test(cc) && cc !== 'ZZ' ? cc : null, org,
    });
  }
  return ranges;
}

// Sort and resolve overlaps, most-specific range wins: a range fully contained
// in another splits the container around it; a partial overlap truncates the
// later range. Cross-registry overlap is rare (transferred legacy space) but
// must produce a deterministic, non-overlapping result.
function normaliseRanges(ranges, report) {
  ranges.sort((a, b) => (a.start - b.start) || (b.end - a.end));
  const out = [];
  for (const range of ranges) {
    let current = range;
    while (out.length) {
      const prev = out[out.length - 1];
      if (current.start > prev.end) break;
      report.overlaps.push(`[${prev.start}-${prev.end}] vs [${current.start}-${current.end}]`);
      if (current.end <= prev.end) {
        // contained: more specific wins; split the container around it
        out.pop();
        if (prev.start < current.start) out.push({ ...prev, end: current.start - 1 });
        out.push(current);
        current = prev.end > current.end ? { ...prev, start: current.end + 1 } : null;
        break;
      }
      // partial overlap: truncate the later range
      current = { ...current, start: prev.end + 1 };
      break;
    }
    if (current) out.push(current);
    // re-sort tail if the split appended out of order
    for (let i = out.length - 1; i > 0 && out[i].start < out[i - 1].start; i -= 1) {
      const tmp = out[i]; out[i] = out[i - 1]; out[i - 1] = tmp;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// geo layer: DB-IP City Lite at region granularity

// The database is city-granular; the artifact is region-granular. Adjacent rows
// sharing a (country, region) collapse into one as they stream past, which is
// what takes ~3.7M database rows down to the artifact's scale. A name with no
// entry in the region map contributes no region, so its addresses answer at
// country granularity - the conservative direction for placement.
async function buildGeoLayer(file, regionMap, report) {
  const geo = createColumns(1 << 21, ['cc', 'region']);
  const countries = interner();
  const regions = interner();
  const unmappedNames = new Set();
  let unmappedRows = 0;
  let gaps = 0;

  const stats = await sources.streamDbipRows(file, (start, end, cc, name) => {
    let region = null;
    if (cc && name) {
      region = regionMap[`${cc}|${name}`] ?? null;
      if (region === null) { unmappedNames.add(`${cc}|${name}`); unmappedRows += 1; }
    }
    const ccIndex = countries.of(cc);
    const regionIndex = regions.of(region);
    const last = geo.length - 1;
    if (last >= 0 && geo.end[last] + 1 === start && geo.cc[last] === ccIndex && geo.region[last] === regionIndex) {
      geo.end[last] = end;
      return;
    }
    if (last >= 0 && geo.end[last] + 1 !== start) gaps += 1;
    appendRow(geo, start, end, [ccIndex, regionIndex]);
  });

  report.dbip = {
    databaseRows: stats.rows,
    malformedRows: stats.malformed,
    unsortedRows: stats.unsorted,
    geoRows: geo.length,
    coverageGaps: gaps,
    countries: countries.values.length,
    regions: regions.values.length,
    rowsWithoutRegion: unmappedRows,
    namesWithoutRegion: unmappedNames.size,
  };
  return { geo, countries: countries.values, regions: regions.values };
}

// ---------------------------------------------------------------------------
// merge

// Organisation identity ships as a 12-hex-char token (48 bits of the sha256 of
// the registry-scoped id). Nothing reads the id's content - the token only has
// to be distinct per organisation. 48 bits across ~110k orgs gives ~1e-5 odds
// of any collision, and a collision merely merges two orgs into one domain.
const orgTokens = new Map();

function orgToken(org) {
  let token = orgTokens.get(org);
  if (token === undefined) {
    token = crypto.createHash('sha256').update(org).digest('hex').slice(0, 12);
    orgTokens.set(org, token);
  }
  return token;
}

// Sweeps the organisation layer against the geo layer and emits a row wherever
// either has something to say. Country and region come from the geo layer, the
// registries' holder country standing in only where DB-IP has no country at all.
// Adjacent rows agreeing on all three fields collapse: with the same
// organisation, country and region there is no boundary between them that
// placement can see. Both-null organisations collapse too - every allocated or
// assigned delegated row carries an organisation id, so a null one means no
// allocation covers the address and there is no block identity to preserve.
function merge(orgRanges, geoLayer, report) {
  const { geo } = geoLayer;
  const rows = createColumns(1 << 21, ['org', 'cc', 'region']);
  const orgs = interner();
  const countries = interner();
  const regions = interner();

  let oi = 0;
  let gi = 0;
  let cursor = 0;
  let collapsed = 0;
  while (cursor <= MAX_IPV4) {
    while (oi < orgRanges.length && orgRanges[oi].end < cursor) oi += 1;
    while (gi < geo.length && geo.end[gi] < cursor) gi += 1;
    const org = oi < orgRanges.length && orgRanges[oi].start <= cursor ? orgRanges[oi] : null;
    const g = gi < geo.length && geo.start[gi] <= cursor ? gi : -1;

    let end = MAX_IPV4;
    if (org) end = Math.min(end, org.end);
    else if (oi < orgRanges.length) end = Math.min(end, orgRanges[oi].start - 1);
    if (g !== -1) end = Math.min(end, geo.end[g]);
    else if (gi < geo.length) end = Math.min(end, geo.start[gi] - 1);

    const geoCc = g !== -1 && geo.cc[g] !== -1 ? geoLayer.countries[geo.cc[g]] : null;
    const cc = geoCc ?? (org ? org.cc : null);
    const region = g !== -1 && geo.region[g] !== -1 ? geoLayer.regions[geo.region[g]] : null;

    if (org || cc) {
      const orgIndex = orgs.of(org ? orgToken(org.org) : null);
      const ccIndex = countries.of(cc);
      const regionIndex = regions.of(region);
      const last = rows.length - 1;
      if (last >= 0 && rows.end[last] + 1 === cursor
        && rows.org[last] === orgIndex && rows.cc[last] === ccIndex && rows.region[last] === regionIndex) {
        rows.end[last] = end;
        collapsed += 1;
      } else {
        appendRow(rows, cursor, end, [orgIndex, ccIndex, regionIndex]);
      }
    }
    cursor = end + 1;
  }

  report.collapsedRows = collapsed;
  return {
    rows, orgs: orgs.values, countries: countries.values, regions: regions.values,
  };
}

// ---------------------------------------------------------------------------
// overrides: the corrections in data/iplocation-overrides.json

// Rebuilds the table with the ledger applied. The entries are few and the table
// is two million rows, so one sweep is cheaper than any indexed edit: every row
// an override covers is split at the override's boundaries, the covered segment
// takes the override's country and region, and rows that come out identical
// collapse exactly as merge() collapses them. Organisation is never overridden -
// the allocation boundary is the registries' fact, and it is the vendor's
// attribution that is in dispute, not theirs.
//
// A range no row covers changes nothing: the table has no row there to carry the
// correction, and an override that invents one would be asserting coverage the
// sources do not have. It is reported as a no-op, which is also what a typo'd
// range looks like.
function applyOverrides(table, entries, report) {
  report.overrides = {
    entries: [], applied: 0, retirable: 0,
  };
  if (!entries.length) return table;

  const { rows } = table;
  const countries = interner();
  const regions = interner();
  for (const value of table.countries) countries.of(value);
  for (const value of table.regions) regions.of(value);

  const stats = entries.map(() => ({ rowsTouched: 0, noop: true }));
  const next = createColumns(rows.length + entries.length * 2, ['org', 'cc', 'region']);
  const push = (start, end, org, cc, region) => {
    const last = next.length - 1;
    if (last >= 0 && next.end[last] + 1 === start
      && next.org[last] === org && next.cc[last] === cc && next.region[last] === region) {
      next.end[last] = end;
      return;
    }
    appendRow(next, start, end, [org, cc, region]);
  };

  let ei = 0;
  for (let i = 0; i < rows.length; i += 1) {
    while (ei < entries.length && entries[ei].end < rows.start[i]) ei += 1;
    let cursor = rows.start[i];
    let e = ei;
    while (cursor <= rows.end[i]) {
      while (e < entries.length && entries[e].end < cursor) e += 1;
      const entry = e < entries.length && entries[e].start <= cursor ? entries[e] : null;
      let end = rows.end[i];
      if (entry) end = Math.min(end, entry.end);
      else if (e < entries.length) end = Math.min(end, entries[e].start - 1);

      if (!entry) {
        push(cursor, end, rows.org[i], rows.cc[i], rows.region[i]);
      } else {
        const rowCc = rows.cc[i] === -1 ? null : table.countries[rows.cc[i]];
        const rowRegion = rows.region[i] === -1 ? null : table.regions[rows.region[i]];
        const cc = entry.country ?? rowCc;
        // A country correction that states no region says the vendor put the block
        // in the wrong country, which makes whatever region it assigned there
        // meaningless - so the covered rows lose it.
        const { region } = entry;
        if (region !== null && !region.startsWith(`${cc}-`)) {
          throw new Error(`override ${entry.range}: region ${region} is not in country ${cc ?? 'none'}, which is what the table says at ${sources.intToIpv4(cursor)} — give the entry an explicit country or narrow its range`);
        }
        stats[e].rowsTouched += 1;
        if (cc !== rowCc || region !== rowRegion) stats[e].noop = false;
        push(cursor, end, rows.org[i], countries.of(cc), regions.of(region));
      }
      cursor = end + 1;
    }
  }

  report.overrides = {
    entries: entries.map((entry, i) => ({
      range: entry.range,
      country: entry.country,
      region: entry.region,
      added: entry.added,
      rowsTouched: stats[i].rowsTouched,
      noop: stats[i].noop,
    })),
    applied: stats.filter((stat) => !stat.noop).length,
    retirable: stats.filter((stat) => stat.noop).length,
  };
  return {
    rows: next, orgs: table.orgs, countries: countries.values, regions: regions.values,
  };
}

// ---------------------------------------------------------------------------
// validation join against the live fleet

async function validate(table, report) {
  const nodeList = (await sources.fetchJson(NODELIST_URL)).data ?? [];
  const stats = (await sources.fetchJson(STATS_URL)).data ?? [];
  const selfGeo = new Map();
  for (const entry of stats) {
    const ip = (entry.ip ?? '').split(':')[0];
    if (ip && entry.geolocation?.countryCode) selfGeo.set(ip, entry.geolocation);
  }

  const ips = new Set();
  for (const node of nodeList) {
    const ip = (node.ip ?? '').split(':')[0];
    if (ip) ips.add(ip);
  }

  let agree = 0;
  let regionAgree = 0;
  let regionTableNull = 0;
  const disagreements = new Map();
  const regionDisagreements = new Map();
  const continentMismatches = new Map();

  // The pair tables say what is disputed; these say where. A disagreement is
  // almost never one node - it is every node inside one allocation contradicting
  // the vendor's attribution of that allocation, and the block is the unit an
  // overrides entry corrects. Keyed by table row and reported value, so one entry
  // per (block, claim).
  const countryBlocks = new Map();
  const regionBlocks = new Map();
  const bumpBlock = (blocks, row, tableValue, fleetValue) => {
    const key = `${row}|${fleetValue}`;
    const existing = blocks.get(key);
    if (existing) { existing.nodes += 1; return; }
    blocks.set(key, {
      row, table: tableValue, fleet: fleetValue, nodes: 1,
    });
  };

  for (const ip of ips) {
    const value = sources.ipv4ToInt(ip);
    const geo = selfGeo.get(ip);
    if (value === null || !geo) continue;
    const row = findRow(table.rows, value);
    if (row === -1 || table.rows.cc[row] === -1) continue;
    const cc = table.countries[table.rows.cc[row]];
    if (cc === geo.countryCode) {
      agree += 1;
      const expected = CONTINENTS[cc];
      if (geo.continentCode && expected && geo.continentCode !== expected) {
        const key = `${cc}: table ${expected} vs ip-api ${geo.continentCode}`;
        continentMismatches.set(key, (continentMismatches.get(key) ?? 0) + 1);
      }
    } else {
      const key = `${cc}->${geo.countryCode}`;
      disagreements.set(key, (disagreements.get(key) ?? 0) + 1);
      bumpBlock(countryBlocks, row, cc, geo.countryCode);
    }
    if (geo.region) {
      const reported = `${geo.countryCode}-${geo.region}`;
      const expected = SELF_REPORT_REGION_ALIASES[reported] ?? reported;
      const tableRegion = table.rows.region[row] === -1 ? null : table.regions[table.rows.region[row]];
      if (tableRegion === null) regionTableNull += 1;
      else if (tableRegion === expected) regionAgree += 1;
      else {
        const key = `${tableRegion}->${expected}`;
        regionDisagreements.set(key, (regionDisagreements.get(key) ?? 0) + 1);
        bumpBlock(regionBlocks, row, tableRegion, expected);
      }
    }
  }

  const top = (map) => Object.fromEntries([...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20));
  const topBlocks = (blocks) => [...blocks.values()]
    .sort((a, b) => b.nodes - a.nodes)
    .slice(0, MAX_DISAGREEMENT_BLOCKS)
    .map(({
      row, table: tableValue, fleet, nodes,
    }) => ({
      range: `${sources.intToIpv4(table.rows.start[row])}-${sources.intToIpv4(table.rows.end[row])}`,
      org: table.rows.org[row] === -1 ? null : table.orgs[table.rows.org[row]],
      table: tableValue,
      fleet,
      nodes,
    }));
  const disagree = [...disagreements.values()].reduce((a, b) => a + b, 0);
  const regionDisagree = [...regionDisagreements.values()].reduce((a, b) => a + b, 0);
  report.validation = {
    fleetIps: ips.size,
    joined: agree + disagree,
    agree,
    expectedAgreement: EXPECTED_COUNTRY_AGREEMENT,
    disagreements: top(disagreements),
    disagreementBlocks: topBlocks(countryBlocks),
    regionJoined: regionAgree + regionDisagree + regionTableNull,
    regionAgree,
    regionDisagree,
    regionTableNull,
    regionDisagreements: top(regionDisagreements),
    regionDisagreementBlocks: topBlocks(regionBlocks),
    continentMismatches: Object.fromEntries(continentMismatches),
  };
}

// ---------------------------------------------------------------------------
// artifact emit

function writeVarint(buffer, offset, value) {
  let remaining = value;
  let cursor = offset;
  while (remaining > 0x7f) {
    buffer[cursor] = (remaining % 128) | 0x80;
    cursor += 1;
    remaining = Math.floor(remaining / 128);
  }
  buffer[cursor] = remaining;
  return cursor + 1;
}

function emit(table, sourceSerials, outPath, regionMap) {
  const { rows } = table;
  const continents = {};
  for (const cc of table.countries) {
    if (CONTINENTS[cc]) continents[cc] = CONTINENTS[cc];
  }
  // The region-name vocabulary, carried so a node can read it too.
  //
  // The rows hold ISO 3166-2, but an app's geolocation may name a region the
  // way ip-api does - 'acEU_DE_Bavaria' - and a node has no way to tell that
  // Bavaria is DE-BY. Without this it answers such an entry at country
  // granularity, which counts the whole of Germany as eligible for a spec that
  // asked for one state.
  //
  // Scoped to the countries the artifact carries, like continents above: a
  // vocabulary entry naming a country the rows do not have could never resolve.
  const regionNames = {};
  const carried = new Set(table.countries);
  for (const [key, code] of Object.entries(regionMap)) {
    if (carried.has(key.slice(0, 2))) regionNames[key] = code;
  }
  const header = Buffer.from(JSON.stringify({
    generated: new Date().toISOString(),
    sources: sourceSerials,
    countries: table.countries,
    continents,
    orgs: table.orgs,
    regions: table.regions,
    regionNames,
  }), 'utf8');

  const prefix = Buffer.allocUnsafe(15 + header.length);
  prefix.write('FLXGEO', 0, 'ascii');
  prefix[6] = 2;
  prefix.writeUInt32LE(header.length, 7);
  header.copy(prefix, 11);
  prefix.writeUInt32LE(rows.length, 11 + header.length);

  const body = Buffer.allocUnsafe(rows.length * 25); // five varints, five bytes each at most
  let offset = 0;
  let previousEnd = -1;
  for (let i = 0; i < rows.length; i += 1) {
    offset = writeVarint(body, offset, rows.start[i] - previousEnd - 1);
    offset = writeVarint(body, offset, rows.end[i] - rows.start[i]);
    offset = writeVarint(body, offset, rows.org[i] + 1);
    offset = writeVarint(body, offset, rows.cc[i] + 1);
    offset = writeVarint(body, offset, rows.region[i] + 1);
    previousEnd = rows.end[i];
  }

  const raw = Buffer.concat([prefix, body.subarray(0, offset)]);
  const compressed = zlib.gzipSync(raw, { level: 9 });
  fs.writeFileSync(outPath, compressed);
  return { uncompressedBytes: raw.length, bytes: compressed.length, regionNames: Object.keys(regionNames).length };
}

// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);
  const report = {
    started: new Date().toISOString(),
    malformedRows: [],
    overlaps: [],
    dbip: null,
    collapsedRows: 0,
    overrides: null,
    validation: null,
  };
  const sourceSerials = {};

  let orgRanges = [];
  for (const rir of RIRS) {
    const text = await sources.cachedText(rir.url, args.cacheDir, `delegated-${rir.registry}.txt`); // eslint-disable-line no-await-in-loop
    orgRanges.push(...parseDelegated(rir.registry, text, sourceSerials, report));
  }
  process.stderr.write(`delegated: ${orgRanges.length} allocated v4 ranges\n`);
  orgRanges = normaliseRanges(orgRanges, report);
  if (report.overlaps.length) process.stderr.write(`resolved ${report.overlaps.length} overlaps\n`);

  if (!fs.existsSync(args.regionMap)) {
    throw new Error(`${path.relative(ROOT, args.regionMap)} is missing - run node scripts/build-region-map.js`);
  }
  const regionMap = JSON.parse(fs.readFileSync(args.regionMap, 'utf8'));
  const database = await sources.resolveDbipCsv(args.cacheDir, { download: !args.offline });
  sourceSerials.dbip = database.month;
  const geoLayer = await buildGeoLayer(database.file, regionMap, report);
  process.stderr.write(`dbip ${database.month}: ${report.dbip.databaseRows} database rows -> ${report.dbip.geoRows} region-granular ranges, ${report.dbip.namesWithoutRegion} region names unmapped\n`);

  const merged = merge(orgRanges, geoLayer, report);
  process.stderr.write(`merged: ${merged.rows.length} rows (${report.collapsedRows} collapsed), ${merged.orgs.length} orgs, ${merged.countries.length} countries, ${merged.regions.length} regions\n`);

  const ledger = overrides.load(args.overrides);
  if (ledger.problems.length) {
    throw new Error(`${path.relative(ROOT, args.overrides)}:\n  ${ledger.problems.join('\n  ')}`);
  }
  const table = applyOverrides(merged, ledger.entries, report);
  if (ledger.entries.length) {
    process.stderr.write(`overrides: ${report.overrides.applied} applied, ${report.overrides.retirable} retirable, ${table.rows.length} rows\n`);
    for (const entry of report.overrides.entries) {
      process.stderr.write(`  ${entry.range} -> ${entry.country ?? 'country unchanged'} / ${entry.region ?? 'no region'}: ${entry.rowsTouched} rows${entry.noop ? ', no-op - retire it' : ''}\n`);
    }
  }

  if (!args.offline) {
    await validate(table, report);
    const { validation } = report;
    const agreement = (100 * validation.agree) / (validation.joined || 1);
    process.stderr.write(`validation: ${validation.agree}/${validation.joined} fleet IPs agree on country (${agreement.toFixed(1)}%, expected ~${EXPECTED_COUNTRY_AGREEMENT}% - materially lower is a regression to investigate)\n`);
    process.stderr.write(`validation: regions ${validation.regionAgree} agree, ${validation.regionDisagree} disagree, ${validation.regionTableNull} not in table, of ${validation.regionJoined} self-reports carrying one\n`);
    if (Object.keys(validation.continentMismatches).length) {
      process.stderr.write(`validation: ${Object.keys(validation.continentMismatches).length} continent mismatches\n`);
    }
  }

  const artifact = emit(table, sourceSerials, args.out, regionMap);
  report.finished = new Date().toISOString();
  report.sources = sourceSerials;
  report.output = {
    file: path.relative(ROOT, args.out),
    rows: table.rows.length,
    countries: table.countries.length,
    orgs: table.orgs.length,
    regions: table.regions.length,
    regionNames: artifact.regionNames,
    uncompressedBytes: artifact.uncompressedBytes,
    bytes: artifact.bytes,
  };
  fs.writeFileSync(args.report, `${JSON.stringify(report, null, 2)}\n`);
  process.stderr.write(`wrote ${report.output.file}: ${report.output.rows} rows, ${(artifact.uncompressedBytes / 1048576).toFixed(1)} MB raw, ${(artifact.bytes / 1048576).toFixed(1)} MB gzipped\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exit(1);
});
