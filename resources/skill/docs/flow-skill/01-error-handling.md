# Error Handling in Power Automate Flow JSON

Companion to `.github/copilot-instructions.md` (failure paths) and
`.github/instructions/flow-json.instructions.md` (`runAfter` validity).
Every pattern below is consistent with FlowPlugin's linter rules.

## What "error handling" actually means in WDL

Workflow Definition Language has no `try` / `catch` keyword. Failure
control flow is expressed entirely through `runAfter`:

```jsonc
"runAfter": { "<sibling-action>": ["Failed", "TimedOut"] }
```

When you see "Try / Catch" in flow code, it is a *convention* — two
sibling Scopes whose `runAfter` graph routes the catch only on
`Failed` / `TimedOut` from the try.

The four legal status values are `Succeeded`, `Failed`, `Skipped`,
`TimedOut` (FlowPlugin rule: `runAfterStatus`). Anything else is
rejected.

## The minimum viable Try / Catch

```jsonc
"actions": {
  "Scope_Try": {
    "type": "Scope",
    "actions": { /* business logic */ },
    "runAfter": {}
  },
  "Scope_Catch": {
    "type": "Scope",
    "runAfter": { "Scope_Try": ["Failed", "TimedOut"] },
    "actions": {
      "Compose_FailureContext": {
        "type": "Compose",
        "inputs": "@result('Scope_Try')",
        "runAfter": {}
      }
    }
  }
}
```

`result('Scope_Try')` returns an array of every child action that ran
inside the scope, including failed ones — each entry carries `name`,
`status`, `error.code`, `error.message`, and `outputs`. Filter to the
failures with `filter(result('Scope_Try'), e => equals(e.status, 'Failed'))`.

When a flow has more than ~10 actions and no branch ever inspects
`Failed` or `TimedOut`, the linter raises `noErrorHandling`.

## Try / Catch / Finally

Add a third sibling Scope that runs in **all** cases — it lists every
terminal status from both the try and the catch:

```jsonc
"Scope_Finally": {
  "type": "Scope",
  "runAfter": {
    "Scope_Try":   ["Succeeded", "Failed", "Skipped", "TimedOut"],
    "Scope_Catch": ["Succeeded", "Failed", "Skipped", "TimedOut"]
  },
  "actions": { /* logging, cleanup, telemetry */ }
}
```

The `Skipped` status matters here: when the try succeeds, the catch
**skips** rather than failing, so `Skipped` must appear in the
finally's `runAfter` for that branch or the finally never runs.

## Retry policies for transient failures

`OpenApiConnection` and `Http` actions accept a `retryPolicy` block.
This is *transparent retry* — the runtime swallows the intermediate
failures and only surfaces the final outcome to `runAfter`.

```jsonc
"runtimeConfiguration": {
  "retryPolicy": {
    "type": "exponential",
    "count": 4,
    "interval": "PT10S",
    "minimumInterval": "PT5S",
    "maximumInterval": "PT1H"
  }
}
```

| Field | Meaning |
|---|---|
| `type` | `none`, `fixed`, or `exponential` |
| `count` | Number of retry attempts (max 10) |
| `interval` | ISO-8601 duration; the base delay |
| `minimumInterval` / `maximumInterval` | Caps for exponential backoff |

Use retry for **transient** failures only (`429`, `503`, network
blips). Do not retry on `400` / `404` / auth errors — they will fail
identically every time and just delay the catch branch.

## Distinguishing transient vs terminal failures

Inside a catch Scope, branch on the failure shape:

```jsonc
"Condition_TransientHttp": {
  "type": "If",
  "expression": {
    "or": [
      { "equals": [ "@first(filter(result('Scope_Try'), e => equals(e.status, 'Failed')))['error']['code']", "429" ] },
      { "equals": [ "@first(filter(result('Scope_Try'), e => equals(e.status, 'Failed')))['error']['code']", "503" ] }
    ]
  },
  "actions":   { /* enqueue for later, do not alarm */ },
  "else":      { "actions": { /* alert, log, escalate */ } }
}
```

In practice, hoist the failure record into a `Compose` first so the
expressions stay readable.

## Saga compensation (multi-step rollback)

When several write actions must succeed atomically and the platform
itself has no transaction, pair each forward step with a
**compensating action** in the catch. The shape:

```text
Scope_Try
├─ Step_1_Reserve   (forward)
├─ Step_2_Charge    (forward)
└─ Step_3_Ship      (forward)

Scope_Catch (runAfter Scope_Try Failed/TimedOut)
└─ For each completed forward step in result('Scope_Try'),
   invoke its compensating action in reverse order.
```

A clean encoding:

```jsonc
"Compose_FailedSteps": {
  "type": "Compose",
  "inputs": "@filter(result('Scope_Try'), e => equals(e.status, 'Succeeded'))"
}
```

Then drive a `Foreach` (Sequential — see `foreachSequential`) over
`reverse(outputs('Compose_FailedSteps'))` and switch on `e.name` to
pick the compensating action (Release, Refund, Cancel_Shipment, …).

This is heavier than most flows need; reach for it only when the
write actions touch external systems that *cannot* be made
idempotent and partial state is unacceptable.

## Terminate vs failure-by-`runAfter`

`Terminate` ends the flow run with a chosen status:

```jsonc
"Terminate_AsFailed": {
  "type": "Terminate",
  "inputs": {
    "runStatus": "Failed",
    "runError": { "code": "InvalidInput", "message": "Title is required." }
  }
}
```

Use `Terminate` to:

- Surface a *business* failure (validation, missing data) as a flow
  failure visible in run history and to upstream callers.
- Stop a flow early after the catch has logged everything.

Avoid `Terminate` inside a Scope that the catch is supposed to
handle — it bypasses the parent's `runAfter` graph in surprising ways.
Keep terminations at the top level.

## Failure visibility

- The flow's run-history page shows the **first** action whose status
  is `Failed`. Subsequent failures inside the same Scope are visible
  only via `result()`.
- Logging from the catch should include at minimum: `result()` payload
  (failed children + error codes), the trigger inputs that caused the
  run, and any correlation id. Without trigger inputs you cannot
  reproduce the failure.

## Anti-patterns

- **Empty catch** — a Scope_Catch that only runs `Compose @{result(...)}`
  and nothing else. The flow now reports Succeeded even though the try
  failed. Either re-Terminate as Failed or surface the error
  somewhere durable (queue, log, alert).
- **Catching everything as Succeeded** — a final `Terminate` with
  `runStatus: 'Succeeded'` after a recovery path masks every failure
  from monitoring. Only do this when recovery genuinely succeeded.
- **Retrying non-idempotent writes** — pairing `retryPolicy` with a
  Create that has no idempotency key produces duplicates on retry.
  Either give the operation an idempotency key or set
  `retryPolicy.type: "none"` and handle the failure explicitly.
- **`runAfter` on the wrong sibling** — `runAfter` keys must be
  **siblings in the same `actions` map**. A catch outside the try's
  container will never fire (linter rule: `runAfterTarget`).

## Cross-references

- Try / Catch shape rules — `.github/copilot-instructions.md` →
  *Failure paths*
- `runAfter` validity — `.github/copilot-instructions.md` →
  *runAfter semantics*
- Foreach + write safety inside a Saga — `02-performance.md` and
  `flow-json.instructions.md` → *Foreach concurrency*
- Reading `result()` outputs — `04-expressions-cookbook.md` →
  *Inspecting failures inside a catch*
