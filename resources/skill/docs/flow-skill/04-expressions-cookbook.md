# Expressions Cookbook

Recipes that build on `.github/instructions/expressions.instructions.md`.
Each entry is a real WDL expression you can paste into a `Compose`
action and adapt.

## Reading from a trigger / connector payload

```text
@triggerBody()?['Title']
@triggerOutputs()?['body/Status']?['Value']
@triggerOutputs()?['headers']?['x-correlation-id']
@body('Get_item')?['Author']?['Email']
@outputs('HTTP_Call')?['statusCode']
```

Always chain `?[]` at every step. A single missing `?` on an optional
field will throw at runtime instead of returning null.

## Defaulting optional fields

```text
@coalesce(triggerBody()?['Title'], '(untitled)')
@coalesce(triggerBody()?['Tags'], createArray())
@coalesce(triggerBody()?['Count'], 0)
```

`coalesce` returns its first non-null argument. Match the default's
type to the expected type, otherwise downstream type checks break.

## `split` on a possibly-null source

The linter rule `splitWithoutCoalesce` flags raw
`split(triggerBody()?.x, ',')`. The fix:

```text
@split(coalesce(triggerBody()?['Tags'], ''), ',')
```

For trimming each piece:

```text
@select(
  split(coalesce(triggerBody()?['Tags'], ''), ','),
  trim(item())
)
```

