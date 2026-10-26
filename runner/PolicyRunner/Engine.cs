using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.RegularExpressions;
using Apim.Policies;
using Newtonsoft.Json.Linq;

namespace PolicyRunner
{
    /// <summary>Runs requests through policies. One per process: it keeps the compiled expressions.</summary>
    public sealed class Engine
    {
        private readonly ExpressionCompiler compiler;

        public Engine(ExpressionCompiler compiler)
        {
            this.compiler = compiler;
        }

        public RunResult Run(RunInput input) => new Run(input, compiler).Execute();
    }

    /// <summary>Why a run can't go on: the result's <see cref="RunResult.Failure"/>.</summary>
    internal sealed class RunFailure : Exception
    {
        public RunFailure(FailureOutput output)
            : base(output.Message)
        {
            Output = output;
        }

        public FailureOutput Output { get; }
    }

    /// <summary>An error the gateway would raise while running a policy: it sends the run to on-error.</summary>
    internal sealed class PolicyError : Exception
    {
        public PolicyError(LastError error, ErrorOutput output)
            : base(error.Message)
        {
            Error = error;
            Output = output;
        }

        public LastError Error { get; }
        public ErrorOutput Output { get; }
    }

    /// <summary>return-response: the pipeline stops and the response goes back.</summary>
    internal sealed class ReturnSignal : Exception
    {
    }

    /// <summary>Where a policy runs: which scope's policy, which section, and what it acts on.</summary>
    internal sealed class Frame
    {
        public Frame(int scope, string section, string? file, string path, Response? building = null)
        {
            Scope = scope;
            Section = section;
            File = file;
            Path = path;
            Building = building;
        }

        public int Scope { get; }
        public string Section { get; }
        public string? File { get; }
        /// <summary>The policies it's nested in, for context.LastError.Path.</summary>
        public string Path { get; }
        /// <summary>Inside return-response: the response it's building, which set-status and the like change.</summary>
        public Response? Building { get; }

        public Frame With(string? file = null, string? path = null, Response? building = null) =>
            new Frame(Scope, Section, file ?? File, path ?? Path, building ?? Building);
    }

    internal sealed class Run
    {
        private static readonly Regex NamedValue = new Regex(@"\{\{\s*([^{}]+?)\s*\}\}", RegexOptions.Compiled);
        private static readonly string[] Sections = { "inbound", "backend", "outbound" };

        private readonly RunInput input;
        private readonly ExpressionCompiler compiler;
        private readonly RunResult result = new RunResult();
        private readonly Dictionary<Expr, ExpressionSource> sources = new Dictionary<Expr, ExpressionSource>(ReferenceEqualityComparer.Instance);
        private readonly Dictionary<string, string> namedValues;
        private Context ctx = null!;

        public Run(RunInput input, ExpressionCompiler compiler)
        {
            this.input = input;
            this.compiler = compiler;
            namedValues = new Dictionary<string, string>(input.NamedValues, StringComparer.OrdinalIgnoreCase);
        }

        public RunResult Execute()
        {
            NamedValues.Current.Value = namedValues;
            try
            {
                Prepare();
                ctx = new Context(input, message => result.Trace.Add(new TraceOutput { Source = "context.Trace", Message = message }));
                Pipeline();
                Finish();
            }
            catch (RunFailure f)
            {
                result.Failure = f.Output;
            }
            finally
            {
                NamedValues.Current.Value = null;
            }
            return result;
        }

        // ---- before the run ----------------------------------------------------------------------

        /// <summary>Compiles every expression in the policies and fragments, with named values substituted, as the gateway does on save.</summary>
        private void Prepare()
        {
            foreach (var scope in input.Scopes)
            {
                if (scope.Root != null) Collect(scope.Root, scope.File);
            }
            foreach (var fragment in input.Fragments.Values) Collect(fragment.Root, fragment.File);
            var errors = compiler.Compile(sources.Values);
            if (errors.Count > 0)
            {
                var first = errors[0];
                throw new RunFailure(new FailureOutput
                {
                    Kind = "compile",
                    Message = $"An expression doesn't compile: {first.Message}",
                    File = first.File,
                    Line = first.Line,
                    Col = first.Col,
                    Diagnostics = errors,
                });
            }
        }

