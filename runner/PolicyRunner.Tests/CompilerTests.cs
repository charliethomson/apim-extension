using System;
using System.IO;
using System.Linq;
using PolicyRunner;
using Xunit;

namespace PolicyRunner.Tests
{
    public class CompilerTests
    {
        [Fact]
        public void HoldsTheGatewayToCSharp73()
        {
            var errors = new ExpressionCompiler().Compile(new[] { new ExpressionSource("context.Request.Method is not null", false, "a.xml", 4, 10) });
            var e = Assert.Single(errors);
            Assert.Equal("a.xml", e.File);
            Assert.Equal(4, e.Line);
            Assert.Contains("7.3", e.Message, StringComparison.Ordinal);
        }

        [Fact]
        public void PlacesErrorsOnLaterLinesOfABlock()
        {
            var errors = new ExpressionCompiler().Compile(new[] { new ExpressionSource("\n    var x = 1;\n    return y;", true, "b.xml", 10, 30) });
            var e = Assert.Single(errors);
            Assert.Equal(12, e.Line);
            Assert.Equal(12, e.Col);
        }

        [Fact]
        public void BlamesTheExpressionForABlockThatDoesntReturn()
        {
            var errors = new ExpressionCompiler().Compile(new[] { new ExpressionSource("return 1;", true, "ok.xml", 1, 1), new ExpressionSource("var x = 1;", true, "c.xml", 7, 3) });
            var e = Assert.Single(errors);
            Assert.Equal("CS0161", e.Code);
            Assert.Equal("c.xml", e.File);
            Assert.Equal(7, e.Line);
        }

        [Fact]
        public void CompilesEachExpressionOnceAndKeepsBatchesOnDisk()
        {
            var dir = Path.Combine(Path.GetTempPath(), "apim-runner-test-" + Guid.NewGuid().ToString("N"));
            try
            {
                var a = new ExpressionSource("1 + 1", false, null, 1, 1);
                var compiler = new ExpressionCompiler(dir);
                Assert.Empty(compiler.Compile(new[] { a, a }));
                Assert.Single(Directory.GetFiles(dir));
                Assert.Empty(compiler.Compile(new[] { a }));
                Assert.Single(Directory.GetFiles(dir));
                // A new process finds the same batch on disk.
                var again = new ExpressionCompiler(dir);
                Assert.Empty(again.Compile(new[] { a }));
                Assert.Equal(2, again.Get(a)(null!));
                Assert.Single(Directory.GetFiles(dir));
            }
            finally
            {
                if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true);
            }
        }

        [Fact]
        public void ImportsTheGatewaysNamespaces()
        {
            var sources = new[]
            {
                new ExpressionSource("new JObject { [\"a\"] = Regex.IsMatch(\"x\", \"x\") }", false, null, 1, 1),
                new ExpressionSource("XElement.Parse(\"<a/>\").Name.LocalName", false, null, 1, 1),
                new ExpressionSource("Encoding.UTF8.GetBytes(\"x\").Length + new List<int>().Count()", false, null, 1, 1),
            };
            var compiler = new ExpressionCompiler();
            Assert.Empty(compiler.Compile(sources));
            Assert.Equal("a", compiler.Get(sources[1])(null!));
            Assert.Equal(new[] { "System", "Newtonsoft.Json.Linq", "Apim.Policies" }.Length, ExpressionCompiler.Usings.Count(u => u == "System" || u == "Newtonsoft.Json.Linq" || u == "Apim.Policies"));
        }
    }
}
