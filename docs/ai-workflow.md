# AI-assisted development workflow

> How this project works with AI agents: where they are applied, what is checked
> in generated code, which data is never shared, and where the agent is not
> relied on. Sections 5 and 8 are the record of what actually happened and are
> extended as work progresses.

## 1. Tools and roles

| Tool | Role | Status |
|---|---|---|
| Claude Code | primary agent: implementation, refactoring, tests | in use |
| Shopify Dev MCP | current Admin/Storefront API schemas instead of model memory | in use |
| OpenAI Codex | independent review of a diff by a second model, before I read it | in use |
| `.claude/skills/*` | domain review checklists (below) | planned |
| CI review loop | the same second-model review posted automatically as a PR comment | planned |
| Custom MCP for `mock-erp` | lets the agent read the real integration contracts | roadmap v2 |

**Why two models rather than one.** The agent that wrote a diff is the worst
reviewer of it: it shares every assumption that produced the mistake, and asking
it to check its own work tends to produce agreement. A second model reviews the
diff first and reports independently; I read the diff and the review, and decide.
Two of the seven cases in section 5 are the kind that survives a same-model
review and does not survive a fresh reading — concurrency and what gets stored.

**Why the Dev MCP is mandatory.** Shopify versions the Admin API quarterly. From
memory, a model will confidently produce mutations and fields that do not exist
in the current version, or that were renamed. The MCP eliminates an entire class
of errors that would otherwise only surface at runtime. It is the first thing set
up in the project, before any code is written. Cases 1 and 2 in section 5 are
that class, caught by exactly that cross-check.

## 2. Custom skills (planned)

`.claude/skills/` does not exist yet. Three skills are specified below and are
built alongside the code they check — a review checklist written before there is
anything to review would only encode guesses. Section 5 is what they are being
tuned against: each of the three exists to catch a mistake that has already
happened once here.

- **`shopify-graphql-review`** — checks whether `userErrors` are handled, whether
  `throttleStatus` is respected, whether a pagination loop is used where a bulk
  operation belongs, whether an API version is hardcoded, and whether the
  document names a mutation that is deprecated in the pinned version (case 1).
- **`webhook-safety`** — HMAC against the raw body, constant-time comparison,
  idempotency on `X-Shopify-Webhook-Id`, 200 returned before work begins, and
  nothing persisted that the topic's handler does not read (case 6).
- **`liquid-a11y-audit`** — per section: keyboard navigation, `aria-live` on async
  updates, focus management, reserved dimensions for media.

Skills will live in `.claude/skills/` and run before every PR. The point is not
automation for its own sake: these domain errors recur, and checking for them by
hand every time is how they get missed.

## 3. Breaking down a task

1. **Context first, task second.** The agent gets the target file, the input data
   schema, the known domain pitfalls, the acceptance criterion, and explicit
   boundaries on what not to touch.
2. **One task, one diff that fits in your head.** If a diff takes more than ten
   minutes to read, the task should have been split.
3. **Tests are written before or alongside the code**, never after. Written after,
   a test gets shaped to fit the implementation and stops verifying anything.
4. **The diff is read in full, line by line.** Not "looks fine" but "I know why
   every line is here." A line that is not understood is either understood or
   removed.

An example of a strong and a weak brief is in `CLAUDE.md`, under "How to brief an
agent in this repository".

## 4. Review checklist for generated code

- **Behaviour**: the test reproduces the scenario rather than mocking it away.
- **Edges**: empty input, network failure, duplicate event, exhausted rate limit.
- **Security**: no secrets, no PII in logs, all input validated.
- **Domain correctness**: fields and mutations exist in the current API version
  (verified through the MCP).
- **Excess**: agents like to add dependencies, abstractions, and handling for
  cases that do not occur. Anything not needed for the task is removed.

## 5. Model mistakes

> The most useful section of this document: which errors recur in this domain,
> how each was caught, and what changed in the process so it does not recur.
> Every case below is a `fix(…)` commit in the history — the commit message
> carries the full reasoning and the tests that pin it.

**The finding that matters most, before the cases.** Not one of the seven was
caught by a test that already existed. Two were caught by cross-checking the
schema through the MCP, two by running the code against the real store, one by
reading the SDK's own source, and two by reading the diff and asking what happens
under concurrency. Every one of them got a test *afterwards*, written to pin the
behaviour. A suite that is green is evidence about the cases someone thought of;
in this domain, the mistakes come from the platform behaving unlike its
documentation, and a test written from the same wrong assumption as the code
agrees with it.

### Case 1 — A mutation that is deprecated in the version we target

