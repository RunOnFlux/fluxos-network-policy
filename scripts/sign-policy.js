#!/usr/bin/env node

// Signs the policy documents so a node can tell what this repository published from what
// something in between handed it. The transport stops needing to be trusted, which is what
// lets a node take policy from a peer instead of only from github.
//
// One signature covers all four documents together, not one each. Separately signed
// documents can be recombined: an attacker able to choose which versions a node receives
// could pair today's enterprise map with last month's blocklist, and both would verify.
// A single payload makes the set the unit, so the only thing a node can hold is a
// combination this repository actually published.
//
// iplocation.bin.gz is covered by its sha256 rather than carried inline -- it is 4.6 MB of
// binary and the documents are a few kilobytes of JSON -- and republished here under a name
// derived from that hash.
//
// The content-addressed name is the point. `iplocation.bin.gz` is a MUTABLE name: it means
// "the current table", so its content changes under anyone holding a reference to it, and a
// document naming it can only ever say "fetch this, and it should hash to X". Between the
// table being regenerated on main and this bundle being signed, those two disagree. Naming
// the file by its own hash makes the question unaskable: the file either exists or it does
// not, and it cannot be the wrong bytes.
//
// It is also what lets a peer serve the table. "Give me iplocation-<hash>.bin.gz" is
// answerable by anyone and checkable on arrival; "give me the current table" is not, because
// the peer's idea of current and the asker's may differ.
//
// Git stores a blob once per content, so the copy beside the bundle shares storage with the
// one on main rather than doubling it.
//
// The payload is signed and transmitted as exact bytes in base64, so verification never
// depends on the signer and the verifier agreeing about JSON key order or whitespace.
//
// stdout carries exactly one line, changed=false or changed=true, read by the workflow to
// decide whether to commit. Everything human goes to stderr.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = process.env.POLICY_SIGNED_DIR || path.join(ROOT, 'signed');
const OUTPUT = path.join(OUT_DIR, 'policy-signed.json');
const PROVENANCE = path.join(OUT_DIR, 'provenance.json');

// Every document a node enforces. Adding one here puts it under the same signature and the
// same sequence as the rest; a node that does not know the name ignores it, so a new
// document can ship before the consumer that reads it.
const DOCUMENTS = [
  'blocklist',
  'blockedrepositories',
  'vettedrepositories',
  'tamperingblockednodes',
  'enterprisenodes',
];

// Named by hash rather than carried by value, for size. Republished under a content-derived
// name; the mutable name stays on main for releases that still fetch it directly.
const ARTIFACTS = ['iplocation.bin.gz'];

// How many superseded artifacts to keep beside the current one. A node holding a bundle from
// the last month or two must still be able to fetch the table that bundle names, so the file
// cannot be deleted the moment a newer one is signed.
const ARTIFACT_GENERATIONS = 3;

// A raw 32-byte Ed25519 seed is not directly importable; Node wants PKCS8. The prefix is
// fixed for the algorithm, so prepending it is enough.
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_ED25519_PREFIX_LENGTH = 12;

function privateKeyFromSeed(seedB64) {
  const seed = Buffer.from(seedB64, 'base64');
  if (seed.length !== 32) {
    throw new Error(`signing seed must be 32 bytes, got ${seed.length}`);
  }
  return crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
}

// The raw 32 bytes consumers pin, rather than any DER wrapping around them.
function rawPublicKey(privateKey) {
  const spki = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  return spki.subarray(SPKI_ED25519_PREFIX_LENGTH).toString('hex');
}

function readDocuments() {
  const documents = {};
  DOCUMENTS.forEach((name) => {
    const file = path.join(ROOT, `${name}.json`);
    // Parsed, not copied as text: the signature should commit to what a node will act on,
    // and reformatting the file must not read as a policy change.
    documents[name] = JSON.parse(fs.readFileSync(file, 'utf8'));
  });
  return documents;
}

