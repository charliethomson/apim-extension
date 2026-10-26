using System.Linq;
using Newtonsoft.Json.Linq;
using PolicyRunner;
using Xunit;
using static PolicyRunner.Tests.Trees;

namespace PolicyRunner.Tests
{
    public class EngineTests
    {
        internal static readonly Engine Engine = new Engine(new ExpressionCompiler());

        [Fact]
        public void SetsVariablesFromLiteralsAndExpressions()
        {
            var run = Run(("api", Policy(
                "<set-variable name='plain' value='hello' />" +
                "<set-variable name='count' value='@(context.Request.Url.Query.GetValueOrDefault(\"count\", \"25\"))' />" +
                "<set-variable name='body' value='@(new JObject { [\"id\"] = 7 })' />" +
                "<set-variable name='five' value='@(5)' />")), ("global", null));
            run.Request.Url = "https://apim.example.net/users?count=3";
            var r = Engine.Run(run);
            Assert.Null(r.Failure);
            Assert.Equal("hello", (string?)r.Variables["plain"].Value);
            Assert.Equal("3", (string?)r.Variables["count"].Value);
            Assert.Equal("JObject", r.Variables["body"].Type);
            Assert.Equal(7, (int)r.Variables["body"].Value!["id"]!);
            Assert.Equal("Int32", r.Variables["five"].Type);
        }

        [Fact]
        public void SplicesBroaderScopesAtBase()
        {
            var r = Engine.Run(Run(
                ("operation", "<policies><inbound><set-variable name='order' value='op' /><base /></inbound><backend><base /></backend><outbound><base /></outbound></policies>"),
                ("api", null),
                ("product", Policy("<set-variable name='order' value='@((string)context.Variables[\"order\"] + \",product\")' />")),
                ("global", "<policies><inbound><set-variable name='order' value='@((string)context.Variables[\"order\"] + \",global\")' /></inbound><backend><forward-request /></backend><outbound /></policies>")));
            Assert.Null(r.Failure);
            // The product's inbound starts with <base />, so global's runs before its own set-variable.
            Assert.Equal("op,global,product", (string?)r.Variables["order"].Value);
            Assert.Equal(new[] { "set-variable", "base", "base", "set-variable", "set-variable", "base", "base", "forward-request", "base", "base" }, r.Policies());
            Assert.Equal("backend body", r.Response!.Body);
        }

        [Fact]
        public void ForwardsWithTheDefaultPolicyWhenTheOutermostScopeHasNone()
        {
            var r = Engine.Run(Run(("api", Policy()), ("global", null)));
            Assert.Single(r.Calls);
            Assert.Contains(r.Steps, s => s.Policy == "forward-request" && s.Detail!.Contains("default policy"));
        }

        [Fact]
        public void SkipsTheBroaderScopesWhenASectionHasNoBase()
        {
            var r = Engine.Run(Run(
                ("api", "<policies><inbound><set-variable name='a' value='1' /></inbound><backend><forward-request /></backend><outbound /></policies>"),
                ("global", Policy("<set-variable name='g' value='1' />"))));
            Assert.False(r.Variables.ContainsKey("g"));
        }

        [Fact]
        public void TakesTheFirstMatchingBranch()
        {
            var run = Run(("api", Policy(
                "<choose>" +
                "<when condition='@(context.Request.Method == \"POST\")'><set-variable name='branch' value='post' /></when>" +
                "<when condition='@(context.Request.Headers.ContainsKey(\"X-Admin\"))'><set-variable name='branch' value='admin' /></when>" +
                "<otherwise><set-variable name='branch' value='other' /></otherwise>" +
                "</choose>")), ("global", null));
            run.Request.Headers = Headers(("x-admin", "yes"));
            var r = Engine.Run(run);
            Assert.Equal("admin", (string?)r.Variables["branch"].Value);
            Assert.Equal("when #2", r.Steps.First(s => s.Policy == "choose").Detail);
        }

