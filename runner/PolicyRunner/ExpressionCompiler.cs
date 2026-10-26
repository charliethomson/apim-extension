using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using Apim.Policies;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;

namespace PolicyRunner
{
    /// <summary>A compiled policy expression.</summary>
    public delegate object? ExpressionFn(IProxyRequestContext context);

    /// <summary>An expression to compile: its code (named values already in) and where it came from.</summary>
    public sealed class ExpressionSource
    {
        public ExpressionSource(string code, bool multi, string? file, int line, int col)
        {
            Code = code;
            Multi = multi;
            File = file;
            Line = line;
            Col = col;
        }

        public string Code { get; }
        public bool Multi { get; }
        public string? File { get; }
        public int Line { get; }
        public int Col { get; }
        internal string Key => (Multi ? "B:" : "E:") + Code;
    }

    /// <summary>
    /// Compiles policy expressions the way the gateway does: C# 7.3, with APIM's namespaces imported
    /// and <c>context</c> in scope. Each distinct expression is compiled once per process; a batch of new
    /// ones becomes one assembly, kept on disk under the cache folder by a hash of its source.
    /// </summary>
    public sealed class ExpressionCompiler
    {
        /// <summary>The namespaces the gateway imports: those of its documented type allowlist, and the context's.</summary>
        internal static readonly string[] Usings =
        {
            "System", "System.Collections.Generic", "System.IO", "System.Linq", "System.Net", "System.Security.Cryptography",
            "System.Security.Cryptography.X509Certificates", "System.Text", "System.Text.RegularExpressions", "System.Xml", "System.Xml.Linq",
            "Newtonsoft.Json", "Newtonsoft.Json.Linq", "Apim.Policies",
        };

        private static readonly Lazy<MetadataReference[]> References = new Lazy<MetadataReference[]>(LoadReferences);
        private readonly Dictionary<string, ExpressionFn> compiled = new Dictionary<string, ExpressionFn>(StringComparer.Ordinal);
        private readonly string? cacheDir;

        public ExpressionCompiler(string? cacheDir = null)
        {
            this.cacheDir = cacheDir;
        }

        /// <summary>
        /// Compiles what hasn't been yet. On errors nothing from the batch is kept, and every error comes
        /// back placed in its file.
        /// </summary>
        public List<DiagnosticOutput> Compile(IEnumerable<ExpressionSource> sources)
        {
            var fresh = new List<ExpressionSource>();
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var s in sources)
            {
                if (!compiled.ContainsKey(s.Key) && seen.Add(s.Key)) fresh.Add(s);
            }
            if (fresh.Count == 0) return new List<DiagnosticOutput>();

