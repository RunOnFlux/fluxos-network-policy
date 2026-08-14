# Signing keys

## FluxOS hash list

fluxbench gates a node's confirmation signature on a list of known-good FluxOS tree hashes. That
list is signed here and verified in fluxbench against public keys compiled into the binary, so
neither the transport nor whichever node relayed the document has to be trusted.

Public keys are published here because they are public, and because losing track of one would force
a rotation — and rotating the pinned set requires a fluxbench release, since the keys are compiled
in. That is also why the set is any-of-N rather than a single key.

| key | public key (raw ed25519, hex) | custody | use |
|---|---|---|---|
| 1 | `911620580c708b80bdb97afc01ec529c5d4655727ec87a277838a1f6b7f123c0` | CI — `hashlist-signing` environment secret `HASHLIST_SIGNING_SEED_B64` | day to day |
| 2 | `fee7b0ccf2323954af68a249eaa61f957239eb222329e08a5b6a50ced649bae8` | cold, offline | continuity only |

### Key 1

Generated 2026-08-14 directly into the environment secret. **There is no copy of the private half
anywhere else, on purpose.** Key 2 is what covers its loss; a second copy would only widen where it
can leak from.

The secret is scoped to the `hashlist-signing` environment rather than the repository, so workflows
that do not declare that environment — `validate.yml`, `monthly-baseline.yml` — cannot read it.

### Key 2

Generated **offline** 2026-08-14, private half never on a networked machine, stored with the same
process that holds the ISO signing material. It is not used in normal operation. Its purpose is continuity:
without a second pinned key, losing key 1 means no new FluxOS release can be blessed until a
fluxbench release ships a replacement, and with the fail-open deleted every upgrading node would
fail closed.

Note what it does **not** give you: a compromised key 1 cannot be revoked by key 2. Dropping a key
from the pinned set needs a fluxbench release. Key 2 buys legitimate publishing while that release
is prepared, not revocation.

Two keys held in the same place buy nothing. The separation is the point.

## Trust set

Anyone who can land a workflow change on `main` can read an environment secret, because a GitHub
secret is an access-controlled environment variable and not a vault. Today that is the four accounts
with write access, and `main` requires no approving reviews. Environment reviewers would turn silent
extraction into an approval request someone has to wave through — worth adding, though the control
that would actually catch a malicious workflow change is requiring review on `main`.
