# APIM Policy extension: design

Status: signed off 2026-10-08. Open questions resolved with the recommended defaults (see Decisions).

## Goals

Editor support for Azure API Management policy documents (`<policies>` and `<fragment>`), including the
C# policy expressions embedded in them, in both the `rawxml` format (not valid XML) and the escaped `xml`
format. No dependency on the Red Hat XML extension. A soft dependency on the C# extension for expression
IntelliSense, with everything else working without it.

## Research findings that shape the design

- **C# grammar.** `source.cs` in VS Code's built-in `csharp` extension (microsoft/vscode main) still has
  `#expression` and `#statement` in its repository, so the injection grammar can keep using them.
- **Expression rules.** `@(...)` is a single expression and `@{...}` is a statement block where every path
  must `return`. The language level is C# 7. `context` is the only implicit variable, and all of its members
  are read-only.
- **Type names.** The docs don't name most interfaces. They're keyed by access path (`context.Request`,
  `context.User`). Only `IApi`, `IUrl`, `IMessageBody`, `IGroup`, `IUserIdentity`, `IPrivateEndpointConnection`,
  `ISubscriptionKeyParameterNames`, `Jwt` and `BasicAuthCredentials` are named, so the rest (`IProxyRequestContext`,
  `IRequest`, `IResponse`, ...) are names we choose.
- **Format.** ARM/REST `format` is one of `xml`, `xml-link`, `rawxml`, `rawxml-link`.
  - `xml` must be well-formed, so expressions are entity-escaped (`@(... GetValueOrDefault(&quot;X&quot;) ...)`).
  - `rawxml` is what the portal and APIOps produce, so C# is written as-is.
  - Because no C# expression contains `&quot;` or `&lt;` legitimately, entity decoding is safe in both formats.
  - The parser therefore doesn't need a format switch.
- **Fragments.**
  - The root is `<fragment>`.
  - Section tags and `<base/>` aren't allowed inside a fragment, and nested `include-fragment` is unsupported.
  - The maximum size is 512 KB.
  - Whether a fragment is valid in a section depends on where it's included.
- **C# extension (Roslyn LS) behaviour.** From reading the vscode-csharp, roslyn and vscode-languageclient
  sources. The spike will confirm or refute these.
  - **Document selector.** The extension's selector is language-only (`csharp`), so virtual documents with
    a custom scheme do get `didOpen`, completion and hover.
  - **Non-file and loose files.** Non-file URIs and `.cs` files outside a loaded project become miscellaneous
    files with "standard references". They get syntax errors and BCL IntelliSense, but **no semantic
    diagnostics**.
  - **File-based apps.** A `.cs` file on disk with `#:` directives plus top-level statements is treated as a
    .NET 10 file-based app. It gets restored and gets full semantics. This machine has SDK 10.0.105.
  - **Project loading.** Discovery takes the single `*.sln`/`*.slnx` in the workspace, or all `*.csproj` files
    if there's no solution. `openSolution` replaces the loaded set and doesn't add to it, and C# Dev Kit owns
    loading when it's installed. So a shadow `.csproj` would fight the user's own .NET projects in mixed
    repos. That's a strong reason to avoid a real project.
  - **Hidden documents.** Pull diagnostics are only requested for documents visible in a tab. For a hidden
    generated file, `languages.getDiagnostics` stays empty, so we'd have to send `textDocument/diagnostic`
    ourselves through the extension's `experimental.sendServerRequest` export.

## Repository layout

