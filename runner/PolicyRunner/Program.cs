using System;
using System.IO;
using System.Reflection;
using System.Text;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using Newtonsoft.Json.Serialization;

namespace PolicyRunner
{
    /// <summary>
    /// The runner process. It reads one JSON request per line on stdin and writes one JSON reply per line on
    /// stdout, in order:
    /// <c>{"id":1,"run":{…}}</c> → <c>{"id":1,"result":{…}}</c>, <c>{"id":2,"hello":true}</c> → <c>{"id":2,"version":"…"}</c>.
    /// A request it can't read gets <c>{"id":…,"error":"…"}</c>. <c>--cache &lt;dir&gt;</c> keeps compiled expressions there.
    /// </summary>
    public static class Program
    {
        internal static readonly JsonSerializerSettings Json = new JsonSerializerSettings
        {
            ContractResolver = new CamelCasePropertyNamesContractResolver { NamingStrategy = new CamelCaseNamingStrategy { ProcessDictionaryKeys = false } },
            NullValueHandling = NullValueHandling.Ignore,
            DateParseHandling = DateParseHandling.None,
        };

        public static int Main(string[] args)
        {
            string? cache = null;
            for (var i = 0; i < args.Length; i++)
            {
                if (args[i] == "--cache" && i + 1 < args.Length) cache = args[++i];
                else if (args[i] == "--version")
                {
                    Console.WriteLine(Version);
                    return 0;
                }
                else
                {
                    Console.Error.WriteLine($"Unknown argument: {args[i]}. Usage: apim-policy-runner [--cache <dir>]");
                    return 2;
                }
            }
            var engine = new Engine(new ExpressionCompiler(cache));
            using var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
            using var stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true, NewLine = "\n" };
            Serve(engine, stdin, stdout);
            return 0;
        }

        public static string Version => typeof(Program).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion ?? "0.0.0";

        /// <summary>Answers each line of <paramref name="input"/> until it ends.</summary>
        public static void Serve(Engine engine, TextReader input, TextWriter output)
        {
            string? line;
            while ((line = input.ReadLine()) != null)
            {
                if (line.Trim().Length == 0) continue;
                output.WriteLine(Answer(engine, line));
            }
        }

        public static string Answer(Engine engine, string line)
        {
            JToken? id = null;
            try
            {
                var request = JObject.Parse(line);
                id = request["id"];
                if (request["run"] is JObject run)
                {
                    var input = run.ToObject<RunInput>(JsonSerializer.Create(Json)) ?? throw new JsonException("run is empty");
                    return Reply(id, "result", JObject.FromObject(engine.Run(input), JsonSerializer.Create(Json)));
                }
                if (request["hello"] != null) return Reply(id, "version", Version);
                return Reply(id, "error", "A request needs run or hello.");
            }
            catch (JsonException e)
            {
                return Reply(id, "error", $"Can't read the request: {e.Message}");
            }
            catch (Exception e)
            {
                return Reply(id, "result", JObject.FromObject(new RunResult { Failure = new FailureOutput { Kind = "runner", Message = $"The runner failed: {e}" } }, JsonSerializer.Create(Json)));
            }
        }

        private static string Reply(JToken? id, string key, JToken value) => new JObject { ["id"] = id?.DeepClone() ?? JValue.CreateNull(), [key] = value }.ToString(Formatting.None);
    }
}
