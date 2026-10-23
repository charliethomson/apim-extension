# Guide

A tour of the extension by task. The [README](../README.md) has install and settings, the
[reference](reference.md) lists every command, setting and quick fix, and
[fragment headers](fragment-headers.md) is the full header format.

To see most of it at once, open `test/fixtures/apiops/` from this repo: the `random-user`
fragment has a complete header with typedefs, and `apis/random-users/policy.xml` calls it.

## Getting a file recognised

Files named `*.policy.xml` are always policies. Any other `.xml` file becomes one when its root
element is `<policies>` or `<fragment>`, which covers the APIOps `policy.xml` layout, or when it
matches a glob in `apimPolicy.files.include`. The language mode in the status bar reads
**APIM Policy** when it worked. Both the escaped `xml` format and the portal's `rawxml` format
work.

## Writing policies

Inside `<inbound>`, `<backend>`, `<outbound>` and `<on-error>`, completion offers the policies
allowed in that section, then their attributes, values and child elements. Type `apim-` for
snippets of common policies. Hover a policy or attribute for its docs.

Diagnostics come from the policy catalog: unknown policies, a policy in a section it isn't allowed
in, missing or invalid attributes, wrong child elements, and the fragment rules (no sections, no
`<base />`, no nested `include-fragment`).

## Writing C# expressions

`@( … )` and `@{ … }` get completion, hover, signature help and errors from the built-in C#
engine, which knows `context` and the types APIM allows. It checks what the gateway checks
when you save a policy:

- types and members outside APIM's allowlist are errors (`apimPolicy.allowedTypes.severity`),
  including ones only reached through inference, like a `var` holding an `IGrouping`;
- syntax newer than C# 7.3 (switch expressions, `is not`, `new()`) and members .NET Framework
  doesn't have are flagged;
- a `set-variable` value must be a type a variable can hold, a `condition` must be a `bool`, and
  a `@{ … }` block must return on every path.

Go to Definition on a C# symbol opens its declaration, or the stub that describes it.

## Variables

`context.Variables["…"]` and `GetValueOrDefault<T>("…")` complete the variables known at that
point: set earlier in the file, set by fragments it includes, and, inside a fragment, set by the
policies that include it. Hover a name to see where it's set.

Reading a variable that may not be set throws at run time. Set
`apimPolicy.lint.unguardedVariableAccess` to `information` or `warning` to flag those reads,
with a quick fix that rewrites each one to `GetValueOrDefault`.

## Fragments

A comment at the top of a fragment documents it. `@in` lines are the variables it takes, `@out`
lines the ones it hands back, and `@internal` lines the ones it keeps to itself:

```xml
<!--
    Looks a user up by id.

    @in  {string} lu-arg-id           The user id.
    @in  {int}    [lu-arg-timeout=10] Seconds to wait.

    @out {string} lu-ret-name         The user's display name.
    @internal     lu-int-*
-->
<fragment>
    …
</fragment>
```

To start one, type `<!--` above `<fragment>` and pick **Fragment header**, or use **Add a header
documenting @in and @out** on the `<fragment>` tag. Either one drafts the header from what the
fragment reads and sets, with types and defaults from the code. Format Document lines it up.

Once a fragment has a header:

- each `include-fragment` of it shows the inputs as an inlay hint, and hover lists them;
- an include whose required inputs nothing sets gets a warning and a quick fix that sets them
  just above it; **Set every input of '…'** stubs all of them, optional ones included;
- the fragment is checked against its header: an `@in` it never reads, an `@out` it doesn't set
  on every path, a variable it reads or sets that the header doesn't mention;
- a caller reading one of its `@internal` variables gets a warning.

Ctrl/Cmd+click a fragment id to open the fragment, or a `set-variable` name to open the `@in`
it sets.

## JSON shapes

`JObject` and `JArray` values are untyped in C#, so the extension tracks their keys itself. A
`set-variable` that builds `new JObject { ["id"] = id, ["age"] = 30 }` makes later reads of that
variable complete `["id"]` and `["age"]` with their types, in the same file and in every file
that includes the fragment.

A header can declare a shape with `@typedef` and `@property`:

```xml
<!--
    @typedef User  A user as this fragment returns them.
    @property {string}   id      The login uuid.
    @property {int}      [age]
    @property {string[]} phones

    @out {User[]} lu-ret-users
-->
```

Building a declared variable is then checked against its shape: unknown keys, missing required
keys and values of the wrong kind get warnings, and `["…"]` inside the `new JObject { … }`
completes the keys still to write. Hover a typedef name for a filled-in example, and
Ctrl/Cmd+click it to jump to its `@typedef`.

You rarely need to write typedefs by hand:

- **Generate a @typedef for '…'** on a tag typed `JObject`, `JObject[]` or nothing, writes one
  from the shape the code builds;
- **Extract this JObject shape to a @typedef** on any `new JObject { … }`;
- **Fill in '…'** on an empty `set-variable` value for a typed variable writes the whole value,
  with `// optional` on the keys that can go.

## Formatting

Format Document and Format Selection re-indent elements with the editor's tab settings, and the
C# inside multi-line expressions by its brackets. Only indentation and line breaks change.
Fragment headers are laid out in columns.

## Working with an instance

**APIM: Connect to an Instance** signs in with your Microsoft account and picks an API
Management service. The **API Management** view in the activity bar then browses its policies,
fragments, named values and backends. Fragments, named values and backends also feed completion
and checks in local files, and variables set by broader scopes (products, global) count as set.

Policies from the instance open read-only. **Open as Editable** gives a copy you can change.
Saving it keeps a draft in memory, and **Push to Instance** shows a diff against what's live
before anything is written. Pushing is off until you allow the instance. The README covers the
[connection](../README.md#connecting-an-apim-instance) and
[push](../README.md#pushing-a-policy) steps in detail.

## Docs for fragments

**APIM: Generate Docs** previews a Markdown page for the open policy or fragment: inputs,
outputs, a usage snippet, types, dependencies and who includes it. **APIM: Write Fragment Docs**
writes one beside every fragment in the workspace, replacing only files it wrote before.