// Reads each artifact and returns what the payload should say about it, keyed by the stable
// name so a consumer can look up "the ip location table" without knowing this month's hash.
function readArtifacts() {
  const artifacts = {};
  ARTIFACTS.forEach((name) => {
    const file = path.join(ROOT, name);
    if (!fs.existsSync(file)) return;
    const bytes = fs.readFileSync(file);
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    const extension = name.slice(name.indexOf('.'));
    artifacts[name] = {
      file: `${name.slice(0, name.indexOf('.'))}-${sha256}${extension}`,
      sha256,
      bytes: bytes.length,
    };
  });
  return artifacts;
}

// Writes each artifact under its content-derived name and removes superseded ones beyond the
// retention window. Same bytes as the copy on main, so git adds no object for it.
function publishArtifacts(artifacts) {
  Object.entries(artifacts).forEach(([name, meta]) => {
    const target = path.join(OUT_DIR, meta.file);
    if (!fs.existsSync(target)) {
      fs.copyFileSync(path.join(ROOT, name), target);
    }
    const prefix = `${name.slice(0, name.indexOf('.'))}-`;
    const superseded = fs.readdirSync(OUT_DIR)
      .filter((f) => f.startsWith(prefix) && f !== meta.file)
      .map((f) => ({ f, mtime: fs.statSync(path.join(OUT_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(ARTIFACT_GENERATIONS);
    superseded.forEach(({ f }) => {
      fs.unlinkSync(path.join(OUT_DIR, f));
      process.stderr.write(`removed superseded ${f}\n`);
    });
  });
}

function buildSignedDocument(seq, issuedAt, documents, artifacts, privateKey) {
  if (!Number.isInteger(seq) || seq < 1) {
    throw new Error('seq must be a positive integer');
  }
  const payload = Buffer.from(
    JSON.stringify({
      seq, issued_at: issuedAt, documents, artifacts,
    }),
    'utf8',
  );
  return {
    payload_b64: payload.toString('base64'),
    sig_b64: crypto.sign(null, payload, privateKey).toString('base64'),
  };
}

function payloadOf(document) {
  return JSON.parse(Buffer.from(document.payload_b64, 'base64').toString('utf8'));
}

function readJsonIfPresent(file) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

function main() {
  const seedB64 = process.env.POLICY_SIGNING_SEED_B64;
  if (!seedB64) throw new Error('POLICY_SIGNING_SEED_B64 is not set');

  const documents = readDocuments();
  const artifacts = readArtifacts();

  const previousDocument = readJsonIfPresent(OUTPUT);
  const previous = previousDocument ? payloadOf(previousDocument) : null;

  // Signed content decides whether anything changed, so a commit that only reformats a
  // document does not burn a sequence -- and a sequence that never moves without a real
  // change is one a node can reason about.
  const unchanged = previous
    && JSON.stringify(previous.documents) === JSON.stringify(documents)
    && JSON.stringify(previous.artifacts) === JSON.stringify(artifacts);
  if (unchanged) {
    process.stderr.write(`nothing changed at seq ${previous.seq}\n`);
    process.stdout.write('changed=false\n');
    return;
  }

  // The high-water is taken from whichever of the two is higher. Losing the document -- a
  // branch reset, a bad merge, a fresh clone -- must not restart the count, because a
  // sequence that can go backwards is not a defence against replay: an old signed bundle
  // would become newer than what is published.
  const provenance = readJsonIfPresent(PROVENANCE) || {};
  const highWater = Math.max(previous ? previous.seq : 0, provenance.seq || 0);
  const seq = highWater + 1;

  const issuedAt = new Date().toISOString();
  const privateKey = privateKeyFromSeed(seedB64);
  const document = buildSignedDocument(seq, issuedAt, documents, artifacts, privateKey);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  publishArtifacts(artifacts);
  fs.writeFileSync(OUTPUT, `${JSON.stringify(document, null, 2)}\n`);
  fs.writeFileSync(PROVENANCE, `${JSON.stringify({
    seq,
    issued_at: issuedAt,
    public_key: rawPublicKey(privateKey),
    documents: Object.fromEntries(DOCUMENTS.map((n) => [n, Array.isArray(documents[n])
      ? `${documents[n].length} entries`
      : `${Object.keys(documents[n]).length} keys`])),
    artifacts,
  }, null, 2)}\n`);

  process.stderr.write(`signed seq ${seq} over ${DOCUMENTS.length} documents\n`);
  process.stdout.write('changed=true\n');
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
