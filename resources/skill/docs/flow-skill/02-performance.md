# Performance & Throughput

Companion to `.github/copilot-instructions.md` (size budgets) and
`.github/instructions/flow-json.instructions.md` (Foreach concurrency,
pagination). All numbers below are platform-wide unless noted; check
your tenant's licensing for stricter caps.

## Hard limits worth memorising

| Limit | Value | Power Automate Copilot DevKit rule |
|---|---|---|
| Actions per flow | 250 | `actionLimit` warns at 200 |
| Parameters per flow | 50 | `parameterLimit` warns at 40 |
| `Foreach` concurrency degree | 50 (default 20) | — |
| `Until` iterations | 5,000 | — |
| `Until` timeout | 1 hour (default), 30 days max | — |
| Run duration | 30 days | — |
| Action input/output size | 100 MB | — |
| Action input/output array length surfaced to UI | 5,000 | — |
| Trigger payload size | 200 MB (varies by connector) | — |

If your design pushes any of these, the answer is almost always
**split into a child flow** (see `03-expert-patterns.md` →
*Child flows*).

## When to use a Scope

The linter raises `largeFlowNoScope` past ~15 actions. The point isn't
cosmetic — Scopes are how WDL gives you:

- **Atomic-looking failure handling** — one `runAfter` on a Scope
  replaces N `runAfter` clauses on its children.
- **`result()` aggregation** — a single call returns every child
  action's status and error.
- **Collapsible run history** — debugging a 200-action flow without
  Scopes is intractable.

Group by **business meaning** (`Scope_ValidateInput`,
`Scope_ChargeCustomer`, `Scope_NotifyOps`), not by action type.

## Foreach: concurrency math

Default behaviour is **parallel with degree 20**. That is fine for
read-only work; for writes, see `flow-json.instructions.md` →
*Foreach concurrency* (`foreachSequential` rule).

To explicitly set a parallel degree:

```jsonc
"runtimeConfiguration": {
  "concurrency": { "repetitions": 20 }
}
```

Two patterns to remember:

- **Sequential** — `"operationOptions": "Sequential"`. Required when
  any descendant action mutates shared state. Throughput = N ×
  per-iteration latency.
- **Bounded parallel** — `runtimeConfiguration.concurrency.repetitions`
  between 2 and 50. Use when iterations are independent reads or
  writes against *different* keys. Throughput ≈ degree ×
  per-iteration latency, capped by connector throttling.

> If you set `Sequential` and also `runtimeConfiguration.concurrency`,
> the Sequential wins. Don't bother with both.

## Don't filter in-flow when you can filter at the source

Most platform throttling (and flow latency) comes from pulling data
the flow then throws away.

| Connector | Push filter to source via |
|---|---|
| SharePoint *Get items / Get files* | OData `$filter` (uses delegable operators: `eq`, `ne`, `gt`, `lt`, `startswith`) |
| SharePoint *Get items* | `$select` to limit returned columns |
| SharePoint *Get items* | `$expand=Lookup/Field` to resolve lookups in one call |
| Dataverse *List rows* | `Filter rows`, `Select columns`, `Expand Query` |
| SQL *Get rows* | `Filter Query`, `Select Query` |
| HTTP / REST | URL query string / request body |

In-flow `Filter array` and `Select` only make sense on data already in
memory. Filtering 10,000 rows down to 50 in `Filter array` still pays
the cost of fetching, paginating, and parsing those 10,000 rows.

## SharePoint specifics

- Lists with **>5,000 items** require *indexed columns* in any
  delegable filter or the connector returns a "Cannot complete this
  operation" error. Add the index in SharePoint list settings before
  shipping the flow.
- Use `$select=ID,Title,Status` on `Get items` to drop heavy columns
  (Note, attachments, computed fields).
- Use the **Send an HTTP request to SharePoint** action for queries
  the typed connector cannot express (CAML, batch). It belongs to the
  SharePoint connector, so it does not move you to a different DLP
  group.
- *Get item* (singular) is a single API call by ID; *Get items*
  paginates. Always use *Get item* when you have the ID.

## Pagination policy

`paginationMissing` watches list-style operations (`GetItems`,
`ListRows`, `List*`, etc.). Without an explicit pagination policy the
connector silently caps at its default page size (often 100 or 256).

```jsonc
"runtimeConfiguration": {
  "paginationPolicy": { "minimumItemCount": 5000 }
}
```

`minimumItemCount` is a *minimum* — set it to the largest result set
you must support. Pagination is free in terms of action count (it is
all one action) but the wall-clock cost grows linearly with size.

## `Compose` over `Set variable` inside loops

Variables are a **flow-scoped, mutex-protected** resource. Inside a
parallel Foreach, `Set variable` serialises the loop and forces every
iteration to wait for the lock — even if you set
`concurrency.repetitions: 50`. The throughput collapse is silent.

Replace with `Compose`:

- `Compose` outputs are *iteration-scoped* — they live inside that
  Foreach iteration only and do not contend.
- `outputs('Compose_X')` from the *current* iteration is referenced
  by name; from a previous iteration's flow body, use the
  `outputs(...)` call inside `items('Foreach_Name')` patterns.

If you genuinely need a variable mutated across iterations, force
`operationOptions: Sequential`.

## Caching repeated work

If the same value (lookup result, expression, API response) appears in
3+ actions, hoist it into a single `Compose` action upstream and
reference `outputs('Compose_<name>')` everywhere else. Wins:

- One API call instead of N.
- The value is visible in run history (debugging).
- Edits in one place, not N places (drift prevention).

## `Apply_to_each` on a single trigger payload

A common foot-gun: the designer wraps an action in `Apply to each`
even when the body shape is already a single object, because the type
inference saw an array somewhere up the chain. The result is a
1-iteration loop adding latency and obscuring intent. If the loop
always has exactly one item, replace with a `Compose @first(...)` and
delete the loop.

## Throttling-aware design

Connectors enforce per-connection request budgets (Office 365: ~600
requests / 60 s; SharePoint: per-tenant + per-connection limits).
Strategies, ordered by impact:

1. **Filter and `$select` at the source** to reduce request count.
2. **Batch where the connector supports it** — SharePoint REST `$batch`,
   Dataverse `Run a Changeset Request`, SQL stored procedures.
3. **Bounded parallelism** — set `concurrency.repetitions` to a value
   the connector can handle, not 50.
4. **Retry with backoff** — see `01-error-handling.md` →
   *Retry policies for transient failures* for `429` handling.
5. **Move the hot path to a child flow** with its own connection
   reference, so its throttling budget is independent.

## Action count is the wrong metric

Two flows with 100 actions can have wildly different runtimes — what
matters is the dependency graph depth and the connector calls. Before
optimising, look at the **run history timing waterfall**. Cut the
longest action first.

## Cross-references

- Foreach concurrency rule and write detection —
  `flow-json.instructions.md` → *Foreach concurrency*
- Pagination glob list — `flow-json.instructions.md` →
  *Pagination on list reads*
- Child flows for >250-action splits — `03-expert-patterns.md` →
  *Child flows*
- Retry / transient handling — `01-error-handling.md`
