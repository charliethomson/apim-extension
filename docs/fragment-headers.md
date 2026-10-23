# Fragment headers

A policy fragment works on context variables, in three kinds: **arguments** the caller sets
before `<include-fragment>`, **returns** the caller reads after it, and **internals** the fragment
uses for itself. APIM doesn't scope variables, so nothing but the header says which is which. A
fragment header documents them, in the comment just before `<fragment>` (or the first thing
inside it):

```xml
<!--
    Signs the outgoing request with an HMAC of the URL.

    @in  {string} sig-key        The HMAC key.
    @in  {int}    [sig-ttl=300]  Seconds the signature holds.
    @in           [sig-scope]    Narrows what the signature covers.

    @out {string} sig-header  The value for the Authorization header.
                              A description continues on the next lines.

    @internal {JObject} sig-parts  What gets signed.
    @internal           sig-tmp-*
-->
<fragment>
    ...
</fragment>
```

## Format

The shape is JSDoc's `@param`, with `@in`, `@out` and `@internal` for the three kinds.

- **`@in {type} name description`**: a variable the caller sets before the include.
  `[name]` makes it optional; `[name=value]` also says what the fragment does without it.
- **`@out {type} name description`**: a variable the fragment sets for the caller to read.
  Outputs can't be optional.
- **`@internal {type} name description`**: a variable the fragment sets for its own use. The name
  can be a pattern: `sig-tmp-*` covers every variable with that prefix, and `@internal *` every
  variable the header doesn't otherwise mention. A line naming one variable still gives it a
  type and description when a pattern covers it too.
- **`{type}`** is optional, and free text: a C# type the value has (`string`, `int`, `JArray`).
- **The description** runs to the end of the line, and continues on following lines that don't
  start with `@`. A blank line ends it.
- **Text before the first tag** is the fragment's summary.

Variable names are what `set-variable` accepts: letters, digits, `_`, `.` and `-`.

## JSON shapes

A `{type}` can describe a JSON value: a name given by `@typedef`, an array of one, or an inline
object type:

```xml
<!--
    @typedef User  A user as this fragment returns them.
    @property {string}   id              The login uuid.
    @property {string}   email
    @property {int}      [age]
    @property {string[]} phones
    @property {JObject}  address
    @property {string}   address.city

    @in  {{ results: int, seed?: string }} ru-arg-options
    @out {User[]}                          ru-ret-users
-->
```

`@typedef Name` starts a type, with an optional description after the name, and the `@property`
lines under it are its keys: `{type}`, the key (`[key]` when it's optional), then a description.
A dotted key (`address.city`) is a key of a nested object. Descriptions show in completion,
hover and the generated docs.

Inline object types are `{ key: type, … }` (`key?` for an optional key, `"odd key"` in quotes),
arrays are `T[]` or `JArray<T>`, and the scalars are the C# ones (`string`, `int?`, `bool`,
`DateTime`). An older one-line typedef, `@typedef {{ … }} Name`, still works, and the refactor
**Write Name as @property lines** converts it.
The fragment's own expressions and every caller then know that
`((JArray)context.Variables["ru-ret-users"])[0]["email"]` is a string: keys complete inside
`["…"]` with their types, and hover shows them.

Where a variable has a declared shape, building it is checked against it: a caller setting an
`@in` of a fragment it includes, and a fragment setting its own `@out`s and `@internal`s. Inside the
`new JObject { … }` that builds it (and every `new JObject` nested in its arrays), `["…"]` completes
the keys still to write, required first; hover shows each key's type; and a warning marks a key the
shape doesn't have, a required key that's missing, and a value of the wrong kind (`"60"` where an
`int` is wanted). Warnings, since the gateway accepts any JSON: they mean the fragment won't get
what it expects.

