#!/usr/bin/env node
'use strict';

// Shape-checks every policy document. A malformed document is rejected by every node on the
// network, and for enterprisenodes.json that means no owner can install on any enterprise
// node — so it must never merge.
//
// The checks mirror the validators in FluxOS's policyStore. Keep them in step: a document this
// script accepts but a node rejects would be silently ignored by the whole fleet.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const overrides = require('./overrides');

const ROOT = path.join(__dirname, '..');

// A structurally valid but truncated generation must not publish: every node would
// take it and silently under-resolve, discovered only from an absence of updates.
// The real table holds ~2M rows, ~250 countries, ~100k orgs and ~2.5k regions;
// these floors are far below any legitimate build and far above any broken one.
const FLOORS = {
  rows: 1500000, countries: 150, orgs: 50000, regions: 1000,
};

const MAX_IPV4 = 4294967295;

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
  { file: 'vettedrepositories.json', check: isStringArray, shape: 'an array of strings' },
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

// iplocation.bin.gz is generated (scripts/build-iplocation.js), not hand-edited, but the same
// contract holds: a malformed artifact would be rejected by every node's reader, which then keeps
// the table it already had. These checks mirror the reader-validation section of
// GEO_TABLE_BASELINE_FORMAT.md and FluxOS's ipLocationTable — keep them in step.
//
// Format 2: gzipped `FLXGEO` + version + u32 header length + header JSON + u32 row count +
// rows of five unsigned LEB128 varints (gap, len, org + 1, cc + 1, region + 1).
(() => {
  const file = 'iplocation.bin.gz';
  let buffer;
  try {
    buffer = zlib.gunzipSync(fs.readFileSync(path.join(ROOT, file)));
  } catch (error) {
    problems.push(`${file}: not readable as gzip — ${error.message}`);
    return;
  }

  if (buffer.length < 15 || buffer.subarray(0, 6).toString('latin1') !== 'FLXGEO') {
    problems.push(`${file}: not a FLXGEO container`);
    return;
  }
  if (buffer[6] !== 2) {
    problems.push(`${file}: unsupported format ${buffer[6]}`);
    return;
  }

  const headerLength = buffer.readUInt32LE(7);
  if (11 + headerLength + 4 > buffer.length) {
    problems.push(`${file}: header length ${headerLength} runs past the end of the artifact`);
    return;
  }
  let header;
  try {
    header = JSON.parse(buffer.subarray(11, 11 + headerLength).toString('utf8'));
  } catch (error) {
    problems.push(`${file}: header is not valid JSON — ${error.message}`);
    return;
  }
  if (!isStringArray(header.countries) || !isStringArray(header.orgs) || !isStringArray(header.regions)
    || typeof header.continents !== 'object' || header.continents === null || Array.isArray(header.continents)
    || typeof header.generated !== 'string' || typeof header.sources !== 'object' || header.sources === null) {
    problems.push(`${file}: missing or malformed header sections`);
    return;
  }

  const badCountry = header.countries.find((cc) => !/^[A-Z]{2}$/.test(cc));
  if (badCountry) problems.push(`${file}: invalid country code ${JSON.stringify(badCountry)}`);
  const badRegion = header.regions.find((region) => !/^[A-Z]{2}-[A-Z0-9]{1,3}$/.test(region));
  if (badRegion) problems.push(`${file}: invalid region code ${JSON.stringify(badRegion)}`);
  const badOrg = header.orgs.find((org) => !/^[0-9a-f]{12}$/.test(org));
  if (badOrg) problems.push(`${file}: invalid organisation token ${JSON.stringify(badOrg)}`);
  const badContinent = Object.entries(header.continents)
    .find(([cc, continent]) => !header.countries.includes(cc) || !/^(AF|AN|AS|EU|NA|OC|SA)$/.test(continent));
  if (badContinent) problems.push(`${file}: invalid continents entry ${JSON.stringify(badContinent)}`);

  // The region-name vocabulary is optional: a baseline built before it existed
  // carries none, and a node without it answers a named region at country
  // granularity, which is the safe direction. Present, it must be well formed -
  // a key naming a country the artifact does not carry could never resolve, and
  // a value that is not a region code would resolve to nothing.
  if (header.regionNames !== undefined) {
    if (typeof header.regionNames !== 'object' || header.regionNames === null || Array.isArray(header.regionNames)) {
      problems.push(`${file}: header regionNames is not an object`);
    } else {
      const carried = new Set(header.countries);
      const badEntry = Object.entries(header.regionNames).find(([key, code]) => {
        const [cc, ...rest] = key.split('|');
        return !carried.has(cc) || rest.join('|').length === 0
          || typeof code !== 'string' || !/^[A-Z]{2}-[A-Z0-9]{1,3}$/.test(code)
          || code.slice(0, 2) !== cc;
      });
      if (badEntry) problems.push(`${file}: invalid regionNames entry ${JSON.stringify(badEntry)}`);
    }
  }

  // Index identity is positional: a duplicate would make two indices name the same domain and
  // silently merge or split fault domains on every node.
  ['countries', 'orgs', 'regions'].forEach((section) => {
    if (new Set(header[section]).size !== header[section].length) {
      problems.push(`${file}: duplicate entries in header ${section}`);
    }
  });

  if (header.countries.length < FLOORS.countries) problems.push(`${file}: only ${header.countries.length} countries — truncated generation`);
  if (header.orgs.length < FLOORS.orgs) problems.push(`${file}: only ${header.orgs.length} orgs — truncated generation`);
  if (header.regions.length < FLOORS.regions) problems.push(`${file}: only ${header.regions.length} regions — truncated generation`);

  const rowCount = buffer.readUInt32LE(11 + headerLength);
  let cursor = 15 + headerLength;
  const readVarint = () => {
    let value = 0;
    let scale = 1;
    for (;;) {
      if (cursor >= buffer.length) throw new Error('varint runs past the end of the artifact');
      const byte = buffer[cursor];
      cursor += 1;
      value += (byte & 0x7f) * scale;
      if ((byte & 0x80) === 0) return value;
      scale *= 128;
      if (scale > 2 ** 35) throw new Error('varint too long');
    }
  };

  let previousEnd = -1;
  try {
    for (let i = 0; i < rowCount; i += 1) {
      // Rows are sorted and non-overlapping by construction: start is derived from the previous
      // end plus a gap that cannot be negative. Only the upper bound needs checking.
      const start = previousEnd + 1 + readVarint();
      const end = start + readVarint();
      const org = readVarint();
      const cc = readVarint();
      const region = readVarint();
      if (end > MAX_IPV4) throw new Error(`row ${i} ends past the IPv4 space`);
      if (org > header.orgs.length) throw new Error(`row ${i} organisation index ${org - 1} out of range`);
      if (cc > header.countries.length) throw new Error(`row ${i} country index ${cc - 1} out of range`);
      if (region > header.regions.length) throw new Error(`row ${i} region index ${region - 1} out of range`);
      previousEnd = end;
    }
    if (cursor !== buffer.length) {
      throw new Error(`${buffer.length - cursor} bytes after the last of ${rowCount} rows`);
    }
  } catch (error) {
    problems.push(`${file}: ${error.message}`);
    return;
  }

  if (rowCount < FLOORS.rows) problems.push(`${file}: only ${rowCount} rows — truncated or empty generation`);

  console.log(`${file}: ok (${rowCount} rows, ${header.countries.length} countries, ${header.orgs.length} orgs, ${header.regions.length} regions, generated ${header.generated})`);
})();

