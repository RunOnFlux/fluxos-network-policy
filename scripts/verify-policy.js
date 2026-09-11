#!/usr/bin/env node

// Verifies a signed policy bundle the way a node does, against pinned public keys. Run by
// the signing workflow over what it just wrote, so a bundle that cannot be verified never
// reaches the branch nodes read.
//
// It is also the reference a consumer implementation is checked against: FluxOS and
// fluxbench each have their own verifier, and this is what "the same document" means.
//
// Usage: node scripts/verify-policy.js [path] [--minseq N]

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// A document signed by any pinned key is accepted, so a key can be replaced without every
// consumer needing an update first. Kept in step with SIGNING.md.
const PINNED_PUBLIC_KEYS = (process.env.POLICY_PUBLIC_KEYS || '').split(',').map((k) => k.trim()).filter(Boolean);

const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function publicKeyFromHex(hex) {
  return crypto.createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(hex, 'hex')]),
    format: 'der',
    type: 'spki',
  });
}

function main() {
  const args = process.argv.slice(2);
  const minSeqIndex = args.indexOf('--minseq');
  const minSeq = minSeqIndex >= 0 ? Number(args[minSeqIndex + 1]) : 0;
  // Guarded on minSeqIndex >= 0. Without it, an absent --minseq makes the value index 0 and
  // excludes the first positional argument, so every invocation silently verifies the
  // default file rather than the one named -- which passes a tampered document.
  const valueIndex = minSeqIndex >= 0 ? minSeqIndex + 1 : -1;
  const file = args.find((a, i) => !a.startsWith('--') && i !== valueIndex)
    || path.join(__dirname, '..', 'signed', 'policy-signed.json');

  if (!PINNED_PUBLIC_KEYS.length) {
    throw new Error('POLICY_PUBLIC_KEYS is not set: nothing to verify against');
  }

  const document = JSON.parse(fs.readFileSync(file, 'utf8'));
  const payload = Buffer.from(document.payload_b64, 'base64');
  const signature = Buffer.from(document.sig_b64, 'base64');

  const verified = PINNED_PUBLIC_KEYS.some(
    (hex) => crypto.verify(null, payload, publicKeyFromHex(hex), signature),
  );
  if (!verified) {
    throw new Error('no pinned key verifies this document');
  }

  const inner = JSON.parse(payload.toString('utf8'));
  if (!Number.isInteger(inner.seq) || inner.seq < 1) {
    throw new Error(`seq is not a positive integer: ${inner.seq}`);
  }
  // A source that was asked for something newer and answered with something older has not
  // answered. Refusing here rather than accepting the stale document is what stops a
  // replay being indistinguishable from "there is nothing newer".
  if (minSeq && inner.seq < minSeq) {
    throw new Error(`seq ${inner.seq} is below the requested floor of ${minSeq}`);
  }
  if (typeof inner.issued_at !== 'string' || Number.isNaN(Date.parse(inner.issued_at))) {
    throw new Error('issued_at is not a parseable date');
  }
  if (!inner.documents || typeof inner.documents !== 'object') {
    throw new Error('documents is missing');
  }

  const names = Object.keys(inner.documents);
  process.stdout.write(`verified seq ${inner.seq}, issued ${inner.issued_at}\n`);
  names.forEach((name) => {
    const value = inner.documents[name];
    const size = Array.isArray(value) ? `${value.length} entries` : `${Object.keys(value).length} keys`;
    process.stdout.write(`  ${name}: ${size}\n`);
  });
  Object.entries(inner.artifacts || {}).forEach(([name, meta]) => {
    process.stdout.write(`  ${name}: sha256 ${meta.sha256.slice(0, 16)}… (${meta.bytes} bytes)\n`);
  });
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