- **Task:** push on-hand stock to Shopify from an external stock event.
- **What the model proposed:** `inventorySetOnHandQuantities`.
- **Why it was wrong:** it still exists in 2026-07 and is marked deprecated in
  it, in favour of `inventorySetQuantities`. It compiles, it validates, it works
  — and it buys a rewrite at the next version upgrade for nothing. This is the
  worst shape a model error takes here: nothing fails.
- **How it was caught:** MCP cross-check, before the code was written.
- **Final solution:** `inventorySetQuantities` with `name: "on_hand"` and
  `@idempotent` keyed on the job id, so a queue retry re-sends one write and
  Shopify applies it once. Recorded in
  [ADR-0017](adr/0017-inventory-writes.md).
- **What changed in the process:** hard rule 1 in `CLAUDE.md` — the API version
  is a code-level contract in one constant, never from model memory — and the
  reason now sits in the doc comment above the document itself, in
  `graphql-documents.ts`, where the next person to edit it will read it. The
  same class of error appeared a second time and was caught the same way:
  `currentBulkOperation`, the query every tutorial shows, deprecated as of
  2026-01 in favour of `bulkOperation(id:)` — and also the wrong question, since
  a shop may now have several operations running at once.

### Case 2 — A mandatory input key, omitted

- **Task:** the same inventory write.
- **What the model proposed:** an `InventoryQuantityInput` without
  `changeFromQuantity`, on the reasonable-sounding assumption that a
  compare-and-swap guard is optional when you do not want the check.
- **Why it was wrong:** `null` skips the check; omitting the key makes the
  mutation return an error. Every inventory push was rejected instead of writing
  stock, and the mocked `graphql` in the unit tests had no way to notice.
  The older escape hatch, `ignoreCompareQuantity`, no longer exists.
- **How it was caught:** MCP cross-check against 2026-07, prompted by the write
  failing.
- **Final solution:** `changeFromQuantity: null` as a deliberate choice — the
  external system is the source of truth and the payload carries no
  expected-previous value; reading the level first would cost a second call
  against the rate limit and still race.
- **What changed in the process:** the test asserts the key is *present*, not
  that its value is null. An assertion on the value alone passes while the
  mutation stays broken, because an absent key reads as `undefined`.

### Case 3 — `instanceof` across two copies of the same class

- **Task:** turn Admin API failures into a merchant-visible error with a status.
- **What the model proposed:** read the `errors` field off
  `GraphQLClientResponse`, and branch on `instanceof GraphqlQueryError`.
- **Why it was wrong:** twice. Nothing populates `errors` —
  `GraphqlClient.request()` *throws* instead, so a GraphQL error on an HTTP 200
  arrives as a thrown `GraphqlQueryError` and never reaches code reading the
  field. And `instanceof` silently never matches: `@shopify/shopify-api` ships
  CJS and ESM builds whose `exports` map hands each importer a different copy of
  every class, `@shopify/shopify-app-express` is CJS-only, so the client that
  throws and our `import` hold different class objects. Every real Shopify
  failure went to the generic branch, and a merchant hit by an outage was told
  the fault was ours, with no status and no message.
- **How it was caught:** at runtime, pointing a real client at a shop that does
  not resolve. The 502-with-detail path that exists for exactly this had only
  ever been reached by tests, which modelled the documented contract rather than
  the real one. `error.name` is no help either: `ShopifyError` never sets it, so
  all of them report `"Error"`.
- **Final solution:** catch and convert at the client boundary, matching on the
  shape of the object rather than its identity, so one function stays the single
  place that decides what a failed call means.
- **What changed in the process:** nine tests built from the SDK's own error
  classes rather than hand-rolled objects, and one that constructs the CJS copy
  through `require` specifically to pin the dual-realm behaviour — so a future
  refactor back to `instanceof` fails loudly instead of silently.

### Case 4 — A hook assumed to fire for both sessions

- **Task:** provision the metaobject and metafield definitions at install time.
- **What the model proposed:** an `afterAuth` hook opening with
  `if (session.isOnline) return`, on the assumption that the hook fires for both
  the offline and the online pass and that preparation belongs on the offline one.
- **Why it was wrong:** it does not fire for both. With `useOnlineTokens` on, the
  offline callback stores the session, registers webhooks, redirects into the
  online OAuth and returns — before reaching the hook. So the hook only ever saw
  the online session, the guard matched every time, and preparation never ran. A
  freshly installed app had no definitions and said nothing about it: the
  storefront symptom of a missing definition is an empty section, with no error
  in the logs, in `theme check`, or in the console.
- **How it was caught:** reading `auth-callback.ts` in
  `@shopify/shopify-app-express` 8.0.1 after the symptom appeared. Not from the
  documentation, which does not say this.
