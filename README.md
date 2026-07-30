# fluxos-network-policy

The documents the Flux network enforces at runtime. Every FluxOS node fetches these directly and
applies them without a release, so **a merge here changes the behaviour of the whole fleet
immediately**. There is no staged rollout and no canary.

This repo contains policy and nothing else. No application code lives here, which is the point: it
used to live in `RunOnFlux/flux` under `helpers/`, where any merge touching those files was a fleet
policy change as a side effect, and where changing policy meant committing to the application's
default branch.

## The documents

| file | governs | shape |
|---|---|---|
| `blockedrepositories.json` | images, app owners and app hashes that may not run anywhere | array of strings |
| `repositories.json` | the image whitelist — only these may be deployed | array of strings |
| `enterprisenodes.json` | which app owners may install on which enterprise nodes | object of node pubkey → array of owner addresses |
| `tamperingblockednodes.json` | collateral txhashes DOSed for tampering, above the score threshold | array of strings |

Entries in `blockedrepositories.json` and `repositories.json` are matched against an image
reference with its tag or digest stripped, and also against the namespace, so `someorg` blocks
everything under that organisation while `someorg/someimage` blocks only that repository. Owner
addresses and 64-character app hashes go in the same flat array.

## How nodes read them

FluxOS fetches each document on its own schedule (10 minutes for the whitelist, 6 hours for blocked
repositories and enterprise nodes, 12 hours for the tampering blocklist), validates its shape, and
keeps the last valid copy it obtained. A node that cannot reach this repo keeps enforcing what it
last read — indefinitely, and across restarts — rather than falling open. Each release also ships a
copy of these files as a cold-start floor for a node that has never successfully fetched.

Two consequences worth holding on to:

- **An empty document is a real answer and an unreachable one is not.** `[]` means nothing is
  listed. A node that cannot read a document does not treat it as empty; it keeps its previous copy,
  and if it has never had one it declines to answer rather than guessing.
- **Removing an entry takes effect on a node's next successful fetch**, so unblocking is not
  instant. Adding one is subject to the same delay.

## Changing policy

Open a PR. One approval from the code owners is required and CI must pass. Both are deliberately
light: the moment you most need to push a block is during an incident, and a rule that cannot be
satisfied at 3am is a rule people learn to bypass.

CI checks that every document parses and matches its expected shape. A malformed document would
otherwise be rejected by every node on the network, which for the whitelist means refusing every
image.

**While the migration is in progress, changes must also be applied to `RunOnFlux/flux` under
`helpers/`.** Nodes on releases predating the switch still read from there, and they are most of the
fleet. CI will fail the PR if the two diverge. This requirement goes away once
`minimumFluxOSAllowedVersion` is above every release that reads the old location.

## What is not here

These documents are served over plain HTTPS and are not signed. Their authenticity rests on GitHub
and on who can merge to this repo — which is why the ownership rules matter, and why moving to
signed documents with a rollback-resistant sequence number is the intended next step rather than a
finished one.