```
package.json, esbuild.mjs, tsconfig.json, LICENSE, README.md, PLAN.md
syntaxes/
  apim-policy.tmLanguage.json        # scopeName text.xml.apim, includes text.xml
  apim-expression.injection.json     # the existing injection, retargeted (see Highlighting)
language-configuration.json          # copied from the XML one: comments, brackets, auto-close
data/policies.json                   # policy definitions driving validation
stubs/ApimContext.cs                 # hand-written C# stubs with XML doc comments
src/
  extension.ts                       # activation, wiring
  parser/
    scanner.ts                       # tolerant XML + C# region scanner
    csharpLexer.ts                   # balanced @(...)/@{...} scanning over a decoded char stream
    entities.ts                      # entity decoding with offset mapping
    ast.ts                           # node types with exact source ranges
  sourceMap.ts                       # segment-based offset maps, composable
  policy/
    schema.ts                        # types for data/policies.json
    validator.ts                     # structural diagnostics
  csharp/
    shadow.ts                        # generates shadow C# from a parsed document + source map
    forwarding.ts                    # completion/hover/signature/definition via vscode.execute*Provider
    diagnostics.ts                   # pulls C# diagnostics, maps them back
    allowedTypes.ts                  # whitelist lint (syntactic, plus semantic if available)
  features/
    namedValues.ts                   # {{name}} recognition (and hover)
    fragments.ts                     # fragment index + go-to-definition for include-fragment
test/
  unit/                              # vitest: scanner, entities, sourceMap, validator, shadow gen
  integration/                       # @vscode/test-electron + mocha
  fixtures/                          # raw, escaped, nested, strings with ) and }, generics, lambdas, fragments
```

There are no runtime npm dependencies. Glob matching uses `vscode.languages.match` with a `DocumentFilter` pattern.
The dev dependencies are typescript, esbuild, vitest, mocha, @vscode/test-electron, @vscode/vsce and @types/vscode.

## 1. Language id and highlighting

- **Language.** Contribute language `apim-policy` with `filenamePatterns: ["*.policy.xml"]`.
- **Extra globs.** The setting `apimPolicy.files.include` (string[], default `[]`) adds more globs. It's
  applied with `languages.setTextDocumentLanguage` when a matching `xml` document opens. Users can also
  just use `files.associations`.
- **APIOps layout.** APIOps lays out `apis/<api>/policy.xml` and `policyFragments/<name>/policy.xml`, and
  `*.policy.xml` misses them. Two ways to cover it:
  - Ship the APIOps globs as defaults in `apimPolicy.files.include`.
  - Add `apimPolicy.files.detectByContent` (default true). It switches an `.xml` document to `apim-policy`
    only if its first element is `<policies>` or `<fragment>`, and ordinary XML is never touched.
  - Open question 1 picks between these.