- **Final solution:** the guard inverted, and the offline session loaded from
  storage rather than taken from the hook's argument — preparation must use the
  offline token, which is per shop rather than per staff member and is what
  webhooks and the worker will hold. `ensureValidOfflineSession()` looks like the
  method for that and throws unless a future flag is on, so the code does what
  it does underneath.
- **What changed in the process:** the logic moved out of `shopify.ts` into its
  own module with its dependencies injected, because the bug lived in wiring no
  test could reach — importing `shopify.ts` constructs a client, opens a Prisma
  pool and needs a populated environment. Four tests now cover it, including the
  one that would have caught this: preparation runs when the hook is handed an
  *online* session, and the Admin client is built from the offline one.

### Case 5 — A state transition addressed by row id alone

- **Task:** complete, fail and reschedule jobs in the queue.
- **What the model proposed:** address the row by its id — the obvious reading of
  "update this job".
- **Why it was wrong:** a worker whose lock goes stale is still running and still
  believes the job is its own. The reaper releases the row, a second worker
  claims it, and the first writes its outcome over an attempt still in flight.
  Marking it `SUCCEEDED` also clears the lock, so a third worker can claim the
  row while the second attempt runs: the same job executing twice at once, one
  run invisible in the sync log.
- **How it was caught:** review of the diff, asking what happens when the lock
  expires while the work is still going. No test failed, and none would have.
- **Final solution:** a claim is identified by `(id, attempts, lockedBy)` plus
  status `RUNNING`, and every transition matches on all of it. `updateMany`
  rather than `update`, because a count of zero answers "is this claim still
  mine?" in the same statement — `update` throws when its filter matches
  nothing, and any read-then-write version leaves a gap for the reaper. Recorded
  in [ADR-0019](adr/0019-job-claim-ownership.md).
- **What changed in the process:** the transitions return whether they applied,
  and a dropped outcome is logged as a warning: nothing is broken, but the work
  was done twice, and two in a row means the staleness window is shorter than a
  job of this kind takes. The tests go through the real sequence — claim,
  backdate the lock, reap, claim again — against a row PostgreSQL actually
  produced, rather than editing columns to simulate one.

### Case 6 — The whole webhook body stored, and a comment asserting otherwise

- **Task:** enqueue work from a verified webhook delivery.
- **What the model proposed:** store the delivery body verbatim in
  `Job.payload`, and a comment above the handler stating that this database
  holds no customer personal data.
- **Why it was wrong:** an `orders/create` job carried the customer's name,
  email, phone and both addresses; a `customers/redact` job carried the email of
  the person asking to be forgotten. Neither redaction path removed any of it —
  `customers/redact` logged "nothing stored to redact" and returned, and
  `shop/redact` cascaded to everything except `Job`, because a job outlives the
  delivery that created it on purpose. The comment was false, and the test it
  claimed asserted this did not exist.
- **How it was caught:** review against the data policy in section 6 of this
  document — reading what the code stores rather than what the comment says it
  stores.
- **Final solution:** a verified delivery is projected onto the fields the
  handler for its topic actually reads, and the rest is dropped at the door.
  Data never stored needs no redaction and cannot be missed by a `deleteMany`
  later. Line item properties are filtered to the bundle id, since the others
  are storefront-written and can carry a gift message. The queue also joins the
  erasure: both redact handlers delete the shop's or the customer's jobs, each
  sparing exactly one row — their own. Recorded in
  [ADR-0018](adr/0018-webhook-payload-minimisation.md).
- **What changed in the process:** the projection is a total `Record` over the
  topic union, so subscribing to a new topic cannot silently inherit "store the
  whole body" — it fails to compile until someone decides what may be kept. This
  is the pattern the repository prefers generally: make the unsafe default
  impossible to express, rather than remembering not to write it.

### Case 7 — Branching on a status code the documentation describes and the store does not send

- **Task:** tell a customer why a bundle could not be added to the cart.
- **What the model proposed:** branch on the HTTP status from `/cart/add.js` —
  422 for sold out, 404 for a variant that no longer exists, as the docs
  describe.
- **Why it was wrong:** measured against the store, `/cart/add.js` answers 422
  for everything the cart refuses, "Cannot find variant" included; the 404 is
  `update.js`. Branching on the status therefore could not tell "sold out" from
  "the variant is gone", and the first version showed the sold-out sentence for
  a deleted variant.
- **How it was caught:** measurement against the real store, not the docs and
  not the model. Recorded in
  [ADR-0012](adr/0012-bundle-add-to-cart-transaction.md).
