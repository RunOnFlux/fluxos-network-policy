'use strict';

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
    problems.push(`${at}: ${JSON.stringify(entry.value)} is not ${kind.expected} for kind ${entry.kind}`);
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
  const allowed = new Set(['kind', 'value', 'reason', 'added']);
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
  KINDS,
  PROJECTED_KINDS,
  entryProblems,
  documentProblems,
  projectToRepositories,
};