        private void Collect(Node node, string? file)
        {
            foreach (var a in node.Attrs)
            {
                if (a.Expr != null) Add(a.Expr, file);
            }
            if (node.Expr != null) Add(node.Expr, file);
            foreach (var c in node.Children) Collect(c, file);
        }

        private void Add(Expr e, string? file)
        {
            if (!sources.ContainsKey(e)) sources[e] = new ExpressionSource(Substitute(e.Code, file, e.Line, e.Col), e.Multi, file, e.Line, e.Col);
        }

        /// <summary>A text with its <c>{{named values}}</c> replaced; one the test doesn't set fails the run.</summary>
        private string Substitute(string text, string? file, int line, int col) =>
            NamedValue.Replace(text, m =>
            {
                var name = m.Groups[1].Value;
                if (namedValues.TryGetValue(name, out var value)) return value;
                throw new RunFailure(new FailureOutput { Kind = "test", Message = $"Named value '{name}' isn't set: give it in the test's namedValues.", File = file, Line = line, Col = col });
            });

        // ---- the pipeline ------------------------------------------------------------------------

        private void Pipeline()
        {
            try
            {
                foreach (var section in Sections) RunSection(0, section);
            }
            catch (ReturnSignal)
            {
                // The response is set; nothing else runs.
            }
            catch (PolicyError e)
            {
                ctx.LastErrorValue = e.Error;
                result.Error = e.Output;
                try
                {
                    RunSection(0, "on-error");
                }
                catch (ReturnSignal)
                {
                    // As above.
                }
                catch (PolicyError)
                {
                    ctx.Response = null;
                }
                ctx.Response ??= DefaultError();
            }
        }

        /// <summary>
        /// A section of the scope at <paramref name="index"/>; its <c>&lt;base /&gt;</c> runs the next scope's. A scope with no
        /// policy is <c>&lt;base /&gt;</c> throughout, except the outermost, which is APIM's default policy.
        /// </summary>
        private void RunSection(int index, string section)
        {
            if (index >= input.Scopes.Count) return;
            var scope = input.Scopes[index];
            if (scope.Root == null)
            {
                if (index < input.Scopes.Count - 1)
                {
                    RunSection(index + 1, section);
                }
                else if (section == "backend")
                {
                    var frame = new Frame(index, section, scope.File, section);
                    Step("forward-request", frame, 0).Detail = "APIM's default policy: no policy at this scope";
                    Forward(null, frame);
                }
                return;
            }
            var element = scope.Root.Children.FirstOrDefault(n => n.Name == section);
            if (element != null) RunChildren(element.Children, new Frame(index, section, scope.File, section));
        }

        private void RunChildren(IEnumerable<Node> nodes, Frame frame)
        {
            foreach (var n in nodes)
            {
                if (n.Name != null) Exec(n, frame);
            }
        }

        private void Exec(Node el, Frame f)
        {
            var step = Step(el.Name!, f, el.Line);
            try
            {
                switch (el.Name)
                {
                    case "base":
                        RunSection(f.Scope + 1, f.Section);
                        break;
                    case "set-variable":
                        SetVariable(el, f, step);
                        break;
                    case "set-header":
                        SetHeader(el, f, Headers(el, f), step);
                        break;
                    case "set-query-parameter":
                        if (f.Section != "inbound" && f.Section != "backend") throw Unsupported(el, f, "set-query-parameter only changes the request");
                        SetHeader(el, f, ctx.Request.Url.QueryParams, step);
                        break;
                    case "set-body":
                        SetBody(el, f);
                        break;
                    case "set-method":
                        ctx.Request.Method = Content(el, f, trim: true) ?? ctx.Request.Method;
                        step.Detail = ctx.Request.Method;
                        break;
                    case "set-status":
                        SetStatus(el, f, step);
                        break;
                    case "rewrite-uri":
                        RewriteUri(el, f, step);
                        break;
                    case "set-backend-service":
                        SetBackendService(el, f, step);
                        break;
                    case "choose":
                        Choose(el, f, step);
                        break;
                    case "return-response":
                        ReturnResponse(el, f);
                        break;
                    case "include-fragment":
                        IncludeFragment(el, f, step);
                        break;
                    case "retry":
                        Retry(el, f, step);
                        break;
                    case "trace":
                        Trace(el, f);
                        break;
                    case "forward-request":
                        Forward(el, f);
                        break;
                    default:
                        throw Unsupported(el, f, $"The runner doesn't support <{el.Name}> yet");
                }
            }
            catch (Exception e) when (!(e is RunFailure || e is PolicyError || e is ReturnSignal))
            {
                throw Error(el, f, "PolicyError", e.Message);
            }
        }

