'use strict';

// data/orgclasses.json - the ledger saying which organisations run access
// (consumer) networks and which sell hosting, and the rule that decides it.
//
// FluxOS needs the answer to enforce anything against a residential node, and a
// node cannot work it out for itself well enough: the strongest signal is the
// registry's own record of what a block was assigned for, and six thousand nodes
// cannot each query the RIRs. So the evidence is gathered once, here, reviewed in
// git alongside its reasons, and carried to every node in the artifact header.
//
// This module is the single definition of the rule and of what an entry may say.
// build-orgclasses.js writes entries through it and build-iplocation.js reads
// them, so a classification cannot mean one thing when it is decided and another
// when it is published.
//
// Entry shape, keyed by ADDRESS RANGE:
//   "82.66.80.0/20": {
//     "class": "residential" | "hosting",
//     "evidence": ["ptr 82-66-83-104.subs.proxad.net", "rdap FR-PROXAD-ADSL"],
//     "hosts": 8,                      fleet hosts the verdict was drawn from
//     "decided": "2026-08-18"
//   }
//
// Keyed by range and NOT by the artifact's organisation token, which would be
// the obvious choice and is wrong. That token is a hash of the registries'
// opaque-id, and the registries regenerate those on every publication - measured
// across eleven days, 1,919 of 2,510 fleet hosts changed token. It groups ranges
// correctly WITHIN one artifact and means nothing between two, so a verdict
// written against one would be looking for an organisation that no longer exists
// under that name by the next build. A range is the thing itself rather than a
// name for it, so it survives; it is also what a reviewer can check, which a
// hash of an anonymous identifier is not.
//
// Anything not listed is unclassified, which is not a third state to act on: an
// address with no verdict is one nothing enforces against.

const overrides = require('./overrides');

const CLASS_CODES = Object.freeze({ residential: 1, hosting: 2 });
const CLASSES = Object.freeze(Object.keys(CLASS_CODES));

// Access-network vocabulary. Generic across operators worldwide, which is what
// makes it worth more than a list of company names: it fires on Optus, Charter,
// Vodafone and Slovak Telekom without any of them being named.
const PTR_RESIDENTIAL = [
  'dsl', 'ppp', 'dial', 'dyn', 'pool', 'dhcp', 'cpe', 'cust', 'client',
  'subscriber', 'subs.', 'user', 'home', 'broadband', 'bband', 'cable',
  'docsis', 'hsd', 'fios', 'lightspeed', 'bras', 'gpon', 'ftth', 'fibre',
  'abo.', 'wanadoo', 'hispeed', 'optusnet', 'res.', 'resnet', 'retail',
  'access', 'mobile', 'lte', 'wireless', 'wifi', 'ipoe', 'rev.', 'fixed.',
];

// Hosting vocabulary. Only ever read as a contradiction, never as evidence in
// its own right.
const PTR_HOSTING = [
  'vps', 'vmi', 'srv', 'server', 'dedi', 'cloud', 'hosted', 'hosting',
  'colo', 'datacenter', 'datacentre', 'instance', 'compute', 'baremetal',
  'your-server', 'contabo', 'ovh', 'hetzner', 'linode', 'vultr',
  'digitalocean', 'amazonaws', 'azure', 'leaseweb', 'infomaniak', 'static.tds',
];

// Registry netname vocabulary. An operator writing DSL or POOL into its own RIPE
// object is saying what the block is for, in its own words.
const NETNAME_RESIDENTIAL = [
  'dsl', 'adsl', 'vdsl', 'pool', 'dyn', 'cpe', 'cust', 'subscriber', 'broadband',
  'ftth', 'fibre', 'cable', 'docsis', 'residential', 'resid', 'consumer', 'home',
  'gpon', 'retail',
];
const NETNAME_HOSTING = [
  'hosting', 'hoster', 'server', 'vps', 'cloud', 'colo', 'datacenter',
  'datacentre', 'dedicated', 'hetzner', 'contabo', 'netcup', 'ovh', 'leaseweb',
  'digitalocean', 'linode', 'vultr', 'infomaniak', 'scaleway', 'poneytelecom',
];

// Operators known to sell hosting. Matched against the operator - ip-api's `isp`
// and `as` - and never against `org`, which is the block registrant and is
// frequently a reseller. The two disagree on 67% of fleet hosts: 46.250.240.89
// carries isp "Contabo Asia Private Limited" and org "Yorkshire Tech Limited".
const HOSTING_OPERATORS = [
  'hetzner', 'ovh', 'netcup', 'hostnodes', 'contabo', 'hostslim', 'zayo',
  'cogent', 'lumen', 'digitalocean', 'linode', 'vultr', 'leaseweb', 'scaleway',
  'infomaniak', 'oracle', 'amazon', 'google', 'microsoft', 'azure', 'alibaba',
  'ionos', 'aruba', 'hostinger', 'namecheap', 'godaddy', 'upcloud',
];

