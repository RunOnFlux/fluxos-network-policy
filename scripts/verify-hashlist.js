#!/usr/bin/env node
'use strict';

// Verifies the signed hash list against a pinned public key, the way fluxbench will.
//
// Run immediately after signing, in the same job. A signing key that has been mangled -- pasted with
// a stray newline, truncated, replaced -- produces a document that looks entirely well-formed and
// that no node will ever accept. Checking here turns that into a failed workflow instead of a fleet
// that silently stops confirming as it upgrades.
//
// It deliberately does not use the signing key to check its own work. It uses the published public
// key, which is what fluxbench holds.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

// Must match SIGNING.md and fluxbench's PINNED_HASHLIST_PUBKEYS. Any of them verifying is enough,
// which is how a second key can take over without a fluxbench release.
const PINNED_PUBLIC_KEYS = [
  '911620580c708b80bdb97afc01ec529c5d4655727ec87a277838a1f6b7f123c0',   // 1, CI
  'fee7b0ccf2323954af68a249eaa61f957239eb222329e08a5b6a50ced649bae8',   // 2, cold
];

function verifyDocument(document, publicKeysHex) {
  const payload = Buffer.from(document.payload_b64, 'base64');
  const signature = Buffer.from(document.sig_b64, 'base64');

  if (signature.length !== 64) {
    throw new Error(`signature is ${signature.length} bytes, expected 64`);
  }

  const accepted = publicKeysHex.some((hex) => {
    const key = crypto.createPublicKey({
      key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(hex, 'hex')]),
      format: 'der',
      type: 'spki',
    });
    return crypto.verify(null, payload, key, signature);
  });

  if (!accepted) {
    throw new Error('signature does not verify under any pinned public key');
  }

  return JSON.parse(payload.toString('utf8'));
}

function main(argv) {
  const document = JSON.parse(fs.readFileSync(argv[0] || path.join(__dirname, '..', 'hashlist.json'), 'utf8'));
  const source = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'hashlist-source.json'), 'utf8'));

  const payload = verifyDocument(document, PINNED_PUBLIC_KEYS);

  // The signed bytes must be what we meant to sign, not merely something validly signed.
  if (payload.seq !== source.seq) {
    throw new Error(`signed seq ${payload.seq} does not match source seq ${source.seq}`);
  }
  if (payload.hashes.length !== source.hashes.length) {
    throw new Error(`signed ${payload.hashes.length} hashes, source has ${source.hashes.length}`);
  }

  process.stderr.write(`verified: seq ${payload.seq}, ${payload.hashes.length} hashes\n`);
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`verify-hashlist: ${error.message}\n`);
    process.exit(1);
  }
}

module.exports = { verifyDocument };
