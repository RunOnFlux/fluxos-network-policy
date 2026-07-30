#!/usr/bin/env node
'use strict';

// Most of the fleet still reads these documents from RunOnFlux/flux under helpers/, because their
// release predates the switch to this repo. Until the version floor is above every such release,
// a change here has to be applied there too, or the nodes that matter never see it.
//
// This compares the two and fails on divergence, so a forgotten second commit is a red check
// rather than a policy change that quietly reached almost nobody. It reads the public repo
// anonymously — there is no token here, and nothing writes to the application repo.
//
// Delete this check, and the dual-write requirement in the README, once the floor has moved.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const UPSTREAM = 'https://raw.githubusercontent.com/RunOnFlux/flux/master/helpers';

const DOCUMENTS = [
  'blockedrepositories.json',
  'repositories.json',
  'tamperingblockednodes.json',
  'enterprisenodes.json',
];

// Compared as parsed JSON, not as text: formatting differences between the two copies are
// irrelevant to a node, and failing on them would train people to ignore this check.
async function upstreamCopy(file) {
  const response = await fetch(`${UPSTREAM}/${file}`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function main() {
  const diverged = [];
  const unreadable = [];

  for (const file of DOCUMENTS) {
    const ours = JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
    let theirs;
    try {
      // eslint-disable-next-line no-await-in-loop
      theirs = await upstreamCopy(file);
    } catch (error) {
      unreadable.push(`${file}: ${error.message}`);
      continue;
    }

    if (JSON.stringify(ours) === JSON.stringify(theirs)) {
      console.log(`${file}: in step with RunOnFlux/flux`);
    } else {
      diverged.push(file);
    }
  }

  if (unreadable.length) {
    // A github blip must not block a policy change; the check is a reminder, not a gate on
    // availability. Divergence we can actually see is still failed below.
    console.warn('\nCould not read some upstream copies (not failing on this):');
    unreadable.forEach((entry) => console.warn(`  - ${entry}`));
  }

  if (diverged.length) {
    console.error('\nThese documents differ from RunOnFlux/flux helpers/:');
    diverged.forEach((file) => console.error(`  - ${file}`));
    console.error('\nApply the same change there. Nodes on releases predating the switch to this');
    console.error('repo read the old location, and they are most of the fleet.');
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
