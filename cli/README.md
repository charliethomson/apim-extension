# apim-policy

**Unit tests for Azure API Management policies, run offline in CI.**

`apim-policy test` runs YAML tests that sit beside the policies in an APIOps extract. Each test
sends a request through a policy and its broader scopes (operation, API, product, global),
answers the backend itself, and checks the response, variables, outgoing calls and trace. The C#
in policy expressions is compiled at C# 7.3 against the real .NET libraries, so it behaves as it
does on the gateway. Nothing talks to Azure.

## Install

```bash
npx -y @charliethomson/apim-cli test
```

That runs the latest release without installing anything. Pin a version in CI
(`@charliethomson/apim-cli@0.1`), or install it once with `npm install -g @charliethomson/apim-cli`;
re-running the install upgrades it. Every push to `main` is published under the `next` tag too
(`@charliethomson/apim-cli@next`).

It needs Node 20 or later and the .NET 10 runtime (`dotnet` on `PATH`). Azure DevOps and GitHub
hosted agents have both.

## Use

```bash
apim-policy test
```

That finds every YAML file in a `tests/` folder under the working folder and runs it. Give folders
or files to narrow it down: `apim-policy test apis/orders`.

| Option | |
|---|---|
| `--junit <file>` | Write JUnit XML, for `PublishTestResults@2` |
| `--filter <text>` | Only tests whose name contains this |
| `--trace <dir>` | Write each test's run (every policy step, trace, call) as JSON |
| `--runner <path>` | A policy runner other than the bundled one |
| `--cache <dir>` | Keep compiled expressions between runs (default: the temp folder) |
| `--timeout <s>` | Seconds one test may take (default 60) |
| `--azure-devops`, `--no-azure-devops` | Report failures as Azure DevOps issues; on by default under Azure Pipelines |

Exit codes: 0 when every test passed, 1 when a test failed, 2 when a test couldn't run (a broken
test file, a policy the runner doesn't support yet, a compile error) or nothing was found.

## A test

```yaml
# apis/orders/tests/orders.yaml
product: gold
request:
  url: /list?page=2
backend:
  status: 200
  body: { json: { orders: [ { id: 1 } ] } }
cases:
  - name: forwards stamped
    expect:
      response: { status: 200 }
      calls:
        - url: https://backend.example.net/api/list?page=2
          headers: { X-Stamp: contoso/gold }
  - name: rejects when asked to
    request: { headers: { X-Reject: "yes" } }
    expect:
      response: { status: 403 }
      calls: []
```

The full format, and what the runner does for each policy, is in
[docs/testing.md](https://github.com/charliethomson/apim-extension/blob/main/docs/testing.md).

## Azure Pipelines

```yaml
pool:
  vmImage: ubuntu-latest   # windows-latest works too; both have node and .NET 10

steps:
  - script: npx -y @charliethomson/apim-cli@0.1 test --junit $(Agent.TempDirectory)/policy-tests.xml
    displayName: Policy tests
  - task: PublishTestResults@2
    condition: succeededOrFailed()
    inputs:
      testResultsFormat: JUnit
      testResultsFiles: $(Agent.TempDirectory)/policy-tests.xml
      testRunTitle: APIM policy tests
```

Each failure also shows on the build summary at its file and line. On a self-hosted agent without
.NET 10, add a `UseDotNet@2` step (`packageType: runtime`, `version: 10.x`) first; without node,
a `NodeTool@0` step.

## Building it from source

```bash
npm ci
```

```bash
npm run package:cli
```

That packs `cli/charliethomson-apim-cli-<version>.tgz`, with the .NET runner inside, at the version
derived from git; `npm install -g` it like any tarball.
