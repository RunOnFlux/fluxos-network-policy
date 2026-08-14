#!/usr/bin/env node
'use strict';

// Signs the list of known-good FluxOS tree hashes that fluxbench checks a node against.
//
// fluxbench gates a node's confirmation signature on that list. Until now it was an unsigned array
// fetched over TLS validated against the system CA store, and it passed unconditionally when it
// could not be downloaded at all -- so a root operator could blackhole the sources, or add a CA and
// serve their own list, and have any directory accepted. Signing it, and having fluxbench verify
// against compiled-in public keys, makes the transport and the courier irrelevant.
//
// The payload is signed and transmitted as exact bytes, base64-encoded, so verification never
// depends on the two sides agreeing about JSON key order, whitespace or number formatting. That
// agreement is the kind that holds in testing and fails in production.

const crypto = require('crypto');
const fs = require('fs');

// A raw 32-byte Ed25519 seed is not directly importable; Node wants PKCS8. The prefix is fixed for
// the algorithm, so prepending it is enough.
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

// The raw 32 bytes fluxbench pins, rather than any DER wrapping around them.
function rawPublicKey(privateKey) {
  const spki = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  return spki.subarray(SPKI_ED25519_PREFIX_LENGTH);
}

// The sequence is inside the signed bytes, not alongside them. Without it an old, validly-signed
// list could be replayed to re-bless a tree hash that had been pulled for being vulnerable.
function buildSignedDocument(seq, hashes, privateKey) {
  if (!Number.isInteger(seq) || seq < 1) {
    throw new Error('seq must be a positive integer');
  }
  if (!Array.isArray(hashes) || hashes.length === 0) {
    throw new Error('hashes must be a non-empty array');
  }
  if (!hashes.every((h) => typeof h === 'string' && /^[0-9a-f]{32}$/.test(h))) {
    throw new Error('every hash must be a lowercase 32-character md5');
  }

  const payload = Buffer.from(JSON.stringify({ seq, hashes }), 'utf8');
  const signature = crypto.sign(null, payload, privateKey);

  return {
    payload_b64: payload.toString('base64'),
    sig_b64: signature.toString('base64'),
  };
}

function main(argv) {
  const args = new Map();
  for (let i = 0; i < argv.length; i += 2) args.set(argv[i].replace(/^--/, ''), argv[i + 1]);

  const seedB64 = process.env.HASHLIST_SIGNING_SEED_B64;
  if (!seedB64) {
    throw new Error('HASHLIST_SIGNING_SEED_B64 is not set');
  }

  const hashes = JSON.parse(fs.readFileSync(args.get('hashes'), 'utf8'));
  const seq = Number(args.get('seq'));
  const privateKey = privateKeyFromSeed(seedB64);
  const document = buildSignedDocument(seq, hashes, privateKey);

  fs.writeFileSync(args.get('out'), `${JSON.stringify(document, null, 2)}\n`);
  process.stderr.write(`signed seq ${seq} over ${hashes.length} hashes\n`);
  process.stderr.write(`public key (raw, hex): ${rawPublicKey(privateKey).toString('hex')}\n`);
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`sign-hashlist: ${error.message}\n`);
    process.exit(1);
  }
}

module.exports = { privateKeyFromSeed, rawPublicKey, buildSignedDocument };