- **Grammar.**
  - A tiny `text.xml.apim` grammar that includes `text.xml`.
  - The injection changes `injectionSelector` to `L:text.xml.apim -comment` and adds `injectTo: ["text.xml.apim"]`.
    Plain XML files are no longer affected (today's `L:text.xml` hits every XML file).
- **Grammar improvements.**
  - Add a `{{name}}` named-value rule, scoped `variable.other.named-value.apim`.
  - Nested `(`/`{` and C# strings are already consumed by the included C# rules, so the outer `\)`/`\}` end
    patterns only fire at the balanced close. Fixtures will verify this, including strings that contain `)` and `}`.
  - Escaped-format strings (`&quot;...&quot;`) won't highlight as C# strings. That's a known limitation,
    because TextMate can't decode entities.

## 2. Tolerant parser (the core)

There is a single pass over the source. It's a hand-written XML scanner that hands off to a C# lexer
whenever it sees `@(` or `@{` in an attribute value, element text or CDATA.

- **XML scanning.**
  - Covers elements, attributes (either quote style), text, comments, CDATA and processing instructions.
  - It never throws. Errors become `ParseDiagnostic`s with ranges.
  - Recovery: an unclosed tag closes at the next `<`, a mismatched end tag pops to the matching open
    element or is reported and ignored, and an unterminated attribute ends at the end of line or the next `>`.
- **Expression detection.**
  - An attribute value or text node is an expression when its first non-whitespace characters are `@(` or `@{`.
    That's how APIM treats them, as whole-value expressions.
  - The C# lexer then runs from that point and owns the input until the balanced close. Only after that does
    the XML scanner look for the closing quote or `<`. This is what makes `condition="@(x == "POST")"`,
    `a < b` and `&&` inside attributes work.
- **C# lexer.**
  - Tracks a paren/brace/bracket stack.
  - Skips these without counting their contents:
    - regular strings
    - verbatim strings `@"..."` with `""`
    - interpolated strings `$"..."`, `$@"..."` and `@$"..."`, with recursive holes, nested strings and format specifiers
    - char literals, including `'\''`, `')'` and `'"'`
    - `//` and `/* */` comments
  - Raw string literals are out of scope, because APIM is C# 7.
  - An unterminated expression is reported at the `@` and recovered by falling back to the plain XML rules
    from the start of the value.
- **Entities.**
  - The lexer reads through a `DecodedReader`. It decodes `&quot; &apos; &lt; &gt; &amp; &#N; &#xN;` on the fly,
    so an escaped `&quot;)&quot;` is a string containing `)` and balancing stays right in the `xml` format.
  - Each expression node carries `code` (the decoded text) and a `SourceMap` from decoded offsets to source offsets.
- **AST.**
  - Node types are `Document`, `Element{name, attributes, children, startTagRange, endTagRange?, selfClosing}`,
    `Attribute{name, nameRange, value, valueRange, expression?}`, `Text{value, range, expression?, namedValues}`,
    `Comment`, `CData` and `Expression{kind: 'expr'|'block', range, codeRange, code, map}`.
  - Named values `{{name}}` are recorded wherever they occur, inside expressions too.
- **SourceMap.**
  - A sorted list of segments `{genStart, srcStart, length}`, plus opaque segments for replacements whose
    length doesn't match.
  - Provides `toSource`, `toGenerated`, range mapping (a range is clamped when it spans an opaque segment)
    and `compose` (entity decoding map then shadow-generation map).
- **Unit tests.** Every lexer construct, both formats, and error recovery. Also property-style round trips:
  every non-opaque generated offset maps back to the source character it came from.

## 3. XML diagnostics

`data/policies.json` holds an entry per policy. It's hand-built from the per-policy reference pages, which
the research pass already extracted for about 30 of them. The remaining entries are filled from the docs.

```jsonc
{
  "name": "set-header",
  "sections": ["inbound", "outbound", "backend", "on-error"],   // or "any"
  "attributes": [
    { "name": "name", "required": true, "expressions": true },
    { "name": "exists-action", "enum": ["override", "skip", "append", "delete"], "expressions": true }
  ],
  "content": { "kind": "children", "children": [{ "name": "value", "content": { "kind": "text" } }] },
  "oneOf": [],                     // e.g. validate-jwt: header-name | query-parameter-name | token-value
  "docs": "https://learn.microsoft.com/azure/api-management/set-header-policy"
}
```

The `content` kinds are `empty`, `text`, `children` (named child schemas, recursive), `policies` (nested
policy content, as in `when`/`otherwise`/`retry`/`limit-concurrency`/`wait`) and `any`.

- **Checks.**
  - Root is `<policies>` or `<fragment>`.
  - Section tags appear only under `<policies>`, with no duplicates.
  - Unknown policy elements.
  - A policy used in a section it doesn't allow. The check inherits through nesting, so `set-header` inside
    `choose/when` in `inbound` counts as inbound.
  - Missing required attributes, `oneOf` violations, and enum values (skipped when the value is an expression).
  - Unknown attributes, as warnings.
  - Fragment rules: no section tags, `base` or `include-fragment` inside `<fragment>`.
  - More than one policy in `<backend>`, as a warning.
  - `wait` children limits.
  - Parser errors.
- **Placement inside fragments.** A fragment's own policies aren't section-checked, because the section is
  unknown there.
- **Severities.** `apimPolicy.validation.unknownElements` etc. take `error|warning|info|off`.
- **Hover.** Element names show a one-line description and a docs link. This comes cheap from the same data.

## 4. C# features inside expressions (spike first)

**Shadow source.** For each policy document, generate one C# file:

```csharp
// <auto-generated> from apis/echo/policy.xml
#:property LangVersion=7.3            // spike variant B only
using System; using System.Linq; using Newtonsoft.Json.Linq; ...   // the implicit namespaces
static class __Policy {
  // L12:20 condition
  static bool __E0(IProxyRequestContext context) => <expr>;
  // L30:9 set-body
  static object __E1(IProxyRequestContext context) { <block verbatim> }
}
```

- **Return types.** Per-attribute types from `policies.json` give useful mismatch errors (`condition` → `bool`).
  Everything else is `object`.
- **Named values.** `{{name}}` outside a string literal is replaced with `NamedValues.Get("name")` through an
  opaque map segment. Inside a string, it's left alone.
- **Stubs.** `stubs/ApimContext.cs` is copied next to the generated file, or inlined for single-file variants.

**Spike variants**, in order:

- **A. Virtual document.**
  - A `apim-cs:` scheme content provider serves `languageId: csharp`, with the stubs inlined in the same text,
    because misc files can't see other files.
  - Expected: completion, hover and signature help work against the stubs and the BCL, but there are no
    semantic diagnostics.
  - Newtonsoft resolution is unknown. If it doesn't resolve, we add minimal `JObject`/`JToken` stubs.
- **B. File-based app on disk** in `context.storageUri` (outside the workspace, so no project discovery):
  - `#:package Newtonsoft.Json@13.0.3`, with the stubs inlined or pulled in by `#:include` if the SDK supports it.
  - The generated file is opened with `openTextDocument`, never shown.
  - Diagnostics come from `textDocument/diagnostic` sent via `experimental.sendServerRequest`.
  - Expected to give full semantics. Costs: a restore on first use (and needs nuget.org or an offline cache)
    and the .NET 10 SDK.
- **C. Real `.csproj` in storage**, opened with `dotnet.openSolution`. This is only a fallback for B, and
  probably unworkable because opening it replaces the user's projects.

**Forwarding.**

- `apim-policy` providers for completion, hover, signature help and definition.
- When the cursor is inside an expression, the provider makes sure the shadow is current (by document
  version), maps the position through `compose(entityMap, shadowMap)` and calls `vscode.executeCompletionItemProvider`
  and the other `execute*Provider` commands.
- It then maps ranges and `textEdit`s back, dropping any that land outside the expression.
- Definitions that land in the stubs file are returned as-is. They point to a real file in the extension
  folder, so the user sees the stub with its doc comments.
- Diagnostics are debounced, filtered to `__E*` bodies, mapped back, and published under a `apim-csharp` collection.

**Spike deliverable.** A short report: a matrix of feature × variant on a real C# extension (installed into
the test-electron VS Code via `--install-extension ms-dotnettools.csharp`), latency, and what breaks with
C# Dev Kit installed. I'll stop there for your input.

