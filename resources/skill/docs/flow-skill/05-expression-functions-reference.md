# WDL Expression Functions — Quick Reference

Distilled from the [Microsoft Learn expression functions reference](https://learn.microsoft.com/en-us/azure/logic-apps/expression-functions-reference).
When a function's behaviour is unclear, check that page for the full parameter table.

This file covers categories not fully addressed in `expressions.instructions.md`
or `04-expressions-cookbook.md`. Refer to those files first for null safety,
SharePoint column shapes, and core date recipes.

---

## String functions

| Function | Signature | Returns | Gotcha |
|---|---|---|---|
| `chunk` | `chunk(text, size)` | array of strings | Also works on arrays |
| `endsWith` | `endsWith(text, suffix)` | boolean | Case-sensitive — normalise with `toLower` first |
| `startsWith` | `startsWith(text, prefix)` | boolean | Case-sensitive — normalise with `toLower` first |
| `formatNumber` | `formatNumber(number, format)` | string | Uses .NET format strings: `'N2'`, `'C2'`, `'P0'` |
| `indexOf` | `indexOf(text, search)` | integer (0-based) | Returns -1 if not found |
| `lastIndexOf` | `lastIndexOf(text, search)` | integer | Returns -1 if not found |
| `nthIndexOf` | `nthIndexOf(text, search, n)` | integer | n is 1-based |
| `isFloat` | `isFloat(value)` | boolean | Input must be a string |
| `isInt` | `isInt(value)` | boolean | Input must be a string |
| `replace` | `replace(text, old, new)` | string | Case-sensitive; replaces all occurrences |
| `slice` | `slice(text, start[, end])` | string | end is exclusive; negative index counts from end |
| `substring` | `substring(text, start[, length])` | string | Length-based, unlike `slice` |
| `trim` | `trim(text)` | string | Removes leading and trailing whitespace only |
| `toLower` | `toLower(text)` | string | — |
| `toUpper` | `toUpper(text)` | string | — |

### String recipes

```text
@trim(triggerBody()?['Name'])
@startsWith(toLower(triggerBody()?['Title']), 'urgent')
@endsWith(toLower(triggerBody()?['Email']), '@contoso.com')
@indexOf(triggerBody()?['Path'], '/')                  // first slash position; -1 if absent
@replace(triggerBody()?['Body'], '\n', '<br/>')        // newline → HTML break
@formatNumber(variables('total'), 'N2')                // "1,234.56"
@formatNumber(variables('price'), 'C2')                // "$1,234.56" (locale-aware)
@substring(triggerBody()?['Code'], 0, 3)               // first 3 chars
@slice(triggerBody()?['Code'], -4)                     // last 4 chars
```

---

## Collection functions

| Function | Signature | Returns | Gotcha |
|---|---|---|---|
| `contains` | `contains(collection, value)` | boolean | Works on arrays, objects (key check), and strings (substring check) |
| `empty` | `empty(collection)` | boolean | True for null, empty string, empty array, empty object |
| `first` | `first(collection)` | item | Throws on empty array — guard with `empty()` |
| `last` | `last(collection)` | item | Throws on empty array — guard with `empty()` |
| `intersection` | `intersection(a, b[, ...])` | array/object | Items present in ALL inputs |
| `join` | `join(array, delimiter)` | string | — |
| `reverse` | `reverse(array)` | array | — |
| `skip` | `skip(array, count)` | array | Returns empty array if count ≥ length |
| `sort` | `sort(array[, sortBy])` | array | `sortBy` is a property-name string for object arrays |
| `take` | `take(array, count)` | array | Returns all items if count > length |
| `union` | `union(a, b[, ...])` | array/object | Key collision → first argument wins (see `expressions.instructions.md`) |

### Collection recipes

```text
@empty(coalesce(body('Get_items')?['value'], createArray()))
@contains(variables('allowedStatuses'), triggerBody()?['Status']?['Value'])
@join(variables('tags'), ', ')
@sort(body('Get_items')?['value'], 'Title')
@skip(body('Get_items')?['value'], 10)             // page 2 (skip first 10)
@take(body('Get_items')?['value'], 5)              // top 5 only
@reverse(outputs('Compose_Steps'))                 // for saga rollback order
@last(body('Get_items')?['value'])?['ID']          // safe only after empty() check
```

---

## Logical comparison functions

| Function | Signature | Returns | Gotcha |
|---|---|---|---|
| `and` | `and(expr1, expr2[, ...])` | boolean | Each expression is a separate arg, not an array |
| `or` | `or(expr1, expr2[, ...])` | boolean | — |
| `not` | `not(expr)` | boolean | — |
| `if` | `if(condition, trueVal, falseVal)` | any | Both branches are **always evaluated** |
| `equals` | `equals(a, b)` | boolean | Case-sensitive for strings; null converts to `''` in comparisons |
| `greater` | `greater(a, b)` | boolean | Mixed types return false silently — convert first |
| `greaterOrEquals` | `greaterOrEquals(a, b)` | boolean | — |
| `less` | `less(a, b)` | boolean | — |
| `lessOrEquals` | `lessOrEquals(a, b)` | boolean | — |

### Null-in-comparisons gotcha

The platform converts `null` to `''` before comparing, so
`equals(field, null)` and `equals(field, '')` can both return true for an
absent field. Use `empty(coalesce(...))` instead:

```text
@empty(coalesce(triggerBody()?['Field'], ''))              // null-or-empty check
@if(empty(coalesce(triggerBody()?['Field'], '')), 'missing', triggerBody()?['Field'])
```

### `if()` recipes

```text
@if(empty(coalesce(variables('tag'), '')), 'untagged', variables('tag'))
@if(greater(int(triggerBody()?['Qty']), 0), 'in-stock', 'out-of-stock')
@if(equals(toLower(triggerBody()?['Status']?['Value']), 'approved'), true, false)
```

Do not use `if()` when one branch has a side effect (action call, mutation).
Use a `Condition` action instead — `if()` always evaluates both branches.

### Multi-condition recipes

```text
@and(
  greater(int(triggerBody()?['Qty']), 0),
  equals(toLower(triggerBody()?['Status']?['Value']), 'active')
)
@or(
  equals(triggerBody()?['Priority'], 'High'),
  equals(triggerBody()?['Priority'], 'Critical')
)
@not(empty(coalesce(triggerBody()?['Title'], '')))
```

---

## Math functions

| Function | Signature | Returns |
|---|---|---|
| `add` | `add(a, b)` | number |
| `sub` | `sub(a, b)` | number |
| `mul` | `mul(a, b)` | number |
| `div` | `div(a, b)` | number (integer division when both inputs are integers) |
| `mod` | `mod(a, b)` | remainder |
| `max` | `max(array)` or `max(n1, n2, ...)` | number |
| `min` | `min(array)` or `min(n1, n2, ...)` | number |
| `rand` | `rand(minInclusive, maxInclusive)` | random integer |
| `range` | `range(start, count)` | integer array |

```text
@mod(variables('counter'), 2)                         // 0 = even, 1 = odd
@max(createArray(int(x), int(y), int(z)))
@range(1, 5)                                          // [1,2,3,4,5]
@rand(1000, 9999)                                     // 4-digit random number
@mul(int(triggerBody()?['Qty']), int(variables('unitPrice')))
```

---

## Date and time functions

Functions not covered in `04-expressions-cookbook.md`:

| Function | Signature | Notes |
|---|---|---|
| `addHours` | `addHours(timestamp, hours[, format])` | — |
| `addMinutes` | `addMinutes(timestamp, minutes[, format])` | — |
| `addSeconds` | `addSeconds(timestamp, seconds[, format])` | — |
| `addToTime` | `addToTime(timestamp, n, unit[, format])` | unit: `Second` `Minute` `Hour` `Day` `Week` `Month` `Year` |
| `subtractFromTime` | `subtractFromTime(timestamp, n, unit[, format])` | Same units as `addToTime` |
| `getFutureTime` | `getFutureTime(n, unit[, format])` | Equivalent to `addToTime(utcNow(), n, unit)` |
| `getPastTime` | `getPastTime(n, unit[, format])` | Equivalent to `subtractFromTime(utcNow(), n, unit)` |
| `convertTimeZone` | `convertTimeZone(timestamp, fromTz, toTz[, format])` | Use Windows timezone names e.g. `'Singapore Standard Time'` |
| `convertToUtc` | `convertToUtc(timestamp, sourceTz[, format])` | — |
| `dateDifference` | `dateDifference(start, end)` | Returns ISO-8601 duration string — NOT a number |
| `dayOfMonth` | `dayOfMonth(timestamp)` | 1–31 |
| `dayOfWeek` | `dayOfWeek(timestamp)` | 0 = Sunday … 6 = Saturday |
| `dayOfYear` | `dayOfYear(timestamp)` | 1–366 |
| `startOfDay` | `startOfDay(timestamp[, format])` | Midnight of the timestamp's day (UTC) |
| `startOfHour` | `startOfHour(timestamp[, format])` | — |
| `startOfMonth` | `startOfMonth(timestamp[, format])` | First day of the month, midnight UTC |
| `parseDateTime` | `parseDateTime(text[, locale[, format]])` | Parses a string into a timestamp |

### Extended date recipes

```text
@addHours(utcNow(), 8)
@addMinutes(triggerBody()?['MeetingStart'], 30)
@getFutureTime(7, 'Day')
@getPastTime(30, 'Day')
@subtractFromTime(utcNow(), 1, 'Month')
@addToTime(utcNow(), 2, 'Week')
@startOfDay(utcNow())
@startOfMonth(utcNow())
@dayOfWeek(utcNow())                                  // 0=Sun 1=Mon … 6=Sat
@convertTimeZone(utcNow(), 'UTC', 'Singapore Standard Time', 'yyyy-MM-dd HH:mm')
@parseDateTime(triggerBody()?['DateString'], 'en-US')
```

`dateDifference` returns a duration string (`P1DT2H30M`), not a number. For a
numeric day count, use the `ticks` approach from `04-expressions-cookbook.md`:

```text
@div(
  sub(ticks(triggerBody()?['DueDate']), ticks(utcNow())),
  864000000000
)   // days remaining (864,000,000,000 ticks = 1 day)
```

---

## Workflow functions

| Function | Notes |
|---|---|
| `triggerBody()` | Shorthand for `trigger()?['body']` |
| `triggerOutputs()` | Full trigger output — includes `headers`, `body`, `statusCode` |
| `body('ActionName')` | Shorthand for `actions('ActionName')?['outputs']?['body']` |
| `outputs('ActionName')` | Full action output — includes `statusCode`, `headers`, `body` |
| `action()` | Current action's output at runtime (rarely needed outside advanced patterns) |
| `actions('ActionName')` | Any named action's full output object |
| `result('ScopeName')` | Array of child-action run records — see `01-error-handling.md` |
| `item()` | Current element inside a **`Filter array` or `Select` mapping** — NOT inside a Foreach body |
| `items('Foreach_Name')` | Current iteration object inside a **Foreach action body** |
| `iterationIndexes('Foreach_Name')` | 0-based index of the current Foreach iteration |
| `variables('VarName')` | Current value of an initialised variable |
| `parameters('ParamName')` | Flow-level parameter (from `properties.definition.parameters`) |
| `workflow()` | Object with `name`, `run.name`, `tags` — useful for telemetry logging |
| `listCallbackUrl()` | Callback URL for a Request trigger — use inside the trigger action only |

### `item()` vs `items()` — critical distinction

```text
// CORRECT: inside a Filter array or Select mapping expression
@filter(variables('records'), equals(item()?['Status']?['Value'], 'Active'))
@select(body('Get_items')?['value'], item()?['Title'])

// CORRECT: inside a Foreach action body
@items('Foreach_Records')?['Title']
@iterationIndexes('Foreach_Records')       // 0-based position in the loop

// WRONG: using item() inside a Foreach body → wrong scope, silent bad data
@item()?['Title']   // do NOT use inside a Foreach action
```

---

## Conversion functions

| Function | Notes |
|---|---|
| `int(value)` | String → integer. Throws if not parseable. |
| `float(value)` | String → float. Throws if not parseable. |
| `bool(value)` | `'true'`/`'false'` → boolean. Case-insensitive. |
| `string(value)` | Any → string. Converts null to `''`. |
| `json(text)` | JSON string → object/array. Throws on invalid JSON. |
| `array(value)` | Single value → single-element array. For multiple inputs use `createArray`. |
| `createArray(v1, v2, ...)` | Multiple values → array. |
| `base64(text)` | String → base64 string. |
| `base64ToString(b64)` | Base64 string → decoded string. |
| `decodeUriComponent(text)` | Decode a URL-encoded string. |
| `encodeUriComponent(text)` | Encode a string for safe use in a URL. |
| `decimal(text)` | Decimal string → decimal number (preserves precision). |

> **Implicit conversions**: the platform auto-converts non-string values to
> strings when a string is expected. Do not rely on this in expressions —
> always convert explicitly with `int()`, `float()`, `bool()`, or `string()`.

---

## JSON manipulation functions

Prefer these over `concat + json` for building or mutating objects —
they are safe against injection and handle quoting correctly.

| Function | Signature | Notes |
|---|---|---|
| `createObject(k1,v1, k2,v2, ...)` | — | Key-value pairs as alternating args |
| `addProperty(obj, key, value)` | — | Returns a new object with the property added |
| `setProperty(obj, key, value)` | — | Returns a new object with the property updated |
| `removeProperty(obj, key)` | — | Returns a new object with the property removed |
| `coalesce(v1, v2, ...)` | — | First non-null value |
| `xpath(xml, query)` | — | XPath expression over an XML string |

### JSON manipulation recipes

```text
// Add a correlation id before forwarding
@addProperty(triggerBody(), 'correlationId', guid())

// Stamp a processed timestamp
@setProperty(variables('record'), 'ProcessedAt', utcNow())

// Strip an internal field before calling a downstream API
@removeProperty(triggerBody(), 'internalRef')

// Chain: update status and strip a field in one expression
@removeProperty(
  setProperty(triggerBody(), 'status', 'Processed'),
  'rawPayload'
)
```

Prefer `createObject` when building from scratch — see the `createObject`
recipe in `04-expressions-cookbook.md` → *Building dynamic JSON for HTTP / API calls*.

---

## URI parsing functions

Useful when processing webhook callback URLs or Link headers.

| Function | Returns |
|---|---|
| `uriHost(uri)` | Hostname |
| `uriPath(uri)` | Path component |
| `uriPathAndQuery(uri)` | Path + query string |
| `uriPort(uri)` | Port number |
| `uriQuery(uri)` | Query string |
| `uriScheme(uri)` | Scheme (`https`, etc.) |

```text
@uriHost(triggerOutputs()?['headers']?['Referer'])
@uriQuery(triggerBody()?['callbackUrl'])
@concat('https://api.contoso.com/items?id=', encodeUriComponent(variables('itemId')))
```

---

## See also

- `expressions.instructions.md` — null safety, `split`, `union`, SharePoint column shapes, type discipline, `if()`, loop context functions
- `04-expressions-cookbook.md` — paste-ready recipes for the most common patterns
- [Full function reference on Microsoft Learn](https://learn.microsoft.com/en-us/azure/logic-apps/expression-functions-reference)
