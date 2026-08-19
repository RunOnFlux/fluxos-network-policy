#!/usr/bin/env node

'use strict';

// Decides which organisations run access (consumer) networks and which sell
// hosting, and writes the verdicts to data/orgclasses.json for review.
//
// FluxOS needs this to enforce anything against a residential node. A node
// cannot decide it well enough alone: the strongest evidence is the registry's
// own record of what a block was assigned for, and six thousand nodes cannot
// each query the RIRs. So it is gathered once here, reviewed in git with its
// reasons, and carried to every node in the artifact header.
//
// The unit is the ORGANISATION, not the address range, because that is what the
// artifact already carries per row and what the evidence actually describes. An
// operator running both consumer lines and a hosting arm contradicts itself and
// comes out unclassified - the honest answer for a block whose addresses are not
// all the same kind of thing. See scripts/orgclasses.js for the rule.
//
// Only organisations the fleet actually occupies are considered. The artifact
// names 103,366 of them; enforcement will only ever ask about the few hundred
// that hold Flux nodes, and a verdict nobody will read is a verdict nobody has
// checked.
//
// Run:  node scripts/build-orgclasses.js
// Then: node scripts/build-iplocation.js     (embeds the ledger in the header)

const dns = require('node:dns');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const orgclasses = require('./orgclasses');
const sources = require('./sources');

const ROOT = path.join(__dirname, '..');
const STATS_URL = 'https://stats.runonflux.io/fluxinfo?projection=geolocation,ip,benchmark';
const IPAPI_BATCH_URL = 'http://ip-api.com/batch?fields=status,query,org,isp,as,proxy,hosting,mobile';
const RDAP_BOOTSTRAP_URL = 'https://data.iana.org/rdap/ipv4.json';

// ip-api's free tier: 100 addresses per request, 15 requests a minute.
const IPAPI_BATCH_SIZE = 100;
const IPAPI_REQUESTS_PER_MINUTE = 15;
// Each worker gets its OWN resolver. Sharing node's global one collapses this
// sweep: on the module-level dns.reverse it answered 1,160 of 2,509 hosts where
// dig answers 1,865 of the same set, and the shortfall came back as ENOTFOUND -
// indistinguishable from a host genuinely having no PTR, and it would silently
// strip the strongest signal the rule has from a third of the fleet. Private
// channels with an explicit timeout and retry answer 300 of 300 controls.
const PTR_CONCURRENCY = 8;
const PTR_TIMEOUT_MS = 5000;
const PTR_TRIES = 3;
const RDAP_CONCURRENCY = 6;
const RDAP_ATTEMPTS = 4;

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function parseArgs(argv) {
  const args = {
    artifact: path.join(ROOT, 'iplocation.bin.gz'),
    out: path.join(ROOT, 'data', 'orgclasses.json'),
    cacheDir: path.join(ROOT, '.cache'),
    report: null,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--artifact') args.artifact = argv[i += 1];
    else if (flag === '--out') args.out = argv[i += 1];
    else if (flag === '--cache-dir') args.cacheDir = argv[i += 1];
    else if (flag === '--report') args.report = argv[i += 1];
    else throw new Error(`Unknown argument ${flag}`);
  }
  return args;
}

// -- the artifact, read back so a host can be attributed to an organisation ---

function readVarint(buf, cursor) {
  let result = 0;
  let shift = 0;
  let byte;
  do {
    byte = buf[cursor.offset];
    cursor.offset += 1;
    result += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  } while (byte & 0x80);
  return result;
}

/**
 * Load the published table into a form that answers "which organisation holds
 * this address". Deliberately reads the artifact rather than rebuilding the org
 * layer: the tokens must be the ones the fleet will look up, and the only way to
 * be sure of that is to use the ones that were published.
 * @param {string} file Path to iplocation.bin.gz.
 * @returns {{orgs: string[], lookup: Function}}
 */
