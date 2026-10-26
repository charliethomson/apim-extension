# Plan: unit tests for APIM policies, in CI

Status: planned (2026-10-26). Milestone 0 is built. This replaces phase 3 of
[apim-connection-plan.md](apim-connection-plan.md) with the decisions made since.

APIOps publishes policy files and checks nothing about what they do. A policy's logic is only
tested by deploying it and sending requests. This adds tests for policy logic: a YAML file gives a
request, named values and canned responses for the outside world, and says what should come
out. A CLI runs every test in an APIOps repo offline and reports in a form Azure DevOps shows
natively. It's a test runner with mocks, not a gateway emulator.

## Decisions

- **The first consumer is Azure DevOps YAML pipelines on Microsoft-hosted agents.** The CLI writes
  JUnit XML for `PublishTestResults@2`, and when `TF_BUILD` is set it also prints
  `##vso[task.logissue]` lines, so failures land on the build summary with file and line.
  How the tool is installed on the agent (npm, a Marketplace task, a .NET tool) is still open
  (see "Open questions"). The design keeps that choice cheap: a CLI and a runner, packaged later.
- **The CLI comes first.** Test Explorer and a trace view in the extension come after it, on
  the same library.
- **Tests live in a `tests/` folder beside the scope they test:** `apis/<api>/tests/*.yaml`,
  `apis/<api>/operations/<op>/tests/*.yaml`, `policyFragments/<id>/tests/*.yaml`,
  `products/<p>/tests/*.yaml`, `tests/*.yaml` at the root for the global policy. The publisher only
  reads the files it knows, so it doesn't see them.
- **The C# runs on real .NET.** Reimplementing .NET semantics in TypeScript (string and LINQ
  behaviour, `DateTime` formats, .NET regex, Newtonsoft, `XElement`) would never be exact, and
  every gap is a test that passes here and fails on the gateway. The runner compiles expressions
  with Roslyn at C# 7.3 against the real BCL and Newtonsoft. What's left is the .NET Framework vs
  modern .NET drift, which the extension's compatibility check already flags.