// data/iplocation-overrides.json is the one hand-edited input to the artifact:
// the corrections the build applies where the vendor's attribution of a block is
// wrong and the fleet inside it says so. It is checked through the same loader the
// build uses, so a bad entry fails the PR rather than the monthly build.
(() => {
  const file = 'data/iplocation-overrides.json';
  const ledger = overrides.load(path.join(ROOT, file));
  if (ledger.problems.length) {
    ledger.problems.forEach((problem) => problems.push(`${file}: ${problem}`));
    return;
  }
  console.log(`${file}: ok (${ledger.entries.length} ${ledger.entries.length === 1 ? 'entry' : 'entries'})`);

  // The build marks an entry no-op when the rows it covers already carry its
  // values: the vendor has caught up and the correction now corrects nothing.
  // Retiring it is a person's edit, so this is a notice and never a failure - a
  // stale entry is inert, and failing CI on one would block unrelated policy
  // changes until somebody tidied up.
  let report;
  try {
    report = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/iplocation-build-report.json'), 'utf8'));
  } catch {
    return;
  }
  (report.overrides?.entries ?? []).filter((entry) => entry.noop).forEach((entry) => {
    const claim = `${entry.country ?? 'country unchanged'} / ${entry.region ?? 'no region'}`;
    const why = entry.rowsTouched === 0
      ? 'no table row covers the range — check it for a typo'
      : 'the table already carries its values — the vendor has caught up';
    console.log(`WARNING ${file}: ${entry.range} (${claim}, added ${entry.added}) is retirable: ${why}; delete the entry`);
  });
})();

if (problems.length) {
  console.error('\nPolicy validation failed:');
  problems.forEach((problem) => console.error(`  - ${problem}`));
  process.exit(1);
}

console.log('\nAll policy documents valid.');