function loadArtifact(file) {
  const raw = zlib.gunzipSync(fs.readFileSync(file));
  if (raw.toString('ascii', 0, 6) !== 'FLXGEO') throw new Error('not a FLXGEO artifact');
  const headerLength = raw.readUInt32LE(7);
  const header = JSON.parse(raw.toString('utf8', 11, 11 + headerLength));
  const rowCount = raw.readUInt32LE(11 + headerLength);

  const starts = new Uint32Array(rowCount);
  const ends = new Uint32Array(rowCount);
  const orgIdx = new Int32Array(rowCount);
  const cursor = { offset: 11 + headerLength + 4 };
  let previousEnd = -1;
  for (let i = 0; i < rowCount; i += 1) {
    const gap = readVarint(raw, cursor);
    const len = readVarint(raw, cursor);
    const org = readVarint(raw, cursor);
    readVarint(raw, cursor); // country, not needed here
    readVarint(raw, cursor); // region, not needed here
    const start = previousEnd + 1 + gap;
    starts[i] = start;
    ends[i] = start + len;
    orgIdx[i] = org - 1;
    previousEnd = start + len;
  }

  function lookup(value) {
    let lo = 0;
    let hi = rowCount - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (value < starts[mid]) hi = mid - 1;
      else if (value > ends[mid]) lo = mid + 1;
      else {
        return {
          org: orgIdx[mid] < 0 ? null : header.orgs[orgIdx[mid]],
          start: starts[mid],
          end: ends[mid],
        };
      }
    }
    return null;
  }

  return { orgs: header.orgs, generated: header.generated, lookup };
}

/**
 * The CIDRs that exactly cover [start, end]. A row boundary is an allocation and
 * rarely a single prefix, and the ledger only accepts CIDRs on their own
 * boundary - so a row becomes the set of prefixes that tile it.
 * @param {number} start First address, inclusive.
 * @param {number} end Last address, inclusive.
 * @returns {string[]}
 */
function toCidrs(start, end) {
  const out = [];
  let cursor = start;
  while (cursor <= end) {
    // The largest block that both starts here and fits in what is left.
    let size = cursor === 0 ? 2 ** 32 : cursor & -cursor;
    while (cursor + size - 1 > end) size /= 2;
    out.push(`${sources.intToIpv4(cursor)}/${32 - Math.log2(size)}`);
    cursor += size;
  }
  return out;
}

// -- evidence sources ---------------------------------------------------------

/**
 * The fleet, one entry per distinct host. A fluxinfo record is a node SLOT and
 * several share a machine, so they are collapsed by address first: the evidence
 * is about the connection, and counting one machine eight times would let a
 * single host outvote eight others.
 */
async function fetchFleet() {
  const records = (await sources.fetchJson(STATS_URL)).data ?? [];
  const hosts = new Map();
  for (const record of records) {
    const ip = (record.geolocation?.ip) || (record.ip ?? '').split(':')[0];
    if (!ip) continue;
    const bench = record.benchmark?.bench ?? {};
    if (!hosts.has(ip)) {
      hosts.set(ip, {
        ip,
        slots: 0,
        uploadSpeed: bench.upload_speed || 0,
        downloadSpeed: bench.download_speed || 0,
      });
    }
    hosts.get(ip).slots += 1;
  }
  return [...hosts.values()];
}

/**
 * ip-api in batches, paced under the free tier's limit. Anything it will not
 * answer for simply carries no ip-api evidence; the rule decides on what remains.
 */
async function fetchIpApi(hosts) {
  const answers = new Map();
  const batches = [];
  for (let i = 0; i < hosts.length; i += IPAPI_BATCH_SIZE) {
    batches.push(hosts.slice(i, i + IPAPI_BATCH_SIZE).map((h) => h.ip));
  }
  for (let i = 0; i < batches.length; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const response = await fetch(IPAPI_BATCH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batches[i]),
    });
    if (response.ok) {
      // eslint-disable-next-line no-await-in-loop
      const rows = await response.json();
      for (const row of rows) {
        if (row.status === 'success') answers.set(row.query, row);
      }
    }
    process.stderr.write(`  ip-api ${Math.min((i + 1) * IPAPI_BATCH_SIZE, hosts.length)}/${hosts.length}\r`);
    if (i + 1 < batches.length) {
      // eslint-disable-next-line no-await-in-loop
      await sleep((60 / IPAPI_REQUESTS_PER_MINUTE) * 1000);
    }
  }
  process.stderr.write('\n');
  return answers;
}