- **TypeScript parses, .NET executes.** The `rawxml` format APIOps writes isn't well-formed XML
  (`"` inside attribute values), so .NET's XML readers can't load it. Our tolerant parser can, and
  it already knows the scope chain and fragments. So the TypeScript side reads the files and
  sends the runner a resolved tree as JSON. The runner owns everything at run time: context state,
  variables (which hold live `JObject`s, so they can't be marshalled back and forth), bodies and
  mocks.

## Shape

```
apim-policy test [paths]            (cli/, Node)
   │  finds tests/*.yaml, loads each test
   ▼
@apim-policy/testing                (packages/testing, no vscode)
   │  test file schema and loader; scope chain from the APIOps layout;
   │  parses each policy and fragment (packages/document) into a run tree:
   │  elements, attributes, expressions with file/line/column, fragments by id;
   │  checks the expectations against what comes back; JUnit and ADO output
   ▼  JSON lines over stdin/stdout, one runner process per CLI run
policy runner                       (runner/, .NET)
      compiles every expression once (one assembly per run, cached by hash),
      implements the context interfaces from ApimContext.cs for real,
      runs inbound → backend → outbound (→ on-error), splicing <base /> and fragments,
      serves send-request, forward-request and cache from the test's mocks,
      returns the final response, the variables, every mocked call and a step trace
```

The runner compiles `packages/csharp-engine/assets/ApimContext.cs` into itself, so the interfaces
the editor binds against and the ones tests run against are the same file. The `throw null`
bodies there are replaced by real implementations in the runner (`GetValueOrDefault`, `AsJwt`,
`AsBasic`, `Encrypt`, and so on); the stubs keep their `throw null` bodies.

Each expression is compiled as a method on a generated class, `object E12(IProxyRequestContext
context) => (…);` for `@(…)`, and with the block as the body for `@{…}`. The usings are APIM's
implicit namespaces. `{{named values}}` are substituted into the text first, as the gateway does.
Compile errors come back with offsets into the expression, and the TypeScript side maps them to
the file through the expression's source map.

## Test file

```yaml
# apis/random-users/tests/filters-by-nationality.yaml
name: keeps only users from the requested nationality
policy: operations/get-users        # optional; default is the scope whose tests/ folder it's in
product: starter                    # which product chain, when the API is in more than one
namedValues:
  random-user-cache-seconds: "60"   # wins over namedValues/ in the repo
request:
  method: GET
  url: https://contoso.azure-api.net/random-users/users?nat=GB&count=5
  headers:
    Accept: application/json
mocks:
  - request: { method: GET, url: "https://randomuser.me/api/*" }
    response:
      status: 200
      headers: { Content-Type: application/json }
      body: { file: data/randomuser-page.json }
backend:                            # what forward-request returns; omit if the policy never forwards
  status: 200
  body: { json: { ok: true } }
cache:
  random-users-page-1: "…"          # seeds cache-lookup-value
expect:
  response:
    status: 200
    headers: { Content-Type: application/json }
    body:
      json: { results: [ { nat: GB } ] }   # a subset match
  variables:
    ru-arg-results: "5"
  calls:
    - { method: GET, url: "https://randomuser.me/api/?results=5*" }
  trace:
    - { source: random-users, contains: "cache miss" }
```

A file can hold `cases:`, a list of tests sharing the fields above it. Bodies are `text`, `json`
or `file`. The exact schema is settled in milestone 2 and published as a JSON Schema, so editors
with the YAML extension complete it.

## Policies, in tiers

- **Executed:** `set-variable`, `set-header`, `set-query-parameter`, `set-body`, `rewrite-uri`,
  `set-method`, `set-status`, `choose`, `return-response`, `include-fragment`, `retry`,
  `on-error` with `context.LastError`, `trace`, `base`, `mock-response`, `find-and-replace`,
  `json-to-xml`/`xml-to-json`.
- **Mocked:** `send-request` and `send-one-way-request`, `forward-request`,
  `cache-lookup`/`cache-store` and the `-value` variants (in memory, seeded by the test),
  `authentication-managed-identity` (a fake token).
- **Recorded, not enforced:** `rate-limit*`, `quota*`, `validate-jwt` (assumed valid, or test keys
  later), `validate-content`, `log-to-eventhub`, `emit-metric`, `set-backend-service`. These need
  gateway state or keys only Azure has. The trace records what they would have done, and a test
  can assert on that.
- **Anything else** fails the test as unsupported, naming the policy and its line. Nothing is
  skipped silently.

The risk is in policy semantics more than the C#: whether a body is consumed unless
`preserveContent`, header merging and `exists-action`, what `LastError` holds for each failure,
retry timing. Each policy is built against its Learn page, and `docs/testing.md` says per policy
what's modelled.

## Milestones

0. **Scope chains from files.** Phase 1 of the connection plan, as far as the runner needs it:
   from an APIOps path, the chain operation → API → product(s) (`products/*/apis.json`) →
   global, read from files. It lives in `packages/analysis`/`workspace` next to the instance
   version, and the extension gets outer-scope variables from an extract as a side effect.
1. **Runner core** (`runner/`, .NET, xunit). The run-tree protocol, expression compilation and its
   cache, the context implementation, the executed tier, `<base />` and fragments, named values.
   Tested in .NET against hand-built trees.
2. **`@apim-policy/testing`.** The test file schema and loader, building the run tree from files,
   the process client, the expectation checks. 80% coverage like every package, with the runner
   faked in unit tests and real in a small set marked to need .NET.
3. **Mocked and recorded tiers.**
4. **CLI** (`cli/`): `apim-policy test [paths] [--junit file] [--trace dir] [--filter text]`, with
   exit code 1 on any failure and 2 on a broken test file or a runner that won't start.
   **Done when** a test drives the random-user fixture end to end against a mocked randomuser.me,
   on an Azure DevOps hosted agent, and a broken expectation shows on the build's Tests tab with
   the policy line that caused it.
5. **CI here.** A kiln pipeline that builds and tests the runner when `runner/` changes, and the
   CLI's tests join `extension.ci`. Each new deliverable goes through `thmsn-new-component`.

Later: Test Explorer and a trace webview in the extension, snapshot expectations (save a run's
output as the next run's expectations), a sample `azure-pipelines.yml` in the docs.

## Open questions

- **Installing on the agent.** npm (`npx`, with the runner as a bundled framework-dependent
  `.dll`), an Azure DevOps Marketplace task wrapping that, or a .NET global tool. Any of them
  needs Node and a .NET runtime on the agent, which hosted images have. The runner targets the
  oldest .NET still on the hosted images, with `RollForward=Major`. Check which that is on
  `ubuntu-latest` and `windows-latest` before milestone 4.
- **Self-hosted agents with no internet.** The runner needs nothing from the network at run time,
  but installing it does.
- **An API in several products.** Tests name the product; is a default (the only one, else
  an error) right?
- **Workspaces** (the APIM feature) aren't in the chain yet.

## Prior art

Microsoft's [policy toolkit](https://techcommunity.microsoft.com/blog/integrationsonazureblog/-/4303483)
has a [testing package](https://www.nuget.org/packages/Microsoft.Azure.ApiManagement.PolicyToolkit.Testing),
but only for policies written in C# with its authoring library, not existing XML.
[LocalStack's APIM emulator](https://docs.localstack.cloud/azure/services/api-management/) stores
policies without running them, and the self-hosted gateway needs an instance in Azure.
