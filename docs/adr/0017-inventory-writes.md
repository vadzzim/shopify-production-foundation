# ADR-0017: Inventory writes — `inventorySetQuantities`, absolute, keyed by job id

- **Status:** accepted
- **Date:** 2026-09-08

## Context

Phase 3 pushes stock levels into Shopify. The brief for the work named
`inventorySetOnHandQuantities`, which is the mutation most documentation and
most model memory will produce for this. Checking it against the 2026-07 schema
through the Shopify Dev MCP — as `CLAUDE.md` requires, rather than writing it
from memory — turned up three things that change the design.

**It is deprecated in the version we pin.** The 2026-07 reference for
`inventorySetOnHandQuantities` reads: *"Deprecated. Use `inventorySetQuantities`
to set on_hand or available quantities instead."*

**An idempotency key is mandatory.** Since 2026-04 both mutations refuse a
request without one, supplied through the `@idempotent(key:)` directive. As of
2026-01 it was optional; the app is being written after that window closed.

**Inventory is not addressed by variant.** A quantity belongs to an
`InventoryItem` × `Location` pair. A product variant has exactly one inventory
item, and that item has an independent quantity at every location the shop
stocks it in.

The reference store has one location, which is precisely why this needs writing
down: every wrong design here works today.

## Decision 1 — which mutation

### `inventorySetOnHandQuantities`

- ➕ Named in the task, and the one most examples show.
- ➕ Its input reads slightly more directly: `setQuantities`, no `name` field.
- ➖ Deprecated in 2026-07, the version this repository pins. New code written
  against it buys a rewrite at the next upgrade in exchange for nothing.

### `inventorySetQuantities`

- ➕ The replacement Shopify's own deprecation notice points at.
- ➕ Can write `available` as well as `on_hand`, so a future need does not mean a
  different mutation.
- ➖ Needs `name: "on_hand"` spelled out, and getting it wrong is silent (see
  decision 2).

**Decision: `inventorySetQuantities`.**

There is no case for starting on a deprecated mutation. The interesting part is
how it was found: `inventorySetOnHandQuantities` typechecks, validates, and works
— the deprecation is visible only in the reference text. This is the concrete
argument for the repository's rule about verifying through the Dev MCP instead of
from memory: the failure being avoided is not an error, it is a decision made
without a fact.

## Decision 2 — `on_hand`, not `available`

`available` is what a storefront may sell. Shopify derives it: on-hand minus what
is committed to unfulfilled orders. `on_hand` is physical stock.

An external system counting a warehouse knows the second number and cannot know
the first — it has no idea which units are already promised to orders placed in
the last hour. Writing that number into `available` overwrites Shopify's own
arithmetic with a figure that ignores every commitment, and the store oversells
by exactly the number of unfulfilled units.

**Decision: `on_hand`.** The field is a required part of the input, so this is a
decision the mutation forces us to make rather than one we could drift into — but
only in the sense that *some* value must be chosen, and the wrong one succeeds.

## Decision 3 — absolute quantities, not deltas

### Deltas (`inventoryAdjustQuantities`)

- ➕ Two systems can adjust the same item without either overwriting the other.
- ➖ **Do not survive a retry.** A "-3 units" message delivered twice removes six.
  With an at-least-once queue that is not an edge case, it is the normal
  behaviour of the transport under any failure.

### Absolute values

- ➕ Applying the same value twice leaves the same number. Re-running a job is
  free, which is what makes a queue safe to point at stock at all.
- ➖ Last write wins. Two sources setting the same item disagree loudly rather
  than composing.

**Decision: absolute.** The single-writer constraint that comes with it is the
model this project already committed to in ADR-0006 — the external system owns
stock, Shopify owns orders — so the drawback costs nothing that was on offer.

## Decision 4 — the idempotency key is the job id

Shopify requires a key. What to put in it is ours, and the choice decides whether
the retry story holds.

A queue with at-least-once delivery re-runs a job whose outcome it never learned:
a socket closed after Shopify applied the write, a process killed between the
mutation and the `SUCCEEDED` update. Without a stable key those retries are
second writes.

- **A fresh UUID per attempt** — every retry is a new instruction to Shopify.
  Harmless for an absolute quantity and useless: it buys nothing over sending no
  key at all.
- **A hash of the payload** — stable across retries, but also identical for two
  *genuinely different* instructions that happen to set the same number. The
  second real write would be swallowed as a duplicate.
- **The job id** — stable for exactly as long as the instruction is the same
  instruction. The queue retries the same row, so a retry reuses it; a new
  instruction is a new row, so it gets a new one.

**Decision: the job id.**

It is the only one of the three that draws the line where the domain draws it.
It also means the boundary is legible: "the same job" and "the same write" are
the same sentence.

## Consequences

- `SET_INVENTORY_ON_HAND` in `graphql-documents.ts` is validated against 2026-07
  and requires `write_inventory` and `read_inventory`, both already granted.
- The payload schema in `@nordlys/shared` requires an `InventoryItem` gid and a
  `Location` gid, so passing a variant gid fails at the queue boundary with the
  field named rather than at Shopify with `INVALID`.
- Every `userError` on this mutation is fatal. Unlike the install step, where
  `TAKEN` means the desired state already holds, there is no error here that
  means "already correct" — each one means the number was not written, and
  reporting success would leave the app believing a stock level Shopify does not
  have.
- The producer of these jobs is still missing. The mock ERP is roadmap v2, so
  today `inventory.push` is enqueued only by hand. The handler, the mutation and
  the retry semantics are real and tested; the thing that would call them is not
  written yet, and the roadmap says so rather than implying otherwise.

## When to revisit

- A second writer for stock appears → absolute values stop being safe and this
  needs ADR-0006's conflict rules applied, or `inventoryAdjustQuantities`.
- Shopify removes `inventorySetOnHandQuantities` → nothing to do; already off it.
- The reference store gains a second location → nothing to change in the code,
  and this ADR is the note explaining why.
