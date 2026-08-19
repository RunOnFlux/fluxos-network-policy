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
| `vettedrepositories.json` | owners, app hashes and repos whose apps bypass user-level blocks | array of strings |
| `iplocation.bin.gz` | the IP → (organisation, country, region) table placement uses to count fault domains | generated binary artifact, see below |

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

`iplocation.bin.gz` is different from the other documents: it is **generated, never hand-edited**,
and it is binary. FluxOS uses it to answer one question locally on every node: *how many distinct
fault domains does an app's eligible candidate set span?* — which is what turns the synced-app
placement rule from a blind veto into arithmetic (an app pinned to a one-provider country converges
instead of sticking below its instance count forever).

The wire format is **format 2**, specified in fluxModels
`workstreams/placement-and-election/GEO_TABLE_BASELINE_FORMAT.md`: a gzipped `FLXGEO` container
holding a JSON header (generation timestamp, source serials, and the country, continent,
organisation and region tables) followed by varint-encoded rows of
(gap, length, organisation, country, region). About 2.0M rows and 4.6 MB on the wire. The publisher
here and the reader in FluxOS implement exactly that document; change neither alone.

Regenerate it with:

```
node scripts/build-iplocation.js
```

The build has two sources, each authoritative for what it knows:

1. **The five RIRs' delegated-extended files** — allocation boundaries and the registry-scoped
   organisation id. An allocation is the block rung of the fault-domain ladder, so these
   boundaries are the artifact's structure.
2. **DB-IP City Lite** — country and region per address range, collapsed from city granularity and
   resolved to ISO 3166-2 through `data/region-map.json`. Country and region come from here
   alone: measured against the fleet's self-reports it wins 178 disagreements to 10 against the
   registry-plus-RDAP machinery it replaced, and it carries region data for 99% of the fleet, which
   the registries do not have at all.