// An access link is typically far faster down than up. Symmetric proves nothing
// either way - FTTH in France and Sweden is ordinary consumer service - so this
// only ever corroborates.
const ASYMMETRY_RATIO = 0.5;

// An organisation is decided by its hosts agreeing, not by every one of them
// agreeing. Unanimity has a size bias that runs exactly the wrong way: across a
// real consumer ISP's customers something always trips a flag, so the bigger the
// access network the less likely it could ever be classified - four addresses
// ip-api called proxy vetoed a verdict about Free SAS's 55. The thresholds are
// the ones ADJUDICATION.md already uses to settle a location dispute.
const MIN_DECIDABLE_FOR_MAJORITY = 3;
const MAJORITY_SHARE = 0.8;

function hits(text, vocabulary) {
  const lower = (text || '').toLowerCase();
  return vocabulary.some((token) => lower.includes(token));
}

/**
 * Evidence for and against one fleet HOST being on an access network.
 * @param {object} host
 * @param {string} [host.ptr] Reverse DNS.
 * @param {string} [host.netname] RDAP object name.
 * @param {string} [host.registrant] RDAP registrant name.
 * @param {boolean} [host.hosting] ip-api hosting flag.
 * @param {boolean} [host.proxy] ip-api proxy flag.
 * @param {boolean} [host.mobile] ip-api mobile flag.
 * @param {string} [host.isp] Operator name.
 * @param {string} [host.asn] Operator AS.
 * @param {number} [host.uploadSpeed] Mbps.
 * @param {number} [host.downloadSpeed] Mbps.
 * @returns {{for: string[], against: string[]}}
 */
function hostEvidence(host = {}) {
  const forEvidence = [];
  const against = [];

  const ptrResidential = hits(host.ptr, PTR_RESIDENTIAL);
  const ptrHosting = hits(host.ptr, PTR_HOSTING);
  // A name carrying hosting vocabulary is never cleared by also carrying access
  // vocabulary - Hetzner's own PTRs say `clients.your-server.de`.
  if (ptrResidential && !ptrHosting) forEvidence.push(`ptr ${host.ptr}`);
  if (ptrHosting) against.push(`ptr ${host.ptr}`);

  const registryText = `${host.netname || ''} ${host.registrant || ''}`;
  const netResidential = hits(registryText, NETNAME_RESIDENTIAL);
  const netHosting = hits(registryText, NETNAME_HOSTING);
  if (netResidential && !netHosting) forEvidence.push(`rdap ${host.netname}`);
  if (netHosting) against.push(`rdap ${host.netname}`);

  if (host.mobile === true) forEvidence.push('ip-api mobile');
  if (host.hosting === true) against.push('ip-api hosting');
  if (host.proxy === true) against.push('ip-api proxy');

  if (hits(`${host.isp || ''} ${host.asn || ''}`, HOSTING_OPERATORS)) {
    against.push(`operator ${host.isp || host.asn}`);
  }

  // Corroboration only, and deliberately kept OUT of `for`. A bench figure is a
  // speed test's result, not a property of the link: Hetzner nodes measure
  // 183/621 often enough that, counted as positive evidence, one noisy
  // benchmark vetoed an operator whose own PTR, registry object and vendor flag
  // all said hosting - 1,102 hosts left unclassified by an instrument reading.
  // It can support a verdict the real signals already reached; it can never
  // reach one, and never fight one.
  const { uploadSpeed: up, downloadSpeed: down } = host;
  const corroborating = [];
  if (up > 0 && down > 0 && up / down < ASYMMETRY_RATIO) {
    corroborating.push(`asymmetric ${Math.round(up)}/${Math.round(down)}`);
  }

  return { for: forEvidence, against, corroborating };
}

/**
 * Classify one organisation from every fleet host inside it.
 *
 * Each host is decided on its own evidence - residential when something
 * positively says access network and nothing contradicts, hosting when
 * something contradicts and nothing says access - and the decided hosts then
 * vote. The zero-contradictions test per host is what earns the accuracy:
 * measured against the 1,569 fleet hosts ip-api positively calls hosting, it
 * calls 0 of them residential, and the 39 that do trip an access signal are all
 * caught by a contradiction.
 *
 * Applying it across the organisation rather than per host is deliberate. An
 * operator that runs both consumer lines and a hosting arm reaches no majority
 * either way and comes out unclassified, which is the honest answer for a block
 * whose addresses are not all the same kind of thing.
 *
 * @param {object[]} hosts Evidence inputs, one per fleet host in the org.
 * @returns {{class: string|null, evidence: string[], contradictions: string[],
 *   decidable: number, share: number}}
 */
