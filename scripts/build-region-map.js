#!/usr/bin/env node

'use strict';

// Builds scripts/region-map.json - the (country, DB-IP region name) -> ISO 3166-2
// table build-iplocation.js applies when it turns the DB-IP database into the
// geo layer of the artifact.
//
// DB-IP names regions in English exonyms and informal short forms; the artifact
// carries ISO 3166-2 codes. The two are matched by a cascade, most-authoritative
// first:
//   1. scripts/region-aliases.json - curated, for names no rule reaches.
//   2. Fleet empirical - ip-api pairs a region name with its ISO suffix on every
//      node's self-report, which settles the exonyms the fleet actually lives in.
//   3. iso-codes, exact on the normalised name.
//   4. iso-codes, with type words ("Province", "Oblast", ...) stripped from either
//      side.
//   5. iso-codes, unique stem prefix within the country - genitive and adjectival
//      forms ("Nitriansky" for "Nitra"), never shorter than four characters.
// A name only maps when its match is unique within the country. Unmatched names
// map to nothing and their addresses land at country granularity, which is the
// safe direction: a missing region can only make placement more conservative.
//
// Only the fleet stats fetch needs the network; the ISO dataset and the DB-IP
// database are read from the cache.
//
// Usage:
//   node scripts/build-region-map.js [--out scripts/region-map.json]
//     [--cache-dir .cache] [--aliases scripts/region-aliases.json]

const fs = require('fs');
const path = require('path');

const sources = require('./sources');

const ROOT = path.join(__dirname, '..');
const ISO_URL = 'https://salsa.debian.org/iso-codes-team/iso-codes/-/raw/main/data/iso_3166-2.json';
const STATS_URL = 'https://stats.runonflux.io/fluxinfo?projection=geolocation,ip';

// Words that name the kind of division rather than the division. Both sides of a
// comparison lose them before the stripped match, so "Nitra Region" reaches
// "Nitriansky kraj" and "Fujian Sheng" reaches "Fujian".
const TYPE_WORDS = new Set([
  'province', 'region', 'oblast', 'county', 'district', 'governorate', 'prefecture',
  'department', 'state', 'territory', 'voivodeship', 'canton', 'parish', 'municipality',
  'krai', 'republic', 'autonomous', 'metropolitan', 'city', 'of', 'shi', 'lan', 'len',
  'fylke', 'grad', 'sheng', 'do', 'si',
]);

const MIN_STEM = 4;

function parseArgs(argv) {
  const args = {
    out: path.join(ROOT, 'scripts', 'region-map.json'),
    cacheDir: path.join(ROOT, '.cache'),
    aliases: path.join(ROOT, 'scripts', 'region-aliases.json'),
  };
  for (let i = 2; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--out') { args.out = argv[i += 1]; } else if (flag === '--cache-dir') { args.cacheDir = argv[i += 1]; } else if (flag === '--aliases') { args.aliases = argv[i += 1]; } else { throw new Error(`Unknown argument ${flag}`); }
  }
  return args;
}

