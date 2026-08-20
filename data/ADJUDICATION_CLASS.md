# Adjudicating network-class disputes

How to work an organisation's network class — access network or hosting — into
`data/orgclass-overrides.json`. The sibling of
[`ADJUDICATION.md`](ADJUDICATION.md), which covers *where* a block is; this
covers *what kind of network* it is.

**This one deletes data.** A wrong country moves an app to a worse node. A wrong
class of `residential` tells FluxOS a node is on a domestic line, which drains
the apps it holds and then DOSes it, and there is nothing node-side that will
decline a verdict this table gives — the node reads the table and acts. Hold an
entry here to a higher bar than a location correction, and when the evidence
does not settle it, leave it unclassified. Unclassified enforces nothing; that
is the safe state and it is the default.

## What the build already does, and where it stops

`scripts/build-orgclasses.js` votes. It gathers evidence per fleet host, groups
hosts by organisation, and decides the organisation when at least
`MIN_DECIDABLE_FOR_MAJORITY` (3) of its decidable hosts agree at
`MAJORITY_SHARE` (0.8) or better. Anything else is left unclassified, and
`data/iplocation-build-report.json` records why — `noEvidence` against
`conflicted` are different problems.

Two populations are unreachable by gathering more of the same evidence, and they
are the only reasons to write an entry:

- **The minority tail of a mixed organisation.** The vote is *designed* to
  outvote up to a fifth of an allocation. Where that fifth is genuinely the other
  kind, only a hand-entered range says so.
- **An allocation with too few fleet hosts to hold a vote.** Below three
  decidable hosts there is nothing to count, however clear the evidence is.

A third reason applies to withdrawal only: **a published verdict we no longer
stand behind.** `"class": "none"` returns the range to unclassified without
waiting for a gather to change its mind.

## The decision rule

Enter a correction only when ALL of these hold:

1. **The range is the unit you examined.** Not the organisation, not the
   covering allocation — the addresses you actually looked at.
2. **At least one signal that is not a geolocation vendor agrees.** Registration
   data, reverse DNS across the range, the operator's own product pages.
3. **No signal of the other kind survives.** A single hosting token anywhere in
   a range you are about to call `residential` kills the entry. This is the
   zero-contradictions clause the measurement rests on, and it is what took the
   combined rule to 0 errors in 142 hosts; relaxing it is how the accuracy is
   lost.
4. **For `residential`, the range is consumer access service.** Business fibre
   from a consumer ISP is still not a domestic line, and a node on it is not
   what this policy is aimed at.

Asymmetric bandwidth is corroboration and never a reason on its own. Symmetric
FTTH is ordinary consumer service in France and Sweden.

## The signals, strongest first

1. **Registration (RDAP)** — `curl -sL https://rdap.org/ip/<ip>`. Read the
   **netname and the registrant, and nothing else**: an early pass that included
   abuse-contact blocks drowned in Hetzner's contact person names. `FR-PROXAD-ADSL
   / ASSIGNED PA` is an operator saying "consumer DSL" in its own object; a
   netname carrying `CLOUD`, `VPS`, `SRV`, `DC` or a site code is saying the
   opposite. An object covering EXACTLY the range outweighs the covering
   allocation.
2. **Reverse DNS across the range** — fleet addresses plus stratified samples.
   Access-network vocabulary (`dsl`, `cpe`, `pool`, `dyn`, `bras`, `fios`,
   `gpon`) is generic worldwide, which is what makes it worth more than a list of
   company names. A name carrying BOTH vocabularies counts only as a
   contradiction — `static.63.10.201.195.clients.your-server.de` is a Hetzner
   box, not a static residential line.
3. **The operator's own product pages.** An ISP that sells only consumer
   broadband in a country, or a hoster's datacentre list, settles what a netname
   convention means.
4. **ip-api `hosting` / `proxy` / `mobile`** — a vendor assertion. `hosting` and
   `proxy` are read only as contradictions; `mobile` is the one positive signal
   among them. Never decisive alone.
5. **ISP and ASN**, read from `isp`/`as` and never from `org`. `org` is the block
   registrant and is frequently a reseller — the two disagree on 67% of fleet
   hosts, and `46.250.240.89` carries isp "Contabo Asia Private Limited" against
   org "Yorkshire Tech Limited".

## Entry mechanics

```json
{
  "range": "203.0.113.0/24",
  "class": "residential",
  "evidence": "what was examined and what it showed, with its source",
  "added": "2026-08-20"
}
```

- **CIDR only, on its own boundary.** `203.0.113.5/24` is a person meaning one
  address and writing 256; the loader refuses it rather than rounding down. A
  disputed span that is not CIDR-aligned decomposes into its minimal exact CIDR
  set — one entry each, never rounded wider than what was examined.
- **Keyed by range, never by organisation.** The organisation tokens in the
  artifact are opaque and are reissued on every publication, so an override keyed
  to one would match today and silently stop matching after the next build.
- **`class`** is `residential`, `hosting`, or `none`. `none` withdraws a verdict
  and leaves the range unclassified.
- **`evidence`** states the concrete finding with its source, so the entry can be
  re-examined without redoing the work. "PTRs look residential" is not evidence;
  the netname, the PTR pattern with a sample, and what the operator sells are.
- **`added`** is the entry date, and becomes the entry's `decided` date.
- Entries are **sorted ascending by range start and must not overlap** — two
  entries covering one address would make the verdict depend on file order.

The build marks what it applied: an overridden entry carries `"override": true`
in `data/orgclasses.json` and is counted separately in the build's output, so a
hand-entered verdict never reads as something the evidence decided.

## Verify before merging

```
node scripts/build-orgclasses.js --report data/orgclass-build-report.json
node scripts/validate.js
```

Require: `validate.js` exits 0; the build's `class overrides:` line names the
entry you added; the range appears in `data/orgclasses.json` with
`"override": true` and your evidence string; and the counts move by exactly the
number of entries you wrote and no more.

An entry reported as **"the evidence already agrees with (retirable)"** means the
vote has caught up with you. Delete it — a correction that no longer corrects
anything is a claim nobody is checking.

## Maintenance

Re-examine an entry when the fleet inside its range changes character, when the
operator restructures, or when a gather starts disagreeing with it. Allocations
do get resold, and a consumer block that becomes a hoster's is exactly the
direction that costs someone their data.

Withdrawing is cheap and safe: set `"class": "none"`, or delete the entry so the
vote decides again. Both end at a state that enforces nothing.