            var source = Generate(fresh);
            var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(source))).Substring(0, 32);
            var cached = cacheDir == null ? null : Path.Combine(cacheDir, $"expr-{hash}.dll");
            byte[]? image = null;
            if (cached != null && File.Exists(cached))
            {
                try
                {
                    image = File.ReadAllBytes(cached);
                }
                catch (IOException)
                {
                    image = null;
                }
            }

            if (image == null)
            {
                var tree = CSharpSyntaxTree.ParseText(source, new CSharpParseOptions(LanguageVersion.CSharp7_3));
                var compilation = CSharpCompilation.Create(
                    $"apim-expressions-{hash}",
                    new[] { tree },
                    References.Value,
                    new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary, optimizationLevel: OptimizationLevel.Release));
                using var ms = new MemoryStream();
                var emit = compilation.Emit(ms);
                if (!emit.Success)
                {
                    return emit.Diagnostics
                        .Where(d => d.Severity == DiagnosticSeverity.Error)
                        .Select(d => Place(d, fresh))
                        .OrderBy(d => d.File, StringComparer.Ordinal).ThenBy(d => d.Line).ThenBy(d => d.Col)
                        .ToList();
                }
                image = ms.ToArray();
                if (cached != null) TryWrite(cached, image);
            }

            var type = Assembly.Load(image).GetType("ApimExpressions.Generated")!;
            for (var i = 0; i < fresh.Count; i++)
            {
                var method = type.GetMethod($"E{i}")!;
                compiled[fresh[i].Key] = (ExpressionFn)Delegate.CreateDelegate(typeof(ExpressionFn), method);
            }
            return new List<DiagnosticOutput>();
        }

        /// <summary>The compiled expression; <see cref="Compile"/> must have taken it first.</summary>
        public ExpressionFn Get(ExpressionSource source) => compiled[source.Key];

        /// <summary>
        /// One method per expression. A <c>#line</c> before each expression's code makes Roslyn report
        /// errors by line and column within it, under a file name that says which expression it is.
        /// </summary>
        private static string Generate(List<ExpressionSource> sources)
        {
            var sb = new StringBuilder();
            foreach (var u in Usings) sb.Append("using ").Append(u).Append(";\n");
            sb.Append("namespace ApimExpressions\n{\npublic static class Generated\n{\n");
            for (var i = 0; i < sources.Count; i++)
            {
                var s = sources[i];
                sb.Append("#line default\n");
                sb.Append("public static object E").Append(i).Append("(IProxyRequestContext context)\n{\n");
                if (!s.Multi) sb.Append("return (object)(\n");
                sb.Append("#line 1 \"expr-").Append(i).Append("\"\n");
                sb.Append(s.Code).Append('\n');
                sb.Append("#line default\n");
                if (!s.Multi) sb.Append(");\n");
                sb.Append("}\n");
            }
            sb.Append("}\n}\n");
            return sb.ToString();
        }

        /// <summary>An error placed in the policy file: the expression's start plus where in it the error is.</summary>
        private static DiagnosticOutput Place(Diagnostic d, List<ExpressionSource> sources)
        {
            var span = d.Location.GetMappedLineSpan();
            var name = span.Path ?? "";
            var message = d.GetMessage(System.Globalization.CultureInfo.InvariantCulture);
            if (name.StartsWith("expr-", StringComparison.Ordinal) && int.TryParse(name.Substring(5), out var i) && i < sources.Count)
            {
                var s = sources[i];
                var line = span.StartLinePosition.Line;
                var col = span.StartLinePosition.Character;
                return new DiagnosticOutput
                {
                    Code = d.Id,
                    Message = message,
                    File = s.File,
                    Line = s.Line + line,
                    Col = line == 0 ? s.Col + col : col + 1,
                };
            }
            // Outside any expression's code: the wrapper around it, as when a block doesn't return.
            var owner = OwnerOf(span.StartLinePosition.Line, sources);
            return new DiagnosticOutput { Code = d.Id, Message = message, File = owner?.File, Line = owner?.Line ?? 0, Col = owner?.Col ?? 0 };
        }

        /// <summary>The expression whose wrapper is at a line of the generated source.</summary>
        private static ExpressionSource? OwnerOf(int generatedLine, List<ExpressionSource> sources)
        {
            var source = Generate(sources).Split('\n');
            ExpressionSource? owner = null;
            for (var line = 0; line <= generatedLine && line < source.Length; line++)
            {
                var text = source[line];
                if (text.StartsWith("public static object E", StringComparison.Ordinal) && int.TryParse(text.Substring(22, text.IndexOf('(') - 22), out var i)) owner = sources[i];
            }
            return owner;
        }

        private static void TryWrite(string path, byte[] image)
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                var temp = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
                File.WriteAllBytes(temp, image);
                File.Move(temp, path, overwrite: true);
            }
            catch (IOException)
            {
                // The cache only saves time.
            }
            catch (UnauthorizedAccessException)
            {
                // Likewise.
            }
        }

        /// <summary>The framework the runner runs on, Newtonsoft, and the runner itself (the context interfaces).</summary>
        private static MetadataReference[] LoadReferences()
        {
            var paths = ((string?)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") ?? "").Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries).ToList();
            paths.Add(typeof(Newtonsoft.Json.JsonConvert).Assembly.Location);
            paths.Add(typeof(IProxyRequestContext).Assembly.Location);
            return paths
                .Where(p => p.Length > 0 && File.Exists(p))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .Select(p => (MetadataReference)MetadataReference.CreateFromFile(p))
                .ToArray();
        }
    }
}