        // ---- policies ----------------------------------------------------------------------------

        private void SetVariable(Node el, Frame f, StepOutput step)
        {
            var name = Literal(el, "name", f) ?? throw Error(el, f, "PolicyError", "set-variable has no name");
            var value = Value(el, "value", f);
            ctx.VariableMap[name] = value;
            step.Detail = $"{name} = {Describe(value)}";
        }

        /// <summary>The headers set-header changes: the request's before the backend answers, the response's after.</summary>
        private Multimap Headers(Node el, Frame f)
        {
            if (f.Building != null) return f.Building.HeaderMap;
            if (f.Section == "inbound" || f.Section == "backend") return ctx.Request.HeaderMap;
            return (ctx.Response ?? throw Error(el, f, "PolicyError", "There's no response to change yet")).HeaderMap;
        }

        /// <summary>set-header and set-query-parameter: the same attributes over a different map.</summary>
        private void SetHeader(Node el, Frame f, Multimap target, StepOutput step)
        {
            var name = Literal(el, "name", f) ?? throw Error(el, f, "PolicyError", $"{el.Name} has no name");
            var action = (Literal(el, "exists-action", f) ?? "override").ToLowerInvariant();
            var values = el.Children.Where(c => c.Name == "value").Select(v => Content(v, f, trim: true) ?? "").ToArray();
            switch (action)
            {
                case "override":
                    target.Set(name, values);
                    break;
                case "skip":
                    if (!target.ContainsKey(name)) target.Set(name, values);
                    break;
                case "append":
                    target.Append(name, values);
                    break;
                case "delete":
                    target.Remove(name);
                    break;
                default:
                    throw Error(el, f, "PolicyError", $"Unknown exists-action '{action}'");
            }
            step.Detail = action == "delete" ? $"{name} deleted" : $"{name}: {string.Join(", ", target.TryGetValue(name, out var v) ? v : values)} ({action})";
        }

        private void SetBody(Node el, Frame f)
        {
            if (Literal(el, "template", f) != null) throw Unsupported(el, f, "Liquid templates in set-body aren't supported yet");
            var body = new MessageBody(Content(el, f, trim: false, json: true));
            if (f.Building != null) f.Building.Body = body;
            else if (f.Section == "inbound" || f.Section == "backend") ctx.Request.Body = body;
            else (ctx.Response ?? throw Error(el, f, "PolicyError", "There's no response to change yet")).Body = body;
        }

        private void SetStatus(Node el, Frame f, StepOutput step)
        {
            var codeText = Text(el, "code", f) ?? throw Error(el, f, "PolicyError", "set-status has no code");
            if (!int.TryParse(codeText, NumberStyles.Integer, CultureInfo.InvariantCulture, out var code)) throw Error(el, f, "PolicyError", $"'{codeText}' isn't a status code");
            var reason = Text(el, "reason", f);
            var target = f.Building ?? (ctx.Response ??= new Response());
            target.StatusCode = code;
            target.StatusReason = reason ?? Response.ReasonFor(code);
            step.Detail = $"{code} {target.StatusReason}".Trim();
        }

