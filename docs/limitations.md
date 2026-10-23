# Known limitations

What the extension doesn't do, or does approximately. The [README](../README.md) is the overview.

- The engine is a subset of the compiler. It reports syntax errors, unknown names and
  members, argument counts and types, failed implicit conversions, missing returns, static/instance
  mix-ups and a few operator errors, but not definite assignment, unreachable code or invalid
  casts. Overload resolution and type inference follow the spec loosely. Constant conditions only
  count when they're the literal `true`.
- The model covers the allowlisted types and the types their members mention. Types
  outside it bind as unknown and get no completion.
- Newer syntax is recognised in its common forms and reported once; less common C# 8+ features
  (default interface members, `init`, records) don't parse and show as syntax errors instead.
- APIM documents the allowed types as .NET Framework types, so members .NET Framework 4.8 lacks
  are warnings, not errors: a gateway on a newer runtime may accept them. Setting
  `apimPolicy.allowedTypes.severity` explicitly applies it to them too.
- `context.GraphQL.Arguments` and `Parent` are indexed as `JToken`. APIM doesn't document their
  type; `JToken` fits how its resolver examples use them.
- An expression that is still unbalanced while you type (an open string, a missing `)`) isn't
  recognised until it closes, so C# completion pauses there.
- `Func<>`/`Action<>` delegates are flagged because the documented allowlist omits them, though
  the gateway may accept them.
- Without an instance connected, named values come from `{{…}}` usage in the workspace and APIOps
  `namedValues/` folder names. Display names in `namedValueInformation.json` and Bicep/ARM
  templates aren't read. With one connected, the instance's names and plain values are used;
  secret values are never fetched.
- JSON shapes only follow keys written as literals. Keys built at run time, `JObject.Parse` of
  runtime text and objects that pass through untyped helpers give no shape, so they get no key
  completion or checks.
- A `.xml` file is recognised by its content only when its root element starts within the first
  64 KB, so comments before it (a long fragment header) can't run past that.
- Highlighting in the escaped `xml` format treats `&quot;…&quot;` as code, not as a C# string.
- Formatting changes indentation and line breaks between elements only. Inside expressions it
  re-indents C# by bracket nesting but doesn't change spacing within a line, wrap long lines or
  move braces. A document with unclosed elements isn't formatted.


# Things that will bite you

Notes for working on the extension.

- **Token types in `package.json` matter.** The embedded C# regions are marked as code so
  suggestions trigger as you type in attribute values. Strings and comments nested in them must
  stay strings and comments, or the bracket colouriser flags every `>` inside a string.