        [Fact]
        public void ChangesTheRequestBeforeTheBackendAndTheResponseAfter()
        {
            var run = Run(("api", Policy(
                inbound: "<set-header name='X-Added' exists-action='override'><value>a</value><value>b</value></set-header>" +
                         "<set-header name='X-Gone' exists-action='delete' />" +
                         "<set-header name='X-Kept' exists-action='skip'><value>new</value></set-header>" +
                         "<set-query-parameter name='page' exists-action='append'><value>2</value></set-query-parameter>" +
                         "<set-method>POST</set-method>" +
                         "<set-body>@(new JObject { [\"sent\"] = true }.ToString())</set-body>",
                outbound: "<set-header name='X-Out' exists-action='append'><value>@(context.Response.StatusCode.ToString())</value></set-header>" +
                          "<set-status code='201' reason='Made' />")), ("global", null));
            run.Request.Url = "https://apim.example.net/x?page=1";
            run.Request.Headers = Headers(("X-Gone", "1"), ("X-Kept", "old"));
            var r = Engine.Run(run);
            Assert.Null(r.Failure);
            var call = Assert.Single(r.Calls);
            Assert.Equal("POST", call.Method);
            Assert.Equal("https://apim.example.net/x?page=1&page=2", call.Url);
            Assert.Equal(new[] { "a", "b" }, call.Headers["X-Added"]);
            Assert.False(call.Headers.ContainsKey("X-Gone"));
            Assert.Equal(new[] { "old" }, call.Headers["X-Kept"]);
            Assert.True((bool)JObject.Parse(call.Body!)["sent"]!);
            Assert.Equal(201, r.Response!.Status);
            Assert.Equal("Made", r.Response.Reason);
            Assert.Equal(new[] { "200" }, r.Response.Headers["X-Out"]);
        }

        [Fact]
        public void StopsAtReturnResponse()
        {
            var r = Engine.Run(Run(("api", Policy(
                inbound: "<return-response><set-status code='401' /><set-header name='WWW-Authenticate' exists-action='override'><value>Bearer</value></set-header><set-body>no</set-body></return-response><set-variable name='after' value='1' />",
                outbound: "<set-variable name='outbound' value='1' />")), ("global", null)));
            Assert.Empty(r.Calls);
            Assert.Equal(401, r.Response!.Status);
            Assert.Equal("Unauthorized", r.Response.Reason);
            Assert.Equal("no", r.Response.Body);
            Assert.Equal(new[] { "Bearer" }, r.Response.Headers["WWW-Authenticate"]);
            Assert.Empty(r.Variables);
        }

        [Fact]
        public void RunsFragmentsInPlace()
        {
            var run = Run(("api", Policy("<set-variable name='in' value='x' /><include-fragment fragment-id='upper' />")), ("global", null));
            run.AddFragment("upper", "<fragment><set-variable name='out' value='@(((string)context.Variables[\"in\"]).ToUpperInvariant())' /></fragment>");
            var r = Engine.Run(run);
            Assert.Equal("X", (string?)r.Variables["out"].Value);
            Assert.Equal("fragments/upper.xml", r.Steps.Single(s => s.Policy == "set-variable" && s.Detail!.StartsWith("out")).File);
        }

        [Fact]
        public void FailsOnAFragmentTheExtractLacks()
        {
            var r = Engine.Run(Run(("api", Policy("<include-fragment fragment-id='nope' />")), ("global", null)));
            Assert.Equal("test", r.Failure!.Kind);
            Assert.Contains("'nope'", r.Failure.Message);
        }

        [Fact]
        public void SendsAnErrorToOnErrorWithLastError()
        {
            var r = Engine.Run(Run(("api", Policy(
                inbound: "<set-variable name='bad' value='@(((string)context.Variables[\"missing\"]).Length)' />",
                onError: "<set-variable name='reason' value='@(context.LastError.Reason)' /><set-variable name='source' value='@(context.LastError.Source)' />" +
                         "<return-response><set-status code='400' /><set-body>@(context.LastError.Section)</set-body></return-response>")), ("global", null)));
            Assert.Null(r.Failure);
            Assert.Equal("ExpressionValueEvaluationFailure", (string?)r.Variables["reason"].Value);
            Assert.Equal("set-variable", (string?)r.Variables["source"].Value);
            Assert.Equal(400, r.Response!.Status);
            Assert.Equal("inbound", r.Response.Body);
            Assert.Equal("api.xml", r.Error!.File);
            Assert.Contains("missing", r.Error.Message, System.StringComparison.Ordinal);
        }