`select` (the WDL `Select` action's expression form) maps each item;
the inner `item()` is the current element.

## Merging objects with `union`

`union(a, b)` keeps `a`'s values on key collisions. To merge defaults
with caller overrides where the caller wins:

```text
@union(variables('defaults'), triggerBody()?['overrides'])
```

The linter rule `unionOrdering` flags the inverse — passing a
variable named `old` / `previous` / `prev` / `existing` first.

## Building SharePoint claim strings

```text
@concat('i:0#.f|membership|', variables('userEmail'))
```

For a Person/Group column with the *Claims* mode, that string is the
correct shape. With *Email* mode, pass the bare email.

## Reading SharePoint Choice columns

```text
@triggerBody()?['Status']?['Value']
@triggerBody()?['Categories']?[0]?['Value']     // first multi-choice
@join(
  select(coalesce(triggerBody()?['Categories'], createArray()), item()['Value']),
  ', '
)
```

Single-select Choice → `?['Value']`. Multi-select → array of
`{ Value: ... }` objects.

## Reading a Lookup column

```text
@triggerBody()?['Manager']?['Value']            // ID
@triggerBody()?['Manager']?['DisplayValue']     // text label
```

When you need fields beyond ID and DisplayValue, use `$expand` on the
*Get items* action and reference the expanded properties:

```text
@triggerBody()?['Manager']?['Title']
@triggerBody()?['Manager']?['EMail']
```

## Case-insensitive comparison

`equals` is case-sensitive. Normalise both sides:

```text
@equals(toLower(triggerBody()?['Status']?['Value']), 'approved')
```

For `contains` / `startsWith` apply the same treatment.

## Type conversions before comparison

```text
@greater(int(triggerBody()?['Quantity']), 0)
@equals(bool(triggerBody()?['IsActive']), true)
@less(float(triggerOutputs()?['body/Amount']), 100.0)
```

Form / query inputs arrive as strings. A bare
`greater(triggerBody()?.Quantity, 0)` returns false silently when the
value is a string.

## Safe array indexing

```text
@if(
  greater(length(coalesce(body('Get_items')?['value'], createArray())), 0),
  first(body('Get_items')?['value'])?['ID'],
  null
)
```

## Date math

All timestamps are ISO-8601 UTC strings.

```text
@utcNow()
@addDays(utcNow(), -7)                                       // 7 days ago
@formatDateTime(utcNow(), 'yyyy-MM-dd')
@convertFromUtc(utcNow(), 'Pacific Standard Time', 'g')      // local view
@ticks(triggerBody()?['Created'])                            // for diffs
@div(sub(ticks(utcNow()), ticks(triggerBody()?['Created'])), 600000000)   // minutes elapsed
```

`ticks` returns 100-nanosecond units; divide by 10,000,000 for
seconds, 600,000,000 for minutes.

## Extended date and time

All timestamps are ISO-8601 UTC strings unless a `format` argument is provided.

```text
@addHours(utcNow(), 8)                                          // 8 hours ahead
@addMinutes(triggerBody()?['MeetingStart'], 30)                 // extend 30 min
@getFutureTime(7, 'Day')                                        // +7 days, no base needed
@getPastTime(30, 'Day')                                         // 30 days ago
@subtractFromTime(utcNow(), 1, 'Month')                         // same day last month
@addToTime(utcNow(), 2, 'Week')                                 // +2 weeks
@startOfDay(utcNow())                                           // midnight today UTC
@startOfMonth(utcNow())                                         // 1st of this month, midnight
@dayOfWeek(utcNow())                                            // 0=Sun 1=Mon … 6=Sat
@convertTimeZone(utcNow(), 'UTC', 'Singapore Standard Time', 'yyyy-MM-dd HH:mm')
@parseDateTime(triggerBody()?['DateString'], 'en-US')           // string → timestamp
```

`dateDifference(start, end)` returns an ISO-8601 duration string (e.g.
`P1DT2H30M`) — not a number. For a numeric day count, use `ticks`:

```text
@div(
  sub(ticks(triggerBody()?['DueDate']), ticks(utcNow())),
  864000000000
)   // days remaining (864,000,000,000 ticks = 1 day)
```

## Inspecting failures inside a catch

```text
@result('Scope_Try')                                          // all child runs
@filter(result('Scope_Try'), e => equals(e.status, 'Failed')) // failures only
@first(filter(result('Scope_Try'), e => equals(e.status, 'Failed')))?['error']?['message']
@first(filter(result('Scope_Try'), e => equals(e.status, 'Failed')))?['error']?['code']
@first(filter(result('Scope_Try'), e => equals(e.status, 'Failed')))?['name']
```

Hoist these into named `Compose` actions inside the catch — the
expressions are awkward enough that inlining them in conditions
becomes unreadable fast.

## Building dynamic JSON for HTTP / API calls

```text
@json(
  concat(
    '{"id":"', triggerBody()?['Id'], '",',
    '"name":"', replace(triggerBody()?['Name'], '"', '\\"'), '"}'
  )
)
```

…is the *wrong* way (string concatenation invites injection). Prefer:

```text
@createObject(
  'id',   triggerBody()?['Id'],
  'name', triggerBody()?['Name']
)
```

`createObject` produces a real object; the connector serialises it.
`replace`-based escaping is brittle — values with quotes or backslashes
will break it.

## JSON object manipulation

Use these to add, update, or remove properties without rebuilding the
whole object from scratch:

```text
// Add a correlation id before forwarding
@addProperty(triggerBody(), 'correlationId', guid())

// Overwrite a property (returns new object — does not mutate in place)
@setProperty(variables('record'), 'ProcessedAt', utcNow())

// Strip an internal field before calling a downstream API
@removeProperty(triggerBody(), 'internalRef')

// Chain: update status and strip a field in one expression
@removeProperty(
  setProperty(triggerBody(), 'status', 'Processed'),
  'rawPayload'
)
```

Each function returns a **new** object. Chain them for multiple changes.
Prefer `createObject` when building from scratch — mutation-chain verbosity
adds up fast.

## Idempotency keys

```text
@guid()                                                       // new id per run
@triggerOutputs()?['headers']?['x-idempotency-key']           // honour caller's key
@coalesce(triggerOutputs()?['headers']?['x-idempotency-key'], guid())
```

For deterministic keys (same inputs → same key), encode the relevant
fields:

```text
@toUpper(
  base64(
    concat(
      coalesce(triggerBody()?['CustomerId'], ''), '|',
      coalesce(triggerBody()?['OrderRef'], '')
    )
  )
)
```

WDL has no `sha256`; `base64(concat(...))` is the conventional
substitute. For real cryptographic hashing call out to a child flow
that wraps an Azure Function or Dataverse plugin.

## Common shape errors and their fixes

| Symptom | Cause | Fix |
|---|---|---|
| `InvalidTemplate` "string was not recognized as a valid date" | Treating a SharePoint `Date and Time` column as already-formatted | `formatDateTime(triggerBody()?['Created'], 'yyyy-MM-dd')` |
| `Property X is not in object` mid-run | Missing `?[]` at one level | Audit the chain top-to-bottom; add `?` everywhere optional |
| Empty array surfaced as null | The connector returned no `value` array | `coalesce(body('Get_items')?['value'], createArray())` |
| Numeric comparison always false | One side is a string | Wrap with `int()` / `float()` |
| `union` output missing newer values | Argument order swapped | `union(new, old)`, not `union(old, new)` |
| `split` throws on null | Source field is null | `split(coalesce(field, ''), ',')` |
| `equals(field, null)` matches empty string too | null → '' conversion | Use `empty(coalesce(field, ''))` instead |
| Wrong value inside Foreach body | Used `item()` instead of `items()` | Use `items('Foreach_Name')?['Field']` |

## Cross-references

- Hard rules and linter coverage —
  `.github/instructions/expressions.instructions.md`
- All function signatures and categories —
  `docs/flow-skill/05-expression-functions-reference.md`
- Reading `result()` inside a catch — `01-error-handling.md` →
  *Distinguishing transient vs terminal failures*
- Hoisting expressions into a `Compose` for caching —
  `02-performance.md` → *Caching repeated work*
