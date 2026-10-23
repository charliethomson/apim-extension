import { describe, expect, it } from 'vitest';
import { CSharpEngine, type CodeKind } from '../src/service';
import { loadEngine, stubSource } from '../src/testing';

const engine = loadEngine();

/** Splits `a.|b` into the code and the cursor offset. */
function at(marked: string): [string, number] {
  const i = marked.indexOf('|');
  return [marked.slice(0, i) + marked.slice(i + 1), i];
}

const labels = (marked: string, kind: CodeKind = 'expr') => {
  const [code, offset] = at(marked);
  return engine.complete(code, kind, offset)?.entries.map((e) => e.label);
};

const errors = (code: string, kind: CodeKind = 'expr') => engine.diagnostics(code, kind).map((d) => d.message);

describe('types of valid policy expressions', () => {
  it.each<[string, string, CodeKind?]>([
    ['context.Request.Headers.GetValueOrDefault("Authorization", "").AsJwt()?.Subject', 'string'],
    ['context.Request.Headers.Where(h => h.Key.StartsWith("x-")).Select(h => h.Value.First()).ToList()', 'List<string>'],
    ['context.Request.Url.Query.Any(q => q.Value.Any(v => v.Length > 3))', 'bool'],
    ['context.Request.Headers.GetValueOrDefault("a", "").Split(\',\').Select(x => x.Trim()).OrderBy(x => x).FirstOrDefault() ?? "none"', 'string'],
    ['context.Request.Headers.ToDictionary(h => h.Key, h => h.Value.Length)', 'Dictionary<string, int>'],
    ['context.Deployment.Certificates.Values.FirstOrDefault()?.Thumbprint', 'string'],
    ['context.Product?.SubscriptionsLimit', 'int?'],
    ['context.Response?.StatusCode', 'int?'],
    ['context.Variables.GetValueOrDefault<int>("n") + 1L', 'long'],
    ['context.Variables.GetValueOrDefault("n", 2.5)', 'double'],
    ['int.TryParse(context.Request.Url.Query.GetValueOrDefault("n", "0"), out var n) ? n * 2 : 0', 'int'],
    ['(string)context.Variables["x"] == "a"', 'bool'],
    ['context.Variables["x"] as string', 'string'],
    ['DateTime.UtcNow - context.Timestamp', 'TimeSpan'],
    ['DateTime.UtcNow - context.Timestamp > TimeSpan.FromSeconds(5)', 'bool'],
    ['context.Timestamp.AddDays(1).ToString("o")', 'string'],
    ['new XElement("a", new XAttribute("b", 1)).Element("c")?.Value', 'string'],
    ['context.Request.Body.As<JObject>(preserveContent: true)["a"]', 'JToken'],
    ['(int)JObject.Parse("{}")["a"]', 'int'],
    ['context.Request.Body.As<string>().Split(new[] { "," }, StringSplitOptions.RemoveEmptyEntries)', 'string[]'],
    ['Convert.ToBase64String(Encoding.UTF8.GetBytes("x"))', 'string'],
    ['Regex.Match("abc", "b").Groups[1].Value', 'string'],
    ['string.Join(",", context.Request.Headers.Keys)', 'string'],
    ['$"{context.Request.Method} {context.Request.Url.Path:x}"', 'string'],
    ['"{{backend-url}}" + {{path}}', 'string'],
    ['new { a = 1, b = context.Request.Method }.b', 'string'],
    ['new List<Dictionary<string, int>>().First()["a"]', 'int'],
    ['new int[3][]', 'int[][]'],
    ['new[] { 1, 2 }.Sum()', 'int'],
    ['new List<string> { "a" }.Count', 'int'],
    // A property of the same name doesn't hide the LINQ extension method when it's invoked.
    ['new List<string> { "a" }.Count(s => s.Length > 0)', 'int'],
    ['JArray.Parse("[]").Count(t => (string)t["g"] == "f")', 'int'],
    ['new Dictionary<string, int> { ["a"] = 1 }.Keys', 'Dictionary<string, int>.KeyCollection'],
    ['(1, "a").Item2', 'string'],
    ['1 + 2.0f', 'float'],
    ['(byte)1 + (byte)2', 'int'],
    ['5m * 2', 'decimal'],
    ['1 << 3', 'int'],
    ['-1u', 'long'],
    ['!true || 1 >= 2 && 1 >> 1 == 0', 'bool'],
    ['context.Api.Protocols.Contains("https") ? "s" : null', 'string'],
    ['context.Backend.Type == BackendType.Pool | false', 'bool'],
    ['RegexOptions.IgnoreCase | RegexOptions.Multiline', 'RegexOptions'],
    ['context.Subscription.EndDate ?? DateTime.MaxValue', 'DateTime'],
    ['typeof(string).Name', 'string'],
    ['default(int)', 'int'],
    ['nameof(context)', 'string'],
    ['checked(1 + 1)', 'int'],
    ['context.LastError is null', 'bool'],
    ['System.Text.Encoding.UTF8.GetString(new byte[0])', 'string'],
    ['global::System.Math.Max(1, 2)', 'int'],
    ['Math.Round(1.5, MidpointRounding.AwayFromZero)', 'double'],
    ['context.User.Groups.Select(g => g.Name).Aggregate((a, b) => a + "," + b)', 'string'],
    ['context.Request.Headers.Select((h, i) => i).Max()', 'int'],
    ['JsonConvert.SerializeObject(new { a = 1 }, Formatting.Indented)', 'string'],
    ['var body = context.Request.Body.As<JObject>(); body["x"] = "y"; return body.ToString();', 'string', 'block'],
    ['foreach (var h in context.Request.Headers) { if (h.Key == "x") { return h.Value[0]; } } return null;', 'string', 'block'],
    ['if (!int.TryParse("1", out int n)) { return 0; } return n;', 'int', 'block'],
    ['for (var i = 0; i < 3; i++) { } var s = new StringBuilder(); s.Append(1).Append("x"); return s.ToString();', 'string', 'block'],
    ['switch (context.Request.Method) { case "GET": return 1; case string m when m.Length > 3: return m.Length; default: break; } return 0;', 'int', 'block'],
    ['try { return JObject.Parse("{}"); } catch (Exception e) when (e.Message != null) { return null; } finally { }', 'JObject', 'block'],
    ['var o = context.Variables["x"]; if (o is string s && s.Length > 0) { return s; } return "";', 'string', 'block'],
    ['int x = 0; do { x += 1; } while (x < 3); while (false) { } return x;', 'int', 'block'],
    ['var list = new List<int>(); list.Add(1); return list.Where(i => { var j = i * 2; return j > 1; }).Count();', 'int', 'block'],
    ['using (var r = new StringReader("x")) { return r.ReadToEnd(); }', 'string', 'block'],
    ['const int k = 2; string[] parts = { "a", "b" }; return parts.Length * k;', 'int', 'block'],
  ])('%s → %s', (code, type, kind = 'expr') => {
    expect(errors(code, kind)).toEqual([]);
    expect(engine.resultType(code, kind)).toBe(type);
  });
});