        [Fact]
        public void HandsOnErrorTheErrorResponseToChange()
        {
            var r = Engine.Run(Run(("api", Policy(
                outbound: "<set-variable name='bad' value='@(context.Response.Body.As&lt;JObject&gt;())' />",
                onError: "<set-header name='X-Reason' exists-action='override'><value>@(context.LastError.Reason)</value></set-header>")), ("global", null)));
            Assert.Equal(500, r.Response!.Status);
            Assert.Equal(new[] { "ExpressionValueEvaluationFailure" }, r.Response.Headers["X-Reason"]);
            Assert.Equal("outbound", r.Error!.Section);
        }

        [Fact]
        public void StartsWithTheVariablesATestSets()
        {
            var run = Run(("api", Policy("<set-variable name='out' value='@((string)context.Variables[\"s\"] + (int)context.Variables[\"i\"] + (long)context.Variables[\"l\"] + (double)context.Variables[\"d\"] + (bool)context.Variables[\"b\"] + ((JObject)context.Variables[\"o\"])[\"k\"] + ((JArray)context.Variables[\"a\"]).Count + (context.Variables[\"n\"] == null))' />")), ("global", null));
            run.Variables["s"] = "x";
            run.Variables["i"] = 1;
            run.Variables["l"] = 5000000000L;
            run.Variables["d"] = 1.5;
            run.Variables["b"] = true;
            run.Variables["o"] = new JObject { ["k"] = "v" };
            run.Variables["a"] = new JArray(1, 2);
            run.Variables["n"] = JValue.CreateNull();
            var r = Engine.Run(run);
            Assert.Null(r.Failure);
            Assert.Equal("x150000000001.5Truev2True", (string?)r.Variables["out"].Value);
        }

        [Fact]
        public void AnswersAnUnhandledErrorWithA500()
        {
            var r = Engine.Run(Run(("api", Policy("<set-variable name='bad' value='@(int.Parse(\"x\"))' />")), ("global", null)));
            Assert.Equal(500, r.Response!.Status);
            Assert.Equal("Internal server error", (string?)JObject.Parse(r.Response.Body!)["message"]);
            Assert.Empty(r.Calls);
        }

        [Fact]
        public void FailsWhenItForwardsWithNoBackendResponse()
        {
            var run = Run(("api", Policy()), ("global", null));
            run.Backend = null;
            Assert.Equal("test", Engine.Run(run).Failure!.Kind);
        }

        [Fact]
        public void FailsOnAPolicyItDoesntSupport()
        {
            var r = Engine.Run(Run(("api", Policy("<quota calls='10' renewal-period='60' />")), ("global", null)));
            Assert.Equal("unsupported", r.Failure!.Kind);
            Assert.Equal("api.xml", r.Failure.File);
            Assert.Contains("<quota>", r.Failure.Message, System.StringComparison.Ordinal);
        }

        [Fact]
        public void SubstitutesNamedValuesInLiteralsAndExpressions()
        {
            var run = Run(("api", Policy("<set-variable name='a' value='{{greeting}}, world' /><set-variable name='b' value='@(\"{{Greeting}}\".Length)' /><set-variable name='c' value='@(NamedValues.Get(\"greeting\"))' />")), ("global", null));
            run.NamedValues["greeting"] = "hello";
            var r = Engine.Run(run);
            Assert.Equal("hello, world", (string?)r.Variables["a"].Value);
            Assert.Equal(5, (int)r.Variables["b"].Value!);
            Assert.Equal("hello", (string?)r.Variables["c"].Value);
        }

        [Fact]
        public void FailsOnANamedValueTheTestDoesntSet()
        {
            var r = Engine.Run(Run(("api", Policy("<set-variable name='a' value='@(\"{{secret}}\")' />")), ("global", null)));
            Assert.Equal("test", r.Failure!.Kind);
            Assert.Contains("'secret'", r.Failure.Message, System.StringComparison.Ordinal);
        }

        [Fact]
        public void ConsumesABodyReadWithoutPreserveContent()
        {
            var keep = Run(("api", Policy("<set-variable name='b' value='@(context.Request.Body.As&lt;string&gt;(preserveContent: true))' />")), ("global", null));
            keep.Request.Body = "{\"a\":1}";
            Assert.Equal("{\"a\":1}", Engine.Run(keep).Calls.Single().Body);

            var consume = Run(("api", Policy("<set-variable name='b' value='@(context.Request.Body.As&lt;JObject&gt;())' />")), ("global", null));
            consume.Request.Body = "{\"a\":1}";
            var r = Engine.Run(consume);
            Assert.Equal(1, (int)r.Variables["b"].Value!["a"]!);
            Assert.Null(r.Calls.Single().Body);
        }