Hover a `@typedef` name in the header (where it's defined or used in a tag) to see the shape and
a value of it with every key filled in, as JSON and as the `new JObject { … }` that builds it. Go to
Definition on a typedef name in a tag's `{type}` (an `@in`, `@out`, `@internal` or `@property`)
jumps to its `@typedef` line. On an
`include-fragment`, the quick fix **Set every input of '…'** adds a `set-variable` for each input
nothing earlier sets: its default if it has one, else an empty value of its type, with a JSON input
built out key by key (`new JObject { … }`, `new JArray { … }`) and `// optional` after each key the
shape doesn't require.

A single `set-variable` whose value is still empty (`value=""`, `value="@()"`) gets the same value
two ways: completion in the empty value, and the quick fix **Fill in '…'**. Go to Definition on a
`set-variable`'s name jumps to where the variable is declared: the `@in` of the fragment it's for,
or the fragment's own `@out` or `@internal` line.

On any `new JObject { … }` in a fragment, **Extract this JObject shape to a @typedef** (a refactor
in the lightbulb) adds a `@typedef` with a `@property` line per key to the header, making one if
needed, named for the variable it builds and with the cursor on the name. On a header tag whose
type is a bare `JObject`, `JArray` or `JToken`, an inline shape, or missing, while the code shows
the shape, the quick fix **Generate a @typedef for '…'** does the same from that shape (an
`@internal {JObject[]} ru-int-kept` becomes `{Kept[]}` plus `@typedef Kept`), with an array of
objects inside it getting a typedef of its own.

Variables nobody documents get shapes too, from the code that builds them, so internal ones need
no header:

```xml
<set-variable name="something" value="@{
    var result = 42;
    return new JObject { ["someData"] = result };
}" />
<!-- (int?)((JObject)context.Variables["something"])?["…"] completes someData: int -->
```

A fragment hands these to the files that include it: its `@out`s (or, without a header,
everything it sets) carry their shapes into the caller, declared or worked out from its code,
through nested includes. **Add a header documenting @in and @out** and the `<!--` and `@`
expansions write the worked-out shape as `@typedef`s and use them as the type
(`@out {ShResult} sh-result`), so the drafted header documents it too.

What's followed: `new JObject { ["k"] = v }`, `o["k"] = v`, nested objects, `new JArray(items)`,
`.Select(x => new JObject { … })`, and back out through indexing, `foreach`, `OfType<JObject>()`,
casts and `GetValueOrDefault<JObject>("x")`. Keys built at run time and `JObject.Parse` of
runtime text give no shape. A shape only adds completion and hover: JSON objects are open, so a
key it doesn't list isn't an error.

## Shape

Format Document lays a header out the same way every time: `<!--` and `-->` on their own lines,
the summary, then each run of `@typedef`, `@in`, `@out` and `@internal` lines, each group after a
blank line and lined up in columns (tag, type, name, description), a typedef's `@property` lines
straight under it, with a description's later lines under its first.
A name longer than 32 characters runs past its column instead of pushing the others out. Only
whitespace changes, and a header that has anything else in it (text after the tags, a malformed
tag) is left as written.

## Writing one

- Type `<!--` above an undocumented `<fragment>` (or as the first thing in it) and pick
  **Fragment header**: it expands to a header drafted from the fragment. What it reads without
  setting becomes `@in`. What it sets becomes `@out` if a file that includes it reads it, and
  `@internal` otherwise, with three or more sharing a prefix folded into one pattern
  (`@internal ru-int-*`). Types come from the code: a cast, `GetValueOrDefault<T>`, a literal, or
  the JSON shape it builds. An input read only through `GetValueOrDefault` (or after a
  `ContainsKey` check) is optional, and when every read passes the same literal fallback that's its
  default: `GetValueOrDefault<bool>("x", false)` drafts `@in {bool} [x=false]`. The quick fixes that
  add one tag line work the same way, and leave the cursor on its description.
- At the start of a line in the header, `@` offers an `@in` line for each variable the fragment
  reads but the header leaves out, an `@out` and an `@internal` line for each it sets, then blank
  `@in`, `@in [optional]`, `@out`, `@internal`, `@typedef` and `@property` lines with tab stops.
- **Add a header documenting @in and @out** on `<fragment>` (the lightbulb) does the same as the
  `<!--` expansion.

## What the extension does with it

Where the fragment is included (the workspace file with that id, else the connected instance's
fragment; an open **Open as Editable** copy stands in for the instance's until it's closed, so
callers see edits before they're pushed):

- **A warning** when the caller reads one of the fragment's internals (an `@internal`, or anything
  a documented fragment sets but doesn't declare `@out`): it depends on how the fragment works
  inside, and the fragment is free to change that. Ask for an `@out` instead.
- **A warning** on the include when one of the fragment's internals overwrites a variable of the
  same name that the caller set before the include and reads after it.

- **An inlay hint** after `<include-fragment>`: `in: sig-key, sig-ttl?, sig-scope? · out: sig-header`.
  Hover a name for its type and description.
- **Hover** on `fragment-id` shows the summary and every input and output.
- **Completion of arguments**: in `set-variable`'s `name` (and any `*-variable-name` attribute),
  the inputs of the fragments the file includes come first, required before optional, each with its
  type, default and description.
- **A warning** when a required `@in` isn't set earlier in the file, by `set-variable`, as an
  `@out` of an earlier include, or (with an instance connected) by a broader scope; the inlay hint
  then starts `missing: sig-key ·`. A quick fix adds the missing `set-variable` lines above the
  include. Where products or the global policy set inputs and no instance is connected to show
  it, set `apimPolicy.lint.missingInput` to `information` (or `off`).
- **Completion** of `context.Variables["…"]` offers the fragment's `@out`s with their types and
  descriptions, and only those: a documented fragment's other variables are its own business.

In the fragment:

- **Completion** offers its own `@in`s in `context.Variables["…"]`, and its own `@out`s where it
  names a variable to set.
- **Warnings** for an `@out` it never sets, an `@out` it doesn't set on every path, an `@in` it
  never reads, a malformed tag, and a `@property` with no `@typedef` above it (or a key listed
  twice); **information** for a variable it reads but neither sets nor
  documents (with a quick fix that adds its `@in` line), an `@internal` nothing sets, and a
  variable it sets that the header doesn't declare. A fragment without a header isn't checked.
- A new variable is the moment to say what it is. The quick fixes on an undeclared one document
  it as `@internal` or `@out` (with the type the code shows), document every undeclared variable
  as its own typed `@internal` line at once (Tab moves through their descriptions), or opt a
  family out with a pattern: `@internal ru-int-*` for its prefix, or `@internal *`.
- An `@out` set only on some paths (in one `<when>`, say) leaves the caller reading whatever it
  held before the include: a stale value from an earlier call, or nothing, which throws. Set every
  output up front and overwrite it later, as `random-user` does in its bookkeeping
  block; the quick fix adds `<set-variable name="x" value="…" />` at the start of the fragment,
  with an empty value of the output's type. A `<choose>` counts when every branch sets it (and it
  has an `<otherwise>`), and a branch that ends in `<return-response>` doesn't need to.

## Docs from the header

**APIM: Generate Docs** turns a fragment into Markdown: the summary, an inputs table (type,
required or the default, description), an outputs table, a usage snippet that sets the required
inputs, its `@typedef`s and `@internal`s, what it depends on and the files that include it. Types
the header leaves out come from the code (a JSON shape, a cast). It opens as a preview and writes
nothing. **APIM: Write Fragment Docs** writes one beside each fragment in the workspace, so the
docs live with the extract; a file that doesn't start with the generator's marker comment is never
replaced.

## Reading a variable that may be unset

`context.Variables["x"]` throws `KeyNotFoundException` when `x` isn't set, and an optional `@in`
is exactly a variable that may not be. With `apimPolicy.lint.unguardedVariableAccess` set to
`information` or `warning` (it's `off` by default), such reads are flagged unless `x` is definitely
set by then:

- an earlier `set-variable` or `*-variable-name` in the same `<when>`/`<otherwise>` branch, or
  outside any `<choose>` (a set in a sibling branch may not have run). `cache-lookup-value` only
  counts with a `default-value`, since a miss sets nothing;
- an earlier include's `@out` (or, for a fragment without a header, anything it sets);
- a required `@in` of the fragment being read in;
- a check in the same expression or an enclosing `<when>`: `ContainsKey("x")`,
  `TryGetValue("x", …)` or `GetValueOrDefault("x") != null`;
- the cache idiom: a `<when>` on `!ContainsKey("x")` that sets `x` leaves it set after its `<choose>`.

A `retry` condition sees what the retry's children set, since it runs after them. The quick fix
rewrites the read to `context.Variables.GetValueOrDefault<T>("x")`, keeping a cast's `T`.

Correlated conditions are beyond it: a variable set only on the success path and read under
`status == "ok"` is still flagged. Across Microsoft's policy samples it flags 4 reads in 59
files, mostly fragments without a header reading what their callers set; documenting those as
required `@in`s silences them.