// Parentheses and brackets qualify a name rather than identify it ("Île-de-France
// (region)"); diacritics, case and punctuation differ freely between the two
// vocabularies for the same place.
function normalise(name) {
  return name
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripTypes(normalised) {
  return normalised.split(' ').filter((word) => !TYPE_WORDS.has(word)).join(' ');
}

// One side is a prefix of the other, both long enough that the prefix is the name
// and not a coincidence.
function stemMatch(a, b) {
  if (a.length < MIN_STEM || b.length < MIN_STEM) return false;
  return a.startsWith(b) || b.startsWith(a);
}

function addTo(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

function uniqueHit(map, key) {
  const hits = map.get(key);
  return hits && hits.length === 1 ? hits[0] : null;
}

function loadIso(text) {
  const entries = JSON.parse(text)['3166-2'];
  const codes = new Set();
  const byCountry = new Map();
  const exact = new Map();
  const stripped = new Map();
  for (const entry of entries) {
    const cc = entry.code.split('-')[0];
    codes.add(entry.code);
    const normalised = normalise(entry.name);
    addTo(exact, `${cc}|${normalised}`, entry.code);
    const stem = stripTypes(normalised);
    if (stem && stem !== normalised) addTo(stripped, `${cc}|${stem}`, entry.code);
    if (!byCountry.has(cc)) byCountry.set(cc, []);
    byCountry.get(cc).push({ code: entry.code, stem });
  }
  return {
    entries: entries.length, codes, byCountry, exact, stripped,
  };
}

// Curated names are written the way a person would write them; they are indexed
// under both normal forms so they match whichever the database uses.
function loadAliases(file, isoCodes, notes) {
  const table = JSON.parse(fs.readFileSync(file, 'utf8'));
  const index = new Map();
  let kept = 0;
  for (const [key, code] of Object.entries(table)) {
    const [cc, name] = key.split('|');
    if (!isoCodes.has(code)) {
      notes.push(`alias ${key} -> ${code}: no such ISO 3166-2 code, ignored`);
      continue;
    }
    if (!cc || !name || !code.startsWith(`${cc}-`)) {
      notes.push(`alias ${key} -> ${code}: code is not in country ${cc}, ignored`);
      continue;
    }
    kept += 1;
    const normalised = normalise(name);
    for (const form of new Set([normalised, stripTypes(normalised)])) {
      if (!form) continue;
      const existing = index.get(`${cc}|${form}`);
      if (existing && existing !== code) notes.push(`alias collision on ${cc}|${form}: ${existing} vs ${code}`);
      index.set(`${cc}|${form}`, code);
    }
  }
  return { index, kept, total: Object.keys(table).length };
}

// ip-api reports a region name and an ISO suffix side by side on every node, so
// the fleet is a live sample of the mapping for exactly the places Flux runs in.
// Suffixes that are not ISO 3166-2 are dropped: the artifact's vocabulary is ISO.
function buildEmpirical(fleetRows, isoCodes, nonIsoSuffixes) {
  const counts = new Map();
  for (const row of fleetRows) {
    const geo = row.geolocation ?? {};
    const cc = geo.countryCode;
    const suffix = geo.region;
    const name = geo.regionName;
    if (!cc || !suffix || !name) continue;
    const code = `${cc}-${suffix}`;
    if (!isoCodes.has(code)) { nonIsoSuffixes.add(code); continue; }
    const normalised = normalise(name);
    for (const form of new Set([normalised, stripTypes(normalised)])) {
      if (!form) continue;
      const key = `${cc}|${form}`;
      if (!counts.has(key)) counts.set(key, new Map());
      const tally = counts.get(key);
      tally.set(code, (tally.get(code) ?? 0) + 1);
    }
  }
  const index = new Map();
  for (const [key, tally] of counts) {
    index.set(key, [...tally.entries()].sort((a, b) => b[1] - a[1])[0][0]);
  }
  return index;
}

function stemCandidates(iso, cc, target) {
  const hits = new Set();
  for (const entry of iso.byCountry.get(cc) ?? []) {
    if (entry.stem && stemMatch(entry.stem, target)) hits.add(entry.code);
  }
  return hits;
}

function match(cc, name, iso, aliases, empirical, how) {
  const normalised = normalise(name);
  const stem = stripTypes(normalised);

  const alias = aliases.get(`${cc}|${normalised}`) ?? aliases.get(`${cc}|${stem}`);
  if (alias) { how.alias += 1; return alias; }

  const fleet = empirical.get(`${cc}|${normalised}`) ?? empirical.get(`${cc}|${stem}`);
  if (fleet) { how.fleetEmpirical += 1; return fleet; }

  const exact = uniqueHit(iso.exact, `${cc}|${normalised}`);
  if (exact) { how.isoExact += 1; return exact; }

  const loose = uniqueHit(iso.stripped, `${cc}|${stem}`)
    ?? uniqueHit(iso.stripped, `${cc}|${normalised}`)
    ?? uniqueHit(iso.exact, `${cc}|${stem}`);
  if (loose) { how.isoStripped += 1; return loose; }

  if (stem) {
    const hits = stemCandidates(iso, cc, stem);
    if (hits.size === 1) { how.stemPrefix += 1; return [...hits][0]; }
  }
  how.unmatched += 1;
  return null;
}

async function main() {
  const args = parseArgs(process.argv);
  const notes = [];
  const nonIsoSuffixes = new Set();

  const iso = loadIso(await sources.cachedText(ISO_URL, args.cacheDir, 'iso_3166-2.json'));
  const aliases = loadAliases(args.aliases, iso.codes, notes);

  const fleetRows = (await sources.fetchJson(STATS_URL)).data ?? [];
  const empirical = buildEmpirical(fleetRows, iso.codes, nonIsoSuffixes);

  // Fleet addresses, deduplicated for the lookup and kept per node for the
  // weighting: a region that a hundred nodes sit in matters a hundred times more
  // than one no node has ever used.
  const nodeIps = [];
  for (const row of fleetRows) {
    const ip = (row.geolocation?.ip ?? row.ip ?? '').split(':')[0];
    const value = ip ? sources.ipv4ToInt(ip) : null;
    if (value !== null) nodeIps.push(value);
  }
  const lookupIps = [...new Set(nodeIps)].sort((a, b) => a - b);

  const { file, month } = await sources.resolveDbipCsv(args.cacheDir);
  process.stderr.write(`reading ${path.relative(ROOT, file)} (${month})\n`);

  const pairs = new Map(); // "cc|name" -> number of database rows
  const fleetPair = new Map(); // fleet address -> "cc|name"
  let cursor = 0;
  const dbip = await sources.streamDbipRows(file, (start, end, cc, name) => {
    const key = cc && name ? `${cc}|${name}` : null;
    if (key) pairs.set(key, (pairs.get(key) ?? 0) + 1);
    while (cursor < lookupIps.length && lookupIps[cursor] < start) cursor += 1;
    while (cursor < lookupIps.length && lookupIps[cursor] <= end) {
      if (key) fleetPair.set(lookupIps[cursor], key);
      cursor += 1;
    }
  });

  const how = {
    alias: 0, fleetEmpirical: 0, isoExact: 0, isoStripped: 0, stemPrefix: 0, unmatched: 0,
  };
  const map = {};
  for (const key of pairs.keys()) {
    const separator = key.indexOf('|');
    const code = match(key.slice(0, separator), key.slice(separator + 1), iso, aliases.index, empirical, how);
    if (code) map[key] = code;
  }

  const matched = Object.keys(map).length;
  const sorted = {};
  for (const key of Object.keys(map).sort()) sorted[key] = map[key];
  fs.writeFileSync(args.out, `${JSON.stringify(sorted, null, 2)}\n`);

  let fleetTotal = 0;
  let fleetMapped = 0;
  const unmatchedFleet = new Map();
  for (const value of nodeIps) {
    const key = fleetPair.get(value);
    if (!key) continue;
    fleetTotal += 1;
    if (map[key]) fleetMapped += 1;
    else unmatchedFleet.set(key, (unmatchedFleet.get(key) ?? 0) + 1);
  }

  let rangeTotal = 0;
  let rangeMapped = 0;
  for (const [key, count] of pairs) {
    rangeTotal += count;
    if (map[key]) rangeMapped += count;
  }

  const pct = (part, whole) => (whole ? `${((100 * part) / whole).toFixed(1)}%` : 'n/a');
  process.stderr.write(`iso-codes: ${iso.entries} subdivisions, ${iso.byCountry.size} countries\n`);
  process.stderr.write(`aliases: ${aliases.kept}/${aliases.total} curated entries usable\n`);
  process.stderr.write(`fleet: ${fleetRows.length} nodes, ${lookupIps.length} distinct addresses, ${empirical.size} empirical name forms\n`);
  process.stderr.write(`dbip: ${dbip.rows} v4 rows, ${pairs.size} distinct (country, region name) pairs\n`);
  process.stderr.write(`matched: ${matched}/${pairs.size} pairs (${pct(matched, pairs.size)})\n`);
  for (const [source, count] of Object.entries(how)) process.stderr.write(`  ${source}: ${count}\n`);
  process.stderr.write(`range-weighted: ${rangeMapped}/${rangeTotal} (${pct(rangeMapped, rangeTotal)})\n`);
  process.stderr.write(`fleet-weighted: ${fleetMapped}/${fleetTotal} (${pct(fleetMapped, fleetTotal)})\n`);
  if (nonIsoSuffixes.size) {
    process.stderr.write(`ip-api suffixes outside ISO 3166-2, not used: ${[...nonIsoSuffixes].sort().join(', ')}\n`);
  }
  if (dbip.malformed || dbip.unsorted) {
    process.stderr.write(`dbip rows rejected: ${dbip.malformed} malformed, ${dbip.unsorted} out of order\n`);
  }
  for (const note of notes) process.stderr.write(`${note}\n`);
  if (unmatchedFleet.size) {
    process.stderr.write(`unmatched names with fleet presence (${unmatchedFleet.size}):\n`);
    for (const [key, count] of [...unmatchedFleet.entries()].sort((a, b) => b[1] - a[1])) {
      process.stderr.write(`  ${key}: ${count} nodes\n`);
    }
  }
  process.stderr.write(`wrote ${path.relative(ROOT, args.out)}: ${matched} entries\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exit(1);
});