> **This product includes IP address to city data from [DB-IP](https://db-ip.com), used under the
> [Creative Commons Attribution 4.0 International Licence](https://creativecommons.org/licenses/by/4.0/).**
> The attribution is a licence condition: it must stay with any redistribution of this artifact.

Three sources are deliberately absent, each measured against the fleet and rejected. **RDAP object
country** corrects a block whose delegated country the nodes inside it contradict; DB-IP is right
more often than that correction is, and needs no per-block queries. **RFC 8805 geofeeds** and their
**RFC 9632 discovery** were beaten or tied by DB-IP everywhere they were measured, at the cost of a
network fetch per operator and a dependency on operators publishing at all.

`data/region-map.json` maps a (country, DB-IP region name) pair to its ISO 3166-2 code. It is
generated too, from the iso-codes dataset, the fleet's own self-reports, and
`data/region-aliases.json` — a small curated table for names no rule reaches:

```
node scripts/build-region-map.js
```

Regenerate it when DB-IP's region names change or the fleet moves into a region the table does not
cover; the script prints its unmatched names with fleet presence, which is what an alias entry is
for. A name with no mapping is not an error: its addresses answer at country granularity, and a
missing region can only make placement more conservative.

The build joins the result against the live fleet's self-reported geolocation and writes
`data/iplocation-build-report.json` with country and region agreement numbers and every
remaining disagreement. Read the report before merging a regeneration; country agreement is
~98.5% and materially below that is a regression, not drift.

The artifact is self-describing (format version, `generated`, per-registry source serials and the
DB-IP vintage). A node that cannot resolve an address in the table falls back to /16 arithmetic,
which errs toward refusing placement — the failure mode is the pre-table status quo, never
over-concentration.

Two deliberate compactions, both revisitable: the artifact carries **IPv4 only** (no Flux node has
an IPv6 address; a v6 lookup falls back strict; add a v6 section when v6 nodes can exist), and
organisation identity is a **12-hex-char token** of the registry-scoped org id — nothing reads the
id's content, distinctness is all that placement needs. Adjacent rows agreeing on organisation,
country and region collapse into one: with all three equal there is no boundary between them that
placement can see.

## Which organisations run access networks

The artifact also answers *is this address on a consumer connection, or in a data centre?* FluxOS
needs it to enforce anything against a residential node, and a node cannot decide it well enough
alone: the strongest evidence is the registry's own record of what a block was assigned for, and
six thousand nodes cannot each query the RIRs.

So it is decided here and carried in the header as `orgClasses` — a sparse map from the 12-hex
organisation token to `1` (residential) or `2` (hosting). The rows are untouched; the unit is the
**organisation**, which is what a row already names and what the evidence actually describes.

```
node scripts/build-orgclasses.js     # gather evidence, write data/orgclasses.json
node scripts/build-iplocation.js     # embed the ledger in the header
```

`data/orgclasses.json` is the reviewable ledger, in the same spirit as the overrides file: every
entry carries the evidence it was decided on, the number of fleet hosts that evidence came from,
and a date. A malformed entry stops the build — publishing a verdict nobody can check is worse than
publishing none, and none is a state the readers already handle.

**The ledger keys ADDRESS RANGES, not organisation tokens**, and that is load-bearing. The token is
a hash of the registries' opaque-id, and the registries regenerate those on every publication:
measured across eleven days, **1,919 of 2,510 fleet hosts changed token**. It groups ranges
correctly *within* one artifact and means nothing between two — so a ledger keyed on it loses its
verdicts at the next build, silently, because a token that no longer exists is indistinguishable
from an organisation the table does not carry. Keyed on ranges, the same ledger resolved cleanly
against a registry vintage eleven days older: 160 organisations in, 160 out, nothing unresolved.
A range is the thing itself rather than a name for it, and it is something a reviewer can check.

The organisation grouping is therefore a build-time derivation: `build-iplocation.js` looks up which
organisation holds each ledger range *in today's registry files* and tags it. An organisation whose
ledger ranges disagree gets **no** verdict — that is an operator running consumer lines and a
hosting arm, and nothing is the honest answer for it. A ledger range that resolves to no allocation
is named in the build output and recorded in the report; it is stale, not absent evidence, and
silence is how verdicts vanish unnoticed.

**The rule** (`scripts/orgclasses.js`, the single definition both the gatherer and the build read):
an organisation is residential when at least one of its fleet hosts gives positive evidence and
**no** host in it contradicts; hosting when there are contradictions and no positive evidence;
and unclassified otherwise. Evidence is reverse DNS, the RDAP object's netname and registrant, the
ip-api `hosting`/`proxy`/`mobile` flags, and whether the operator is a known host — read from
`isp`/`as` and never from `org`, which is the block registrant and frequently a reseller.

Link asymmetry is recorded but **decides nothing**. A bench figure is a speed test's result, not a
property of the link, and Hetzner nodes measure 183/621 often enough that counting it as evidence
let one noisy benchmark veto an operator whose own PTR, registry object and vendor flag all said
hosting — 1,102 hosts left unclassified by an instrument reading. It can support a verdict the real
signals already reached; it can never reach one, and never fight one.

The contradiction rule is what earns the accuracy, and it is measured, not asserted: against the
1,569 fleet hosts ip-api positively calls hosting, spanning all 29 hosting ASNs the fleet uses, the
per-host form of this rule calls **none** of them residential — and the 39 that do trip an access
signal are each caught by a contradiction. Applying it across the organisation rather than per host
is deliberate: an operator running both consumer lines and a hosting arm contradicts itself and
comes out unclassified, which is the honest answer for a block whose addresses are not all the same
kind of thing.

Only organisations the fleet actually occupies are considered. The artifact names over 103,000;
enforcement will only ever ask about the few hundred holding Flux nodes, and a verdict nobody will
read is a verdict nobody has checked. On the 2026-08-18 fleet that is 261 organisations behind
2,511 hosts, written as 1,296 ranges: **107 residential, 49 hosting, 105 unclassified**.

Checked against the deterministic node list on the day it was built — 2,508 host addresses, 15%
residential, 63% hosting, 21% unclassified:

- Of the 1,575 hosts ip-api positively calls hosting, **none** came out residential.
- Hetzner (1,156), OVH, Contabo, netcup and Linode nodes carry **no** residential verdict.
- The hosts PR #1784's classifier wrongly targeted — the University of Latvia, Infomaniak, the
  `*.dedicated.static.tds.net` block — all come out `hosting` or unclassified.

Of the organisations left unclassified, most have no evidence at all; the rest are genuine
disagreements worth leaving alone. Cogent's space holds both transit customers and a fibre ISP;
Free SAS, Bouygues and Frontier carry consumer PTRs and consumer registry objects while ip-api flags
them `proxy` or `hosting`. Weighting one source over another to break those ties is a judgement
nobody has measured, and unclassified costs only enforcement — so they stay unclassified.

`orgClasses` is optional, like `regionNames`, and for the same reason: an organisation absent from
the map has no verdict, and nothing enforces without one. A build carrying none costs enforcement
rather than misdirecting it. Do **not** raise the format version to add a section — a bump makes
every node on the current release reject the artifact and fall back to /16 arithmetic until it
upgrades, degrading placement fleet-wide across the rollout.

## Correcting the location table

DB-IP is right about far more of the address space than anything measured against it, but it is not
right about all of it, and where it is wrong it is usually wrong about a whole block: a dozen nodes
inside one allocation all self-reporting a country the table disagrees with is the vendor
mis-attributing that allocation, not a dozen nodes lying. `data/iplocation-overrides.json` is the
ledger of those corrections. They are applied **build-side**, between the merge and the artifact, so
every node fetches a corrected table and there is nothing to override node-side.

The build report is what an entry is written from. `validation.disagreementBlocks` and
`validation.regionDisagreementBlocks` name the address ranges the fleet contradicts, with the
organisation token and the node count — the country and region pair tables say *what* is disputed,
these say *where*.

An entry looks like this:

```json
{
  "range": "203.0.113.0/24",
  "country": "FR",
  "region": null,
  "evidence": "12 nodes self-report FR; RIPE db inetnum country: FR — https://…",
  "added": "2026-08-02"
}
```

- `range` is an IPv4 CIDR on its own boundary. Entries are sorted ascending by range start and may
  not overlap.
- At least one of `country` and `region` must say something. `country` is an ISO 3166-1 alpha-2 code
  that the build knows a continent for; `region` is an ISO 3166-2 code whose country prefix matches.
  A region-only entry keeps whatever country the table already has, and the prefix is checked
  against it when the entry is applied — a mismatch fails the build.
- **`country` set with `region: null` clears the region** on every row the range covers. A block in
  the wrong country was also given the wrong region, and there is nothing to salvage; leave `region`
  out and it means the same thing.
- `evidence` is required and is meant to be read by whoever finds the entry in a year. Say what
  showed the vendor wrong — node self-reports, the RIR record, an operator's own statement — with a
  URL where there is one. `added` is the ISO date the entry went in.
- Organisation is never overridden. The allocation boundary is the registries' fact; it is the
  vendor's attribution that is in dispute.

Entries are effectively write-once. There is no expiry and no review date, because the build
detects retirement on its own: when the vendor catches up and every row a range covers already
carries the entry's values, the build marks it `noop` and it is then deleted, nothing more. A range
no table row covers at all is marked `noop` too, which is what a typo'd range looks like. Both
counts land in `overrides` in the build report, `node scripts/validate.js` prints a `WARNING` line
per retirable entry, and the monthly PR body carries the block — so the signal to write one and the
signal to delete one both arrive in the same place, once a month.

A stale entry never fails CI. It is inert by definition, and blocking an unrelated policy merge on
somebody else's tidy-up is the rule that gets bypassed.

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
