// What the runner is sent and what it sends back, one JSON object per line. The TypeScript side
// (packages/testing) parses the policy files with the tolerant parser and sends them as trees,
// since rawxml isn't well-formed XML and .NET's readers can't load it.

using System;
using System.Collections.Generic;
using Newtonsoft.Json.Linq;

namespace PolicyRunner
{
    /// <summary>An element of a policy, or a run of text in one (when <see cref="Name"/> is null).</summary>
    public sealed class Node
    {
        public string? Name { get; set; }
        public List<Attr> Attrs { get; set; } = new List<Attr>();
        public List<Node> Children { get; set; } = new List<Node>();
        /// <summary>A text node's text, entity-decoded.</summary>
        public string? Text { get; set; }
        /// <summary>Set when the text node is a policy expression.</summary>
        public Expr? Expr { get; set; }
        /// <summary>Where it starts in its file, 1-based.</summary>
        public int Line { get; set; }
        public int Col { get; set; }
    }

    public sealed class Attr
    {
        public string Name { get; set; } = "";
        /// <summary>The value, entity-decoded.</summary>
        public string Value { get; set; } = "";
        /// <summary>Set when the value is a policy expression.</summary>
        public Expr? Expr { get; set; }
    }

    /// <summary>A policy expression: the C# inside <c>@(…)</c> or <c>@{…}</c>.</summary>
    public sealed class Expr
    {
        public string Code { get; set; } = "";
        /// <summary>A statement block (<c>@{…}</c>) rather than a single expression.</summary>
        public bool Multi { get; set; }
        /// <summary>Where the code starts in its file, 1-based, for errors.</summary>
        public int Line { get; set; }
        public int Col { get; set; }
    }

    /// <summary>One run: a request through a policy and its broader scopes.</summary>
    public sealed class RunInput
    {
        /// <summary>The policy under test and its broader scopes, innermost first.</summary>
        public List<ScopePolicy> Scopes { get; set; } = new List<ScopePolicy>();
        /// <summary>Fragments by id.</summary>
        public Dictionary<string, FragmentInput> Fragments { get; set; } = new Dictionary<string, FragmentInput>();
        /// <summary>Named values by display name, matched ignoring case as APIM does.</summary>
        public Dictionary<string, string> NamedValues { get; set; } = new Dictionary<string, string>();
        public RequestInput Request { get; set; } = new RequestInput();
        /// <summary>What forward-request gets back; a run that forwards without one fails.</summary>
        public ResponseInput? Backend { get; set; }
        public ContextInput Context { get; set; } = new ContextInput();
    }

    public sealed class ScopePolicy
    {
        /// <summary>global, product, api, operation, or anything else for a test's own wrapper.</summary>
        public string Kind { get; set; } = "";
        /// <summary>How to name the scope in steps and errors, e.g. "API echo".</summary>
        public string Label { get; set; } = "";
        public string? File { get; set; }
        /// <summary>
        /// The parsed <c>&lt;policies&gt;</c>, or null when the scope has none. APIM treats a missing policy as
        /// <c>&lt;base /&gt;</c> in every section, and a missing outermost one as its default policy,
        /// which forwards the request.
        /// </summary>
        public Node? Root { get; set; }
    }

    public sealed class FragmentInput
    {
        public string? File { get; set; }
        /// <summary>The parsed <c>&lt;fragment&gt;</c>.</summary>
        public Node Root { get; set; } = new Node();
    }

    public sealed class RequestInput
    {
        public string Method { get; set; } = "GET";
        /// <summary>The URL the client called (<c>context.Request.OriginalUrl</c>).</summary>
        public string Url { get; set; } = "https://apim.example.net/";
        /// <summary>
        /// The backend URL the gateway starts from (<c>context.Request.Url</c>): the API's service URL
        /// with the operation's path. Defaults to <see cref="Url"/>.
        /// </summary>
        public string? BackendUrl { get; set; }
        public Dictionary<string, string[]> Headers { get; set; } = new Dictionary<string, string[]>();
        public string? Body { get; set; }
        public string IpAddress { get; set; } = "127.0.0.1";
        public Dictionary<string, string> MatchedParameters { get; set; } = new Dictionary<string, string>();
    }

    public sealed class ResponseInput
    {
        public int Status { get; set; } = 200;
        public string? Reason { get; set; }
        public Dictionary<string, string[]> Headers { get; set; } = new Dictionary<string, string[]>();
        public string? Body { get; set; }
    }

    /// <summary>What the gateway knows about the call. Anything left out gets a fixed test value, or null where APIM gives null.</summary>
    public sealed class ContextInput
    {
        public ApiInput Api { get; set; } = new ApiInput();
        public OperationInput Operation { get; set; } = new OperationInput();
        /// <summary>Null: the call isn't through a product, as with no subscription.</summary>
        public NamedInput? Product { get; set; }
        public SubscriptionInput? Subscription { get; set; }
        public UserInput? User { get; set; }
        public Guid? RequestId { get; set; }
        public DateTime? Timestamp { get; set; }
        public string Region { get; set; } = "West Europe";
        public string ServiceName { get; set; } = "apim-test";
    }