describe('diagnostics', () => {
  it.each<[string, string, CodeKind?]>([
    ['context.Nope', "'IProxyRequestContext' does not contain a definition for 'Nope'."],
    ['foo + 1', "The name 'foo' does not exist in the current context."],
    ['context.Request.Url.Host.Substring()', "No overload for method 'Substring' takes 0 arguments."],
    ['new Regex()', "No overload for method 'Regex' takes 0 arguments."],
    ['context.Request.Url.Port.Length', "'int' does not contain a definition for 'Length'."],
    ['"a".Length()', "'int' isn't invocable."],
    ['string.Length', "An object reference is required to access 'string.Length'."],
    ['"a".IsNullOrEmpty("b")', "Member 'string.IsNullOrEmpty' is static; qualify it with the type name instead."],
    ['context.Request = null', "Property 'Request' is read-only."],
    ['context = null', "'context' is read-only."],
    ['1 is int ? true : "a"', "Type of conditional expression cannot be determined because there is no implicit conversion between 'bool' and 'string'."],
    ['1 as int', "The as operator must be used with a reference type or nullable type ('int' is a non-nullable value type)."],
    ['1 ?? 2', "Operator '??' cannot be applied to a non-nullable value of type 'int'."],
    ['true + 1', "Operator '+' cannot be applied to operands of type 'bool' and 'int'."],
    ['new IRequest()', "Cannot create an instance of the interface 'IRequest'."],
    ['new int[]', 'Array creation must have an array size or an initializer.'],
    ['Foo.Bar', "The name 'Foo' does not exist in the current context."],
    ['System.Nope.X', "The type or namespace name 'Nope' does not exist in the namespace 'System'."],
    ['int x = 0; int.TryParse("1", x); return x;', "Argument 2 must be passed with the 'out' keyword.", 'block'],
    ['int.Parse(out var x)', "Argument 1 must not be passed with the 'out' keyword."],
    ['this.x', "Keyword 'this' isn't available in a policy expression."],
    ['new int[1][0, 0]', 'Wrong number of indices inside []; expected 1.'],
    ['true[0]', "Cannot apply indexing with [] to an expression of type 'bool'."],
    ['context.Request.Method(1)', "'string' isn't invocable."],
    ['new List<int> { Nope = 1 }', "'List<int>' does not contain a definition for 'Nope'."],
    ['var x = null; return x;', 'Cannot assign null to an implicitly-typed variable.', 'block'],
    ['var x; return 1;', 'Implicitly-typed variables must be initialized.', 'block'],
    ['var x = 1; var x = 2; return x;', "A local variable named 'x' is already defined in this scope.", 'block'],
    ['List<int> x = new List<int>(); x.Nope(); return x;', "'List<int>' does not contain a definition for 'Nope'.", 'block'],
    ['Nope x = null; return x;', "The type or namespace name 'Nope' could not be found.", 'block'],
    ['System x = null; return x;', "'System' is a namespace but is used like a type.", 'block'],
  ])('%s', (code, message, kind = 'expr') => {
    expect(errors(code, kind)).toContain(message);
  });

  it.each<[string, string, CodeKind?]>([
    ['context.Request.', 'Identifier expected.'],
    ['f(a', "')' expected."],
    ['f(a, ', 'Expression expected.'],
    ['"abc', 'Unterminated string literal.'],
    ['a +', 'Expression expected.'],
    ['1 /* x', 'Unterminated comment.'],
    ['1 2', "Unexpected '2'."],
    ['return 1', "';' expected.", 'block'],
    ['if (x) else', 'Statement expected.', 'block'],
    ['try { }', "'catch' or 'finally' expected.", 'block'],
    ['switch (1) { x; }', "'case' or 'default' expected.", 'block'],
  ])('syntax: %s', (code, message, kind = 'expr') => {
    expect(errors(code, kind)).toContain(message);
  });

  it('checks a set-variable value against the types a variable may hold', () => {
    const variable = (code: string, kind: CodeKind = 'expr') => engine.diagnostics(code, kind, 'variable').map((d) => d.message);
    expect(variable('(object)null')).toEqual(["A set-variable value can't be 'object'. Use a string, bool, number, char, Guid, DateTime, TimeSpan, byte[] or JSON (JToken) value."]);
    expect(variable('context.Variables["x"]')).toHaveLength(1);
    expect(variable('new List<string>()')).toHaveLength(1);
    for (const ok of ['"a"', '(int?)null', 'Guid.NewGuid()', 'new byte[0]', 'new JObject()', 'context.Variables.GetValueOrDefault<string>("x")', 'null', 'context.Request.Body.As<JArray>()']) {
      expect(variable(ok), ok).toEqual([]);
    }
    expect(variable('if (true) { return new JObject(); } return null;', 'block')).toEqual([]);
    expect(variable('return new object();', 'block')).toHaveLength(1);
    // Other errors come first; the type is only checked once the code binds cleanly.
    expect(variable('nope')).toEqual(["The name 'nope' does not exist in the current context."]);
  });

  it("doesn't report what it can't see: unknown receivers and dynamic values stay quiet", () => {
    expect(errors('context.Variables["x"].ToString()')).toEqual([]);
    expect(errors('context.Request.Body.As<JObject>()["a"]["b"].Value<string>()')).toEqual([]);
    expect(errors('context.GraphQL.Parent.Equals(null)')).toEqual([]);
  });
});

