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
//      resolved to ISO 3166-2 through scripts/region-map.json. Country and region
//      come from here alone - measured against the fleet's self-reports it is
//      right where the registries' holder country is not.
//
// The build then validates the result against the live fleet's self-reported
// geolocation and writes a report. Only the fleet fetches need the network;
// `--offline` builds from the cached files alone.
//
// db-ip.com IP to City Lite database, CC BY 4.0 (https://db-ip.com).
//
// Usage:
//   node scripts/build-iplocation.js [--out iplocation.bin.gz]
//     [--cache-dir .cache] [--offline] [--report scripts/iplocation-build-report.json]

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

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

// Country -> continent, the geonames assignment ip-api follows. Nodes
// self-report ip-api continents, and app geolocation specs were written against
// them, so eligibility must use the same convention. The build report flags any
// live (country, continent) pair that disagrees with this map.
const CONTINENTS = {
  AF: 'AS', AL: 'EU', DZ: 'AF', AS: 'OC', AD: 'EU', AO: 'AF', AI: 'NA', AQ: 'AN', AG: 'NA', AR: 'SA',
  AM: 'AS', AW: 'NA', AU: 'OC', AT: 'EU', AZ: 'AS', BS: 'NA', BH: 'AS', BD: 'AS', BB: 'NA', BY: 'EU',
  BE: 'EU', BZ: 'NA', BJ: 'AF', BM: 'NA', BT: 'AS', BO: 'SA', BQ: 'NA', BA: 'EU', BW: 'AF', BV: 'AN',
  BR: 'SA', IO: 'AS', BN: 'AS', BG: 'EU', BF: 'AF', BI: 'AF', CV: 'AF', KH: 'AS', CM: 'AF', CA: 'NA',
  KY: 'NA', CF: 'AF', TD: 'AF', CL: 'SA', CN: 'AS', CX: 'OC', CC: 'AS', CO: 'SA', KM: 'AF', CG: 'AF',
  CD: 'AF', CK: 'OC', CR: 'NA', CI: 'AF', HR: 'EU', CU: 'NA', CW: 'NA', CY: 'EU', CZ: 'EU', DK: 'EU',
  DJ: 'AF', DM: 'NA', DO: 'NA', EC: 'SA', EG: 'AF', SV: 'NA', GQ: 'AF', ER: 'AF', EE: 'EU', SZ: 'AF',
  ET: 'AF', FK: 'SA', FO: 'EU', FJ: 'OC', FI: 'EU', FR: 'EU', GF: 'SA', PF: 'OC', TF: 'AN', GA: 'AF',
  GM: 'AF', GE: 'AS', DE: 'EU', GH: 'AF', GI: 'EU', GR: 'EU', GL: 'NA', GD: 'NA', GP: 'NA', GU: 'OC',
  GT: 'NA', GG: 'EU', GN: 'AF', GW: 'AF', GY: 'SA', HT: 'NA', HM: 'AN', VA: 'EU', HN: 'NA', HK: 'AS',
  HU: 'EU', IS: 'EU', IN: 'AS', ID: 'AS', IR: 'AS', IQ: 'AS', IE: 'EU', IM: 'EU', IL: 'AS', IT: 'EU',
  JM: 'NA', JP: 'AS', JE: 'EU', JO: 'AS', KZ: 'AS', KE: 'AF', KI: 'OC', KP: 'AS', KR: 'AS', KW: 'AS',
  KG: 'AS', LA: 'AS', LV: 'EU', LB: 'AS', LS: 'AF', LR: 'AF', LY: 'AF', LI: 'EU', LT: 'EU', LU: 'EU',
  MO: 'AS', MG: 'AF', MW: 'AF', MY: 'AS', MV: 'AS', ML: 'AF', MT: 'EU', MH: 'OC', MQ: 'NA', MR: 'AF',
  MU: 'AF', YT: 'AF', MX: 'NA', FM: 'OC', MD: 'EU', MC: 'EU', MN: 'AS', ME: 'EU', MS: 'NA', MA: 'AF',
  MZ: 'AF', MM: 'AS', NA: 'AF', NR: 'OC', NP: 'AS', NL: 'EU', NC: 'OC', NZ: 'OC', NI: 'NA', NE: 'AF',
  NG: 'AF', NU: 'OC', NF: 'OC', MK: 'EU', MP: 'OC', NO: 'EU', OM: 'AS', PK: 'AS', PW: 'OC', PS: 'AS',
  PA: 'NA', PG: 'OC', PY: 'SA', PE: 'SA', PH: 'AS', PN: 'OC', PL: 'EU', PT: 'EU', PR: 'NA', QA: 'AS',
  RE: 'AF', RO: 'EU', RU: 'EU', RW: 'AF', BL: 'NA', SH: 'AF', KN: 'NA', LC: 'NA', MF: 'NA', PM: 'NA',
  VC: 'NA', WS: 'OC', SM: 'EU', ST: 'AF', SA: 'AS', SN: 'AF', RS: 'EU', SC: 'AF', SL: 'AF', SG: 'AS',
  SX: 'NA', SK: 'EU', SI: 'EU', SB: 'OC', SO: 'AF', ZA: 'AF', GS: 'AN', SS: 'AF', ES: 'EU', LK: 'AS',
  SD: 'AF', SR: 'SA', SJ: 'EU', SE: 'EU', CH: 'EU', SY: 'AS', TW: 'AS', TJ: 'AS', TZ: 'AF', TH: 'AS',
  TL: 'AS', TG: 'AF', TK: 'OC', TO: 'OC', TT: 'NA', TN: 'AF', TR: 'AS', TM: 'AS', TC: 'NA', TV: 'OC',
  UG: 'AF', UA: 'EU', AE: 'AS', GB: 'EU', US: 'NA', UM: 'OC', UY: 'SA', UZ: 'AS', VU: 'OC', VE: 'SA',
  VN: 'AS', VG: 'NA', VI: 'NA', WF: 'OC', EH: 'AF', YE: 'AS', ZM: 'AF', ZW: 'AF', AX: 'EU', XK: 'EU',
};

