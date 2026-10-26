using System.IO;
using Newtonsoft.Json.Linq;
using PolicyRunner;
using Xunit;

namespace PolicyRunner.Tests
{
    public class ProtocolTests
    {
        [Fact]
        public void AnswersEachLineInOrder()
        {
            var run = new JObject
            {
                ["scopes"] = new JArray(new JObject
                {
                    ["kind"] = "api",
                    ["label"] = "API echo",
                    ["file"] = "apis/echo/policy.xml",
                    ["root"] = JObject.FromObject(Trees.Parse(Trees.Policy("<set-variable name='x' value='@(context.Request.Headers.GetValueOrDefault(\"X-Id\", \"\"))' />")), Newtonsoft.Json.JsonSerializer.Create(Program.Json)),
                }, new JObject { ["kind"] = "global", ["label"] = "global" }),
                ["request"] = new JObject { ["url"] = "https://apim.example.net/echo", ["headers"] = new JObject { ["X-Id"] = new JArray("42") } },
                ["backend"] = new JObject { ["status"] = 204 },
            };
            var input = new StringReader($"{{\"id\":1,\"hello\":true}}\n\n{new JObject { ["id"] = 2, ["run"] = run }.ToString(Newtonsoft.Json.Formatting.None)}\nnot json\n{{\"id\":4}}\n");
            var output = new StringWriter();
            Program.Serve(EngineTests.Engine, input, output);
            var lines = output.ToString().TrimEnd('\n').Split('\n');
            Assert.Equal(4, lines.Length);
            Assert.Equal(1, (int)JObject.Parse(lines[0])["id"]!);
            Assert.NotNull(JObject.Parse(lines[0])["version"]);
            var result = JObject.Parse(lines[1])["result"]!;
            Assert.Equal("42", (string?)result["variables"]!["x"]!["value"]);
            Assert.Equal(204, (int)result["response"]!["status"]!);
            Assert.Equal("API echo", (string?)result["steps"]![0]!["scope"]);
            Assert.Null(result["failure"]);
            Assert.StartsWith("Can't read", (string?)JObject.Parse(lines[2])["error"], System.StringComparison.Ordinal);
            Assert.Equal(JTokenType.Null, JObject.Parse(lines[2])["id"]!.Type);
            Assert.Equal("A request needs run or hello.", (string?)JObject.Parse(lines[3])["error"]);
        }
    }
}
