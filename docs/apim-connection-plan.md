# Plan: knowing the APIM instance, and running policies offline

Status: phase 2 is built (2026-10-23), ahead of phase 1, since the instance was what was needed
first; see "Phase 2 as built". Phases 1 and 3 aren't started.

Today the extension knows only the policy files open in the workspace. Three things it can't see
make its checks weaker than they should be:

- **Outer scopes.** A policy runs inside its operation, API, product, workspace and global
  policies (`<base />` is where they splice in). Variables set out there are invisible, so "nothing
  earlier sets `x`" and the unguarded-variable lint can only ever be information.
- **Fragments outside the repo.** `include-fragment` completion, go-to, inlay hints and input
  checks only work for fragments in the workspace.
- **Named values.** Names come from `{{…}}` usage and `namedValues/` folder names; display names
  and non-secret values aren't read, and an unknown `{{name}}` isn't flagged.

Phases 1 and 2 close those gaps, cheapest and most offline first; phase 1 alone covers most of
the value for teams on APIOps. Phase 3 goes further: running a policy against a test request,
offline, with the outside world mocked.

## Phase 1: read the APIOps extract properly

No auth, no network. An APIOps extractor output (or anything shaped like it) already holds the
outer scopes, the fragments and the named values:

```
policy.xml                                      global (service) policy
workspaces/<ws>/policy.xml                      workspace policy
products/<p>/policy.xml, productInformation.json, apis.json   product policy and its APIs
apis/<api>/policy.xml, apiInformation.json      API policy
apis/<api>/operations/<op>/policy.xml           operation policy
policyFragments/<id>/policy.xml, policyFragmentInformation.json
namedValues/<name>/namedValueInformation.json   displayName, value (null when secret), secret, keyVault
backends/<id>/backendInformation.json
```

**Work**

1. **A scope model** (`src/policy/scopes.ts`, pure). From a policy file's path, work out its scope
   (global, workspace, product, API, operation) and the chain that wraps it: operation → API →
   each product the API belongs to (`products/*/apis.json`) → workspace → global. An API in two
   products has two chains; anything set in *every* chain counts as set.
2. **Variables from outer scopes.** A broader policy runs at the inner policy's `<base />`, so
   what it sets in a section counts from the end of the inner `<base />` in that section, and
   from the start of every later section. Built in phase 2 (`src/policy/scopes.ts`); phase 1
   only needs to supply the outer policies from files instead of the instance.
3. **Named values.** Read `namedValueInformation.json`: the display name is what `{{…}}` uses, so
   index by it; keep `value` for hover when not secret, never for secrets or Key Vault references.
   Flag a `{{name}}` that no named value declares (information, since the extract may be partial).
4. **Backends.** Completion for `set-backend-service backend-id` from `backends/`.
5. **Index changes.** `PolicyIndex` already scans `**/*.xml`; add the `*Information.json` and
   `apis.json` files, read once each (the same single-open rule as policies), and watch them.

**Done when** a policy in an APIOps repo sees product and global variables, `{{…}}` completion
lists real display names with values on hover, and an unknown named value is flagged. Unit tests
run on a fixture extract with two products and a workspace; the integration suite gets one case
per feature. Bench: a 500-file extract scans in under a second, and per-edit cost stays flat
(outer-scope summaries are cached per file version like every other summary).

**Settings:** `apimPolicy.apiops.root` (default: auto-detect the folder holding `apis/` and
`policyFragments/`), for repos with more than one extract.

## Phase 2: read a live instance (opt-in)

For instances that aren't extracted, or to check the extract against what's deployed. Read-only.

**Connection**

- **Auth:** `vscode.authentication.getSession('microsoft', ['https://management.azure.com/.default'])`.
  VS Code owns the sign-in, tenants and conditional access; no Azure SDK in the bundle.
- **Which instance:** `apimPolicy.instance` (an ARM resource ID), or a command that lists the
  user's subscriptions and APIM services and writes the setting. Sovereign clouds via
  `apimPolicy.armEndpoint` (default `https://management.azure.com`).
- **Calls:** plain `fetch` to the ARM REST API (`2024-05-01` or later): `namedValues`,
  `policyFragments` (`?format=rawxml`), `policies` at service, workspace, product, API and
  operation scope, `products/{p}/apis`, `backends`. Paged with `nextLink`.
- **Permissions:** the built-in *API Management Service Reader Role*. Nothing writes, and the
  `listValue` action that reveals secret named values is never called.

**Work**

1. `src/apim/client.ts`: a small ARM client (auth header, paging, 429 retry with `Retry-After`,
   cancellation), and a `Source` interface the index reads through, with two implementations:
   the APIOps reader from phase 1, and the live instance. Everything phase 1 built consumes the
   interface, so the features don't change.
