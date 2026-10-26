using System.Collections.Generic;
using System.Linq;
using System.Xml;
using System.Xml.Linq;
using PolicyRunner;

namespace PolicyRunner.Tests
{
    /// <summary>
    /// Builds the trees the TypeScript side sends from well-formed XML, which is enough for tests: a value
    /// or text that is all <c>@(…)</c> or <c>@{…}</c> is an expression.
    /// </summary>
    internal static class Trees
    {
        public static Node Parse(string xml)
        {
            var doc = XDocument.Parse(xml, LoadOptions.SetLineInfo | LoadOptions.PreserveWhitespace);
            return Element(doc.Root!);
        }

        /// <summary>A run of <paramref name="scopes"/>, innermost first, each a (kind, xml-or-null) pair.</summary>
        public static RunInput Run(params (string Kind, string? Xml)[] scopes) => new RunInput
        {
            Scopes = scopes.Select(s => new ScopePolicy { Kind = s.Kind, Label = s.Kind, File = $"{s.Kind}.xml", Root = s.Xml == null ? null : Parse(s.Xml) }).ToList(),
            Backend = new ResponseInput { Status = 200, Body = "backend body" },
        };

        /// <summary>A policy with <paramref name="inbound"/> after <c>&lt;base /&gt;</c> and <c>&lt;base /&gt;</c> everywhere else.</summary>
        public static string Policy(string inbound = "", string outbound = "", string onError = "", string backend = "<base />") =>
            $"<policies><inbound><base />{inbound}</inbound><backend>{backend}</backend><outbound><base />{outbound}</outbound><on-error><base />{onError}</on-error></policies>";

        public static void AddFragment(this RunInput run, string id, string xml) =>
            run.Fragments[id] = new FragmentInput { File = $"fragments/{id}.xml", Root = Parse(xml) };

        private static Node Element(XElement e)
        {
            var info = (IXmlLineInfo)e;
            var node = new Node { Name = e.Name.LocalName, Line = info.LineNumber, Col = info.LinePosition };
            foreach (var a in e.Attributes())
            {
                var ai = (IXmlLineInfo)a;
                node.Attrs.Add(new Attr { Name = a.Name.LocalName, Value = a.Value, Expr = Expression(a.Value, ai.LineNumber, ai.LinePosition + a.Name.LocalName.Length + 2) });
            }
            foreach (var n in e.Nodes())
            {
                if (n is XElement child) node.Children.Add(Element(child));
                else if (n is XText text)
                {
                    var ti = (IXmlLineInfo)text;
                    node.Children.Add(new Node { Text = text.Value, Expr = Expression(text.Value.Trim(), ti.LineNumber, ti.LinePosition), Line = ti.LineNumber, Col = ti.LinePosition });
                }
            }
            return node;
        }

        private static Expr? Expression(string value, int line, int col)
        {
            if (value.Length < 3 || value[0] != '@') return null;
            if (value[1] == '(' && value[^1] == ')') return new Expr { Code = value.Substring(2, value.Length - 3), Multi = false, Line = line, Col = col + 2 };
            if (value[1] == '{' && value[^1] == '}') return new Expr { Code = value.Substring(2, value.Length - 3), Multi = true, Line = line, Col = col + 2 };
            return null;
        }

        public static string[] Policies(this RunResult r) => r.Steps.Select(s => s.Policy).ToArray();

        public static Dictionary<string, string[]> Headers(params (string, string)[] pairs) => pairs.ToDictionary(p => p.Item1, p => new[] { p.Item2 });
    }
}
