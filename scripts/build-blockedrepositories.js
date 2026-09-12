#!/usr/bin/env node
'use strict';

// Writes blockedrepositories.json from blocklist.json.
//
// blocklist.json is the source. blockedrepositories.json is an artifact of it,
// kept because every release before kinds fetches that name and would otherwise
// stop enforcing anything the moment the source moved. It is not hand-edited;
// validate.js fails when it drifts from what this script would write.
//
// The projection is lossy on purpose - see PROJECTED_KINDS in blocklist.js for
// what a reader without kinds cannot be given.

const fs = require('fs');
const path = require('path');

const { projectToRepositories } = require('./blocklist');

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'blocklist.json');
const ARTIFACT = path.join(ROOT, 'blockedrepositories.json');

const entries = JSON.parse(fs.readFileSync(SOURCE, 'utf8'));
const projected = projectToRepositories(entries);
const rendered = `${JSON.stringify(projected, null, 2)}\n`;

const before = fs.existsSync(ARTIFACT) ? fs.readFileSync(ARTIFACT, 'utf8') : null;
fs.writeFileSync(ARTIFACT, rendered);

if (before === rendered) {
  process.stdout.write(`blockedrepositories.json: unchanged (${projected.length} entries)\n`);
} else {
  const was = before === null ? 'created' : 'rewritten';
  process.stdout.write(`blockedrepositories.json: ${was} (${projected.length} entries from ${entries.length})\n`);
}