**Fallback if forwarding is unworkable: a .NET sidecar.**

- A small `net8.0` console process using Microsoft.CodeAnalysis.CSharp (+ Features for completion),
  speaking JSON-RPC over stdio.
- **Pros:** full control, real semantic diagnostics, an exact allowed-types lint through the `SemanticModel`,
  no interference with the user's projects, and the same behaviour with or without Dev Kit.
- **Cons:** ships roughly 15–25 MB of Roslyn assemblies, or restores them on first run. It needs a .NET runtime
  on the machine, and we'd own completion/hover formatting.
- I'd only propose this with spike evidence.

## 5. Context stubs

`stubs/ApimContext.cs`:

- `IProxyRequestContext` (Api, Backend, Deployment, Elapsed, GraphQL, LastError, Operation, Product, Request,
  RequestId, Response, Subscription, Timestamp, Tracing, User, Variables, Workspace, `Trace(string)`) and the
  per-path interfaces from the docs (`IRequest`, `IResponse`, `IUrl`, `IMessageBody`, `IApi`, `IOperation`,
  `IUser`, `ISubscription`, `IProduct`, `IDeployment`, `IGateway`, `ILastError`, `IBackend`, `IWorkspace`, `Jwt`,
  `BasicAuthCredentials`, enums, ...).
- Each member carries a short paraphrased `/// <summary>`.
- Extension methods:
  - `GetValueOrDefault` for headers, query and claims (`IReadOnlyDictionary<string,string[]>`) and for
    `Variables` (`<T>`, with and without a default; the no-default form is undocumented but used everywhere)
  - `As<T>(bool preserveContent = false)` and `AsFormUrlEncodedContent`
  - `AsJwt`, `TryParseJwt`, `AsBasic` and `TryParseBasic`
  - `Encrypt`/`Decrypt` overloads and `VerifyNoRevocation`
  - `ToQueryString`/`ToFormUrlEncodedContent`
- The stubs compile under `dotnet build` in CI (a tiny test project in `test/stubs/`), so they can't rot.

