#!/usr/bin/env node
'use strict';

// Regenerates the interop vector that fluxbench's verifier is tested against.
//
// The signing runs here in Node and the verifying runs in C++ inside fluxbench, written months
// apart. There are several ways for the two to disagree while each looks correct alone: one signs
// the JSON and the other the base64, one includes a trailing newline, one pins the raw key bytes
// and the other a DER wrapping. Every one of those produces a signer that works, a verifier that
// works, and a network where no signature ever validates -- discovered on the canary, with the
// fail-open already deleted.
//
// So the two sides share a fixed example instead of a shared assumption. Ed25519 is deterministic
// (RFC 8032), so re-running this reproduces the same bytes; a diff here means someone changed the
// contract.
//
// The key below is a TEST key. It is committed on purpose, because a vector nobody can regenerate
// is a snapshot rather than a check. It signs nothing the network trusts.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { privateKeyFromSeed, rawPublicKey, buildSignedDocument } = require('./sign-hashlist');

const VECTORS = path.join(__dirname, '..', 'test', 'vectors');

// Derived from a fixed phrase so the key is reproducible and obviously not a production secret.
const TEST_SEED = crypto.createHash('sha256')
  .update('fluxos-hashlist-interop-vector-test-key-not-for-production')
  .digest();

// A real tree hash: FluxOS v8.17.1, as published. Using a real one means the vector also documents
// the shape of what gets signed, rather than a placeholder that could hide a length assumption.
const HASHES = ['8ad927518ce5f37406aed39700134082'];
const SEQ = 1;

function main() {
  const seedB64 = TEST_SEED.toString('base64');
  const privateKey = privateKeyFromSeed(seedB64);
  const publicHex = rawPublicKey(privateKey).toString('hex');
  const document = buildSignedDocument(SEQ, HASHES, privateKey);

  fs.writeFileSync(path.join(VECTORS, 'hashlist-key.json'), `${JSON.stringify({
    note: 'TEST KEY. Committed so the vector can be regenerated. Signs nothing the network trusts.',
    derivation: "sha256('fluxos-hashlist-interop-vector-test-key-not-for-production')",
    seed_b64: seedB64,
    public_key_hex: publicHex,
  }, null, 2)}\n`);

  fs.writeFileSync(path.join(VECTORS, 'hashlist.json'), `${JSON.stringify(document, null, 2)}\n`);

  process.stderr.write(`vector written: seq ${SEQ}, ${HASHES.length} hash(es)\n`);
  process.stderr.write(`public key (raw, hex): ${publicHex}\n`);
}

if (require.main === module) main();
