'use strict';

// data/orgclass-overrides.json - the ledger of hand-entered corrections the
// build applies to the derived network-class verdicts before it writes them.
//
// It exists because the derived verdict is a vote. An organisation is decided by
// MAJORITY_SHARE of its decidable hosts agreeing, over a floor of
// MIN_DECIDABLE_FOR_MAJORITY, so two populations are guaranteed to need a human:
// the minority tail of a mixed organisation, which the vote is designed to
// outvote, and any allocation with too few fleet hosts to hold a vote at all.
// Neither is a classifier that can be improved by gathering more of the same
// evidence.
//
// It matters more than the location ledger does. A wrong country moves an app;
// a wrong class decides whether FluxOS drains a node's apps and DOSes it, and
// there is nothing node-side that will decline it - the node consults this
// table and acts on what it says.
//
// KEYED BY CIDR RANGE, NEVER BY ORGANISATION. The organisation tokens in the
// artifact are opaque and are reissued on every publication, so an override
// keyed to one would match today and silently stop matching after the next
// build - failing in the direction of not correcting something a person
// examined and decided was wrong.
//
// This module is the single definition of what an entry may say. Both the build
// and scripts/validate.js load through it, so a rule cannot hold in one and not
// the other.
//
// Entry shape:
//   {
//     "range": "203.0.113.0/24",    IPv4 CIDR, on its own boundary
//     "class": "residential",       "residential" | "datacenter" | "none"
//     "evidence": "why, with its source",
//     "added": "2026-08-20"
//   }
//
// `none` withdraws a verdict rather than asserting one, and is the reason this
// file can act faster than the evidence can be rebuilt: a range published as a
// class we no longer stand behind goes back to unclassified, which enforces
// nothing, without waiting for a gather to change its mind.

const fs = require('fs');

const orgclasses = require('./orgclasses');
const overrides = require('./overrides');

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const FIELDS = new Set(['range', 'class', 'evidence', 'added']);
// The classes a verdict may be set to, plus the withdrawal.
const VALUES = [...orgclasses.CLASSES, 'none'];

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read and check the class-override ledger.
 *
 * Returns { entries, problems }. Callers decide what a problem costs: the build
 * refuses to write a ledger, validate.js fails the PR. Entries come back in file
 * order with integer `start`/`end`.
 * @param {string} file Path to the JSON ledger.
 * @returns {{entries: object[], problems: string[]}} Parsed entries and problems.
 */
function load(file) {
  const problems = [];
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { entries: [], problems: [] };
    return { entries: [], problems: [`not readable as JSON — ${error.message}`] };
  }
  if (!Array.isArray(parsed)) return { entries: [], problems: ['must be an array of override entries'] };

  const entries = [];
  parsed.forEach((entry, index) => {
    const at = `entry ${index}`;
    if (!isPlainObject(entry)) { problems.push(`${at}: must be an object`); return; }

    const unknown = Object.keys(entry).filter((key) => !FIELDS.has(key));
    if (unknown.length) problems.push(`${at}: unknown field(s) ${unknown.join(', ')}`);

    const bounds = overrides.parseCidr(entry.range);
    if (!bounds) problems.push(`${at}: range ${JSON.stringify(entry.range)} is not an IPv4 CIDR on its own boundary`);
    const where = bounds ? entry.range : at;

    if (!VALUES.includes(entry.class)) {
      problems.push(`${where}: class must be one of ${VALUES.join(', ')}`);
    }
    if (typeof entry.evidence !== 'string' || !entry.evidence.trim()) {
      problems.push(`${where}: evidence is required — say what was examined and what it showed, with its source`);
    }
    if (typeof entry.added !== 'string' || !ISO_DATE.test(entry.added) || Number.isNaN(Date.parse(entry.added))) {
      problems.push(`${where}: added must be an ISO date, e.g. "2026-08-20"`);
    }

    if (!bounds) return;
    entries.push({
      range: entry.range,
      class: entry.class,
      evidence: entry.evidence,
      added: entry.added,
      start: bounds.start,
      end: bounds.end,
    });
  });

  // Sorted and non-overlapping, for the same reason the location ledger is: two
  // entries covering one address would make the verdict depend on file order
  // rather than on what a person wrote.
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

module.exports = { load, VALUES };
