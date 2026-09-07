# AI-assisted development workflow

> How this project works with AI agents: where they are applied, what is checked
> in generated code, which data is never shared, and where the agent is not
> relied on. The "Model mistakes" and "Metrics" sections are filled in as work
> progresses.

## 1. Tools and roles

| Tool | Role |
|---|---|
| Claude Code | primary agent: implementation, refactoring, tests |
| Shopify Dev MCP | current Admin/Storefront API schemas instead of model memory |
| Custom MCP for `mock-erp` | lets the agent read the real integration contracts |
| `.claude/skills/*` | domain review checklists (below) |
| CI review loop | tests plus automated review, posted as a PR comment |

**Why the Dev MCP is mandatory.** Shopify versions the Admin API quarterly. From
memory, a model will confidently produce mutations and fields that do not exist
in the current version, or that were renamed. The MCP eliminates an entire class
of errors that would otherwise only surface at runtime. It is the first thing set
up in the project, before any code is written.

## 2. Custom skills

- **`shopify-graphql-review`** — checks whether `userErrors` are handled, whether
  `throttleStatus` is respected, whether a pagination loop is used where a bulk
  operation belongs, and whether an API version is hardcoded.
- **`webhook-safety`** — HMAC against the raw body, constant-time comparison,
  idempotency on `X-Shopify-Webhook-Id`, 200 returned before work begins.
- **`liquid-a11y-audit`** — per section: keyboard navigation, `aria-live` on async
  updates, focus management, reserved dimensions for media.

Skills live in `.claude/skills/` and run before every PR. The point is not
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

> The most useful section of this document: it records which model errors recur
> in this domain and what was changed in the process to catch them. Filled in as
> work progresses. Format:

### Case 1 — <short title>

- **Task:** …
- **What the model proposed:** …
- **Why it was wrong:** …
- **How it was caught:** test / review / MCP cross-check / runtime
- **Final solution:** …
- **What changed in the process so it does not recur:** a rule in `CLAUDE.md` /
  a new skill / a new test

### Errors characteristic of this domain

Growing list. These are what the skills in section 2 are tuned for — the model
repeats them because they require platform knowledge, not language knowledge:

- a mutation or field from an outdated Admin API version;
- HMAC verified against reparsed JSON rather than the raw body;
- a webhook handler doing all its work before returning 200;
- a pagination loop instead of a bulk operation on a large catalog;
- `userErrors` left unhandled and the failure swallowed;
- a Liquid section missing `presets`, so it never appears in the theme editor.

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
requires client approval first.

## 7. Where AI is not relied on

Where an agent saves hours: boilerplate, tests for a described scenario,
refactoring toward a known goal, reading unfamiliar legacy code, documentation.

Where I do not rely on an agent:

- **architectural choices** — a model proposes what is popular, not what fits;
  decisions are recorded in ADRs and made by me;
- **versioned external APIs** — through the MCP or the docs, never from memory;
- **performance** — optimising without measuring is meaningless, and only a human
  with access to the real environment can measure;
- **security and data handling** — the cost of an error is asymmetric, so it gets
  a manual check.

## 8. Metrics (to be completed)

| | |
|---|---|
| Share of code written with agent involvement | |
| Model errors caught in review | |
| Of those, would have reached production without tests | |
| Changes to `CLAUDE.md` prompted by those errors | |