        /// <summary>
        /// The template replaces the path under the API's service URL. <c>{name}</c> takes the matched URL parameter or
        /// query parameter of that name, and query parameters the template doesn't use are kept unless
        /// copy-unmatched-params is false.
        /// </summary>
        private void RewriteUri(Node el, Frame f, StepOutput step)
        {
            var template = Text(el, "template", f) ?? throw Error(el, f, "PolicyError", "rewrite-uri has no template");
            var copy = !string.Equals(Text(el, "copy-unmatched-params", f), "false", StringComparison.OrdinalIgnoreCase);
            var original = ctx.Request.Url.QueryParams;
            var used = new HashSet<string>(StringComparer.Ordinal);
            var filled = Regex.Replace(template, @"\{([^{}]+)\}", m =>
            {
                var name = m.Groups[1].Value;
                if (ctx.Request.MatchedParameters.TryGetValue(name, out var v)) return Uri.EscapeDataString(v);
                if (original.TryGetValue(name, out var q))
                {
                    used.Add(name);
                    return Uri.EscapeDataString(string.Join(",", q));
                }
                return "";
            });
            var q2 = filled.IndexOf('?');
            var path = q2 < 0 ? filled : filled.Substring(0, q2);
            var query = Url.ParseQuery(q2 < 0 ? "" : filled.Substring(q2 + 1));
            if (copy)
            {
                foreach (var kv in original)
                {
                    if (!used.Contains(kv.Key) && !query.ContainsKey(kv.Key)) query.Set(kv.Key, kv.Value);
                }
            }
            var basePath = ((Url)ctx.Api.ServiceUrl).Path.TrimEnd('/');
            ctx.Request.Url.Path = basePath + "/" + Uri.UnescapeDataString(path).TrimStart('/');
            ctx.Request.Url.SetQuery(query);
            step.Detail = ctx.Request.Url.ToString();
        }

        /// <summary>base-url swaps the service URL the request goes to; a backend-id is recorded, since the test has no backends.</summary>
        private void SetBackendService(Node el, Frame f, StepOutput step)
        {
            var baseUrl = Text(el, "base-url", f);
            if (baseUrl == null)
            {
                step.Detail = $"backend-id {Text(el, "backend-id", f)}: recorded, the request URL is unchanged";
                return;
            }
            var service = ((Url)ctx.Api.ServiceUrl).Path.TrimEnd('/');
            var current = ctx.Request.Url;
            var suffix = current.Path.StartsWith(service, StringComparison.Ordinal) ? current.Path.Substring(service.Length) : current.Path;
            var next = new Url(baseUrl);
            next.Path = next.Path.TrimEnd('/') + (suffix.StartsWith("/", StringComparison.Ordinal) || suffix.Length == 0 ? suffix : "/" + suffix);
            next.SetQuery(current.QueryParams);
            ctx.Request.Url = next;
            step.Detail = next.ToString();
        }

        private void Choose(Node el, Frame f, StepOutput step)
        {
            var i = 0;
            foreach (var branch in el.Children.Where(c => c.Name == "when" || c.Name == "otherwise"))
            {
                i++;
                if (branch.Name == "otherwise" || Condition(branch, f))
                {
                    step.Detail = branch.Name == "otherwise" ? "otherwise" : $"when #{i}";
                    RunChildren(branch.Children, f.With(path: $"{f.Path}/choose/{branch.Name}"));
                    return;
                }
            }
            step.Detail = "no branch";
        }

        private void ReturnResponse(Node el, Frame f)
        {
            var name = Literal(el, "response-variable-name", f);
            Response response;
            if (name != null)
            {
                response = ctx.VariableMap.TryGetValue(name, out var v) && v is Response r ? r : throw Error(el, f, "PolicyError", $"Variable '{name}' doesn't hold a response");
            }
            else
            {
                response = new Response();
            }
            RunChildren(el.Children, f.With(path: $"{f.Path}/return-response", building: response));
            ctx.Response = response;
            throw new ReturnSignal();
        }

        private void IncludeFragment(Node el, Frame f, StepOutput step)
        {
            var id = Literal(el, "fragment-id", f) ?? throw Error(el, f, "PolicyError", "include-fragment has no fragment-id");
            if (!input.Fragments.TryGetValue(id, out var fragment))
            {
                throw new RunFailure(new FailureOutput { Kind = "test", Message = $"Fragment '{id}' isn't in the extract.", File = f.File, Line = el.Line, Col = el.Col });
            }
            step.Detail = id;
            RunChildren(fragment.Root.Children, f.With(file: fragment.File, path: $"{f.Path}/include-fragment"));
        }

