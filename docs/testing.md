# What the policy test runner models

The runner in [`runner/`](../runner) runs a request through a policy and its broader scopes
offline. It compiles the C# with Roslyn at C# 7.3, against the real BCL and Newtonsoft, so the
expressions behave as they do on the gateway (apart from .NET Framework 4.8 vs modern .NET,
which the editor's compatibility check flags). Policy semantics are rebuilt from the Learn pages,
so this page says what each one does here. The design is in
[policy-testing-plan.md](policy-testing-plan.md). The test files and CLI aren't built yet.

## The pipeline

- Sections run inbound, backend, outbound. `<base />` runs the next broader scope's same
  section. A section a policy leaves out means the broader scopes' section doesn't run.
- A scope with no policy counts as `<base />` everywhere. If the outermost scope (global) has
  none, APIM's default policy applies, and its backend section forwards the request.
- `return-response` ends the run. Nothing after it runs, outbound included.
- An error (an expression throwing, a policy failing) sets `context.LastError` and runs
  on-error the same way, from the innermost scope. When on-error sets no response, or fails
  itself, the client gets the gateway's 500 with its JSON body.
- `{{named values}}` are put into expressions and attribute values before anything compiles, as
  on save. One the test doesn't give fails the test.
- `context.Request.Url` starts as the backend URL (the API's service URL plus the operation's
  path) and `OriginalUrl` is what the client called.

## Policies

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

## Bodies

`Body.As<T>()` reads `string`, `byte[]`, `JObject`, `JArray`, `JToken`, `XDocument`, `XElement`
and `XNode`. Without `preserveContent: true` the read consumes the body, as the gateway's stream
does: later reads get an empty body, and so does the backend. An empty body read as JSON or XML
is `null`.

## The rest of `context`

Whatever the test leaves out gets a fixed value: an API and operation named for the test,
region West Europe, a managed gateway. `context.Product`, `Subscription` and `User` are null
unless the test gives them, as for an anonymous call with no subscription.
`Backend`, `GraphQL`, `Workspace` and the request's client certificate are null.