describe('completion', () => {
  it('lists members after a dot, including through ?. and partial names', () => {
    expect(labels('context.|')).toEqual(expect.arrayContaining(['Request', 'Variables', 'Trace', 'Elapsed']));
    expect(labels('context.User?.|')).toEqual(expect.arrayContaining(['Email', 'Groups']));
    expect(labels('context.Request.He|')).toContain('Headers');
    expect(labels('context.Request.He|aders.Count')).toContain('Headers');
  });

  it('gives lambda parameters their inferred types', () => {
    expect(labels('context.Request.Headers.Where(h => h.|)')).toEqual(expect.arrayContaining(['Key', 'Value']));
    expect(labels('context.User.Groups.Select(g => g.Name).Where(n => n.|)')).toContain('StartsWith');
    expect(labels('context.Request.Headers.First(h => h.Key == "a").Value.|')).toContain('Length');
  });

  it('offers applicable extension methods and hides inapplicable ones', () => {
    const items = labels('context.Request.Headers.|')!;
    expect(items).toEqual(expect.arrayContaining(['GetValueOrDefault', 'Where', 'Select', 'ContainsKey']));
    expect(items).not.toContain('Ancestors'); // constrained to XNode / JToken sequences
    expect(labels('"a".|')).toEqual(expect.arrayContaining(['AsJwt', 'Length', 'Split']));
    expect(labels('context.Request.Url.Port.|')).not.toContain('Where');
  });

  it('lists static members, nested types and enum values on a type', () => {
    expect(labels('DateTime.|')).toEqual(expect.arrayContaining(['UtcNow', 'Parse']));
    expect(labels('DateTime.|')).not.toContain('Year');
    expect(labels('BackendType.|')?.slice(0, 2)).toEqual(['Single', 'Pool']);
    expect(labels('TimeZoneInfo.|')).toContain('AdjustmentRule');
  });

  it('lists namespaces and their types', () => {
    expect(labels('System.Text.|')).toEqual(expect.arrayContaining(['RegularExpressions', 'Encoding', 'StringBuilder']));
    expect(labels('Newtonsoft.Json.Linq.|')).toContain('JObject');
  });

  it('offers locals, context, types and keywords for a bare name, in scope order', () => {
    const top = labels('|')!;
    expect(top).toEqual(expect.arrayContaining(['context', 'DateTime', 'JObject', 'System', 'new', 'string']));
    expect(top).not.toContain('return');
    const inBlock = labels('var early = 1; | var late = 2;', 'block')!;
    expect(inBlock).toEqual(expect.arrayContaining(['early', 'return', 'foreach']));
    expect(inBlock).not.toContain('late');
    expect(labels('context.Request.Headers.Select(h => |)')).toContain('h');
  });

  it('offers only types in type positions', () => {
    const items = labels('new |')!;
    expect(items).toEqual(expect.arrayContaining(['StringBuilder', 'JObject', 'int']));
    expect(items).not.toContain('context');
    expect(labels('context.Variables["x"] is Str|')).toContain('StringBuilder');
  });

  it('offers unassigned writable members in an object initializer', () => {
    expect(labels('new JsonSerializerSettings { Formatting = Formatting.None, | }')).toEqual(expect.arrayContaining(['NullValueHandling']));
    expect(labels('new JsonSerializerSettings { Formatting = Formatting.None, | }')).not.toContain('Formatting');
  });

  it('stays out of strings and comments', () => {
    expect(labels('"context.|"')).toBeUndefined();
    expect(labels('1 /* context.| */')).toBeUndefined();
    expect(labels('$"{context.|}"')).toContain('Request');
  });

  it('honours a usage filter', () => {
    const filtered = new CSharpEngine(engine.model, { type: (d) => d.name !== 'StringBuilder', member: (_, m) => m.name !== 'UtcNow' });
    const [code, offset] = at('DateTime.|');
    expect(filtered.complete(code, 'expr', offset)!.entries.map((e) => e.label)).not.toContain('UtcNow');
    expect(filtered.complete('', 'expr', 0)!.entries.map((e) => e.label)).not.toContain('StringBuilder');
  });
});