        /// <summary>Runs its policies, then again while the condition holds and retries are left. Intervals aren't waited.</summary>
        private void Retry(Node el, Frame f, StepOutput step)
        {
            var countText = Text(el, "count", f) ?? throw Error(el, f, "PolicyError", "retry has no count");
            var count = int.Parse(countText, CultureInfo.InvariantCulture);
            var runs = 0;
            var frame = f.With(path: $"{f.Path}/retry");
            while (true)
            {
                RunChildren(el.Children, frame);
                runs++;
                if (runs > count || !Condition(el, f)) break;
            }
            step.Detail = runs == 1 ? "ran once" : $"ran {runs} times";
        }

        private void Trace(Node el, Frame f)
        {
            var message = el.Children.FirstOrDefault(c => c.Name == "message");
            result.Trace.Add(new TraceOutput
            {
                Source = Text(el, "source", f) ?? "",
                Severity = Literal(el, "severity", f) ?? "verbose",
                Message = message == null ? "" : Content(message, f, trim: true) ?? "",
                Metadata = el.Children.Where(c => c.Name == "metadata").ToDictionary(m => Text(m, "name", f) ?? "", m => Text(m, "value", f) ?? ""),
            });
        }

        /// <summary>The backend call: recorded, and answered with the test's backend response.</summary>
        private void Forward(Node? el, Frame f)
        {
            var backend = input.Backend ?? throw new RunFailure(new FailureOutput
            {
                Kind = "test",
                Message = "The request is forwarded to the backend, but the test gives no backend response.",
                File = f.File,
                Line = el?.Line ?? 0,
                Col = el?.Col ?? 0,
            });
            result.Calls.Add(new CallOutput
            {
                Kind = "backend",
                Method = ctx.Request.Method,
                Url = ctx.Request.Url.ToString(),
                Headers = ctx.Request.HeaderMap.ToDictionary(),
                Body = ctx.Request.Body.Content,
            });
            ctx.Response = new Response(backend.Status, backend.Reason, backend.Headers, backend.Body);
        }

        // ---- values ------------------------------------------------------------------------------

        /// <summary>A condition attribute, which must come out a bool.</summary>
        private bool Condition(Node el, Frame f)
        {
            var value = Value(el, "condition", f);
            if (value is bool b) return b;
            if (value is string s && bool.TryParse(s, out var parsed)) return parsed;
            throw Error(el, f, "PolicyError", $"The condition isn't a bool: {Describe(value)}");
        }

        /// <summary>An attribute's value: what its expression returns, or its text with named values in.</summary>
        private object? Value(Node el, string name, Frame f)
        {
            var a = el.Attrs.FirstOrDefault(x => x.Name == name);
            if (a == null) return null;
            if (a.Expr != null) return Eval(a.Expr, el, f);
            return Substitute(a.Value, f.File, el.Line, el.Col);
        }

        private string? Text(Node el, string name, Frame f) => AsText(Value(el, name, f), json: false);

        /// <summary>An attribute that can't hold an expression, such as a name.</summary>
        private string? Literal(Node el, string name, Frame f)
        {
            var a = el.Attrs.FirstOrDefault(x => x.Name == name);
            return a == null ? null : a.Expr != null ? AsText(Eval(a.Expr, el, f), json: false) : Substitute(a.Value, f.File, el.Line, el.Col);
        }

        /// <summary>An element's content: what its expression returns, or its text with named values in.</summary>
        private string? Content(Node el, Frame f, bool trim, bool json = false)
        {
            var expr = el.Children.FirstOrDefault(c => c.Name == null && c.Expr != null);
            if (expr != null) return AsText(Eval(expr.Expr!, el, f), json);
            var text = string.Concat(el.Children.Where(c => c.Name == null).Select(c => c.Text ?? ""));
            text = Substitute(text, f.File, el.Line, el.Col);
            return trim ? text.Trim() : text;
        }

