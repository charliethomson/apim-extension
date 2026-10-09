# apim-extension

**Editor support for Azure API Management policy files, including the C# inside them.**

A VS Code extension for APIM policy documents (`<policies>`) and policy fragments
(`<fragment>`). It reads them with its own tolerant parser, so the `rawxml` format the portal
and APIOps produce works as well as the escaped `xml` format, and it gives the C# policy
expressions (`@(...)` and `@{...}`) real IntelliSense by handing them to the C# extension.

[Versioning](VERSIONING.md) · [Design](PLAN.md) · [Standards](standards/)

<!-- screenshot: completion of context.Request members inside an attribute expression -->
<!-- screenshot: structural diagnostics on a policy in the wrong section -->
<!-- screenshot: known-variable completion in context.Variables["…"] -->

## How it works

Every feature starts from the same parse of the policy file:

```
policy.xml ──► tolerant parser ──► elements, attributes, expressions (with source maps)
                                      │
           ┌──────────────────────────┼───────────────────────────┐
           ▼                          ▼                           ▼
   policy catalog            shadow C# file per policy       workspace index
   (data/policies.json)      (one method per expression)     (fragments, variables,
   → diagnostics, XML        → C# extension: completion,      named values)
     completion, hover         hover, signatures, type errors  → navigation, known names
```

- **Parser.** A hand-written XML scanner hands off to a small C# lexer at `@(` or `@{`. The lexer
  owns the input until the balanced close, so `"`, `<` and `&&` inside an expression can't break
  the XML structure. The lexer reads an entity-decoded view, so `&quot;)&quot;` in the escaped
  format behaves like `")"` in rawxml. Each expression carries a source map back to the file.
- **Catalog.** `data/policies.json` lists each policy's allowed sections, attributes (required,
  enum, expression-capable) and child elements. Validation and XML completion are driven
  entirely by it.
- **C#.** For each open policy the extension writes a hidden C# file to its global storage. The
  file has one static method per expression, taking `IProxyRequestContext context`, plus the stubs
  from `stubs/ApimContext.cs`. With the .NET 10 SDK installed it's a file-based app with a
  `#:package Newtonsoft.Json` directive, which the C# server loads as a real project. Requests at
  a position inside an expression are forwarded to the C# extension against that file, and the
  results are mapped back. Type errors are pulled from the server, because it doesn't push them
  for documents that aren't shown.
- **Allowlist.** Expressions are checked against APIM's documented type allowlist
  (`data/allowed-types.json`): syntactically on every change, and semantically through the C#
  server when it's available.

Without the C# extension, everything except C# IntelliSense still works, and `context.` member
chains complete from the stubs.

## Features

- **Language:** `*.policy.xml` files are APIM policies. Other `.xml` files switch over when their
  root is `<policies>` or `<fragment>` (APIOps' `policy.xml`), or when they match
  `apimPolicy.files.include`. Ordinary XML is left alone.
- **Highlighting:** XML with C# highlighting inside expressions, and `{{named values}}` marked.
- **Diagnostics:** parse errors, unknown policies, policies in the wrong section, missing or
  invalid attributes, child element rules, and the fragment rules (no sections, `base` or
  nested `include-fragment`). C# type errors and allowlist warnings appear on the expression.
- **Completion:**
  - policies allowed in the current section, child elements, attributes and values
  - fragment ids and named values
  - C# inside expressions
  - known variable names in `context.Variables["…"]` and `GetValueOrDefault<T>("…")`, including
    variables set by included fragments and, inside a fragment, by the policies that include it
  - snippets: type `apim-` to list them
- **Hover and navigation:**
  - hover docs for policies, attributes, `context` members and variables
  - go-to-definition from `include-fragment` to the fragment file, from a variable name to its
    `set-variable`, and from C# symbols into the stubs

## Install

Build a `.vsix` and install it:

```bash
npm ci
```

```bash
npm run package
```

```bash
code --install-extension apim-policy-*.vsix
```

For C# IntelliSense, install the C# extension (`ms-dotnettools.csharp`). C# type errors also need
the .NET 10 SDK on `PATH`, since the shadow file is a .NET 10 file-based app. Without the SDK,
completion and hover still work, but there are no type errors. The language status item for
APIM policies shows which mode is active.

### Settings

| Setting | Default | |
|---|---|---|
| `apimPolicy.files.include` | `[]` | Extra globs for policy files, e.g. `**/policies/**/*.xml` |
| `apimPolicy.files.detectByContent` | `true` | Treat XML with a `<policies>`/`<fragment>` root as a policy |
| `apimPolicy.csharp.enabled` | `true` | C# features inside expressions |
| `apimPolicy.csharp.mode` | `auto` | `file` (needs .NET 10 SDK), `virtual` (completion only) or `auto` |
| `apimPolicy.allowedTypes.severity` | `warning` | Severity of allowlist findings, or `off` |

## Layout

```
src/parser/     tolerant parser, C# lexer, entity decoding, position queries
src/policy/     catalog types, validator, XML completion, variable analysis
src/csharp/     shadow generation, C# backend, result mapping, allowlist lint, stub model
src/features/   VS Code providers that wire the above to the editor
src/sourceMap.ts  offset maps shared by the parser and the shadow file
data/           policy catalog, allowlist, generated BCL type index
stubs/          C# stubs for context and APIM's helper methods (shipped, read at runtime)
syntaxes/       TextMate grammar and the C# injection
snippets/       policy snippets
tools/          generator for data/bcl-types.json
test/unit/      vitest suites; test/fixtures/ holds the sample policies
test/integration/  VS Code + C# extension end-to-end suite
test/stubs/     a tiny project that compiles the stubs at C# 7.3
test/spike/     the request-forwarding spike, kept for reference
standards/      vendored engineering standards (git submodule)
```

## Development

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
dotnet build test/stubs
```

The unit tests run in milliseconds. The integration suite downloads VS Code and the C# extension
into `.vscode-test/` on first run, then runs on a temporary copy of `test/fixtures/`. Set
`APIM_DEBUG=1` to mirror the extension's log to the console. To try the extension by hand, use
**Run Extension** from VS Code or `code --extensionDevelopmentPath=.` on a folder of policies.

`data/bcl-types.json` is generated from the installed .NET reference assemblies. Regenerate it
after changing the allowlist's restricted types:

```bash
dotnet run tools/gen-bcl-types.cs
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

- C# features need the C# extension. Diagnostics go through its `experimental.sendServerRequest`
  export, which an update could change. Behaviour with C# Dev Kit installed hasn't been tested.
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
- Formatting isn't implemented.

## Docs

- [PLAN.md](PLAN.md): the design, and the request-forwarding spike results.
- [VERSIONING.md](VERSIONING.md): how the version is derived.
- [SHORTCUTS.md](SHORTCUTS.md): operational shortcuts (none yet).

Conventions: [`AGENTS.md`](AGENTS.md) and the [`standards/`](standards) submodule.
