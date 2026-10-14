# apim-extension

**Editor support for Azure API Management policy files, including the C# inside them.**

A VS Code extension for APIM policy documents (`<policies>`) and policy fragments
(`<fragment>`). It reads them with its own tolerant parser, so the `rawxml` format the portal
and APIOps produce works as well as the escaped `xml` format, and it gives the C# policy
expressions (`@(...)` and `@{...}`) real IntelliSense, either from its own built-in C# engine or by
handing them to the C# extension.

[Versioning](VERSIONING.md) · [Design](PLAN.md) · [Standards](standards/)

<!-- screenshot: completion of context.Request members inside an attribute expression -->
<!-- screenshot: structural diagnostics on a policy in the wrong section -->
<!-- screenshot: known-variable completion in context.Variables["…"] -->

## How it works

Every feature starts from the same parse of the policy file:

```
policy.xml ──► tolerant parser ──► elements, attributes, expressions (with source maps)
                                      │
           ┌──────────────────────┬───────┴──────────────┬──────────────────────┐
           ▼                      ▼                      ▼                      ▼
   policy catalog          built-in C# engine     shadow C# file          workspace index
   (data/policies.json)    (data/csharp-model)    (one method per expr)   (fragments, variables,
   → diagnostics, XML      → completion, hover,   → C# extension: the     named values)
     completion, hover       signatures, errors     same, from Roslyn     → navigation, known names
```

- **Parser.** A hand-written XML scanner hands off to a small C# lexer at `@(` or `@{`. The lexer
  owns the input until the balanced close, so `"`, `<` and `&&` inside an expression can't break
  the XML structure. The lexer reads an entity-decoded view, so `&quot;)&quot;` in the escaped
  format behaves like `")"` in rawxml. Each expression carries a source map back to the file.
- **Catalog.** `data/policies.json` lists each policy's allowed sections, attributes (required,
  enum, expression-capable) and child elements. Validation and XML completion are driven
  entirely by it.
- **Built-in C# engine.** `src/csharp/lang/` is a C# 7.3 lexer, a tolerant parser for expressions
  and statement blocks, and a binder that resolves names, members, overloads, generic type
  arguments and lambda parameter types. It binds against `data/csharp-model.json` (the public
  surface of the allowlisted BCL and Newtonsoft types, with doc summaries) and the stubs. Binding
  takes the cursor offset and records what completion, hover and signature help need as it passes
  it, so one walk answers each request. Anything the model can't see binds to an unknown type that
  converts to everything, so gaps in the model stop inference instead of producing errors.
- **C# extension.** For each open policy the extension writes a hidden C# file to its global storage. The
  file has one static method per expression, taking `IProxyRequestContext context`, plus the stubs
  from `stubs/ApimContext.cs`. With the .NET 10 SDK installed it's a file-based app with a
  `#:package Newtonsoft.Json` directive, which the C# server loads as a real project. Requests at
  a position inside an expression are forwarded to the C# extension against that file, and the
  results are mapped back. Type errors are pulled from the server, because it doesn't push them
  for documents that aren't shown.
- **Which one answers.** `apimPolicy.csharp.mode` picks. In `auto`, the C# extension is used when
  it's installed and the workspace is trusted, and the built-in engine otherwise. In `builtin`, the
  C# extension is never started. The built-in engine also supplies type errors in `virtual` mode,
  where the server can't.
- **Allowlist.** Expressions are checked against APIM's documented type allowlist
  (`data/allowed-types.json`): syntactically on every change, and semantically through whichever
  C# implementation is active. Built-in completion hides what the allowlist forbids.

Without the C# extension, everything still works, through the built-in engine.

## Features