        private object? Eval(Expr e, Node el, Frame f)
        {
            var fn = compiler.Get(sources[e]);
            try
            {
                return fn(ctx);
            }
            catch (RunFailure)
            {
                throw;
            }
            catch (Exception ex)
            {
                var inner = ex is System.Reflection.TargetInvocationException t && t.InnerException != null ? t.InnerException : ex;
                throw Error(el, f, "ExpressionValueEvaluationFailure", $"Expression evaluation failed. {inner.Message}");
            }
        }

        private static string? AsText(object? value, bool json)
        {
            switch (value)
            {
                case null:
                    return null;
                case string s:
                    return s;
                case JToken t:
                    return json ? t.ToString() : t.ToString(Newtonsoft.Json.Formatting.None);
                case IFormattable fmt:
                    return fmt.ToString(null, CultureInfo.InvariantCulture);
                default:
                    return value.ToString();
            }
        }

        private static string Describe(object? value)
        {
            var text = value == null ? "null" : AsText(value, json: false) ?? "null";
            if (text.Length > 120) text = text.Substring(0, 117) + "...";
            return value is string ? $"\"{text}\"" : value == null ? text : $"{text} ({value.GetType().Name})";
        }

        // ---- results -----------------------------------------------------------------------------

        private StepOutput Step(string policy, Frame f, int line)
        {
            var step = new StepOutput { Policy = policy, Scope = input.Scopes[f.Scope].Label, Section = f.Section, File = f.File, Line = line };
            result.Steps.Add(step);
            return step;
        }

        private PolicyError Error(Node el, Frame f, string reason, string message)
        {
            var scope = input.Scopes[f.Scope];
            var error = new LastError
            {
                Source = el.Name ?? "",
                Reason = reason,
                Message = message,
                Scope = scope.Kind,
                Section = f.Section,
                Path = $"{f.Path}/{el.Name}",
                PolicyId = "",
            };
            var output = new ErrorOutput
            {
                Source = error.Source,
                Reason = reason,
                Message = message,
                Scope = error.Scope,
                Section = f.Section,
                Path = error.Path,
                File = f.File,
                Line = el.Line,
            };
            return new PolicyError(error, output);
        }

        private static RunFailure Unsupported(Node el, Frame f, string message) =>
            new RunFailure(new FailureOutput { Kind = "unsupported", Message = message + ".", File = f.File, Line = el.Line, Col = el.Col });

        /// <summary>What the gateway answers when an error isn't handled: a 500 with its JSON body.</summary>
        private Response DefaultError() =>
            new Response(
                500,
                "Internal Server Error",
                new[] { new KeyValuePair<string, string[]>("Content-Type", new[] { "application/json; charset=utf-8" }) },
                new JObject { ["statusCode"] = 500, ["message"] = "Internal server error", ["activityId"] = ctx.RequestId.ToString() }.ToString());

        private void Finish()
        {
            if (ctx.Response != null)
            {
                result.Response = new ResponseOutput
                {
                    Status = ctx.Response.StatusCode,
                    Reason = ctx.Response.StatusReason,
                    Headers = ctx.Response.HeaderMap.ToDictionary(),
                    Body = ctx.Response.Body.Content,
                };
            }
            foreach (var kv in ctx.VariableMap) result.Variables[kv.Key] = new VariableOutput { Type = TypeName(kv.Value), Value = ToJson(kv.Value) };
        }

        private static string TypeName(object? value) => value == null ? "null" : value is Response ? "IResponse" : value.GetType().Name;

        private static JToken? ToJson(object? value)
        {
            switch (value)
            {
                case null:
                    return JValue.CreateNull();
                case JToken t:
                    return t.DeepClone();
                case string s:
                    return new JValue(s);
                case bool _:
                case int _:
                case long _:
                case double _:
                case float _:
                case decimal _:
                case short _:
                case byte _:
                case char _:
                case DateTime _:
                case Guid _:
                case TimeSpan _:
                case Uri _:
                    return new JValue(value);
                case Response r:
                    return new JObject { ["status"] = r.StatusCode, ["reason"] = r.StatusReason, ["body"] = r.Body.Content };
                case IEnumerable<string> list:
                    return new JArray(list);
                default:
                    return new JValue(value.ToString());
            }
        }
    }
}
