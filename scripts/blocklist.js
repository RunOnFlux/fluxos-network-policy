'use strict';

const net = require('net');

// The vocabulary of `blocklist.json`, and the projection that keeps
// `blockedrepositories.json` in step with it.
//
// Every entry names its kind, and a kind names the ONE field it is compared
// against. That is the whole point of the file: in the flat document an entry is
// a bare string tested against four different fields, so `grafana` refuses the
// application called grafana AND every image published under the grafana
// namespace, and no one writing the entry gets to say which they meant. Here
// `{ kind: 'name', value: 'grafana' }` can only ever reach an application name.
//
// A kind is not a hint. A reader that matches an entry against any field other
// than its kind's has reintroduced the ambiguity this file exists to remove.

// Mirrors APP_NAME_REGEX in FluxOS's appConstants: alphanumeric with internal
// hyphens. Measured against the 1441 live specifications on 2026-09-12 - every
// one of them satisfies it, and the longest is 35 characters.
const APP_NAME = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/;

// An app message hash as the chain anchors it.
const APP_HASH = /^[0-9a-f]{64}$/;

// Both owner identities in use: a base58 Flux address, and the 0x form that 13
// live specifications carry.
const FLUX_ADDRESS = /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/;
const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

// A registry namespace, and a repository which is a namespace plus a path. Tags
// and digests are never part of an entry: a node compares against a parsed
// reference with the tag already removed, so an entry carrying one is inert.
const REGISTRY_TOKEN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const REPOSITORY = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/;

// A `client` range: a CIDR on its own boundary, prefix always written, in the one
// canonical spelling - so one range can never be listed twice under two spellings,
// and the duplicate check sees every copy. The floors stop a typo from banning a
// continent; IPv6 stops at /64 because one customer is given a whole /64, so a
// finer range bans an address its holder can step off.
const CLIENT_PREFIX = { 4: { min: 12, max: 32 }, 6: { min: 32, max: 64 } };
const FAMILY_BITS = { 4: 32n, 6: 128n };

// IPv6 unicast is allocated from 2000::/3; nothing outside it is a submitter.
const IPV6_GLOBAL_UNICAST = ['2000::', 3];

// The IANA special-purpose address registries (iana-ipv4-special-registry,
// iana-ipv6-special-registry) and the multicast and reserved space beside them. A
// range overlapping any of these names something other than a submitter.
const SPECIAL_PURPOSE = {
  4: [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
    ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.31.196.0', 24], ['192.52.193.0', 24],
    ['192.88.99.0', 24], ['192.168.0.0', 16], ['192.175.48.0', 24], ['198.18.0.0', 15],
    ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
  ],
  6: [
    ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['100:0:0:1::', 64], ['2001::', 23],
    ['2001:db8::', 32], ['2002::', 16], ['2620:4f:8000::', 48], ['3fff::', 20], ['5f00::', 16],
  ],
};

// An address as an unsigned integer.
function addressBits(address, family) {
  if (family === 4) {
    return address.split('.').reduce((acc, octet) => (acc << 8n) + BigInt(octet), 0n);
  }
  const [head, tail = ''] = address.toLowerCase().split('::');
  const headGroups = head ? head.split(':') : [];
  const tailGroups = address.includes('::') && tail ? tail.split(':') : [];
  const groups = [...headGroups, ...new Array(8 - headGroups.length - tailGroups.length).fill('0'), ...tailGroups];
  return groups.reduce((acc, group) => (acc << 16n) + BigInt(parseInt(group, 16)), 0n);
}

// An integer as the canonical text of an address: dotted decimal, or RFC 5952 -
// lowercase, no leading zeros, the longest run of two or more zero groups as `::`
// (the first such run on a tie).
function addressText(bits, family) {
  if (family === 4) {
    return [24n, 16n, 8n, 0n].map((shift) => String((bits >> shift) & 255n)).join('.');
  }
  const groups = [112n, 96n, 80n, 64n, 48n, 32n, 16n, 0n].map((shift) => ((bits >> shift) & 0xffffn).toString(16));
  let best = { at: -1, length: 1 };
  let run = { at: -1, length: 0 };
  groups.forEach((group, index) => {
    if (group !== '0') {
      run = { at: -1, length: 0 };
      return;
    }
    run = run.at === -1 ? { at: index, length: 1 } : { at: run.at, length: run.length + 1 };
    if (run.length > best.length) best = { ...run };
  });
  if (best.at === -1) return groups.join(':');
  const head = groups.slice(0, best.at).join(':');
  const tail = groups.slice(best.at + best.length).join(':');
  return `${head}::${tail}`;
}