function classifyOrg(hosts) {
  // Decide each host on its own evidence first, then let the hosts vote. Pooling
  // every host's evidence into one bag, as this used to, meant a single
  // contradicting address spoke for the whole organisation.
  const verdicts = [];
  const reasons = { residential: new Set(), hosting: new Set() };
  const corroborating = new Set();
  for (const host of hosts) {
    const evidence = hostEvidence(host);
    evidence.corroborating.forEach((item) => corroborating.add(item));
    if (evidence.for.length && !evidence.against.length) {
      verdicts.push('residential');
      evidence.for.forEach((item) => reasons.residential.add(item));
    } else if (evidence.against.length && !evidence.for.length) {
      verdicts.push('hosting');
      evidence.against.forEach((item) => reasons.hosting.add(item));
    }
    // A host whose own signals disagree, or that has none, casts no vote.
  }

  const decidable = verdicts.length;
  if (!decidable) return { class: null, evidence: [], contradictions: [], decidable: 0, share: 0 };

  const counts = verdicts.reduce((acc, v) => ({ ...acc, [v]: (acc[v] ?? 0) + 1 }), {});
  const winner = (counts.residential ?? 0) >= (counts.hosting ?? 0) ? 'residential' : 'hosting';
  const share = counts[winner] / decidable;
  const evidence = [...reasons[winner]];
  const contradictions = [...reasons[winner === 'residential' ? 'hosting' : 'residential']];

  // Unanimous is decided at any size, which keeps the many one- and two-host
  // organisations answerable. Short of unanimous it takes a real population and
  // a strong majority - otherwise the addresses in this organisation are not all
  // the same kind of thing, and nothing is the honest answer.
  const decided = share === 1
    || (decidable >= MIN_DECIDABLE_FOR_MAJORITY && share >= MAJORITY_SHARE);
  if (!decided) return { class: null, evidence, contradictions, decidable, share };

  return {
    class: winner,
    evidence: winner === 'residential' ? [...evidence, ...corroborating] : evidence,
    contradictions,
    decidable,
    share,
  };
}

/**
 * Reject a ledger entry that does not say what an entry may say.
 * @param {string} range IPv4 CIDR on its own boundary.
 * @param {object} entry
 * @returns {string[]} Problems, empty when the entry is well formed.
 */
function entryProblems(range, entry) {
  const problems = [];
  if (!overrides.parseCidr(range)) {
    problems.push(`${range}: not an IPv4 CIDR on its own boundary`);
  }
  if (!entry || typeof entry !== 'object') {
    problems.push(`${range}: entry is not an object`);
    return problems;
  }
  if (!CLASSES.includes(entry.class)) {
    problems.push(`${range}: class must be one of ${CLASSES.join(', ')}`);
  }
  if (!Array.isArray(entry.evidence) || !entry.evidence.length) {
    problems.push(`${range}: evidence must be a non-empty array - an entry with no reason is a guess`);
  }
  if (!Number.isInteger(entry.hosts) || entry.hosts < 1) {
    problems.push(`${range}: hosts must be the number of fleet hosts the verdict was drawn from`);
  }
  if (typeof entry.decided !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(entry.decided)) {
    problems.push(`${range}: decided must be a YYYY-MM-DD date`);
  }
  return problems;
}

/**
 * Resolve the ledger against THIS build's organisations.
 *
 * Each ledger range is looked up in the table being built, which says which
 * organisation holds it today; the verdict then covers every range that
 * organisation holds, because the evidence is about an operator rather than
 * about one of its blocks. An organisation whose ledger ranges DISAGREE gets no
 * verdict at all - that is an operator running consumer lines and a hosting arm,
 * and the honest answer for it is nothing.
 *
 * @param {object} ledger Parsed data/orgclasses.json.
 * @param {Function} orgTokenAt Address (as an integer) -> organisation token or null.
 * @returns {{map: object, unresolved: string[], conflicted: string[]}}
 */
function resolveHeaderMap(ledger, orgTokenAt) {
  const byToken = new Map();
  const unresolved = [];
  for (const [range, entry] of Object.entries(ledger.entries || {})) {
    const bounds = overrides.parseCidr(range);
    const token = bounds ? orgTokenAt(bounds.start) : null;
    if (!token) {
      // The range is in no allocation this build knows, so there is nothing to
      // attach the verdict to. Reported rather than dropped: a ledger entry that
      // resolves to nothing is stale, and silence is how 90 of 156 verdicts
      // vanished the first time this was keyed on a token instead.
      unresolved.push(range);
      continue;
    }
    if (!byToken.has(token)) byToken.set(token, new Set());
    byToken.get(token).add(entry.class);
  }

  const map = {};
  const conflicted = [];
  for (const [token, classes] of byToken) {
    if (classes.size === 1) map[token] = CLASS_CODES[[...classes][0]];
    else conflicted.push(token);
  }
  return { map, unresolved, conflicted };
}

module.exports = {
  CLASS_CODES,
  CLASSES,
  PTR_RESIDENTIAL,
  PTR_HOSTING,
  NETNAME_RESIDENTIAL,
  NETNAME_HOSTING,
  HOSTING_OPERATORS,
  hostEvidence,
  classifyOrg,
  entryProblems,
  resolveHeaderMap,
};
