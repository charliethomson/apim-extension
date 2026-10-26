# apim-policy

**Unit tests for Azure API Management policies, run offline in CI.**

`apim-policy test` runs YAML tests that sit beside the policies in an APIOps extract. Each test
sends a request through a policy and its broader scopes (operation, API, product, global),
answers the backend itself, and checks the response, variables, outgoing calls and trace. The C#
in policy expressions is compiled at C# 7.3 against the real .NET libraries, so it behaves as it
does on the gateway. Nothing talks to Azure.

## Install

It isn't published to a registry yet. Build the package from this repo, then install the tarball:

```bash
npm ci
```

```bash
npm run package:cli
```

```bash
npm install -g cli/apim-policy-cli-*.tgz
```

It needs Node 20 or later and the .NET 10 runtime (`dotnet` on `PATH`).

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
steps:
  - task: UseDotNet@2
    displayName: .NET 10 runtime for the policy tests
    inputs:
      packageType: runtime
      version: 10.x
  - task: NodeTool@0
    inputs:
      versionSpec: 22.x
  - script: npm install -g $(Pipeline.Workspace)/tools/apim-policy-cli.tgz
    displayName: Install apim-policy
  - script: apim-policy test --junit $(Agent.TempDirectory)/policy-tests.xml
    displayName: Policy tests
  - task: PublishTestResults@2
    condition: succeededOrFailed()
    inputs:
      testResultsFormat: JUnit
      testResultsFiles: $(Agent.TempDirectory)/policy-tests.xml
      testRunTitle: APIM policy tests
```

Under Azure Pipelines each failure also shows on the build summary at its file and line. Where
the tarball comes from (`tools/apim-policy-cli.tgz` above) depends on how you get it there until
it's published.