// The first and last address of a range.
function bounds(bits, prefix, family) {
  const hostMask = (1n << (FAMILY_BITS[family] - BigInt(prefix))) - 1n;
  return [bits & ~hostMask, (bits & ~hostMask) | hostMask];
}

function overlaps([first, last], [address, prefix], family) {
  const [otherFirst, otherLast] = bounds(addressBits(address, family), prefix, family);
  return first <= otherLast && otherFirst <= last;
}

/**
 * Why a `client` value is not a range the network can ban, or null.
 * @param {string} value
 * @returns {string|null}
 */
function clientRangeProblem(value) {
  const match = /^([^/]+)\/(0|[1-9]\d{0,2})$/.exec(value);
  if (!match) return 'a CIDR with its prefix written, such as 203.0.113.7/32';
  const [, address, prefixText] = match;
  const family = net.isIP(address);
  if (family === 0 || address.includes('%')) return 'a CIDR whose address is an IPv4 or IPv6 address';
  if (family === 6 && address.includes('.')) return 'an IPv6 range written in hexadecimal groups only';
  const prefix = Number(prefixText);
  const { min, max } = CLIENT_PREFIX[family];
  if (prefix < min || prefix > max) return `an IPv${family} prefix from /${min} to /${max}`;
  const bits = addressBits(address, family);
  const range = bounds(bits, prefix, family);
  if (range[0] !== bits) return `a range on its own boundary — ${address} has host bits set below /${prefix}`;
  const canonical = `${addressText(bits, family)}/${prefix}`;
  if (canonical !== value) return `the canonical spelling ${canonical}`;
  if (family === 6 && !overlaps(range, IPV6_GLOBAL_UNICAST, 6)) return 'a range in IPv6 global unicast space, 2000::/3';
  const special = SPECIAL_PURPOSE[family].find((block) => overlaps(range, block, family));
  if (special) return `a range clear of special-purpose space — it overlaps ${special[0]}/${special[1]}`;
  return null;
}

// A YYYY-MM-DD date that exists on the calendar: 2026-02-31 does not.
function isCalendarDate(text) {
  if (typeof text !== 'string' || !ISO_DATE.test(text)) return false;
  const time = Date.parse(`${text}T00:00:00Z`);
  return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === text;
}

// How long a `client` entry may stand. An address is reassigned when its renter
// lets it go, so a ban that outlives its abuser lands on whoever rents it next;
// renewing is a new date in a PR.
const CLIENT_MAX_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

const KINDS = {
  hash: {
    field: 'the application message hash',
    covers: 'one version of one application, and nothing after its next update',
    valid: (value) => APP_HASH.test(value),
    expected: '64 lowercase hex characters',
  },
  name: {
    field: 'the application name',
    covers: 'that application for as long as it exists, across every update',
    valid: (value) => APP_NAME.test(value) && value.length <= 64,
    expected: 'alphanumeric with internal hyphens, at most 64 characters',
  },
  owner: {
    field: 'the application owner identity',
    covers: 'every application that identity registers, present and future',
    valid: (value) => FLUX_ADDRESS.test(value) || HEX_ADDRESS.test(value),
    expected: 'a base58 Flux address or an 0x-prefixed 20-byte address',
  },
  image: {
    field: 'a component repository, tag removed',
    covers: 'every application running that exact image',
    valid: (value) => REPOSITORY.test(value) || REGISTRY_TOKEN.test(value),
    expected: 'a repository reference with no tag or digest',
  },
  org: {
    field: 'a registry namespace',
    covers: 'every application running any image published under it',
    valid: (value) => REGISTRY_TOKEN.test(value),
    expected: 'a single registry namespace token',
  },
  client: {
    field: 'the address a request to a route that takes or prepares an app message comes from',
    covers: 'every registration and update from that range, and every request preparing one, until it expires',
    valid: (value) => clientRangeProblem(value) === null,
    problem: clientRangeProblem,
    expected: 'an IPv4 range /12 to /32 or an IPv6 range /32 to /64 in global unicast space, canonically spelled, on its own boundary, clear of special-purpose space',
    fields: ['expires'],
  },
};

// Kinds a node reading the flat document can enforce. `name` is deliberately
// absent: that reader tests a bare string against the image and the namespace as
// well, so projecting a name into it would ban an unrelated organisation of the
// same word - which is the defect this file removes, reintroduced by the
// compatibility path. A name ban is enforced only by a reader that understands
// kinds, and is simply not in force until then.
const PROJECTED_KINDS = ['hash', 'owner', 'image', 'org'];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Every problem with one entry, as prose. Empty means the entry is well formed.
 * @param {unknown} entry An element of blocklist.json
 * @param {number} index Its position, for the message
 * @returns {string[]}
 */