    public sealed class ApiInput
    {
        public string Id { get; set; } = "test-api";
        public string Name { get; set; } = "Test API";
        public string Path { get; set; } = "";
        public string? ServiceUrl { get; set; }
        public string? Revision { get; set; } = "1";
        public string? Version { get; set; }
    }

    public sealed class OperationInput
    {
        public string Id { get; set; } = "test-operation";
        public string Name { get; set; } = "Test operation";
        public string? Method { get; set; }
        public string UrlTemplate { get; set; } = "/";
    }

    public sealed class NamedInput
    {
        public string Id { get; set; } = "";
        public string Name { get; set; } = "";
    }

    public sealed class SubscriptionInput
    {
        public string Id { get; set; } = "test-subscription";
        public string Name { get; set; } = "Test subscription";
        public string Key { get; set; } = "test-key";
    }

    public sealed class UserInput
    {
        public string Id { get; set; } = "test-user";
        public string Email { get; set; } = "user@example.com";
        public string FirstName { get; set; } = "Test";
        public string LastName { get; set; } = "User";
        public List<NamedInput> Groups { get; set; } = new List<NamedInput>();
    }

    /// <summary>What a run did.</summary>
    public sealed class RunResult
    {
        /// <summary>The response the client gets; null when nothing produced one.</summary>
        public ResponseOutput? Response { get; set; }
        /// <summary>Every variable at the end, as JSON with its .NET type.</summary>
        public Dictionary<string, VariableOutput> Variables { get; set; } = new Dictionary<string, VariableOutput>();
        /// <summary>Calls out of the gateway: the backend, and send-request.</summary>
        public List<CallOutput> Calls { get; set; } = new List<CallOutput>();
        /// <summary>What trace policies and context.Trace wrote.</summary>
        public List<TraceOutput> Trace { get; set; } = new List<TraceOutput>();
        /// <summary>Each policy that ran, in order.</summary>
        public List<StepOutput> Steps { get; set; } = new List<StepOutput>();
        /// <summary>The error that sent the run to on-error, as context.LastError held it.</summary>
        public ErrorOutput? Error { get; set; }
        /// <summary>Why the run couldn't be done at all: a compile error, an unsupported policy, a missing mock.</summary>
        public FailureOutput? Failure { get; set; }
    }

    public sealed class ResponseOutput
    {
        public int Status { get; set; }
        public string? Reason { get; set; }
        public Dictionary<string, string[]> Headers { get; set; } = new Dictionary<string, string[]>();
        public string? Body { get; set; }
    }

    public sealed class VariableOutput
    {
        public string Type { get; set; } = "";
        public JToken? Value { get; set; }
    }

    public sealed class CallOutput
    {
        /// <summary>backend, or send-request.</summary>
        public string Kind { get; set; } = "";
        public string Method { get; set; } = "";
        public string Url { get; set; } = "";
        public Dictionary<string, string[]> Headers { get; set; } = new Dictionary<string, string[]>();
        public string? Body { get; set; }
    }

    public sealed class TraceOutput
    {
        public string Source { get; set; } = "";
        public string Severity { get; set; } = "verbose";
        public string Message { get; set; } = "";
        public Dictionary<string, string> Metadata { get; set; } = new Dictionary<string, string>();
    }

    public sealed class StepOutput
    {
        public string Policy { get; set; } = "";
        public string Scope { get; set; } = "";
        public string Section { get; set; } = "";
        public string? File { get; set; }
        public int Line { get; set; }
        /// <summary>What it did, when that's more than running: the branch taken, the value set.</summary>
        public string? Detail { get; set; }
    }

    public sealed class ErrorOutput
    {
        public string Source { get; set; } = "";
        public string Reason { get; set; } = "";
        public string Message { get; set; } = "";
        public string Scope { get; set; } = "";
        public string Section { get; set; } = "";
        public string Path { get; set; } = "";
        public string? File { get; set; }
        public int Line { get; set; }
    }

    public sealed class FailureOutput
    {
        /// <summary>compile, unsupported, test (the test lacks something the run needs) or runner.</summary>
        public string Kind { get; set; } = "";
        public string Message { get; set; } = "";
        public string? File { get; set; }
        public int Line { get; set; }
        public int Col { get; set; }
        /// <summary>For compile failures, every error.</summary>
        public List<DiagnosticOutput> Diagnostics { get; set; } = new List<DiagnosticOutput>();
    }

    public sealed class DiagnosticOutput
    {
        public string Code { get; set; } = "";
        public string Message { get; set; } = "";
        public string? File { get; set; }
        public int Line { get; set; }
        public int Col { get; set; }
    }
}