// ---------------------------------------------------------------------------
// small utilities

function parseArgs(argv) {
  const args = {
    out: path.join(ROOT, 'iplocation.bin.gz'),
    cacheDir: path.join(ROOT, '.cache'),
    regionMap: path.join(ROOT, 'scripts', 'region-map.json'),
    report: path.join(ROOT, 'scripts', 'iplocation-build-report.json'),
    offline: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--out') { args.out = argv[i += 1]; } else if (flag === '--cache-dir') { args.cacheDir = argv[i += 1]; } else if (flag === '--region-map') { args.regionMap = argv[i += 1]; } else if (flag === '--report') { args.report = argv[i += 1]; } else if (flag === '--offline') { args.offline = true; } else { throw new Error(`Unknown argument ${flag}`); }
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
    }
    if (geo.region) {
      const expected = `${geo.countryCode}-${geo.region}`;
      const tableRegion = table.rows.region[row] === -1 ? null : table.regions[table.rows.region[row]];
      if (tableRegion === null) regionTableNull += 1;
      else if (tableRegion === expected) regionAgree += 1;
      else {
        const key = `${tableRegion}->${expected}`;
        regionDisagreements.set(key, (regionDisagreements.get(key) ?? 0) + 1);
      }
    }
  }

  const top = (map) => Object.fromEntries([...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20));
  const disagree = [...disagreements.values()].reduce((a, b) => a + b, 0);
  const regionDisagree = [...regionDisagreements.values()].reduce((a, b) => a + b, 0);
  report.validation = {
    fleetIps: ips.size,
    joined: agree + disagree,
    agree,
    expectedAgreement: EXPECTED_COUNTRY_AGREEMENT,
    disagreements: top(disagreements),
    regionJoined: regionAgree + regionDisagree + regionTableNull,
    regionAgree,
    regionDisagree,
    regionTableNull,
    regionDisagreements: top(regionDisagreements),
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

function emit(table, sourceSerials, outPath) {
  const { rows } = table;
  const continents = {};
  for (const cc of table.countries) {
    if (CONTINENTS[cc]) continents[cc] = CONTINENTS[cc];
  }
  const header = Buffer.from(JSON.stringify({
    generated: new Date().toISOString(),
    sources: sourceSerials,
    countries: table.countries,
    continents,
    orgs: table.orgs,
    regions: table.regions,
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
  return { uncompressedBytes: raw.length, bytes: compressed.length };
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

  const table = merge(orgRanges, geoLayer, report);
  process.stderr.write(`merged: ${table.rows.length} rows (${report.collapsedRows} collapsed), ${table.orgs.length} orgs, ${table.countries.length} countries, ${table.regions.length} regions\n`);

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

  const artifact = emit(table, sourceSerials, args.out);
  report.finished = new Date().toISOString();
  report.sources = sourceSerials;
  report.output = {
    file: path.relative(ROOT, args.out),
    rows: table.rows.length,
    countries: table.countries.length,
    orgs: table.orgs.length,
    regions: table.regions.length,
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
