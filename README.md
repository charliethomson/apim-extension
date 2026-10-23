# apim-extension

**Editor support for Azure API Management policy files, including the C# inside them.**

A VS Code extension for APIM policy documents (`<policies>`) and policy fragments
(`<fragment>`). It reads them with its own tolerant parser, so the `rawxml` format the portal
and APIOps produce works as well as the escaped `xml` format, and it gives the C# policy
expressions (`@(...)` and `@{...}`) real IntelliSense from its own C# engine, with no .NET SDK or
other extension needed.

[Guide](docs/guide.md) · [Reference](docs/reference.md) · [Versioning](VERSIONING.md) · [Design](PLAN.md) · [Standards](https://standards.thmsn.dev)

<!-- screenshot: completion of context.Request members inside an attribute expression -->
<!-- screenshot: structural diagnostics on a policy in the wrong section -->
<!-- screenshot: known-variable completion in context.Variables["…"] -->

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

Releases are published to the Visual Studio Marketplace by the `extension.release` pipeline
when a `v*` tag is pushed (see [VERSIONING.md](VERSIONING.md)).

Nothing else is needed: the C# engine ships with the extension, works offline and in Restricted
Mode, and doesn't use the C# extension even when it's installed.

### Settings

| Setting | Default | |
|---|---|---|
| `apimPolicy.files.include` | `[]` | Extra globs for policy files, e.g. `**/policies/**/*.xml` |
| `apimPolicy.files.detectByContent` | `true` | Treat XML with a `<policies>`/`<fragment>` root as a policy |
| `apimPolicy.csharp.enabled` | `true` | C# features inside expressions |
| `apimPolicy.lint.unguardedVariableAccess` | `off` | Flag `context.Variables["x"]` where `x` may be unset (it throws); `information` or `warning` |
| `apimPolicy.lint.missingInput` | `warning` | Severity for an include whose required `@in` nothing sets; `information` or `off` |
| `apimPolicy.allowedTypes.severity` | `error` | Severity of allowlist findings, or `off`. .NET Framework findings are warnings unless this is set |
| `apimPolicy.instance` | | An APIM instance to read from, as its ARM resource ID (see below) |
| `apimPolicy.tenant` | | The instance's Entra tenant, when it isn't your account's default |
| `apimPolicy.armEndpoint` | `https://management.azure.com` | Resource Manager endpoint, for sovereign clouds |
| `apimPolicy.instanceCacheMinutes` | `10` | How long what's read from the instance is reused |
| `apimPolicy.publish.allowedInstances` | `[]` | Instances the push command may write to; empty means pushing is off |

### Connecting an APIM instance

Optional. **APIM: Connect to an Instance** signs in with VS Code's Microsoft account, lists your
subscriptions and API Management services, and sets `apimPolicy.instance`. From then on:

- the instance's fragments join `include-fragment` completion, inlay hints, hover and
  go-to-definition (from a workspace file a fragment in the workspace wins over the instance's
  copy; from a policy opened from the instance, the instance's copy wins), and open
  read-only;
- `{{named values}}` complete by display name, hover shows a plain value (never a secret's), and
  a name the instance doesn't have is flagged;
- `set-backend-service backend-id` completes the instance's backends;
- variables the broader scopes set (each product the API is in, then global) count as set in the
  checks and completion, from the policy's `<base />` on. The status bar shows the policy's scope:
  taken from an APIOps-shaped path (`apis/<api>/operations/<op>/policy.xml`), or set with
  **APIM: Set This Policy's Scope**.

The **API Management** view in the activity bar browses the instance: the global policy,
products, APIs and their operations, fragments, named values (secrets shown as such) and
backends. Click a scope to open its policy read-only; right-click one and **Use as This Policy's
Scope** to tie the policy you're editing to it. **APIM: Open a Policy from the Instance** does the
same from the command palette.
Everything read stays in memory and nothing is written to disk. Secret named values are never
fetched. Reading needs the *API Management Service Reader* role.

### Pushing a policy

Nothing changes the instance until you push, and pushing is two explicit steps:

1. **Push to Instance** (the cloud button on a policy, or the command) pulls what's live now and
   opens it in a diff against your version. Nothing is written.
2. In that diff, **Push These Changes** (the check button) writes your version; **Cancel Push**
   (or closing the diff) drops it. The write carries the ETag from the pull, so if the policy
   changed on the instance while you were looking, it fails and the diff reopens with the new
   version. When the gateway rejects the policy, its errors appear on the lines they name, and
   the diff stays open so you can fix them on the right and push again.

It works on a local policy file (its scope comes from its path or **Set This Policy's Scope**; a
fragment asks for its id once) and on a policy that only exists on the instance: right-click it
in the API Management view, or use the pencil button on a read-only copy, and **Open as
Editable**. Saving that copy keeps a draft in memory and doesn't touch the instance;
**Reload from Instance** throws the draft away. A scope with no policy opens as `<base />` in
every section, and pushing creates it.

Pushing is off until you allow the instance: the first push asks, and adds it to
`apimPolicy.publish.allowedInstances` in the workspace settings. Allow only instances you change
by hand, not ones a pipeline deploys. It needs a role that can write policies, such as *API
Management Service Contributor*. In Restricted Mode a workspace's settings can't turn it on.

## How it works

Every feature starts from the same parse of the policy file:

```
policy.xml ──► tolerant parser ──► elements, attributes, expressions (with source maps)
                                      │
           ┌──────────────────────────┼──────────────────────────┐
           ▼                          ▼                          ▼
   policy catalog              C# engine                  workspace index
   (data/policies.json)        (data/csharp-model.json)   (fragments, variables,
   → diagnostics, XML          → completion, hover,        named values; with an
     completion, hover           signatures, errors       instance, its too)
                                                          → navigation, known names
```

- **Parser.** A hand-written XML scanner hands off to a small C# lexer at `@(` or `@{`. The lexer
  owns the input until the balanced close, so `"`, `<` and `&&` inside an expression can't break
  the XML structure. The lexer reads an entity-decoded view, so `&quot;)&quot;` in the escaped
  format behaves like `")"` in rawxml. Each expression carries a source map back to the file.
- **Catalog.** `data/policies.json` lists each policy's allowed sections, attributes (required,
  enum, expression-capable) and child elements. Validation and XML completion are driven
  entirely by it.
- **C# engine.** `src/csharp/lang/` lexes and parses C# 7.3 tolerantly, then binds names,
  overloads, generics and lambda types against `data/csharp-model.json` (the allowlisted BCL and
  Newtonsoft surface, flagged where .NET Framework 4.8 lacks a member) and the stubs. One walk
  with the cursor offset answers completion, hover or signature help. What the model can't see
  binds to an unknown type that converts to anything, so gaps never become errors.
- **Allowlist.** Expressions are checked against APIM's documented type allowlist
  (`data/allowed-types.json`), syntactically and from what the engine bound. Completion hides
  what it forbids.
- **Gateway compatibility.** The gateway compiles C# 7.3 against .NET Framework types, so newer
  syntax (switch expressions, `is not`, `new()`, `x!`, …) and .NET Core-only members are flagged.
- **Instance.** `src/apim/` reads an instance over the Resource Manager REST API with VS Code's
  Microsoft sign-in (no Azure SDK), lazily and cached in memory. `src/policy/scopes.ts` works out
  what the broader scopes set: a broader policy runs at the inner one's `<base />`, so its
  variables count from there on, and an API in several products only gets what every product's
  chain sets.

## Features

- **Language:** `*.policy.xml` files are APIM policies. Other `.xml` files switch over when their
  root is `<policies>` or `<fragment>` (APIOps' `policy.xml`), or when they match
  `apimPolicy.files.include`. Ordinary XML is left alone.
- **Highlighting:** XML with C# highlighting inside expressions, and `{{named values}}` marked.
- **Diagnostics:** parse errors, unknown policies, policies in the wrong section, missing or
  invalid attributes, child element rules, and the fragment rules (no sections, `base` or
  nested `include-fragment`). On the expression: C# syntax and type errors (including failed
  conversions, a non-bool `condition`, a `set-variable` value of a type variables can't hold, and
  a block that doesn't return on every path),
  types and members outside the allowlist, syntax newer than C# 7.3, and members .NET Framework
  doesn't have.
- **Completion:**
  - policies allowed in the current section, child elements, attributes and values
  - fragment ids and named values
  - C# inside expressions: members, extension methods (LINQ, the APIM helpers), types and
    namespaces, locals and lambda parameters with their inferred types
  - known variable names in `context.Variables["…"]` and `GetValueOrDefault<T>("…")`, including
    variables set by included fragments and, inside a fragment, by the policies that include it
  - snippets: type `apim-` to list them
- **JSON shapes:** a JObject built with literal keys (`new JObject { ["k"] = v }`, `o["k"] = v`,
  `.Select(x => new JObject { … })`) keeps its keys and their types, through `set-variable` into
  later `context.Variables["x"]` reads and into the files that include a fragment, so keys complete
  in `["…"]` and hover shows their types. Fragment headers can declare shapes too (`@typedef User`
  followed by `@property {string} id` lines, or inline `{ id: string }[]`), and a drafted header
  writes the shapes it finds as typedefs. A tag typed only `JObject` or `JObject[]` gets a
  **Generate a @typedef** quick fix from the shape the code builds. Building a variable with
  a declared shape (a fragment's `@in`, say) completes the keys still to write and warns on
  unknown, missing and mistyped ones; hovering a `@typedef` shows a filled-in example; and
  **Set every input of '…'** on an include stubs all of a fragment's inputs. An empty
  `set-variable` value for a typed variable completes (or quick-fixes) to a filled-in one, Go to
  Definition on its name opens the fragment's `@in`, and any `new JObject { … }` in a fragment can
  be extracted to a `@typedef`.
- **Arguments, returns and internals:** a fragment header says which variables are `@in`, `@out`
  and `@internal` (by name or prefix pattern). Callers are warned when they read a fragment's
  internals, or when one overwrites a variable they set, and a fragment is asked to declare each
  new variable it introduces.
- **Fragment headers:** document a fragment's input and output variables with `@in` and `@out`
  tags ([format](docs/fragment-headers.md)), and every include shows them as an inlay hint, with
  argument completion, checks for unset inputs and for a header that disagrees with its fragment.
- **Docs:** **APIM: Generate Docs** previews Markdown for the open policy or fragment: a
  fragment's inputs and outputs as tables (required, defaults, types and shapes), a usage snippet,
  its internals and typedefs, what it depends on (fragments, named values, backends, URLs) and
  which files include it. **APIM: Write Fragment Docs** writes one beside every fragment
  (`README.md` in an APIOps fragment folder, else `<name>.md`), and only ever replaces files it
  wrote itself.
- **Formatting:** Format Document and Format Selection re-indent elements with the editor's tab
  settings, and the C# in multi-line `@{ … }` and `@( … )` by its brackets (with a level more
  for continued lines like `.Where(…)`, and `case` bodies inside their label). Only indentation
  and line breaks change: attribute values, text, comments and strings keep their characters.
- **Hover and navigation:**
  - hover docs for policies, attributes, `context` members and variables
  - signature help for C# methods and constructors
  - go-to-definition from `include-fragment` to the fragment file, from a variable name to its
    `set-variable`, from a C# local to its declaration, and from C# symbols into the stubs

## Layout

```
src/parser/     tolerant parser, C# lexer, entity decoding, position queries
src/policy/     catalog types, validator, XML completion, variable analysis, scopes
src/apim/       Resource Manager client and the instance reader
src/csharp/     allowlist lint
src/csharp/lang/  C# engine: lexer, parser, type model, stub reader, binder, editor features
src/features/   VS Code providers that wire the above to the editor
src/sourceMap.ts  offset maps from decoded expression code back to the file
data/           policy catalog, allowlist, generated BCL type index and C# type model
stubs/          C# stubs for context and APIM's helper methods (shipped, read at runtime)
syntaxes/       TextMate grammar and the C# injection
snippets/       policy snippets
tools/          generators for data/bcl-types.json and data/csharp-model.json
test/unit/      vitest suites; test/fixtures/ holds the sample policies
test/integration/  VS Code end-to-end suite
test/stubs/     a tiny project that compiles the stubs at C# 7.3
bench/          hot-path benchmarks
docs/           the fragment header format, known limitations, development gotchas
scripts/ci/     version derivation for `npm run package`
.kiln/          the CI pipelines, as Rust (kiln)
.woodpecker/    generated from .kiln/ by `emit woodpecker`; never edited by hand
```

## Development

CI is [kiln](https://standards.thmsn.dev/d/ci-cd#pipelines-as-code-kiln): the pipelines are Rust
in [`.kiln/src/`](.kiln/src/main.rs), and `.woodpecker/` is generated from them (AGENTS.md has
the regenerate commands). The gate, `extension.ci`, runs on pushes to `main` and runs these, so
passing them locally means passing CI:

```bash
npm run typecheck
```

```bash
npm run lint
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

CI also packages the `.vsix` and checks that regenerating `data/*.json` with the .NET 10.0.103
SDK changes nothing. `audit.ci` runs `npm audit` on lockfile changes and weekly, and only fails
on a critical advisory that [`audit-exceptions.json`](audit-exceptions.json) has no live
exception for. Exceptions need a reason and an expiry date, and an expired one fails it. The
coverage floor (80%, in `vitest.config.ts`) covers the parser, source maps, policy logic, the
allowlist lint and the engine. The VS Code glue in `src/features/` is covered by the integration
suite instead, which runs with every other extension disabled.

The unit tests run in milliseconds. The integration suite downloads VS Code into `.vscode-test/`
on first run, then runs on a temporary copy of `test/fixtures/`. Set
`APIM_DEBUG=1` to mirror the extension's log to the console. To try the extension by hand, use
**Run Extension** from VS Code or `code --extensionDevelopmentPath=.` on a folder of policies.

CI doesn't run the bench; run it yourself when touching the hot paths:

```bash
npm run bench
```

It times startup, the work after an edit and the editor requests. The extension has to stay
usable on slow machines with on-access file scanning, so keep these flat, and keep file I/O
down: nothing runs until a policy opens, each workspace policy is read once, nothing is written.

`data/bcl-types.json` and `data/csharp-model.json` are generated from the installed .NET reference
assemblies and their doc files. The model generator also restores Microsoft's .NET Framework 4.8
reference assemblies from NuGet to flag what Framework lacks. Regenerate both after changing the
allowlist:

```bash
dotnet run tools/gen-bcl-types.cs
```

```bash
dotnet run tools/gen-csharp-model.cs
```

`data/policies.json` and `data/allowed-types.json` are hand-maintained from the Learn policy
reference and the policy expressions page.

## Licence and attribution

The code is MIT licensed ([LICENSE](LICENSE)). The policy catalog (`data/policies.json`), the
allowlist (`data/allowed-types.json`) and the doc comments in `stubs/ApimContext.cs` are
paraphrased from the [Azure API Management documentation](https://learn.microsoft.com/azure/api-management/)
([MicrosoftDocs/azure-docs](https://github.com/MicrosoftDocs/azure-docs), CC BY 4.0). They aren't
affiliated with or endorsed by Microsoft. The grammars in `test/grammars/` are MIT-licensed copies
used only by the tests; see [their notice](test/grammars/NOTICE).

## Docs

- [docs/guide.md](docs/guide.md): a tour of the features, by task.
- [docs/reference.md](docs/reference.md): every command, setting, quick fix and header expansion.
- [docs/fragment-headers.md](docs/fragment-headers.md): documenting a fragment's variables.
- [docs/apim-connection-plan.md](docs/apim-connection-plan.md): the plan for reading an instance,
  and running policies offline.
- [docs/limitations.md](docs/limitations.md): known limitations, and things that will bite you
  when working on it.
- [PLAN.md](PLAN.md): the original design, including the C# extension approach it replaced.
- [VERSIONING.md](VERSIONING.md): how the version is derived.
- [test/stubs/README.md](test/stubs/README.md): the stubs compile check.
- [SHORTCUTS.md](SHORTCUTS.md): operational shortcuts (what's published, what's running).

Conventions: [`AGENTS.md`](AGENTS.md), whose `Standards:` line names the archetype; the rules
come from the [standards server](https://standards.thmsn.dev) via the `standards` MCP.
