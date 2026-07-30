#!/usr/bin/env node
'use strict';

// Shape-checks every policy document. A malformed document is rejected by every node on the
// network, and for the whitelist that means refusing every image — so it must never merge.
//
// The checks mirror the validators in FluxOS's policyStore. Keep them in step: a document this
// script accepts but a node rejects would be silently ignored by the whole fleet.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function isStringArray(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isNodeOwnerMap(value) {
  const isPlainObject = typeof value === 'object' && value !== null && !Array.isArray(value);
  if (!isPlainObject) return false;
  return Object.values(value).every(
    (owners) => Array.isArray(owners) && owners.every((owner) => typeof owner === 'string'),
  );
}

const DOCUMENTS = [
  { file: 'blockedrepositories.json', check: isStringArray, shape: 'an array of strings' },
  { file: 'repositories.json', check: isStringArray, shape: 'an array of strings' },
  { file: 'tamperingblockednodes.json', check: isStringArray, shape: 'an array of strings' },
  { file: 'enterprisenodes.json', check: isNodeOwnerMap, shape: 'an object of pubkey -> array of owner strings' },
];

const problems = [];

DOCUMENTS.forEach(({ file, check, shape }) => {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
  } catch (error) {
    problems.push(`${file}: not readable as JSON — ${error.message}`);
    return;
  }

  if (!check(parsed)) {
    problems.push(`${file}: must be ${shape}`);
    return;
  }

  // Duplicates are harmless to a node but always a mistake, and they hide the case where someone
  // meant to edit an entry and added a second one instead.
  const entries = Array.isArray(parsed) ? parsed : Object.keys(parsed);
  const duplicates = entries.filter((entry, index) => entries.indexOf(entry) !== index);
  if (duplicates.length) {
    problems.push(`${file}: duplicate entries — ${[...new Set(duplicates)].join(', ')}`);
  }

  // Whitespace at the edges never matches anything, because nodes compare against a parsed image
  // reference. An entry with a stray space is silently inert, which is the worst way to fail.
  const padded = entries.filter((entry) => entry !== entry.trim());
  if (padded.length) {
    problems.push(`${file}: entries with leading/trailing whitespace — ${padded.map((e) => JSON.stringify(e)).join(', ')}`);
  }

  console.log(`${file}: ok (${entries.length} ${Array.isArray(parsed) ? 'entries' : 'nodes'})`);
});

if (problems.length) {
  console.error('\nPolicy validation failed:');
  problems.forEach((problem) => console.error(`  - ${problem}`));
  process.exit(1);
}

console.log('\nAll policy documents valid.');