describe('hover', () => {
  const hover = (marked: string, kind: CodeKind = 'expr') => {
    const [code, offset] = at(marked);
    return engine.hover(code, kind, offset)?.signature;
  };

  it.each<[string, string, CodeKind?]>([
    ['context.Req|uest.Url', 'IRequest IProxyRequestContext.Request { get; }'],
    ['cont|ext', '(parameter) IProxyRequestContext context'],
    ['context.Request.Headers.GetValueOr|Default("x", "")', '(extension) string IReadOnlyDictionary<string, string[]>.GetValueOrDefault(string name, string defaultValue)'],
    ['context.Request.Headers.Sel|ect(h => h.Key)', '(extension) IEnumerable<string> IEnumerable<KeyValuePair<string, string[]>>.Select<KeyValuePair<string, string[]>, string>(Func<KeyValuePair<string, string[]>, string> selector)'],
    ['var j| = context.Request.Body.As<JObject>(); return j;', '(local variable) JObject j', 'block'],
    ['context.User.Groups.Select(g| => g.Name)', '(parameter) IGroup g'],
    ['Date|Time.UtcNow', 'struct System.DateTime'],
    ['str|ing.Empty', 'class System.String'],
    ['Sys|tem.Math.PI', 'namespace System'],
    ['Math.P|I', 'const double Math.PI'],
    ['BackendType.Po|ol', 'BackendType.Pool'],
    ['new Reg|ex("a")', 'Regex(string pattern)'],
    ['"a".Sub|string(1, 2)', 'string string.Substring(int startIndex, int length)'],
  ])('%s', (marked, signature, kind = 'expr') => {
    expect(hover(marked, kind)).toBe(signature);
  });

  it('carries the doc summary', () => {
    const [code, offset] = at('context.Requ|est');
    expect(engine.hover(code, 'expr', offset)?.documentation).toBe('The incoming request.');
  });
});