        [Fact]
        public void RewritesTheUrlUnderTheServiceUrl()
        {
            var run = Run(("api", Policy("<rewrite-uri template='/v2/users/{id}?sort={sort}' />")), ("global", null));
            run.Request.Url = "https://apim.example.net/people/users/7?sort=age&page=2";
            run.Request.BackendUrl = "https://backend.example.net/api/users/7?sort=age&page=2";
            run.Context.Api.ServiceUrl = "https://backend.example.net/api";
            run.Request.MatchedParameters["id"] = "7";
            Assert.Equal("https://backend.example.net/api/v2/users/7?sort=age&page=2", Engine.Run(run).Calls.Single().Url);
        }

        [Fact]
        public void SwapsTheServiceUrlForABaseUrl()
        {
            var run = Run(("api", Policy("<set-backend-service base-url='https://other.example.net/v9' />")), ("global", null));
            run.Request.BackendUrl = "https://backend.example.net/api/users?x=1";
            run.Context.Api.ServiceUrl = "https://backend.example.net/api";
            Assert.Equal("https://other.example.net/v9/users?x=1", Engine.Run(run).Calls.Single().Url);
        }

        [Fact]
        public void RetriesWhileTheConditionHolds()
        {
            var r = Engine.Run(Run(("api", Policy(
                "<set-variable name='n' value='@(0)' />" +
                "<retry condition='@((int)context.Variables[\"n\"] &lt; 3)' count='5' interval='1'><set-variable name='n' value='@((int)context.Variables[\"n\"] + 1)' /></retry>")), ("global", null)));
            Assert.Equal(3, (int)r.Variables["n"].Value!);
            Assert.Equal("ran 3 times", r.Steps.Single(s => s.Policy == "retry").Detail);
        }

        [Fact]
        public void CollectsTraces()
        {
            var r = Engine.Run(Run(("api", Policy("<trace source='users' severity='error'><message>@(\"saw \" + context.Request.Method)</message><metadata name='k' value='v' /></trace><set-variable name='x' value='@{ context.Trace(\"hi\"); return 1; }' />")), ("global", null)));
            Assert.Equal("users", r.Trace[0].Source);
            Assert.Equal("error", r.Trace[0].Severity);
            Assert.Equal("saw GET", r.Trace[0].Message);
            Assert.Equal("v", r.Trace[0].Metadata["k"]);
            Assert.Equal("hi", r.Trace[1].Message);
        }

        [Fact]
        public void ReportsCompileErrorsInTheirFile()
        {
            var r = Engine.Run(Run(("api", "<policies>\n<inbound>\n<set-variable name='x' value='@(context.Nope)' />\n</inbound>\n</policies>"), ("global", null)));
            Assert.Equal("compile", r.Failure!.Kind);
            var d = Assert.Single(r.Failure.Diagnostics);
            Assert.Equal("api.xml", d.File);
            Assert.Equal(3, d.Line);
            Assert.Equal("CS1061", d.Code);
            Assert.Equal(41, d.Col);
        }

        [Fact]
        public void HasTheContextATestDescribes()
        {
            var run = Run(("api", Policy(
                "<set-variable name='api' value='@(context.Api.Name)' />" +
                "<set-variable name='product' value='@(context.Product == null ? \"none\" : context.Product.Name)' />" +
                "<set-variable name='user' value='@(context.User.Email)' />" +
                "<set-variable name='original' value='@(context.Request.OriginalUrl.Host)' />" +
                "<set-variable name='backend' value='@(context.Request.Url.Host)' />")), ("global", null));
            run.Context.Api.Name = "Users";
            run.Context.User = new UserInput { Email = "a@b.c" };
            run.Request.BackendUrl = "https://backend.example.net/";
            var r = Engine.Run(run);
            Assert.Equal("Users", (string?)r.Variables["api"].Value);
            Assert.Equal("none", (string?)r.Variables["product"].Value);
            Assert.Equal("a@b.c", (string?)r.Variables["user"].Value);
            Assert.Equal("apim.example.net", (string?)r.Variables["original"].Value);
            Assert.Equal("backend.example.net", (string?)r.Variables["backend"].Value);
        }
    }
}
