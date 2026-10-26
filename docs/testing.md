# Policy tests

Policy tests run a request through a policy and its broader scopes offline, with the outside
world answered by the test, and check what comes out. The runner in [`runner/`](../runner)
compiles the C# with Roslyn at C# 7.3, against the real BCL and Newtonsoft, so the expressions
behave as they do on the gateway (apart from .NET Framework 4.8 vs modern .NET, which the editor's
compatibility check flags). Policy semantics are rebuilt from the Learn pages, so this page says
what each one does here. [`packages/testing`](../packages/testing) reads the test files, builds
each run from the APIOps extract and checks the results. The design is in
[policy-testing-plan.md](policy-testing-plan.md). `npx @charliethomson/apim-cli test` runs them
([`cli/`](../cli)); [its README](../cli/README.md) has the Azure Pipelines steps.

## Test files

A test file is YAML in a `tests/` folder beside the scope it tests:

| Tests | Run |
|---|---|
| `tests/*.yaml` at the extract's root | the global policy |
| `products/<p>/tests/*.yaml` | the product's policy, inside global |
| `apis/<api>/tests/*.yaml` | the API's policy, inside its product's and global (`policy: operations/<op>` tests an operation instead) |
| `apis/<api>/operations/<op>/tests/*.yaml` | the operation's policy, inside all of those |
| `policyFragments/<id>/tests/*.yaml` | the fragment alone, included in one section of an empty policy |

```yaml
name: keeps only users from the requested nationality
policy: operations/get-users    # optional: a policy under this scope's folder
product: starter                # needed when the API is in more than one product
section: inbound                # fragment tests only: where it's included (inbound by default)
namedValues:                    # on top of the plain values in namedValues/ (secrets need giving)
  random-user-cache-seconds: 60
variables:                      # set before the run, as a fragment's @in inputs would be
  ru-arg-results: "5"
context:                        # what the gateway knows, on top of what the extract says
  user: { email: a@example.com }
  subscription: { key: test-key }
request:
  method: GET                   # GET by default
  url: /users?nat=GB            # a path goes under the API's path; a full URL is taken as it is
  headers: { Accept: application/json }
  body: { json: { a: 1 } }      # text, { text: … }, { json: … } or { file: data/x.json } beside the test
  matchedParameters: { id: "7" }
backend:                        # what forward-request gets back
  status: 200
  headers: { Content-Type: application/json }
  body: { file: data/users.json }
expect:
  response:
    status: 200
    reason: OK
    headers: { Content-Type: application/json, X-Debug: null }   # null: must be absent
    body: { json: { results: [ { nat: GB } ] } }                  # or text, contains, file, empty: true
  variables:
    ru-arg-results: "5"         # a JSON value compares as a subset; null: must not be set
  calls:                        # in this order, others may come between; [] means no calls
    - { method: GET, url: "https://randomuser.me/api/*", headers: { X-Key: k } }
  trace:
    - { source: random-users, severity: information, contains: "cache miss" }
  error: null                   # or { reason, source, section, contains } for what ran on-error
```

`cases:` holds a list of tests that share everything above it: each case needs a `name`, and its
mappings merge into the shared ones (its own values win). A JSON expectation matches when every
key it gives matches; the actual object may have more, but lists must have the same length and
match item by item. Unknown fields are errors, so a typo doesn't pass silently.

The request's backend URL comes from the API's `serviceUrl` in `apiInformation.json` and the part
of the request's path after the API's path. `context.Api`, `Operation` and `Product` come from
the extract too.

## What a run models

### The pipeline

- Sections run inbound, backend, outbound. `<base />` runs the next broader scope's same
  section. A section a policy leaves out means the broader scopes' section doesn't run.
- A scope with no policy counts as `<base />` everywhere. If the outermost scope (global) has
  none, APIM's default policy applies, and its backend section forwards the request.
- `return-response` ends the run. Nothing after it runs, outbound included.
- An error (an expression throwing, a policy failing) sets `context.LastError` and runs
  on-error the same way, from the innermost scope. on-error starts from the gateway's 500 with
  its JSON body, which it can change (`set-header`, `set-status`) or replace (`return-response`).
  If on-error fails too, the client gets that 500.
- `{{named values}}` are put into expressions and attribute values before anything compiles, as
  on save. One the test doesn't give fails the test.
- `context.Request.Url` starts as the backend URL (the API's service URL plus the operation's
  path) and `OriginalUrl` is what the client called.

### Policies

| Policy | Here |
|---|---|
| `set-variable` | Stores what the expression returns, or the literal text as a string. |
| `set-header` | `override` (the default), `skip`, `append`, `delete`. The request's headers before the backend answers, the response's after, and the new response's inside `return-response`. |
| `set-query-parameter` | As `set-header`, on the request URL's query. |
| `set-body` | The request's or the response's body, by section. A `JObject` result is written with `ToString()`. Liquid templates aren't supported. |
| `set-method`, `set-status` | As documented. `set-status` before a response exists creates one. |
| `rewrite-uri` | Replaces the path under the API's service URL. `{name}` takes a matched URL parameter, else the query parameter. Unused query parameters stay unless `copy-unmatched-params="false"`. |
| `set-backend-service` | `base-url` replaces the service URL part of the request URL. `backend-id` is recorded in the steps and changes nothing, since a test has no backends. |
| `choose` | The first `when` whose condition is true, else `otherwise`. A condition must come out a bool. |
| `return-response` | Builds a new response (or uses `response-variable-name`) from its children, then ends the run. |
| `include-fragment` | Runs the fragment's policies in place. A fragment the extract doesn't have fails the test. |
| `retry` | Runs its policies, then again while the condition is true and retries are left. Intervals aren't waited. |
| `trace` | Recorded with its source, severity, message and metadata. `context.Trace` is recorded too. |
| `forward-request` | Recorded as a backend call (method, URL, headers, body) and answered with the test's backend response. A test that forwards without one fails. |
| anything else | Fails the test as unsupported, naming the policy and its line. |

### Bodies

`Body.As<T>()` reads `string`, `byte[]`, `JObject`, `JArray`, `JToken`, `XDocument`, `XElement`
and `XNode`. Without `preserveContent: true` the read consumes the body, as the gateway's stream
does: later reads get an empty body, and so does the backend. An empty body read as JSON or XML
is `null`.

### The rest of `context`

Whatever the test leaves out gets a fixed value: an API and operation named for the test,
region West Europe, a managed gateway. `context.Product`, `Subscription` and `User` are null
unless the test gives them, as for an anonymous call with no subscription.
`Backend`, `GraphQL`, `Workspace` and the request's client certificate are null.