function entryProblems(entry, index) {
  const at = `entry ${index}`;
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return [`${at}: must be an object`];
  }
  const problems = [];
  const kind = KINDS[entry.kind];
  if (!kind) {
    problems.push(`${at}: unknown kind ${JSON.stringify(entry.kind)} — expected one of ${Object.keys(KINDS).join(', ')}`);
  }
  if (typeof entry.value !== 'string' || !entry.value) {
    problems.push(`${at}: value must be a non-empty string`);
  } else if (entry.value !== entry.value.trim()) {
    // A padded value matches nothing and fails silently, which is the worst way
    // for a ban not to be in force.
    problems.push(`${at}: value has leading or trailing whitespace`);
  } else if (kind && !kind.valid(entry.value)) {
    const detail = kind.problem ? kind.problem(entry.value) : kind.expected;
    problems.push(`${at}: ${JSON.stringify(entry.value)} is not ${detail} for kind ${entry.kind}`);
  }
  // Why an entry exists is the part that cannot be recovered later. The 149
  // application hashes added on 2026-09-11 carried their reasoning in a commit
  // message, where nothing that reads the document can see it.
  if (typeof entry.reason !== 'string' || !entry.reason.trim()) {
    problems.push(`${at}: reason must say why this is blocked`);
  }
  if (typeof entry.added !== 'string' || !ISO_DATE.test(entry.added)) {
    problems.push(`${at}: added must be a YYYY-MM-DD date`);
  }
  if (entry.kind === 'client') {
    // The 90 days are counted from `added`, so `added` must be the day the entry
    // went in or earlier: a later one would let an entry stand for as long as the
    // gap. Checked against the clock this runs on, which for CI is the merge.
    const today = new Date().toISOString().slice(0, 10);
    if (typeof entry.added === 'string' && ISO_DATE.test(entry.added)) {
      if (!isCalendarDate(entry.added)) problems.push(`${at}: added ${entry.added} is not a calendar date`);
      else if (entry.added > today) problems.push(`${at}: added ${entry.added} is after today, ${today}`);
    }
    if (!isCalendarDate(entry.expires)) {
      problems.push(`${at}: expires must be a YYYY-MM-DD calendar date — a client ban always ends`);
    } else if (isCalendarDate(entry.added)) {
      const days = (Date.parse(entry.expires) - Date.parse(entry.added)) / DAY_MS;
      if (!(days > 0)) problems.push(`${at}: expires must be after added`);
      else if (days > CLIENT_MAX_DAYS) problems.push(`${at}: expires is ${days} days after added — at most ${CLIENT_MAX_DAYS}`);
    }
  }
  const allowed = new Set(['kind', 'value', 'reason', 'added', ...(kind?.fields ?? [])]);
  const extra = Object.keys(entry).filter((key) => !allowed.has(key));
  if (extra.length) {
    problems.push(`${at}: unexpected field(s) ${extra.join(', ')}`);
  }
  return problems;
}

/**
 * Every problem with the document as a whole.
 * @param {unknown} parsed The parsed blocklist.json
 * @returns {string[]}
 */
function documentProblems(parsed) {
  if (!Array.isArray(parsed)) return ['blocklist.json: must be an array of entries'];
  const problems = parsed.flatMap(entryProblems);
  // A kind and a value together identify an entry; the same pair twice is always
  // a mistake, and hides the case where an edit was meant and an addition
  // happened instead.
  const seen = new Map();
  parsed.forEach((entry, index) => {
    if (typeof entry !== 'object' || entry === null) return;
    const key = `${entry.kind}:${entry.value}`;
    if (seen.has(key)) problems.push(`entry ${index}: duplicate of entry ${seen.get(key)} — ${key}`);
    else seen.set(key, index);
  });
  return problems;
}

/**
 * The flat document a node on a release that predates kinds reads, derived from
 * the typed one. Order follows the source so a diff of the artifact reads as the
 * diff of the change that produced it.
 * @param {Array<object>} entries The parsed blocklist.json
 * @returns {string[]}
 */
function projectToRepositories(entries) {
  const projected = entries
    .filter((entry) => PROJECTED_KINDS.includes(entry.kind))
    .map((entry) => entry.value);
  return [...new Set(projected)];
}

module.exports = {
  CLIENT_MAX_DAYS,
  KINDS,
  PROJECTED_KINDS,
  entryProblems,
  documentProblems,
  projectToRepositories,
};
