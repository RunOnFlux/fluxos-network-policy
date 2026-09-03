# Adjudicating location disputes

How to work the dispute lists in `data/iplocation-build-report.json`
(`validation.disagreementBlocks` and `validation.regionDisagreementBlocks`) into
`data/iplocation-overrides.json` entries. This is the procedure that produced the
first six entries (PR #9); follow it and the ledger stays evidence-backed.

This document covers **where** a block is. For **what kind of network** it is -
access network or hosting, which is what decides whether FluxOS drains a node's
apps - see [`ADJUDICATION_CLASS.md`](ADJUDICATION_CLASS.md) and
`data/orgclass-overrides.json`. The signals overlap and the evidence discipline
is the same; the bar is higher there, because that verdict deletes data.

Every disputed block ends in exactly one of three states:

- **vendor-wrong** — enter a correction, with the evidence in the entry;
- **fleet-wrong** — leave the table alone (a node's self-report can be wrong too);
- **undecidable** — leave it listed; never enter a guess.

## The decision rule

Enter a correction only when ALL three hold:

1. **Every fleet node inside the block reports the same value.** Contiguous runs
   of addresses are ONE customer, not independent observations — 52 nodes in one
   run carry the weight of one witness.
2. **At least one independent signal agrees with the fleet.** Independent means
   not derived from a geolocation vendor: registration data, reverse DNS,
   operator publications, measurement.
3. **No independent signal supports the vendor's value.** If the registry says
   the vendor is right, the fleet's self-report is the wrong side — leave the
   table alone.

One-node blocks need an operator-grade signal (a geofeed, an exactly-covering
registry object) — reverse DNS alone does not carry a single witness.

## The signals, strongest first

1. **The operator's own statement.** A `geofeed:` attribute on the covering RIPE
   object (fetch it, find the block's line) or a published datacenter list.
   Decisive on its own.
2. **Registration chain** — `curl -sL https://rdap.org/ip/<ip>` and the RIR's own
   RDAP (`rdap.db.ripe.net` etc.). Read it critically:
   - An object covering EXACTLY the disputed range outweighs the covering
     allocation; but check what the object names — `LT-OVH` / `descr: UAB OVH`
     names a registering ENTITY, not a site. Registrant country is not location.
   - ARIN customer assignments are the opposite case. A `type: ASSIGNMENT`
     covering exactly the disputed range and naming a PERSON rather than a
     company is that customer's service address, and there the address IS the
     location — the rule above is about CORPORATE registrants, and applied here
     it talks you out of the best signal on the block. Read the address from the
     vcard `adr` LABEL parameter in the RDAP response; the value array beside it
     is usually seven empty strings.
   - Hoster naming conventions are location-bearing when the operator's own DC
     list confirms them: Hetzner `fsn1`=Falkenstein(DE-SN) `nbg1`=Nuremberg(DE-BY)
     `hel1`=Helsinki(FI); OVH `gra`/`rbx`/`sbg`=FR `waw`=PL `bhs`=CA.
   - Some hosters mark foreign ranges deliberately — Contabo's inetnums say DE
     except the six that say SG/FR/GB/US/DK, so DE there is a statement. Establish
     the operator's convention (sample their other objects) before trusting one.
3. **Reverse DNS** across the block (fleet IPs plus stratified samples). ISP PTRs
   often encode metro codes (`nwrknj` = Newark NJ, `CMDNNJ` = Camden NJ, `asd` =
   Amsterdam). Verify a convention is location-bearing before citing it: netcup's
   `*.srv.de` PTRs also cover its Vienna block, so they locate nothing. To confirm
   one does bear location, `dig -x` a few of the same operator's OTHER blocks and
   check each code decodes to a different known place: Metronet's `molnilaa`
   (Moline IL) is corroborated by `clsp`+co, `fyvl`+nc, `zmmn`+oh and `tlhs`+fl —
   four for four city+state, so the state code is the convention and not a
   coincidence. Four lookups, two minutes, and it is the difference between
   evidence and a hunch.
4. **Measurement** — TCP connect-time triangulation settles country-level ties in
   seconds when references exist: OVH publishes per-DC hosts
   (`gra|rbx|sbg|waw.proof.ovh.net`), so `curl -w %{time_connect}` from any fixed
   vantage against the block and the candidate DCs discriminates (PR #9's OVH
   block matched Strasbourg within 1ms; Warsaw was the vendor's claim). ICMP is
   often filtered; use TCP to the nodes' API port. One vantage suffices when the
   block MATCHES a reference; excluding requires knowing what the alternative
   would measure.

Re-derive the fleet view first (same joins the build makes): the deterministic
node list crossed with `stats.runonflux.io/fluxinfo?projection=geolocation,ip`,
filtered into the block's range. Remember the fleet side is ip-api vocabulary —
it speaks retired region codes for Norway and can be plain wrong for hoster
ranges; it is one witness, not ground truth.

## Entry mechanics

- The loader accepts on-boundary IPv4 CIDR only. A disputed table row that is not
  CIDR-aligned must be decomposed into its minimal exact CIDR set — one entry per
  CIDR, never rounded wider than the row: an override asserts only what was
  examined.
- Country disputes: set `country`, omit `region` — a block in the wrong country
  has a meaningless vendor region, and omitting clears it.
- Same-country region disputes: set `region` only.
- `evidence` states the concrete finding with its source, so the entry can be
  re-examined without redoing the work. `added` is the entry date.

## Verify before merging

Rebuild (`node scripts/build-iplocation.js`) and require: every new entry
`noop: false` with plausible `rowsTouched`; the corrected pairs leave the
disagreement tables; country agreement moves by exactly the corrected node count;
`node scripts/validate.js` exits 0 with no retirement warnings. Then PR — the
evidence table belongs in the body.

## Maintenance

The monthly PR body carries the overrides summary and fresh dispute lists. An
entry flagged retirable (the vendor caught up) is deleted, not kept. An entry the
fleet later disagrees with is re-examined — blocks do occasionally re-home, and
the ledger must never outlive its evidence. Agreement percentage is a proxy
metric: adjudicated-and-classified is the real target, and leaving a
fleet-wrong or undecidable block unentered is a correct outcome, not a failure.