describe('signature help', () => {
  const sig = (marked: string) => {
    const [code, offset] = at(marked);
    const r = engine.signatureHelp(code, 'expr', offset);
    return r && { label: r.signatures[r.activeSignature].label, param: r.activeParameter, count: r.signatures.length };
  };

  it('picks the overload that fits and tracks the argument', () => {
    expect(sig('context.Request.Headers.GetValueOrDefault("a", |)')).toEqual({ label: '(extension) string IReadOnlyDictionary<string, string[]>.GetValueOrDefault(string name, string defaultValue)', param: 1, count: 2 });
    expect(sig('new Regex(|')).toMatchObject({ label: 'Regex(string pattern)', param: 0 });
    expect(sig('"a".Substring(1, |)')).toMatchObject({ param: 1, count: 2 });
  });

  it('answers for the innermost call and maps named and params arguments', () => {
    expect(sig('string.Join(",", "a".Substring(|))')?.label).toMatch(/^string string\.Substring/);
    expect(sig('context.Request.Body.As<JObject>(preserveContent: |)')).toMatchObject({ param: 0 });
    expect(sig('string.Format("{0}{1}", 1, 2, 3, |)')?.label).toMatch(/params object\[\] args/);
  });

  it('is quiet outside argument lists', () => {
    expect(sig('context.Request|')).toBeUndefined();
  });
});

describe('definition', () => {
  const def = (marked: string, kind: CodeKind = 'expr') => {
    const [code, offset] = at(marked);
    return engine.definition(code, kind, offset);
  };

  it('goes to locals and lambda parameters in the code', () => {
    expect(def('var abc = 1; return ab|c;', 'block')).toEqual({ kind: 'local', span: { start: 4, end: 7 } });
    expect(def('context.Api.Protocols.Where(p => p|.Length > 0)')).toEqual({ kind: 'local', span: { start: 28, end: 29 } });
  });

  it('goes into the stubs for context members and stub types', () => {
    const stubLines = stubSource().split('\n');
    const loc = def('context.Requ|est');
    expect(loc?.kind).toBe('stub');
    if (loc?.kind === 'stub') expect(stubLines[loc.location.line]).toContain('IRequest Request');
    const ext = def('"a".AsJ|wt()');
    if (ext?.kind === 'stub') expect(stubLines[ext.location.line]).toContain('Jwt AsJwt');
    else expect.fail('expected a stub location');
  });

  it('has nothing for BCL members or context itself', () => {
    expect(def('"a".Len|gth')).toBeUndefined();
    expect(def('cont|ext')).toBeUndefined();
  });
});
