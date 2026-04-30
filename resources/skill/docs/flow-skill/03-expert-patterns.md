# Expert Patterns

Architectural recipes for flows that outgrow a single Scope. Each
pattern names the linter rules it interacts with so the assistant's
suggestions stay aligned with FlowPlugin's diagnostics.

## Child flows

A *child flow* is a separate flow whose trigger is **Manually trigger
a flow** (HTTP request) or **When an HTTP request is received**, and
which is invoked from a parent via the **Run a Child Flow** action.

### When to extract

- The parent flow is approaching the 250-action cap (`actionLimit`
  warns at 200).
- The same logic appears in two or more flows.
- A subprocess has its own failure semantics or owners.
- A subprocess needs an independent throttling budget (different
  connection reference).

### Contract

Treat the child flow as an API:

- **Inputs** are the request schema. Pin them in
  `properties.definition.parameters` (also counts against
  `parameterLimit`, capped at 50).
- **Outputs** are the response body. The parent uses
  `body('Run_a_Child_Flow')?['<field>']` to read them.
- **Errors** propagate as the HTTP status; non-2xx fails the parent's
  Run a Child Flow action, which the parent's `runAfter` graph can
  catch like any other failure.

### Solution packaging

Both flows live in the **same solution** so they ship together. The
parent's reference is by **child flow name**; renaming the child
breaks the parent.

## Idempotent consumer

Goal: the flow can run twice with the same input and produce the same
end state without duplicating work.

Recipe:

1. Compute (or accept) an **idempotency key** for the request — a
   stable hash, GUID, or upstream id.
2. Look up by key first (`Get items` filtered on the key column).
3. If a record exists, branch to the "already processed" path
   (return existing result).
4. Otherwise create the record using a unique-key constraint (or
   optimistic concurrency via `If-Match` on Dataverse).
5. Store the key and the response so step 2 succeeds on retry.

This is what makes `retryPolicy` (see `01-error-handling.md`) safe on
write actions. Without it, every retry on a `429` doubles the side
effects.

## Saga (compensation)

See `01-error-handling.md` → *Saga compensation*. Use only when:

- Multiple writes must look atomic to the caller.
- The target systems do **not** support transactions.
- Partial state is unacceptable (financial, inventory).

For everything else, prefer **idempotent retries**. Saga code is
expensive to maintain.

## Queue-based fan-out

Goal: decouple a high-volume producer from a rate-limited consumer.

Shape:

- **Producer flow** — appends items to a queue (SharePoint list,
  Service Bus, Dataverse table) and returns immediately.
- **Worker flow** — triggers per item (SharePoint *When an item is
  created*, Service Bus, scheduled poll) and processes one at a time.

Why this works:

- The worker runs at its own pace; the producer does not block on
  downstream throughput.
- Failures are isolated to a single item, not the whole batch.
- Retries become "set status back to *Pending*" — see *State machine*
  below.

Trigger conditions on the worker:

```text
@equals(triggerOutputs()?['body/Status']?['Value'], 'Pending')
```

…paired with a status update at the **start** of the worker (set to
*Processing*) avoids race conditions when multiple workers wake on the
same item.

## State machine via Choice column

A SharePoint list (or Dataverse table) row is a state container. A
`Choice` / `OptionSet` column drives transitions; the trigger
condition restricts which states wake the worker.

```text
Pending ──Worker.Run──▶ Processing ──Success──▶ Done
                                  └──Failure──▶ Failed (alert)
```

Implementation rules:

- The trigger filter narrows by status. Modifying the row to
  *Processing* re-fires the trigger only if *Processing* is also in
  the filter — usually it isn't, breaking the loop.
- Set **trigger concurrency to 1** for the writer flow when state
  transitions must be serialised per row.
- Add a **trigger condition** that excludes
  `triggerOutputs()?['body/Editor/Email']` equal to the flow's own
  service principal, so flow-driven edits do not re-trigger the
  same flow.

## Circuit breaker

Goal: stop hammering a downstream system that is already failing.

Shape:

- A shared **state** (SharePoint list row, Dataverse row, blob) holds
  `{ status: 'Closed' | 'Open' | 'HalfOpen', openedAt, failureCount }`.
- Each call:
  1. Read state. If `Open` and `now < openedAt + cooldown`, fail fast
     (`Terminate` with a domain error).
  2. Otherwise call the downstream.
  3. On success: reset `failureCount` to 0, status `Closed`.
  4. On failure: increment `failureCount`. When threshold hit, set
     `Open` with `openedAt = utcNow()`.
- A scheduled flow (or the next call after the cooldown) flips
  `Open` → `HalfOpen` to probe.

Use this when the downstream service has a real cost per call (paid
API, fragile system) and `retryPolicy` alone would just amplify load.

## Trigger concurrency and self-edit guards

These two settings are easy to forget and cause the most "why is my
flow looping?" tickets:

```jsonc
"runtimeConfiguration": {
  "concurrency": { "runs": 1 }
}
```

Sets **trigger concurrency** to 1: the platform queues new runs while
a previous run is in progress. Required for any read-then-write
pattern where two simultaneous runs could clobber each other.

```jsonc
"triggerConditions": [
  "@not(equals(triggerOutputs()?['body/Editor/Email'], 'flow-service@contoso.com'))"
]
```

A trigger condition that excludes the service account the flow uses
to write back. Prevents `When item is modified` from re-firing on
the flow's own updates.

## Environment variables and configuration

Don't hardcode site URLs, list names, group ids, or distribution lists
in action inputs. Solution **environment variables** let the same
flow run in dev/test/prod without rewiring:

- `string` env var for site URL → reference as
  `parameters('SiteUrlParam')` after exposing it as a flow parameter.
- `JSON` env var for a config blob → parse with `Parse JSON` once at
  the top.

Connection references already do this for connectors; environment
variables do it for everything else.

## Solution packaging hygiene

- Every production flow lives **inside a Solution**, never as a
  "default" / "My flows" flow. Outside a solution, environment
  variables and connection references do not exist.
- Pin a solution per workspace via FlowPlugin's
  `flowplugin.pickSolution` so `pac solution unpack` and the upload
  command target the same artefact.
- Don't mix unmanaged and managed in the same workspace; the linter
  treats both as plain JSON, but the platform's deploy semantics
  differ.

## Cross-references

- Failure handling primitives — `01-error-handling.md`
- Action / parameter caps and Foreach throughput —
  `02-performance.md`
- `runAfter` semantics for parent / child error propagation —
  `.github/copilot-instructions.md` → *runAfter semantics*
- `inputs.host.connectionName` rules per child flow —
  `flow-json.instructions.md` → *Connection-reference keys*
