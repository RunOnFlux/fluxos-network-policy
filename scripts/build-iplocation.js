#!/usr/bin/env node

'use strict';

// Builds iplocation.json - the IP -> (organisation, country) table FluxOS uses
// to compute placement fault domains (see PLACEMENT_DIVERSITY in fluxModels).
//
// Sources, layered:
//   1. The five RIRs' delegated-extended files: every allocated range's
//      boundaries, holder country, and registry-scoped organisation id. This is
//      the base layer and covers all allocated address space.
//   2. RDAP object country: the registry database's per-range country
//      attribute, queried only for ranges whose delegated country disagrees
//      with what the Flux nodes inside them self-report. Hosting providers
//      registered under a different-country LIR (Hetzner FI under DE, etc.)
//      resolve here.
//   3. RFC 8805 geofeeds, discovered per RFC 9632 from the RDAP responses:
//      operator-published per-prefix country and ISO 3166-2 region. Applied for
//      subranges they cover.
//
// The build then validates the result against the live fleet's self-reported
// geolocation and writes a report. Corrections and validation need the network;
// `--no-corrections` builds the base layer alone from cached files.
//
// Usage:
//   node scripts/build-iplocation.js [--out iplocation.json]
//     [--cache-dir .cache] [--no-corrections] [--report build-report.json]

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const RIRS = [
  { registry: 'ripencc', url: 'https://ftp.ripe.net/pub/stats/ripencc/delegated-ripencc-extended-latest', rdap: 'https://rdap.db.ripe.net/ip/' },
  { registry: 'arin', url: 'https://ftp.arin.net/pub/stats/arin/delegated-arin-extended-latest', rdap: 'https://rdap.arin.net/registry/ip/' },
  { registry: 'apnic', url: 'https://ftp.apnic.net/stats/apnic/delegated-apnic-extended-latest', rdap: 'https://rdap.apnic.net/ip/' },
  { registry: 'lacnic', url: 'https://ftp.lacnic.net/pub/stats/lacnic/delegated-lacnic-extended-latest', rdap: 'https://rdap.lacnic.net/rdap/ip/' },
  { registry: 'afrinic', url: 'https://ftp.afrinic.net/pub/stats/afrinic/delegated-afrinic-extended-latest', rdap: 'https://rdap.afrinic.net/rdap/ip/' },
];

const NODELIST_URL = 'https://api.runonflux.io/daemon/viewdeterministiczelnodelist';
const STATS_URL = 'https://stats.runonflux.io/fluxinfo?projection=geolocation,ip';

const FETCH_TIMEOUT_MS = 120000;
const RDAP_TIMEOUT_MS = 20000;
const RDAP_CONCURRENCY = 8;
const GEOFEED_MAX_BYTES = 8 * 1024 * 1024;

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
    out: path.join(ROOT, 'iplocation.json'),
    cacheDir: path.join(ROOT, '.cache'),
    report: path.join(ROOT, 'scripts', 'iplocation-build-report.json'),
    corrections: true,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--out') { args.out = argv[i += 1]; } else if (flag === '--cache-dir') { args.cacheDir = argv[i += 1]; } else if (flag === '--report') { args.report = argv[i += 1]; } else if (flag === '--no-corrections') { args.corrections = false; } else { throw new Error(`Unknown argument ${flag}`); }
  }
  return args;
}

function ipv4ToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

function intToIpv4(value) {
  return [
    Math.floor(value / 16777216) % 256,
    Math.floor(value / 65536) % 256,
    Math.floor(value / 256) % 256,
    value % 256,
  ].join('.');
}

function ipv6ToBigInt(ip) {
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
  const missing = halves.length > 1 ? 8 - head.length - tail.length : 0;
  if (missing < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array(missing).fill('0'), ...tail];
  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    value = (value << 16n) + BigInt(parseInt(group, 16));
  }
  return value;
}

