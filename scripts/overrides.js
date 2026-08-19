'use strict';

// data/iplocation-overrides.json - the ledger of hand-entered corrections the
// build applies to the merged location table before it validates and emits it.
//
// It exists because the vendor's attribution is sometimes wrong for a whole
// block, and the fleet says so: a dozen nodes inside one allocation all
// self-reporting a country the table disagrees with is the vendor mis-attributing
// the block, not a dozen nodes lying. Correcting it here means every node fetches
// the corrected table; there is nothing to override node-side.
//
// This module is the single definition of what an entry may say. Both the build
// and scripts/validate.js load through it, so a rule cannot hold in one and not
// the other - the build would otherwise accept an entry the PR check rejects, or
// worse the other way round.
//
// Entry shape:
//   {
//     "range": "203.0.113.0/24",   IPv4 CIDR, on its own boundary
//     "country": "FR",             ISO 3166-1 alpha-2, or absent/null
//     "region": null,              ISO 3166-2, or absent/null
//     "evidence": "why, ideally with a URL",
//     "added": "2026-08-02"
//   }

const fs = require('fs');

const { CONTINENTS } = require('./continents');
const sources = require('./sources');

const COUNTRY = /^[A-Z]{2}$/;
const REGION = /^[A-Z]{2}-[A-Z0-9]{1,3}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const FIELDS = new Set(['range', 'country', 'region', 'evidence', 'added']);

// Hand-rolled, and deliberately strict about the boundary: a prefix with bits set
// below it ("203.0.113.5/24") is a person meaning one address and writing 256, and
// rounding it down silently would widen the correction to addresses nobody looked
// at.
function parseCidr(range) {
  if (typeof range !== 'string') return null;
  const slash = range.indexOf('/');
  if (slash === -1) return null;
  const address = sources.ipv4ToInt(range.slice(0, slash));
  const bits = range.slice(slash + 1);
  if (address === null || !/^(0|[1-9][0-9]?)$/.test(bits)) return null;
  const prefix = Number(bits);
  if (prefix > 32) return null;
  const size = 2 ** (32 - prefix);
  if (address % size !== 0) return null;
  return { start: address, end: address + size - 1 };
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Returns { entries, problems }. Callers decide what a problem costs: the build
// refuses to produce an artifact, validate.js fails the PR. Entries come back in
// file order with integer `start`/`end`, and `country`/`region` normalised to a
// string or null - an absent key and an explicit null say the same thing.
function load(file) {
  const problems = [];
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return { entries: [], problems: [`not readable as JSON — ${error.message}`] };
  }
  if (!Array.isArray(parsed)) return { entries: [], problems: ['must be an array of override entries'] };

  const entries = [];
  parsed.forEach((entry, index) => {
    const at = `entry ${index}`;
    if (!isPlainObject(entry)) { problems.push(`${at}: must be an object`); return; }

    const unknown = Object.keys(entry).filter((key) => !FIELDS.has(key));
    if (unknown.length) problems.push(`${at}: unknown field(s) ${unknown.join(', ')}`);

    const bounds = parseCidr(entry.range);
    if (!bounds) problems.push(`${at}: range ${JSON.stringify(entry.range)} is not an IPv4 CIDR on its own boundary`);
    const where = bounds ? entry.range : at;

    const country = entry.country ?? null;
    const region = entry.region ?? null;
    if (country === null && region === null) {
      problems.push(`${where}: states neither a country nor a region, so it corrects nothing`);
    }
    if (country !== null) {
      if (typeof country !== 'string' || !COUNTRY.test(country)) {
        problems.push(`${where}: country ${JSON.stringify(country)} is not an uppercase ISO 3166-1 alpha-2 code`);
      } else if (!CONTINENTS[country]) {
        problems.push(`${where}: country ${country} has no continent in scripts/continents.js, so the artifact could not place it`);
      }
    }
    if (region !== null) {
      if (typeof region !== 'string' || !REGION.test(region)) {
        problems.push(`${where}: region ${JSON.stringify(region)} is not an ISO 3166-2 code`);
      } else if (typeof country === 'string' && !region.startsWith(`${country}-`)) {
        problems.push(`${where}: region ${region} is not in country ${country}`);
      }
    }
    if (typeof entry.evidence !== 'string' || !entry.evidence.trim()) {
      problems.push(`${where}: evidence is required — say what shows the vendor wrong, ideally with a URL`);
    }
    if (typeof entry.added !== 'string' || !ISO_DATE.test(entry.added) || Number.isNaN(Date.parse(entry.added))) {
      problems.push(`${where}: added must be an ISO date, e.g. "2026-08-02"`);
    }

    // An entry with no usable bounds cannot be placed against the table, so it is
    // left out of the result; its problems are already recorded, and the ordering
    // check below reads better without a hole in the sequence.
    if (!bounds) return;
    entries.push({
      range: entry.range,
      country: typeof country === 'string' ? country : null,
      region: typeof region === 'string' ? region : null,
      evidence: entry.evidence,
      added: entry.added,
      start: bounds.start,
      end: bounds.end,
    });
  });

  // Sorted and non-overlapping: the build applies them in one sweep of the table,
  // and two entries covering the same address would make the correction depend on
  // file order rather than on what a person wrote.
  for (let i = 1; i < entries.length; i += 1) {
    const previous = entries[i - 1];
    const current = entries[i];
    if (current.start < previous.start) {
      problems.push(`${current.range}: out of order — entries are sorted ascending by range start`);
    } else if (current.start <= previous.end) {
      problems.push(`${current.range}: overlaps ${previous.range}`);
    }
  }

  return { entries, problems };
}

module.exports = { load, parseCidr };