2. Policies from the instance are summarised exactly like files (they're the same XML), cached in
   memory per instance, refreshed on a command and after a configurable TTL (default 10 minutes).
   **Nothing is written to disk**, which matters on machines with on-access scanning.
3. Fragments that exist only on the instance open as read-only virtual documents
   (`apim-instance:` scheme), so go-to-definition and hover work.
4. A language status item: "APIM: <instance>" with last refresh time, and a sign-in prompt when
   the session is missing.

**Done when** a workspace with no extract, pointed at an instance, gets the same outer-scope
variables, fragments and named values as phase 1. Unit tests run on recorded ARM responses; one
integration test runs only when `APIM_IT_INSTANCE` is set, against a Consumption-tier instance.

### Phase 2 as built

- `src/apim/arm.ts` (client: paging, retry on 429/5xx, switching tenant from the 401 challenge),
  `src/apim/instance.ts` (lazy reads, TTL cache, never `listValue`), `src/policy/scopes.ts`
  (scope from path, product chains, outer variables), `src/features/instance.ts` (sign-in,
  status items, commands, `apim-instance:` documents, unknown named values).
- **Which scope a file is** comes from an APIOps-shaped path, or from **APIM: Set This Policy's
  Scope**, kept in workspace state. A second status item shows it.
- Reads are lazy: named values, fragments and backends on first use; for a policy, its API's
  products and the policies on its chain. Completion waits at most 300 ms for the instance.
- **Not done:** workspaces (the APIM feature) aren't in the chain; the live integration test
  (`APIM_IT_INSTANCE`) isn't written, since the test VS Code can't sign in; the integration
  suite covers the commands and the signed-out path.

## Phase 3: simulate a request offline (opt-in)

Superseded by [policy-testing-plan.md](policy-testing-plan.md), which settles the open questions
below and targets CI first. Kept for the history.

A test runner for policy logic: send a request through a policy, with its outer scopes, and see
the response, the variables after every step and which branches ran. Like APIM's trace, without
an instance. A test runner with mocks, not a gateway emulator.

**The hard part is running the C#.** The built-in engine type-checks expressions but can't run
them. Reimplementing .NET in TypeScript (string and LINQ semantics, `DateTime` formats, .NET regex,
Newtonsoft, `XElement`, crypto) would never be exact, and every gap is a test that passes here and
fails on the gateway. So the runner is **.NET**: it compiles each expression with Roslyn against
a real, in-memory implementation of the `context` interfaces (the stubs, made concrete), with the
real BCL and Newtonsoft. Remaining drift is .NET Framework vs .NET 10, which the compatibility
check already flags. It needs the .NET SDK, which is acceptable for an opt-in tool and is the one
feature that does.

**Work**

1. **The runner** (`tools/simulator/`, a small .NET app the extension starts on demand): reads the
   policy and its outer scopes (phase 1's scope model), compiles every expression once (cached by
   source hash, in memory and under the extension's global storage, so a scanned machine pays
   once), and executes the sections in order, `<base />` splicing included. JSON over stdin/stdout
   to the extension.
2. **Policies, in tiers:**
   - *Executed:* `set-variable`, `set-header`, `set-query-parameter`, `set-body`, `rewrite-uri`,
     `set-method`, `set-status`, `choose`, `return-response`, `include-fragment`, `retry`,
     `on-error` with `context.LastError`, `trace`.
   - *Mocked:* `send-request` and `forward-request` (canned responses matched by method and URL,
     or an error), `cache-lookup`/`cache-store` and the `-value` variants (in memory, seedable),
     `authentication-managed-identity` (a fake token).
   - *Simulated, asserted on, not enforced:* `rate-limit*`, `quota*`, `validate-jwt` (test keys,
     or "assume valid"), `validate-content`, `log-to-eventhub`, `emit-metric`. These depend on
     gateway state and keys only Azure has; the run records what they would have done.
   - Anything else is reported as unsupported and skipped, never silently ignored.
3. **Test files** beside the policy (`*.policytest.yaml`): the request, named values, mocks, and
   expectations on the response, headers and variables. A command runs one; VS Code's Test
   Explorer runs them all; `npm run`-style CLI runs them in CI.
4. **Output:** the final response, a step-by-step trace (each policy, variables before and after,
   the branch taken, each mocked call), shown in a webview and as the test result.

**Fidelity.** The risk is in policy semantics, not the C#: bodies that are consumed unless
`preserveContent`, header merging and `exists-action`, what `LastError` holds per failure, retry
timing. Build each policy against its doc page and Microsoft's sample corpus, and say per policy
in the docs what the simulator does and doesn't model.

**Prior art.** Microsoft's [policy toolkit](https://techcommunity.microsoft.com/blog/integrationsonazureblog/-/4303483)
has a [testing package](https://www.nuget.org/packages/Microsoft.Azure.ApiManagement.PolicyToolkit.Testing),
for policies authored in C# with its authoring library rather than existing XML.
[LocalStack's APIM emulator](https://docs.localstack.cloud/azure/services/api-management/) stores
policies but doesn't run them, and the self-hosted gateway needs an instance in Azure. Nothing
found runs existing policy XML offline.

**Done when** a test file can drive the random-user fixture end to end with a mocked
randomuser.me, assert on its outputs, and fail usefully when an expectation doesn't hold, in the
editor and from the CLI.

## Not planned

- **Writing to the instance**, beyond the opt-in push command (README, "Pushing a policy"):
  one file at a time, per allowed instance, after a diff and with an ETag. Bulk publishing is
  what APIOps pipelines are for.
- **Validating on the gateway.** APIM has no dry-run; the only server-side compile is saving the
  policy, which would mean writing to a scratch API. Phase 3 compiles expressions with real .NET,
  which covers most of what that would catch.
- **Emulating the gateway.** Phase 3 runs policy logic with mocks; it doesn't serve traffic, enforce
  limits or validate real tokens.
- **Policy debugging.** Microsoft's extension has a debugger for it.

## Open questions

- Do teams here use APIOps extracts, edit against instances directly, or both? That decides
  whether phase 2 is worth it at all.
- Workspaces (the APIM feature): are they in use? They add a scope to the chain and their own
  named values and fragments.
- For an API in several products, is "set in every chain" right, or should a product be pickable
  (a setting, or a status item that switches it)?
- Phase 3's test file format: YAML beside the policy, or one folder of tests per API? And should
  a run's trace be saveable as the expectations for the next (snapshot-style)?

## Rough size

Phase 1 is a few days: the scope model and its tests are most of it. Phase 2 is about the same
again, most of it in the client, caching and the instance picker. Phase 3 is one to two weeks for
the runner, the executed and mocked tiers and the test files; each further policy is small after
that. It depends on phase 1 for outer scopes, but not on phase 2.