- **Language:** `*.policy.xml` files are APIM policies. Other `.xml` files switch over when their
  root is `<policies>` or `<fragment>` (APIOps' `policy.xml`), or when they match
  `apimPolicy.files.include`. Ordinary XML is left alone.
- **Highlighting:** XML with C# highlighting inside expressions, and `{{named values}}` marked.
- **Diagnostics:** parse errors, unknown policies, policies in the wrong section, missing or
  invalid attributes, child element rules, and the fragment rules (no sections, `base` or
  nested `include-fragment`). C# syntax and type errors and allowlist warnings appear on the
  expression.
- **Completion:**
  - policies allowed in the current section, child elements, attributes and values
  - fragment ids and named values
  - C# inside expressions: members, extension methods (LINQ, the APIM helpers), types and
    namespaces, locals and lambda parameters with their inferred types
  - known variable names in `context.Variables["…"]` and `GetValueOrDefault<T>("…")`, including
    variables set by included fragments and, inside a fragment, by the policies that include it
  - snippets: type `apim-` to list them
- **Hover and navigation:**
  - hover docs for policies, attributes, `context` members and variables
  - signature help for C# methods and constructors
  - go-to-definition from `include-fragment` to the fragment file, from a variable name to its
    `set-variable`, from a C# local to its declaration, and from C# symbols into the stubs

## Install

Install **Azure APIM Policies** (`thmsn-dev.apim-policy`) from the
[Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=thmsn-dev.apim-policy),
or build a `.vsix` and install it:

```bash
npm ci
```

```bash
npm run package
```

```bash
code --install-extension apim-policy-*.vsix
```

Releases are published to the Visual Studio Marketplace by
[`.woodpecker/extension.release.yml`](.woodpecker/extension.release.yml) when a `v*` tag is pushed
(see [VERSIONING.md](VERSIONING.md)).

C# IntelliSense works out of the box with the built-in engine. For Roslyn's full semantics instead,
install the C# extension (`ms-dotnettools.csharp`) and the .NET 10 SDK, since the shadow file is a
.NET 10 file-based app. With the C# extension but no SDK, completion and hover come from the
server and type errors from the built-in engine. The language status item for APIM policies shows
which mode is active. In Restricted Mode (an untrusted workspace) the C# extension isn't used,
because it would restore a generated project from NuGet, and the built-in engine takes over.

### Settings

| Setting | Default | |
|---|---|---|
| `apimPolicy.files.include` | `[]` | Extra globs for policy files, e.g. `**/policies/**/*.xml` |
| `apimPolicy.files.detectByContent` | `true` | Treat XML with a `<policies>`/`<fragment>` root as a policy |
| `apimPolicy.csharp.enabled` | `true` | C# features inside expressions |
| `apimPolicy.csharp.mode` | `auto` | `builtin`, `file` (C# extension and .NET 10 SDK), `virtual` (C# extension, completion only) or `auto` |
| `apimPolicy.allowedTypes.severity` | `warning` | Severity of allowlist findings, or `off` |

## Layout

```
src/parser/     tolerant parser, C# lexer, entity decoding, position queries
src/policy/     catalog types, validator, XML completion, variable analysis
src/csharp/     shadow generation, C# backend, result mapping, allowlist lint
src/csharp/lang/  built-in C# engine: lexer, parser, type model, stub reader, binder, editor features
src/features/   VS Code providers that wire the above to the editor
src/sourceMap.ts  offset maps shared by the parser and the shadow file
data/           policy catalog, allowlist, generated BCL type index and C# type model
stubs/          C# stubs for context and APIM's helper methods (shipped, read at runtime)
syntaxes/       TextMate grammar and the C# injection
snippets/       policy snippets
tools/          generators for data/bcl-types.json and data/csharp-model.json
test/unit/      vitest suites; test/fixtures/ holds the sample policies
test/integration/  VS Code + C# extension end-to-end suite
test/stubs/     a tiny project that compiles the stubs at C# 7.3
test/spike/     the request-forwarding spike, kept for reference
standards/      vendored engineering standards (git submodule)
```

## Development

[`.woodpecker/extension.ci.yml`](.woodpecker/extension.ci.yml) is the gate. It runs these, so
passing them locally means passing CI:

```bash
npm run typecheck
```

```bash
npm test
```

```bash
npm run test:integration
```

```bash
npm run test:integration:builtin
```

```bash
dotnet build test/stubs
```

CI also packages the `.vsix` and runs `npm audit`, which only fails on critical advisories. The
coverage floor (80%, in `vitest.config.ts`) covers the parser, source maps, policy logic, the
pure C# helpers and the built-in engine. The VS Code glue in `src/features/` is covered by the
integration suite instead, which runs twice: with the C# extension, and with every other extension
disabled so the built-in engine answers.

The unit tests run in milliseconds. The integration suite downloads VS Code and the C# extension
into `.vscode-test/` on first run, then runs on a temporary copy of `test/fixtures/`. Set
`APIM_DEBUG=1` to mirror the extension's log to the console. To try the extension by hand, use
**Run Extension** from VS Code or `code --extensionDevelopmentPath=.` on a folder of policies.

`data/bcl-types.json` and `data/csharp-model.json` are generated from the installed .NET reference
assemblies and their doc files. Regenerate them after changing the allowlist:

```bash
dotnet run tools/gen-bcl-types.cs
```

```bash
dotnet run tools/gen-csharp-model.cs
```

`data/policies.json` and `data/allowed-types.json` are hand-maintained from the Learn policy
reference and the policy expressions page.

## Things that will bite you

- **The shadow file must be a `file:` URI.** VS Code's storage URIs can use the
  `vscode-userdata:` scheme. The C# server treats those as loose files with no semantics, so type
  errors silently disappear.
- **Don't add `LangVersion=7.3` to the shadow.** It rejects the top-level statement that makes
  the file a file-based app, and the server falls back to a loose file without Newtonsoft.
- **Completion items from the C# extension can't be mutated.** Mapped items have to be copied
  into new `CompletionItem`s, or VS Code drops them for having ranges in the wrong file.
- **Token types in `package.json` matter.** The embedded C# regions are marked as code so
  suggestions trigger as you type in attribute values. Strings and comments nested in them must
  stay strings and comments, or the bracket colouriser flags every `>` inside a string.

## Known limitations

- C# extension diagnostics go through its `experimental.sendServerRequest` export, which an
  update could change. Behaviour with C# Dev Kit installed hasn't been tested.
- The built-in engine is a subset of the compiler. It reports syntax errors, unknown names and
  members, wrong argument counts, static/instance mix-ups and a few operator errors, but not
  failed conversions, definite assignment or missing returns. Overload resolution and type
  inference follow the spec loosely, and LINQ query syntax (`from x in ...`) isn't parsed.
- The built-in model is the .NET 10 surface of the allowlisted types and the types their members
  mention, so it offers members .NET Framework doesn't have. Types outside it bind as unknown and
  get no completion.
- The C# 7.3 limit of policy expressions isn't enforced, so newer syntax isn't flagged.
- An expression that is still unbalanced while you type (an open string, a missing `)`) isn't
  recognised until it closes, so C# completion pauses there.
- The allowlist lint's syntactic pass can't see instance members whose receiver type isn't
  written out. The semantic pass covers those when the C# extension is available.
- `Func<>`/`Action<>` delegates are flagged because the documented allowlist omits them, though
  the gateway may accept them.
- Named values come from `{{…}}` usage in the workspace and APIOps `namedValues/` folder names.
  Display names in `namedValueInformation.json`, Bicep/ARM templates and live APIM instances aren't read.
- Highlighting in the escaped `xml` format treats `&quot;…&quot;` as code, not as a C# string.
- With format-on-save (or another save participant) enabled for C#, the hidden shadow file is
  left unsaved after edits so the participant can't rewrite it. Hot exit backs it up quietly.
- Formatting isn't implemented.

## Licence and attribution

The code is MIT licensed ([LICENSE](LICENSE)). The policy catalog (`data/policies.json`), the
allowlist (`data/allowed-types.json`) and the doc comments in `stubs/ApimContext.cs` are
paraphrased from the [Azure API Management documentation](https://learn.microsoft.com/azure/api-management/)
([MicrosoftDocs/azure-docs](https://github.com/MicrosoftDocs/azure-docs), CC BY 4.0). They aren't
affiliated with or endorsed by Microsoft. The grammars in `test/grammars/` are MIT-licensed copies
used only by the tests; see [their notice](test/grammars/NOTICE).

## Docs

- [PLAN.md](PLAN.md): the design, and the request-forwarding spike results.
- [VERSIONING.md](VERSIONING.md): how the version is derived.
- [SHORTCUTS.md](SHORTCUTS.md): operational shortcuts (none yet).

Conventions: [`AGENTS.md`](AGENTS.md) and the [`standards/`](standards) submodule.
