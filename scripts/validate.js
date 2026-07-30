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

// iplocation.json is generated (scripts/build-iplocation.js), not hand-edited, but the same
// contract holds: a malformed artifact would be rejected by every node's reader. These checks
// mirror ZelBack/src/services/appPlacement/ipLocationTable.js — keep them in step.
(() => {
  const file = 'iplocation.json';
  let artifact;
  try {
    artifact = JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
  } catch (error) {
    problems.push(`${file}: not readable as JSON — ${error.message}`);
    return;
  }
  if (artifact.format !== 1) {
    problems.push(`${file}: unsupported format ${artifact.format}`);
    return;
  }
  if (!isStringArray(artifact.countries) || !isStringArray(artifact.orgs) || !isStringArray(artifact.regions)
    || !Array.isArray(artifact.v4) || !Array.isArray(artifact.v6)
    || typeof artifact.continents !== 'object' || artifact.continents === null) {
    problems.push(`${file}: missing or malformed sections`);
    return;
  }
  const badCountry = artifact.countries.find((cc) => !/^[A-Z]{2}$/.test(cc));
  if (badCountry) problems.push(`${file}: invalid country code ${JSON.stringify(badCountry)}`);
  const badContinent = Object.entries(artifact.continents)
    .find(([cc, cont]) => !artifact.countries.includes(cc) || !/^(AF|AN|AS|EU|NA|OC|SA)$/.test(cont));
  if (badContinent) problems.push(`${file}: invalid continents entry ${JSON.stringify(badContinent)}`);

  const checkRows = (rows, version, toValue) => {
    let previousEnd = null;
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      if (!Array.isArray(row) || row.length < 4 || row.length > 5) {
        problems.push(`${file}: malformed v${version} row ${i}`);
        return;
      }
      const start = toValue(row[0]);
      const end = toValue(row[1]);
      if (start === null || end === null || end < start || (previousEnd !== null && start <= previousEnd)) {
        problems.push(`${file}: v${version} rows invalid, unsorted or overlapping at row ${i}`);
        return;
      }
      previousEnd = end;
      const [, , org, cc] = row;
      const region = row.length === 5 ? row[4] : null;
      if ((org !== null && !(Number.isInteger(org) && org >= 0 && org < artifact.orgs.length))
        || (cc !== null && !(Number.isInteger(cc) && cc >= 0 && cc < artifact.countries.length))
        || (region !== null && !(Number.isInteger(region) && region >= 0 && region < artifact.regions.length))) {
        problems.push(`${file}: index out of range at v${version} row ${i}`);
        return;
      }
    }
  };
  checkRows(artifact.v4, 4, (v) => (Number.isInteger(v) && v >= 0 && v <= 0xFFFFFFFF ? v : null));
  checkRows(artifact.v6, 6, (v) => {
    if (typeof v !== 'string') return null;
    const halves = v.split('::');
    if (halves.length > 2) return null;
    const head = halves[0] ? halves[0].split(':') : [];
    const tail = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
    const missing = halves.length > 1 ? 8 - head.length - tail.length : 0;
    if (missing < 0 || (halves.length === 1 && head.length !== 8)) return null;
    let value = 0n;
    for (const group of [...head, ...Array(missing).fill('0'), ...tail]) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      value = (value << 16n) + BigInt(parseInt(group, 16));
    }
    return value;
  });

  console.log(`${file}: ok (${artifact.v4.length} v4 + ${artifact.v6.length} v6 ranges, ${artifact.countries.length} countries, ${artifact.orgs.length} orgs, generated ${artifact.generated})`);
})();

if (problems.length) {
  console.error('\nPolicy validation failed:');
  problems.forEach((problem) => console.error(`  - ${problem}`));
  process.exit(1);
}

console.log('\nAll policy documents valid.');
