---
applyTo: "**/Workflows/**/*.json,**/workflows/**/*.json"
---

# WDL Expression Style

Applies to any string in a flow definition that begins with `@` (the
shorthand `@expr`, the embedded form `@{expr}`, or the explicit
`@expression(...)`).

## Defend against null

- Reach into objects with `?[]` at every step. `triggerBody()['x']['y']`
  throws when `x` is absent; `triggerBody()?['x']?['y']` evaluates to
  null instead.
- Substitute defaults with `coalesce`:
  `coalesce(triggerBody()?['Title'], '')`.

## `split` on a possibly-null source

`split(field, ',')` errors out if `field` is null. The linter rule
`splitWithoutCoalesce` watches for `split(triggerBody()?.x, …)` and
`split(item()?.x, …)`. Wrap the input first:

```text
split(coalesce(triggerBody()?['Tags'], ''), ',')
```

## `union` argument order

`union(a, b)` resolves key collisions in favour of `a`. When you mean
"merge with the new copy winning", call `union(new, old)`. The linter
rule `unionOrdering` flags the inverse — specifically when the first
argument's name contains `old`, `previous`, `prev`, or `existing`.

## SharePoint column shapes

- *Choice* columns are objects with a `Value` member — read them as
  `triggerBody()?['Status']?['Value']`.
- *Person / People* columns require the claims string:
  `concat('i:0#.f|membership|', variables('userEmail'))`.
- *Lookup* columns surface as expanded objects when `$expand` is set:
  `triggerBody()?['Manager']?['Title']`.

## Comparisons honour case

`equals('Approved', 'approved')` returns false. Normalise both sides
with `toLower` or `toUpper` whenever the input came from a human:

```text
equals(toLower(triggerBody()?['Status']?['Value']), 'approved')
```

## Type discipline

- Convert query / form values explicitly with `int(…)`, `float(…)`,
  `bool(…)`, or `string(…)` before comparing them — mixed-type
  comparisons return false silently.
- `length(…)` accepts arrays and strings. Guard indexing with
  `greater(length(coalesce(items, createArray())), 0)` so an absent
  collection does not blow up the expression.

## Materialise repeated subexpressions

When the same expression shows up in three or more places, hoist it
into a `Compose` action and reference `outputs('Compose_<name>')`
elsewhere. The Compose value is visible in run history (easier to
debug) and edits stay in one place.

## Prototype hard expressions

Multi-step `if`, deep `?[]` chains, and date arithmetic deserve a
standalone `Compose` while you build them so the run history shows the
intermediate value. Inline them into a `Condition` or `Switch` only
after you have confirmed the output.

## See also

- `docs/flow-skill/04-expressions-cookbook.md` — paste-ready recipes
  for SharePoint Choice / Lookup, date math, `result()` inspection,
  idempotency keys, dynamic JSON via `createObject`.
- `docs/flow-skill/01-error-handling.md` — reading `result('Scope_Try')`
  inside a catch.