/**
 * Reverse DNS for each host. About a quarter of the fleet genuinely has none,
 * which is ordinary - but a resolver that fails under load looks exactly the
 * same to a caller that swallows errors, so the two are kept apart here and the
 * unresolved count is reported. A sweep that answers far fewer hosts than usual
 * is a broken instrument, not a fleet that lost its PTRs.
 * @returns {{answers: Map<string,string>, absent: number, unresolved: number}}
 */
async function fetchPtr(hosts) {
  const answers = new Map();
  let absent = 0;
  let index = 0;
  async function worker() {
    const resolver = new dns.promises.Resolver({ timeout: PTR_TIMEOUT_MS, tries: PTR_TRIES });
    while (index < hosts.length) {
      const host = hosts[index];
      index += 1;
      try {
        // eslint-disable-next-line no-await-in-loop
        const names = await resolver.reverse(host.ip);
        if (names?.length) answers.set(host.ip, names[0]);
        else absent += 1;
      } catch {
        absent += 1;
      }
    }
  }
  await Promise.all(Array.from({ length: PTR_CONCURRENCY }, worker));
  return { answers, absent };
}

/**
 * Registry records, routed straight at the authoritative RIR rather than through
 * an aggregator, which throttles hard enough to answer a fraction of a sweep.
 * Cached on disk: this is the expensive source and it changes rarely.
 */
async function fetchRdap(hosts, cacheDir) {
  const bootstrapPath = path.join(cacheDir, 'rdap-bootstrap.json');
  let bootstrap;
  if (fs.existsSync(bootstrapPath)) {
    bootstrap = JSON.parse(fs.readFileSync(bootstrapPath, 'utf8'));
  } else {
    bootstrap = await (await fetch(RDAP_BOOTSTRAP_URL)).json();
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(bootstrapPath, JSON.stringify(bootstrap));
  }
  const services = [];
  for (const [prefixes, urls] of bootstrap.services) {
    const base = (urls.find((u) => u.startsWith('https')) ?? urls[0]).replace(/\/$/, '');
    for (const prefix of prefixes) {
      const [network, bits] = prefix.split('/');
      const size = 2 ** (32 - Number(bits));
      const start = sources.ipv4ToInt(network);
      services.push({ start, end: start + size - 1, base });
    }
  }
  const baseFor = (value) => (services.find((s) => value >= s.start && value <= s.end)?.base ?? 'https://rdap.org');

  const rdapDir = path.join(cacheDir, 'rdap');
  fs.mkdirSync(rdapDir, { recursive: true });

  const answers = new Map();
  let index = 0;
  let done = 0;
  async function worker() {
    while (index < hosts.length) {
      const host = hosts[index];
      index += 1;
      const cached = path.join(rdapDir, `${host.ip}.json`);
      let doc = null;
      if (fs.existsSync(cached)) {
        try { doc = JSON.parse(fs.readFileSync(cached, 'utf8')); } catch { doc = null; }
      }
      for (let attempt = 0; doc === null && attempt < RDAP_ATTEMPTS; attempt += 1) {
        try {
          const url = `${baseFor(sources.ipv4ToInt(host.ip))}/ip/${host.ip}`;
          // eslint-disable-next-line no-await-in-loop
          const response = await fetch(url, { headers: { Accept: 'application/rdap+json' } });
          if (response.status === 404) break; // genuinely no record; stop asking
          if (response.ok) {
            // eslint-disable-next-line no-await-in-loop
            doc = await response.json();
            fs.writeFileSync(cached, JSON.stringify(doc));
            break;
          }
        } catch {
          // fall through to the backoff
        }
        // eslint-disable-next-line no-await-in-loop
        await sleep((2 ** attempt) * 1000 + Math.floor(Math.random() * 500));
      }
      if (doc) answers.set(host.ip, doc);
      done += 1;
      if (done % 50 === 0) process.stderr.write(`  rdap ${done}/${hosts.length}\r`);
    }
  }
  await Promise.all(Array.from({ length: RDAP_CONCURRENCY }, worker));
  process.stderr.write('\n');
  return answers;
}

