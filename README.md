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
| `enterprisenodes.json` | which app owners may install on which enterprise nodes | object of node pubkey → array of owner addresses |
| `tamperingblockednodes.json` | collateral txhashes DOSed for tampering, above the score threshold | array of strings |
| `iplocation.json` | the IP → (organisation, country) table placement uses to count fault domains | generated artifact, see below |

Entries in `blockedrepositories.json` are matched against an image reference with its tag or digest
stripped, and also against the namespace, so `someorg` blocks everything under that organisation
while `someorg/someimage` blocks only that repository. Owner addresses and 64-character app hashes
go in the same flat array.

There is no image whitelist here. `RunOnFlux/flux` still carries a `helpers/repositories.json`, but
nothing has enforced it since the method that read it was written without a caller in July 2024, and
the file has not been edited since September 2024. It is not part of this repo and should not be
added back without the enforcement to go with it.

## How nodes read them

FluxOS fetches each document on its own schedule (6 hours for blocked repositories and enterprise
nodes, 12 hours for the tampering blocklist), validates its shape, and
keeps the last valid copy it obtained. A node that cannot reach this repo keeps enforcing what it
last read — indefinitely, and across restarts — rather than falling open. Each release also ships a
copy of these files as a cold-start floor for a node that has never successfully fetched.

Two consequences worth holding on to:

- **An empty document is a real answer and an unreachable one is not.** `[]` means nothing is
  listed. A node that cannot read a document does not treat it as empty; it keeps its previous copy,
  and if it has never had one it declines to answer rather than guessing.
- **Removing an entry takes effect on a node's next successful fetch**, so unblocking is not
  instant. Adding one is subject to the same delay.

## The IP location table

`iplocation.json` is different from the other documents: it is **generated, never hand-edited**.
FluxOS uses it to answer one question locally on every node: *how many distinct fault domains does
an app's eligible candidate set span?* — which is what turns the synced-app placement rule from a
blind veto into arithmetic (an app pinned to a one-provider country converges instead of sticking
below its instance count forever).

Regenerate it with:

```
node scripts/build-iplocation.js
```

The build layers three sources, most-authoritative-last:

1. **The five RIRs' delegated-extended files** — every allocated range's boundaries, holder
   country, and registry-scoped organisation id. Public registry data, downloaded fresh, covering
   all allocated address space.
2. **RDAP object country** — queried only for ranges whose delegated country disagrees with what
   the Flux nodes inside them self-report (hosting providers registered under a
   different-country LIR: Hetzner's Finnish ranges are delegated DE, their database object says FI).
3. **RFC 8805 geofeeds**, discovered per RFC 9632 from the RDAP responses — operator-published
   per-prefix country and ISO 3166-2 region, applied to the subranges they cover.

The build then joins the result against the live fleet's self-reported geolocation and writes
`scripts/iplocation-build-report.json` with agreement numbers, the corrections applied, and every
remaining disagreement. Read the report before merging a regeneration; agreement below the
previous build's is a regression, not drift.

The artifact is self-describing (`format`, `generated`, per-registry source serials). A node that
cannot resolve an address in the table falls back to /16 arithmetic, which errs toward refusing
placement — the failure mode is the pre-table status quo, never over-concentration.

Two deliberate compactions, both revisitable: the artifact carries **IPv4 only** (no Flux node has
an IPv6 address; a v6 lookup falls back strict; reinstate the `v6` section when v6 nodes can
exist), and organisation identity is a **12-hex-char token** of the registry-scoped org id —
nothing reads the id's content, distinctness is all that placement needs. Adjacent ranges of the
same organisation, country and region are merged; org-less ranges keep their registry boundaries
because for them the boundary is the fault domain.

## Changing policy

Open a PR. `main` refuses direct pushes, including from admins, because the `validate` check has to
pass first and it cannot run against a commit that has not been pushed anywhere.

No reviewer is required — merge your own PR once CI is green, which takes about fifteen seconds.
That is deliberate: the moment you most need to change policy is during an incident, and a rule
requiring a second person is one that gets bypassed at 3am. A rule one person can satisfy alone
does not.

The check is the point of the rule, not the PR. A document that fails validation is ignored by every
node on the network, which for `enterprisenodes.json` means no owner can install on any enterprise
node — so the one mistake worth preventing here is a shape error, which four trusted people can make
as easily as anyone.

There is deliberately no review requirement. Write access here is already limited to the org owners
— narrower than the application repo this was split out of — and everyone who has it is an admin, so
a review rule among them would be a convention rather than a control. The protection that mattered
was the split itself: a merge to `RunOnFlux/flux` can no longer change what the fleet enforces as a
side effect of unrelated work, which is exactly how a tidy-up commit once removed a policy document
from under the whole network.

**While the migration is in progress, changes must also be applied to `RunOnFlux/flux` under
`helpers/`.** Nodes on releases predating the switch still read from there, and they are most of the
fleet. CI will fail the PR if the two diverge. This requirement goes away once
`minimumFluxOSAllowedVersion` is above every release that reads the old location.

## What is not here

These documents are served over plain HTTPS and are not signed. Their authenticity rests on GitHub
and on who can merge to this repo — which is why the ownership rules matter, and why moving to
signed documents with a rollback-resistant sequence number is the intended next step rather than a
finished one.
