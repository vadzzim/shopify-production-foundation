# ADR-0019: A job's state transitions are conditioned on the claim, not on its id

- **Status:** accepted
- **Date:** 2026-09-08

## Context

The queue is a table claimed with `SELECT ... FOR UPDATE SKIP LOCKED`, and a
claim is a row moved to RUNNING with `lockedAt`, `lockedBy` and an incremented
`attempts` (ADR-0007). Attempts are counted at claim time, because a worker
killed mid-job never runs its failure path. A reaper releases rows whose
`lockedAt` has gone stale, which is what makes the queue survive a redeploy.

That leaves a window nothing accounted for. A stale lock does not stop the
worker holding it: a slow Admin API call, a bulk export download, or a process
paused long enough to look dead all leave a worker still running, still
believing the job is its own. The reaper releases the row, a second worker
claims it, and the first one then finishes and writes its outcome.

Every transition — `completeJob`, `failJob`, `rescheduleJob` — addressed the row
by `id` alone, so that late write applied. Marking the job SUCCEEDED also
cleared the lock, which freed the row for a *third* claim while the second
attempt was still running: the same job executing twice concurrently, with one
of the runs invisible in the sync log.

Separately, and for the same reason, nothing compared a job to its attempt
budget when its worker died. `failJob` is where that comparison lived; a process
that is gone does not reach it. The reaper released every stale row regardless
of `attempts`, and `claimJobs` took FAILED rows without checking. A job that
reliably kills its worker cycled indefinitely, showing as FAILED throughout.

## Options considered

1. **Renew the lock from the handler (a heartbeat).** ➕ Addresses the cause: a
   worker that is alive keeps its claim, so the reaper never takes a job that is
   still running. ➖ Needs every handler to call something periodically, which
   makes "did you remember to heartbeat" a property of each handler rather than
   of the queue. ➖ Does not remove the race, only narrows it: a process paused
   between two heartbeats is indistinguishable from a dead one, and the write
   after it resumes is still late.
2. **A lock generation column** — a token minted per claim and matched on write.
   ➕ Unambiguous. ➖ A migration and a new column for information two existing
   columns already carry.
3. **Match on the claim's identity: `(id, attempts, lockedBy)` plus status
   RUNNING.** ➕ No schema change: `attempts` is already incremented per claim
   and `lockedBy` already says whose it is, so the pair is a generation counter
   that exists. ➕ The condition and the write are one statement, so there is no
   read-then-write gap for the reaper to land in. ➖ Every transition needs the
   job object rather than an id, and callers that faked a job's numbers to steer
   the outcome have to stop.
4. **Leave it and rely on the staleness window being generous.** ➕ Nothing to
   write. ➖ The window is five minutes and one handler polls a bulk operation
   for half a minute per attempt; the margin is a guess about how slow Shopify
   can be, not a guarantee. ➖ The failure is silent and produces duplicate
   concurrent work, which for `inventory.push` means two writers of the same
   stock level.

## Decision

Option 3, with the attempt budget checked in the two places a dead worker's
attempt can be accounted for: the reaper dead-letters a stale row that has no
attempts left, and `claimJobs` refuses a row whose attempts are spent.

`updateMany` rather than `update` for each transition: `update` throws when its
filter matches nothing, which would make a conditional write a caught exception,
while a count of zero is a plain answer to "is this claim still mine?". The
transitions return whether they applied, and the worker logs a dropped outcome
at warning level — nothing is broken, but the work was done twice, and two of
those in a row means the staleness window is shorter than a job of that kind
takes.

`failJob` gains a `permanent` flag. The worker used to force the dead-letter
state by passing `attempts: maxAttempts` in place of the real count, which this
filter rejects — and which was a poor way to say it anyway, since it falsified
the job's own numbers to carry one bit of the caller's intent.

## Rationale

A heartbeat (option 1) is the textbook answer and it is the one that does not
fit here: it puts a requirement on every handler, and it cannot make a late
write safe — only rarer. Option 3 makes the late write *harmless*, which is a
different kind of guarantee: correctness does not depend on how long a job
takes, on how generous the staleness window is, or on a handler remembering
anything.

The two columns being enough is what made it cheap. `attempts` is incremented on
claim for a reason that predates this decision, and that reason — a dead worker
must still cost an attempt — is exactly what makes it a per-claim generation
counter.

## Consequences

- No job can be marked finished by a worker that no longer owns it, and no
  attempt's failure can be recorded against a different attempt.
- A worker whose claim expires does its work for nothing. The wasted run is
  visible in the logs rather than silent, and the fix is a longer staleness
  window or a shorter job, both of which the log line points at.
- Handlers must be idempotent, and that requirement is now honest rather than
  aspirational: the duplicate run is a documented outcome, not a race nobody
  mentioned. `inventory.push` is safe by construction — absolute quantity, job
  id as the idempotency key (ADR-0017).
- A job that takes its worker down as many times as it is allowed to lands in
  the dead-letter state, where the sync log surfaces it for a manual retry, and
  a manual retry still works because it resets `attempts` to 0.
- Anything that edits a job row by hand — a `maxAttempts` lowered, a status set
  in a console — now has to leave `attempts`, `lockedBy` and status consistent,
  or the next transition drops.

## When to revisit

When the worker moves into its own process (roadmap v2, ADR-0008) and several of
them run in parallel by default, the frequency of lost claims stops being
theoretical: if the logs show them regularly, the staleness window becomes a
per-kind setting rather than one constant, and a heartbeat for the long-running
export handler is worth reconsidering on its own.