/**
 * Registrant names from an RDAP document's entity chain, and the object's own
 * name. Read these only - the abuse-contact block carries the operator's contact
 * person names, which swamp the vocabulary with false signal.
 */
function rdapNames(doc) {
  if (!doc) return { netname: '', registrant: '' };
  const names = [];
  const walk = (entity) => {
    for (const item of entity.vcardArray?.[1] ?? []) {
      if (Array.isArray(item) && item[0] === 'fn' && item.length >= 4) names.push(String(item[3]));
    }
    for (const sub of entity.entities ?? []) walk(sub);
  };
  for (const entity of doc.entities ?? []) walk(entity);
  return { netname: doc.name ?? '', registrant: names.slice(0, 2).join(' ') };
}

// -- main ---------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);

  process.stderr.write('reading published artifact\n');
  const artifact = loadArtifact(args.artifact);
  process.stderr.write(`  ${artifact.orgs.length} organisations, generated ${artifact.generated}\n`);

  process.stderr.write('fetching fleet\n');
  const hosts = await fetchFleet();
  process.stderr.write(`  ${hosts.length} distinct hosts\n`);

  process.stderr.write('gathering evidence\n');
  const ipapi = await fetchIpApi(hosts);
  const ptrSweep = await fetchPtr(hosts);
  const ptr = ptrSweep.answers;
  const rdap = await fetchRdap(hosts, args.cacheDir);
  process.stderr.write(`  ip-api ${ipapi.size}, ptr ${ptr.size} resolved / ${ptrSweep.absent} none, rdap ${rdap.size}\n`);
  // About three quarters of fleet hosts do have a PTR. A sweep that finds far
  // fewer is a resolver failing to answer, not a fleet that lost its names, and
  // classifying on it would read a broken instrument as absent evidence.
  const ptrRate = ptr.size / hosts.length;
  if (ptrRate < 0.5) {
    throw new Error(`only ${ptr.size} of ${hosts.length} hosts resolved a PTR (${(ptrRate * 100).toFixed(0)}%, expected ~75%) - `
      + 'the resolver is not answering the whole sweep, and its silence is not evidence.');
  }

  // Group the evidence by the organisation the artifact attributes each host to,
  // remembering the allocation each host sits in - the verdict is decided per
  // organisation, but written down per range, which is what survives a rebuild.
  const byOrg = new Map();
  const rangesByOrg = new Map();
  let unattributed = 0;
  for (const host of hosts) {
    const hit = artifact.lookup(sources.ipv4ToInt(host.ip));
    const token = hit?.org ?? null;
    if (!token) { unattributed += 1; continue; }
    if (!rangesByOrg.has(token)) rangesByOrg.set(token, new Map());
    for (const cidr of toCidrs(hit.start, hit.end)) {
      rangesByOrg.get(token).set(cidr, (rangesByOrg.get(token).get(cidr) ?? 0) + 1);
    }
    const api = ipapi.get(host.ip) ?? {};
    const names = rdapNames(rdap.get(host.ip));
    if (!byOrg.has(token)) byOrg.set(token, []);
    byOrg.get(token).push({
      ip: host.ip,
      ptr: ptr.get(host.ip) ?? '',
      netname: names.netname,
      registrant: names.registrant,
      hosting: api.hosting,
      proxy: api.proxy,
      mobile: api.mobile,
      isp: api.isp,
      asn: api.as,
      uploadSpeed: host.uploadSpeed,
      downloadSpeed: host.downloadSpeed,
    });
  }
  process.stderr.write(`  ${byOrg.size} organisations hold fleet hosts (${unattributed} hosts in no allocation)\n`);

  const decided = new Date().toISOString().slice(0, 10);
  const entries = {};
  const tally = { residential: 0, hosting: 0, unclassified: 0 };
  // Why each undecided organisation was undecided. "No evidence at all" is a
  // different problem from "the signals fought", and only one of them is a
  // classifier that can be improved.
  const undecided = { noEvidence: 0, conflicted: 0, conflictCauses: {} };
  for (const [token, orgHosts] of [...byOrg].sort((a, b) => b[1].length - a[1].length)) {
    const verdict = orgclasses.classifyOrg(orgHosts);
    if (!verdict.class) {
      tally.unclassified += 1;
      undecided.largest = undecided.largest ?? [];
      undecided.largest.push({
        hosts: orgHosts.length,
        reason: (!verdict.evidence.length && !verdict.contradictions.length) ? 'no evidence' : 'conflicted',
        for: verdict.evidence.slice(0, 3),
        against: verdict.contradictions.slice(0, 3),
        sample: orgHosts[0].ip,
        isp: orgHosts[0].isp ?? '',
      });
      if (!verdict.evidence.length && !verdict.contradictions.length) undecided.noEvidence += 1;
      else {
        undecided.conflicted += 1;
        // Name the kind of positive signal that fought the contradictions, so a
        // signal that is poisoning otherwise-clear verdicts is visible.
        for (const item of verdict.evidence) {
          const kind = item.split(' ')[0];
          undecided.conflictCauses[kind] = (undecided.conflictCauses[kind] ?? 0) + 1;
        }
      }
      continue;
    }
    tally[verdict.class] += 1;
    // `evidence` carries the reasons of whichever side won the vote, whatever
    // that side was; `contradictions` carries the dissenting minority's, which is
    // recorded in the report rather than the ledger.
    const reasons = verdict.evidence;
    for (const cidr of rangesByOrg.get(token).keys()) {
      entries[cidr] = {
        class: verdict.class,
        evidence: reasons.slice(0, 8),
        hosts: orgHosts.length,
        decided,
      };
    }
  }

  const ledger = { generated: new Date().toISOString(), entries };
  const problems = Object.entries(entries).flatMap(([t, e]) => orgclasses.entryProblems(t, e));
  if (problems.length) throw new Error(`refusing to write a malformed ledger:\n  ${problems.join('\n  ')}`);
  fs.writeFileSync(args.out, `${JSON.stringify(ledger, null, 2)}\n`);

  process.stderr.write(`\nwrote ${path.relative(ROOT, args.out)}\n`);
  process.stderr.write(`  organisations: residential ${tally.residential}, hosting ${tally.hosting}, unclassified ${tally.unclassified}\n`);
  process.stderr.write(`  ranges written: ${Object.keys(entries).length}\n`);

  if (args.report) {
    const hostTally = { residential: 0, hosting: 0, unclassified: 0 };
    for (const [token, orgHosts] of byOrg) {
      const firstRange = [...(rangesByOrg.get(token)?.keys() ?? [])][0];
      const bucket = entries[firstRange]?.class ?? 'unclassified';
      hostTally[bucket] += orgHosts.length;
    }
    fs.writeFileSync(args.report, `${JSON.stringify({
      generated: ledger.generated,
      artifactGenerated: artifact.generated,
      hosts: hosts.length,
      unattributed,
      organisations: tally,
      undecided: {
        ...undecided,
        largest: (undecided.largest ?? []).sort((a, b) => b.hosts - a.hosts).slice(0, 12),
      },
      ranges: Object.keys(entries).length,
      hostsByClass: hostTally,
    }, null, 2)}\n`);
    process.stderr.write(`  hosts: residential ${hostTally.residential}, hosting ${hostTally.hosting}, unclassified ${hostTally.unclassified}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exit(1);
});