function bigIntToIpv6(value) {
  const groups = [];
  for (let i = 7; i >= 0; i -= 1) {
    groups.push(Number((value >> BigInt(i * 16)) & 0xffffn).toString(16));
  }
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < groups.length; i += 1) {
    if (groups[i] !== '0') continue;
    let len = 0;
    while (i + len < groups.length && groups[i + len] === '0') len += 1;
    if (len > bestLen) { bestStart = i; bestLen = len; }
  }
  if (bestLen < 2) return groups.join(':');
  return `${groups.slice(0, bestStart).join(':')}::${groups.slice(bestStart + bestLen).join(':')}`;
}

async function fetchText(url, timeoutMs) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.text();
}

async function fetchJson(url, timeoutMs) {
  return JSON.parse(await fetchText(url, timeoutMs));
}

async function cachedDownload(url, cacheDir, filename) {
  const filePath = path.join(cacheDir, filename);
  if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) {
    return fs.readFileSync(filePath, 'utf8');
  }
  process.stderr.write(`downloading ${url}\n`);
  const text = await fetchText(url, FETCH_TIMEOUT_MS);
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(filePath, text);
  return text;
}

async function mapConcurrent(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index); // eslint-disable-line no-await-in-loop
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

// ---------------------------------------------------------------------------
// layer 1: delegated-extended base

function parseDelegated(registry, text, sources, report) {
  const v4 = [];
  const v6 = [];
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const fields = line.split('|');
    if (/^\d/.test(fields[0])) { // version header, e.g. "2|ripencc|serial|..." or "2.3|arin|..."
      sources[registry] = fields[2] ?? null;
      continue;
    }
    if (fields[1] === '*' || fields.length < 7) continue; // summary lines
    const [, cc, type, start, value, , status] = fields;
    if (status !== 'allocated' && status !== 'assigned') continue;
    const org = fields.length >= 8 && fields[7] ? `${registry}:${fields[7]}` : null;
    const country = /^[A-Z]{2}$/.test(cc) && cc !== 'ZZ' ? cc : null;
    if (type === 'ipv4') {
      const startInt = ipv4ToInt(start);
      const count = Number(value);
      if (startInt === null || !Number.isInteger(count) || count <= 0) {
        report.malformedRows.push(`${registry}: ${line.slice(0, 120)}`);
        continue;
      }
      v4.push({
        start: BigInt(startInt), end: BigInt(startInt + count - 1), cc: country, org, registry, source: 'delegated',
      });
    } else if (type === 'ipv6') {
      const startInt = ipv6ToBigInt(start);
      const prefix = Number(value);
      if (startInt === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 128) {
        report.malformedRows.push(`${registry}: ${line.slice(0, 120)}`);
        continue;
      }
      v6.push({
        start: startInt, end: startInt + (1n << BigInt(128 - prefix)) - 1n, cc: country, org, registry, source: 'delegated',
      });
    }
  }
  return { v4, v6 };
}

