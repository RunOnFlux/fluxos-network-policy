# Signing the policy documents

Every document in this repository is published signed, so a node can tell what this
repository published from what something in between handed it. The transport stops needing
to be trusted — which is what allows a node to take policy from a peer rather than only from
github.

`main` is what people edit. **`signed` is what nodes read.**

## The document

`signed/policy-signed.json` is `{ payload_b64, sig_b64 }`, where the payload is the exact
signed bytes — a JSON object `{ seq, issued_at, documents, artifacts }`. The signature covers
the transmitted bytes, so verification never depends on signer and verifier agreeing about
JSON key order or whitespace.

**One signature covers all four documents together.** Separately signed documents can be
recombined: anything able to choose which versions a node receives could pair today's
`enterprisenodes.json` with last month's `blockedrepositories.json`, and both would verify
while being a pair this repository never published. A single payload makes the set the unit.

`seq` increases by one per signing run and never restarts. The signer takes the next sequence
from whichever is higher — the published document or `signed/provenance.json` — so losing one
of them, however that happens, does not reset the count. A sequence that can go backwards is
not a defence against replay, because an old signed bundle would become newer than what is
published.

A consumer asks for a minimum with `?minseq=N` where the serving side supports it, and treats
an answer below its floor as no answer at all. Verifying a stale document and accepting it is
indistinguishable from there being nothing newer, which is the whole of a freeze attack.

## The artifacts

`iplocation.bin.gz` is covered by its sha256 rather than carried inline — 4.6 MB of binary
against a few kilobytes of JSON — and republished under a name derived from that hash:
`signed/iplocation-<sha256>.bin.gz`.

The content-addressed name is the point. `iplocation.bin.gz` is a **mutable name**: it means
"the current table", so its bytes change under anyone holding a reference, and a document
naming it can only say "fetch this, and it should hash to X". Between a regeneration landing
on `main` and this bundle being signed, those two disagree. A name derived from the content
makes that question unaskable — the file either exists or it does not, and it cannot be the
wrong bytes.

It is also what lets a peer serve the table. *"Give me `iplocation-<hash>.bin.gz`"* is
answerable by anyone and checkable on arrival; *"give me the current table"* is not, because
the peer's idea of current and the asker's may differ.

Three superseded artifacts are kept beside the current one. A node holding a bundle from last
month must still be able to fetch the table that bundle names.

Git stores a blob once per content, so the copy beside the bundle shares storage with the one
on `main` rather than doubling it.

## Keys

Consumers pin a set of public keys and accept a document signed by any one of them, so a
second key can take over without those consumers needing an update first.

| key | custody | use |
|---|---|---|
| 1 | CI, secret `POLICY_SIGNING_SEED_B64` in the `policy-signing` environment | day to day |
| 2 | cold, offline | continuity only |

The environment's deployment branch policy admits `main` only, so a workflow run on any other
ref is refused before its first step and a branch push cannot read the key.

The repository variable `POLICY_PUBLIC_KEYS` holds the same pinned list the consumers carry,
and the workflow verifies every document against it before publishing. A seed rotated without
updating that list produces a document every node rejects; this is what catches it before
publication rather than after.

To generate a key:

```sh
node -e '
const crypto = require("crypto");
const seed = crypto.randomBytes(32);
const key = crypto.createPrivateKey({
  key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]),
  format: "der",
  type: "pkcs8",
});
const pub = crypto.createPublicKey(key).export({ format: "der", type: "spki" }).subarray(12);
console.error("seed (secret POLICY_SIGNING_SEED_B64):", seed.toString("base64"));
console.error("public key (add to POLICY_PUBLIC_KEYS and to consumers):", pub.toString("hex"));
'
```

Write the seed straight into the environment secret. There should be no copy of the private
half anywhere else: key 2 covers its loss, and a second copy only widens where it can leak
from.

## Verifying

```sh
POLICY_PUBLIC_KEYS=<hex>[,<hex>] node scripts/verify-policy.js [path] [--minseq N]
```

This is the reference a consumer implementation is checked against. FluxOS and fluxbench each
have their own verifier; this is what "the same document" means.