- **Final solution:** ask the source of truth — fetch the chosen products' JSON
  and read the case off the data: variant absent, present but unavailable, or
  present and available while the cart still refused, which means the cart
  already holds all the stock. That last case got its own sentence; the previous
  fallback told the customer to try again, which would never have worked.
- **What changed in the process:** matching words in Shopify's own error
  description was the alternative and was rejected — that sentence is written in
  the shop's language and is not a contract. The general rule it produced:
  platform behaviour that a feature depends on gets measured and written into an
  ADR, because the documentation is a description and the store is the contract.

### Errors characteristic of this domain

Growing list. These are what the skills in section 2 are tuned for — the model
repeats them because they require platform knowledge, not language knowledge:

- a mutation or field from an outdated Admin API version, or one deprecated in
  the version we pin — which compiles and works (cases 1, 2);
- an SDK error contract taken from its type declarations rather than its
  behaviour (case 3);
- a lifecycle hook assumed to fire on every pass of a multi-step OAuth (case 4);
- concurrency written as if the process that started the work is the only one
  that can finish it (case 5);
- a whole webhook body persisted because it was the input, not because anything
  reads it (case 6);
- HMAC verified against reparsed JSON rather than the raw body;
- a webhook handler doing all its work before returning 200;
- a pagination loop instead of a bulk operation on a large catalog, and a first
  page treated as a fact about the whole catalog;
- `userErrors` left unhandled and the failure swallowed;
- a Liquid section missing `presets`, so it never appears in the theme editor;
- storefront behaviour taken from the documentation where the platform actually
  behaves differently (case 7).

## 6. Data policy

What **never** goes to a model or a third-party service:

- `.env` contents, access tokens, API keys, database connection strings;
- customer personal data (names, addresses, emails, phone numbers) — examples and
  tests use synthetic data only;
- client code under NDA;
- production database dumps.

In practice: every fragment is checked for secrets and PII before it goes into a
prompt. CI runs a secret scan (gitleaks). `.gitignore` covers `.env*`, dumps and logs.

Permitted tools are recorded explicitly; using a new service that receives code
requires client approval first. The same constraint appears as a hard rule for
agents in [`../CLAUDE.md`](../CLAUDE.md) under "Boundaries for AI agents"; this
section is the reasoning behind it.

Case 6 is this section applied to the code rather than to the prompt: the same
question — what is stored, and does anything read it — and the answer that data
never held cannot leak.

## 7. Where AI is not relied on

Where an agent saves hours: boilerplate, tests for a described scenario,
refactoring toward a known goal, reading unfamiliar legacy code, documentation.

Where I do not rely on an agent:

- **architectural choices** — a model proposes what is popular, not what fits;
  decisions are recorded in ADRs and made by me;
- **versioned external APIs** — through the MCP or the docs, never from memory
  (cases 1, 2);
- **SDK error and lifecycle contracts** — read from the dependency's source when
  the behaviour matters, because the type declarations describe the intent and
  not always the runtime (cases 3, 4);
- **concurrency** — reviewed by hand against the question "what if this process
  is not the only one here", since a green suite says nothing about it (case 5);
- **performance** — optimising without measuring is meaningless, and only a human
  with access to the real environment can measure;
- **security and data handling** — the cost of an error is asymmetric, so it gets
  a manual check (case 6).

## 8. Metrics

Counted from the repository at the close of phase 3, not estimated. 80 commits:
21 `feat`, 19 `fix`, 29 `docs`.

| | |
|---|---|
| Share of code written with agent involvement | All of it. Every file here was produced in an agent session; none was merged unread, and the diff-read rule in section 3 is what makes that a defensible sentence rather than a boast |
| Errors of platform semantics caught before merge | 19 `fix` commits; the 7 in section 5 are the ones where the platform, not the language, was the reason |
| How those 7 were caught | MCP cross-check 2, running against the real store 2, reading the dependency's source 1, reading the diff for concurrency and data handling 2 |
| Caught by an existing test | 0. Each got a test afterwards, written to pin the behaviour — see the note opening section 5 |
| Would have shipped silently | 4 of the 7: the deprecated mutation (works), the never-firing hook (empty section, no error anywhere), the lost-claim race (visible only as duplicate work), the stored PII (a comment asserted the opposite) |
| Changes to `CLAUDE.md` prompted by those errors | 7 commits touch it; hard rules 1, 2, 4, 9 and 10 each exist because of a mistake made once here |
| ADRs recording a decision that a mistake forced | 4 — [0012](adr/0012-bundle-add-to-cart-transaction.md), [0017](adr/0017-inventory-writes.md), [0018](adr/0018-webhook-payload-minimisation.md), [0019](adr/0019-job-claim-ownership.md) |