## 6. Allowed-types lint

- **Whitelist.** The docs' whitelist (about 130 types, some restricted to listed members) is encoded in
  `data/allowed-types.json`.
- **Syntactic pass (always on).**
  - Tokenises the decoded expression with the same lexer.
  - Finds qualified names (`System.IO.File`), `new X(`, `typeof(X)`, casts and generic arguments, and type
    names before `.`.
  - Resolves them against the whitelist plus stub types plus local identifiers declared in the block.
  - Known-forbidden type names (anything in the BCL index that isn't whitelisted, from a generated list of
    common type names) get a warning.
  - Members on restricted types (`DateTime.Parse` okay, `DateTime.FromBinary` flagged) are checked when the
    receiver is a type name.
- **Semantic pass (if variant B or the sidecar works).** Uses hover or definition results to resolve the
  receiver type and catch `var x = ...; x.Forbidden()`. With forwarding this is best-effort, and the sidecar
  does it exactly.

## 7. Named values and fragments

- `{{name}}` is recognised everywhere, never reported, given a highlight scope, and hovers as "named value".
- **Fragment index.** A `FileSystemWatcher` over `apim-policy` files whose root is `<fragment>`. A fragment id
  matches:
  - the file stem (`x.policy.xml`, `x.xml`)
  - the parent folder for APIOps (`policyFragments/x/policy.xml`)
  - anything added by `apimPolicy.fragments.include` globs
- **Fragment features.**
  - Go-to-definition and document links on `fragment-id`.
  - An info diagnostic when no fragment matches. It's off by default, since fragments often live elsewhere.

## Testing

- **vitest unit tests:** parser, lexer, entities, source maps, validator against `policies.json`, and shadow
  generation snapshots.
- **Integration (`@vscode/test-electron` + mocha):**
  - language assignment, including that plain `.xml` isn't touched
  - grammar scopes via `vscode.provideDocumentSemanticTokens`. Tokenisation will actually come from the
    `vscode-textmate` + `vscode-oniguruma` dev deps in a unit test, which is more reliable.
  - structural diagnostics appear
  - fragment go-to-definition
  - C# forwarding, gated on the C# extension being installable (skipped otherwise)
- **Fixtures:** raw, escaped, nested parens and braces, strings and chars containing `)`/`}`/`"`/`<`,
  verbatim and interpolated strings, generics, lambdas, comments inside blocks, `{{nv}}` in and out of
  strings, fragments (valid and invalid), APIOps layout.

## Commit plan

1. `git init`, scaffold (package.json, esbuild, tsconfig, LICENSE, language + grammars).
2. Source map + entities + lexer + scanner with unit tests.
3. Policy data + validator + diagnostics wiring.
4. Stubs + shadow generation (unit-tested).
5. **Spike** of forwarding variants A/B with integration harness, then a report and a stop.
6. Forwarding build-out, diagnostics mapping.
7. Allowed-types lint.
8. Named values + fragments.
9. Integration tests, README, vsce packaging.

## Decisions

1. **APIOps detection.** `apimPolicy.files.detectByContent` (default on) plus the
   `apimPolicy.files.include` globs.
2. **Minimum VS Code** is `^1.95`.
3. **C# backend.** The spike tries variant A and variant B, and the results decide. Variant A
   is the floor when the .NET 10 SDK or NuGet isn't available.

## Standards

This repo vendors [`standards/`](standards/), and [`AGENTS.md`](AGENTS.md) lists the
overrides for a TypeScript extension. What changes here:

- **Versioning.** The version is derived as `MAJOR.MINOR.<commit count>` by
  `scripts/ci/version.sh`, and `npm run package` passes it to vsce. The `package.json`
  version stays a placeholder.
- **Testing.** The 80% coverage floor (vitest v8 coverage) applies to the parser, the source
  maps, the validator and the shadow generator.
- **No change-detector tests.** Shadow-generation snapshots are only committed after the
  output has been checked by eye. Most assertions are on behaviour, such as a position that
  maps back correctly, or a diagnostic appearing.
- **Commits.** Commit straight to `main`. README.md is updated in the same commit as any
  behaviour it describes.
