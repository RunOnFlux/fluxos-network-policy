#!/usr/bin/env node
'use strict';

// Adds a FluxOS tree hash to the source list and advances the sequence.
//
// Called by the signing workflow when RunOnFlux/flux CI reports a newly built tree, so the list
// tracks every tree the official CI has produced -- the same population fluxhashes holds today,
// which is what makes a node running an official branch still able to confirm.
//
// Adding a hash always advances the sequence, because fluxbench refuses a document whose sequence
// is below the highest it has already accepted. A new hash published under an unchanged sequence
// would be indistinguishable from a replay of the older document.

const fs = require('fs');
const path = require('path');

const SOURCE = path.join(__dirname, '..', 'data', 'hashlist-source.json');

function addHash(source, hash) {
  if (!/^[0-9a-f]{32}$/.test(hash)) {
    throw new Error(`not a lowercase md5: ${hash}`);
  }

  // Idempotent: CI reports a hash on every push, and pushes that do not change ./ZelBack report one
  // that is already listed. Re-signing an unchanged list would burn a sequence for nothing.
  if (source.hashes.includes(hash)) {
    return { source, changed: false };
  }

  return {
    source: { seq: source.seq + 1, hashes: source.hashes.concat([hash]) },
    changed: true,
  };
}

function main(argv) {
  const hash = argv[0];
  if (!hash) {
    throw new Error('usage: update-hashlist.js <md5>');
  }

  const before = JSON.parse(fs.readFileSync(SOURCE, 'utf8'));
  const { source, changed } = addHash(before, hash);

  if (!changed) {
    process.stderr.write(`already listed, nothing to do: ${hash}\n`);
    process.stdout.write('changed=false\n');
    return;
  }

  fs.writeFileSync(SOURCE, `${JSON.stringify(source, null, 2)}\n`);
  process.stderr.write(`added ${hash}, seq ${before.seq} -> ${source.seq}, ${source.hashes.length} hashes\n`);
  process.stdout.write('changed=true\n');
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`update-hashlist: ${error.message}\n`);
    process.exit(1);
  }
}

module.exports = { addHash };