// Sort and resolve overlaps, most-specific range wins: a range fully contained
// in another splits the container around it; a partial overlap truncates the
// later range. Cross-registry overlap is rare (transferred legacy space) but
// must produce a deterministic, non-overlapping result.
function normaliseRanges(ranges, report, label) {
  ranges.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : (a.end > b.end ? -1 : a.end < b.end ? 1 : 0)));
  const out = [];
  for (const range of ranges) {
    let current = range;
    while (out.length) {
      const prev = out[out.length - 1];
      if (current.start > prev.end) break;
      report.overlaps.push(`${label}: [${prev.start}-${prev.end}] vs [${current.start}-${current.end}]`);
      if (current.end <= prev.end) {
        // contained: more specific wins; split the container around it
        out.pop();
        if (prev.start < current.start) out.push({ ...prev, end: current.start - 1n });
        out.push(current);
        current = prev.end > current.end ? { ...prev, start: current.end + 1n } : null;
        break;
      }
      // partial overlap: truncate the later range
      current = { ...current, start: prev.end + 1n };
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
// layers 2+3: RDAP object country and RFC 8805 geofeeds for fleet blocks

function findRange(ranges, value) {
  let lo = 0;
  let hi = ranges.length - 1;
  let hit = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ranges[mid].start <= value) { hit = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  if (hit === -1 || ranges[hit].end < value) return null;
  return ranges[hit];
}

function discoverGeofeedUrl(rdap) {
  for (const link of rdap.links ?? []) {
    const rel = `${link.rel ?? ''} ${link.title ?? ''}`.toLowerCase();
    if (rel.includes('geofeed') && link.href) return link.href;
  }
  for (const remark of rdap.remarks ?? []) {
    for (const line of remark.description ?? []) {
      const match = line.match(/^\s*geofeed:?\s+(https:\/\/\S+)/i);
      if (match) return match[1];
    }
  }
  return null;
}

function parseGeofeed(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const [prefix, cc, region] = trimmed.split(',').map((s) => (s ?? '').trim());
    if (!prefix || !/^[A-Z]{2}$/i.test(cc ?? '')) continue;
    const [addr, lenStr] = prefix.split('/');
    const len = Number(lenStr);
    if (addr.includes(':')) {
      const start = ipv6ToBigInt(addr);
      if (start === null || !Number.isInteger(len) || len < 0 || len > 128) continue;
      rows.push({
        v6: true, start, end: start + (1n << BigInt(128 - len)) - 1n, cc: cc.toUpperCase(), region: region || null,
      });
    } else {
      const start = ipv4ToInt(addr);
      if (start === null || !Number.isInteger(len) || len < 0 || len > 32) continue;
      rows.push({
        v6: false, start: BigInt(start), end: BigInt(start) + (1n << BigInt(32 - len)) - 1n, cc: cc.toUpperCase(), region: region || null,
      });
    }
  }
  return rows;
}

// Apply override intervals onto a non-overlapping base, splitting base ranges
// where an override covers part of them. Overrides never extend past the block
// they were gathered for.
function applyOverrides(ranges, overrides) {
  if (!overrides.length) return ranges;
  overrides.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  const out = [];
  for (const range of ranges) {
    let cursor = range.start;
    const pieces = [];
    for (const override of overrides) {
      if (override.end < cursor || override.start > range.end) continue;
      const start = override.start > cursor ? override.start : cursor; // floor at cursor: overlapping overrides apply first-wins
      const end = override.end < range.end ? override.end : range.end;
      if (start > end) continue;
      if (start > cursor) pieces.push({ ...range, start: cursor, end: start - 1n });
      pieces.push({
        ...range, start, end, cc: override.cc, region: override.region ?? null, source: override.source,
      });
      cursor = end + 1n;
    }
    if (cursor <= range.end) pieces.push({ ...range, start: cursor, end: range.end });
    out.push(...(pieces.length ? pieces : [range]));
  }
  return out;
}

async function correctFleetBlocks(v4, report) {
  const nodeList = (await fetchJson(NODELIST_URL, FETCH_TIMEOUT_MS)).data ?? [];
  const stats = (await fetchJson(STATS_URL, FETCH_TIMEOUT_MS)).data ?? [];

  const selfCountry = new Map();
  for (const entry of stats) {
    const ip = (entry.ip ?? '').split(':')[0];
    const cc = entry.geolocation?.countryCode;
    if (ip && cc) selfCountry.set(ip, cc);
  }

  // group fleet IPs by covering range
  const blocks = new Map(); // range object -> {ips, selfCCs}
  for (const node of nodeList) {
    const ip = (node.ip ?? '').split(':')[0];
    const value = ip ? ipv4ToInt(ip) : null;
    if (value === null) continue;
    const range = findRange(v4, BigInt(value));
    if (!range) continue;
    if (!blocks.has(range)) blocks.set(range, { ips: new Set(), selfCCs: new Map() });
    const block = blocks.get(range);
    block.ips.add(ip);
    const cc = selfCountry.get(ip);
    if (cc) block.selfCCs.set(cc, (block.selfCCs.get(cc) ?? 0) + 1);
  }
  report.fleet.blocks = blocks.size;

  // blocks whose delegated country disagrees with the nodes' majority self-report
  const disputed = [];
  for (const [range, block] of blocks) {
    const majority = [...block.selfCCs.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    if (majority && majority !== range.cc) disputed.push({ range, majority, ips: block.ips });
  }
  report.fleet.disputedBlocks = disputed.length;

  const overrides = [];
  await mapConcurrent(disputed, RDAP_CONCURRENCY, async ({ range, majority, ips }) => {
    const rdapBase = RIRS.find((rir) => rir.registry === range.registry)?.rdap ?? RIRS[0].rdap;
    const sampleIp = intToIpv4(Number(range.start));
    const record = {
      block: `${sampleIp}-${intToIpv4(Number(range.end))}`,
      delegated: range.cc,
      fleetSelfReport: majority,
      nodes: ips.size,
      rdapCountry: null,
      geofeed: null,
      applied: 'none',
    };
    try {
      const rdap = await fetchJson(`${rdapBase}${sampleIp}`, RDAP_TIMEOUT_MS);
      if (/^[A-Z]{2}$/.test(rdap.country ?? '')) {
        record.rdapCountry = rdap.country;
        overrides.push({
          start: range.start, end: range.end, cc: rdap.country, region: null, source: 'rdap',
        });
        record.applied = 'rdap';
      }
      const geofeedUrl = discoverGeofeedUrl(rdap);
      if (geofeedUrl) {
        record.geofeed = geofeedUrl;
        const text = await fetchText(geofeedUrl, RDAP_TIMEOUT_MS);
        if (text.length <= GEOFEED_MAX_BYTES) {
          for (const row of parseGeofeed(text)) {
            if (row.v6 || row.end < range.start || row.start > range.end) continue;
            overrides.push({
              start: row.start > range.start ? row.start : range.start,
              end: row.end < range.end ? row.end : range.end,
              cc: row.cc,
              region: row.region,
              source: 'geofeed',
            });
          }
          record.applied = record.applied === 'rdap' ? 'rdap+geofeed' : 'geofeed';
        }
      }
    } catch (error) {
      record.error = error.message;
    }
    report.corrections.push(record);
  });

  // geofeed rows are more specific than the whole-block rdap country: apply
  // rdap first, geofeed second so geofeed wins where both cover an address
  const rdapOverrides = overrides.filter((o) => o.source === 'rdap');
  const geofeedOverrides = overrides.filter((o) => o.source === 'geofeed');
  let corrected = applyOverrides(v4, rdapOverrides);
  corrected = applyOverrides(corrected, geofeedOverrides);
  return corrected;
}

// ---------------------------------------------------------------------------
// validation join against the live fleet

async function validate(v4, report) {
  const nodeList = (await fetchJson(NODELIST_URL, FETCH_TIMEOUT_MS)).data ?? [];
  const stats = (await fetchJson(STATS_URL, FETCH_TIMEOUT_MS)).data ?? [];
  const selfGeo = new Map();
  for (const entry of stats) {
    const ip = (entry.ip ?? '').split(':')[0];
    if (ip && entry.geolocation?.countryCode) selfGeo.set(ip, entry.geolocation);
  }

  let agree = 0;
  const disagreements = new Map();
  const continentMismatches = new Map();
  const ips = new Set();
  for (const node of nodeList) {
    const ip = (node.ip ?? '').split(':')[0];
    if (ip) ips.add(ip);
  }
  for (const ip of ips) {
    const value = ipv4ToInt(ip);
    const geo = selfGeo.get(ip);
    if (value === null || !geo) continue;
    const range = findRange(v4, BigInt(value));
    if (!range || !range.cc) continue;
    if (range.cc === geo.countryCode) {
      agree += 1;
      const expected = CONTINENTS[range.cc];
      if (geo.continentCode && expected && geo.continentCode !== expected) {
        const key = `${range.cc}: table ${expected} vs ip-api ${geo.continentCode}`;
        continentMismatches.set(key, (continentMismatches.get(key) ?? 0) + 1);
      }
    } else {
      const key = `${range.cc}->${geo.countryCode}`;
      disagreements.set(key, (disagreements.get(key) ?? 0) + 1);
    }
  }
  report.validation = {
    fleetIps: ips.size,
    joined: agree + [...disagreements.values()].reduce((a, b) => a + b, 0),
    agree,
    disagreements: Object.fromEntries([...disagreements.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)),
    continentMismatches: Object.fromEntries(continentMismatches),
  };
}

// ---------------------------------------------------------------------------
// artifact emit

function emit(v4, v6, sources, outPath) {
  const countries = new Map();
  const orgs = new Map();
  const regions = new Map();
  const index = (map, key) => {
    if (key === null || key === undefined) return null;
    if (!map.has(key)) map.set(key, map.size);
    return map.get(key);
  };
  const rows = (ranges, toStr) => ranges.map((range) => {
    const row = [toStr ? toStr(range.start) : Number(range.start), toStr ? toStr(range.end) : Number(range.end), index(orgs, range.org), index(countries, range.cc)];
    if (range.region) row.push(index(regions, range.region));
    return row;
  });
  const v4Rows = rows(v4, null);
  const v6Rows = rows(v6, bigIntToIpv6);
  const continents = {};
  for (const cc of countries.keys()) {
    if (CONTINENTS[cc]) continents[cc] = CONTINENTS[cc];
  }
  const artifact = {
    format: 1,
    generated: new Date().toISOString(),
    sources,
    countries: [...countries.keys()],
    continents,
    orgs: [...orgs.keys()],
    regions: [...regions.keys()],
    v4: v4Rows,
    v6: v6Rows,
  };
  fs.writeFileSync(outPath, `${JSON.stringify(artifact)}\n`);
  return artifact;
}

// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);
  const report = {
    started: new Date().toISOString(),
    malformedRows: [],
    overlaps: [],
    fleet: {},
    corrections: [],
    validation: null,
  };
  const sources = {};

  let v4 = [];
  let v6 = [];
  for (const rir of RIRS) {
    const text = await cachedDownload(rir.url, args.cacheDir, `delegated-${rir.registry}.txt`); // eslint-disable-line no-await-in-loop
    const parsed = parseDelegated(rir.registry, text, sources, report);
    v4.push(...parsed.v4);
    v6.push(...parsed.v6);
  }
  process.stderr.write(`base: ${v4.length} v4 + ${v6.length} v6 allocated ranges\n`);
  v4 = normaliseRanges(v4, report, 'v4');
  v6 = normaliseRanges(v6, report, 'v6');
  if (report.overlaps.length) process.stderr.write(`resolved ${report.overlaps.length} overlaps\n`);

  if (args.corrections) {
    v4 = await correctFleetBlocks(v4, report);
    process.stderr.write(`corrections: ${report.corrections.length} disputed blocks processed\n`);
    await validate(v4, report);
    const { validation } = report;
    process.stderr.write(`validation: ${validation.agree}/${validation.joined} fleet IPs agree with self-reports\n`);
  }

  const artifact = emit(v4, v6, sources, args.out);
  report.finished = new Date().toISOString();
  report.output = {
    file: path.relative(ROOT, args.out),
    v4Rows: artifact.v4.length,
    v6Rows: artifact.v6.length,
    countries: artifact.countries.length,
    orgs: artifact.orgs.length,
    regions: artifact.regions.length,
    bytes: fs.statSync(args.out).size,
  };
  fs.writeFileSync(args.report, `${JSON.stringify(report, null, 2)}\n`);
  process.stderr.write(`wrote ${report.output.file}: ${report.output.v4Rows} v4 rows, ${report.output.v6Rows} v6 rows, ${(report.output.bytes / 1048576).toFixed(1)} MB\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exit(1);
});
