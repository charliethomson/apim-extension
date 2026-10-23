import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RawModel } from '../../src/csharp/lang/model';
import { CSharpEngine, type CodeKind } from '../../src/csharp/lang/service';

// What the gateway accepts and rejects, beyond what the plain engine tests cover: C# 7.3 features
// the engine has to understand, newer syntax it has to refuse, conversions, missing returns, and
// the .NET Framework 4.8 surface.

const root = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const engine = CSharpEngine.load(JSON.parse(read('data/csharp-model.json')) as RawModel, read('stubs/ApimContext.cs'));

const errors = (code: string, kind: CodeKind = 'expr', expected?: 'bool') => engine.diagnostics(code, kind, expected).map((d) => d.message);
const compat = (code: string, kind: CodeKind = 'expr') => engine.compatibility(code, kind).map((d) => d.message);

function at(marked: string): [string, number] {
  const i = marked.indexOf('|');
  return [marked.slice(0, i) + marked.slice(i + 1), i];
}

const labels = (marked: string, kind: CodeKind = 'expr') => {
  const [code, offset] = at(marked);
  return engine.complete(code, kind, offset)?.entries.map((e) => e.label);
};

describe('C# 7.3 the engine understands', () => {
  it.each<[string, string, CodeKind?]>([
    // Local functions: expression and block bodies, recursion, calls before the declaration, generics.
    ['int Twice(int x) => x * 2; return Twice(21);', 'int', 'block'],
    ['return Fact(5); long Fact(int n) { if (n <= 1) { return 1; } return n * Fact(n - 1); }', 'long', 'block'],
    ['T First<T>(IEnumerable<T> xs) => xs.First(); return First(new[] { "a" });', 'string', 'block'],
    ['string Join(string sep, params string[] parts) => string.Join(sep, parts); return Join(",", "a", "b");', 'string', 'block'],
    ['int Add(int a, int b = 1) => a + b; return Add(1);', 'int', 'block'],
    // LINQ query syntax.
    ['from h in context.Request.Headers select h.Key', 'IEnumerable<string>'],
    ['from h in context.Request.Headers where h.Value.Length > 1 orderby h.Key descending select h.Value[0]', 'IEnumerable<string>'],
    ['from g in context.User.Groups let n = g.Name.Length select n', 'IEnumerable<int>'],
    ['from a in new[] { 1, 2 } from b in new[] { "x" } select b + a', 'IEnumerable<string>'],
    ['from g in context.User.Groups group g by g.Name.Length', 'IEnumerable<IGrouping<int, IGroup>>'],
    ['from g in context.User.Groups group g by g.Name into byName select byName.Key', 'IEnumerable<string>'],
    ['from a in new[] { 1 } join b in new[] { 2 } on a equals b select a + b', 'IEnumerable<int>'],
    ['from string s in new List<string>() select s.Length', 'IEnumerable<int>'],
    // checked and unchecked blocks.
    ['long t = 1; byte[] b = new byte[2]; unchecked { b[0] = (byte)(t >> 8); } return b;', 'byte[]', 'block'],
    // Named values are pasted in as text, so outside a string they can be numbers.
    ['DateTimeOffset.UtcNow.AddSeconds({{expiry-seconds}}).ToUnixTimeMilliseconds()', 'long'],
    // Members the reference documents loosely, as Microsoft's own examples use them.
    ['context.Request.MatchedParameters.GetValueOrDefault("id", "")', 'string'],
    ['context.GraphQL.Arguments["id"].ToString()', 'string'],
    ['$"https://example.com/{context.GraphQL.Parent["id"]}"', 'string'],
    ['((Authorization)context.Variables.GetValueOrDefault("auth-context"))?.AccessToken', 'string'],
    ['var o = new JObject(); o.Add("name", context.GraphQL.Arguments["name"]); return o.ToString();', 'string', 'block'],
  ])('%s → %s', (code, type, kind = 'expr') => {
    expect(errors(code, kind)).toEqual([]);
    expect(compat(code, kind)).toEqual([]);
    expect(engine.resultType(code, kind)).toBe(type);
  });
});

describe('newer C# than policy expressions accept', () => {
  it.each<[string, string, CodeKind?]>([
    ['context.Response.StatusCode switch { 200 => "ok", _ => "no" }', 'Switch expressions need C# 8.'],
    ['"abc"[^1]', 'Index-from-end expressions need C# 8.'],
    ['"abc".Substring(1..2)', 'Ranges need C# 8.'],
    ['context.Request.Body is not null', "'not' patterns need C# 9."],
    ['context.Request.Body is { } b && b != null', 'Property patterns need C# 8.'],
    ['context.Response.StatusCode is >= 200 and < 300', 'Relational patterns need C# 9.'],
    ['context.Response.StatusCode is 200 or 204', "'and' and 'or' patterns need C# 9."],
    ['string? s = null; return s;', 'Nullable reference types need C# 8.', 'block'],
    ['List<int> l = new(); return l;', "Target-typed 'new' expressions need C# 9.", 'block'],
    ['string s = null; s ??= "a"; return s;', "The '??=' operator needs C# 8.", 'block'],
    ['context.Request.Body!.As<string>()', 'The null-forgiving operator needs C# 8.'],
    ['@$"{context.RequestId}"', "Interpolated verbatim strings written '@$' need C# 8."],
    ['"""raw"""', 'Raw string literals need C# 11.'],
    ['using var r = new StringReader("a"); return r.ReadToEnd();', 'Using declarations need C# 8.', 'block'],
    ['static int F(int x) => x; return F(1);', 'Static local functions need C# 8.', 'block'],
    ['context.Variables.Select(static x => x.Key).First()', 'Static anonymous functions need C# 9.'],
    ['switch (context.Response.StatusCode) { case >= 500: return "error"; default: return "ok"; }', 'Relational patterns need C# 9.', 'block'],
  ])('%s', (code, message, kind = 'expr') => {
    const found = compat(code, kind);
    expect(found).toContain(`${message} Policy expressions are C# 7.3.`);
    // Reported once, without the parse errors the unfamiliar syntax would otherwise cause.
    expect(errors(code, kind).filter((m) => !m.includes('C# 7.3'))).toEqual([]);
  });

  it('keeps the variable a newer pattern declares, so the code after it still binds', () => {
    expect(errors('context.Request.Body is { } body && body.As<string>() != null').filter((m) => !m.includes('C# 7.3'))).toEqual([]);
  });

  it('accepts what C# 7.3 already has', () => {
    for (const code of ['$@"{context.RequestId}"', 'context.Request.Body is IMessageBody b', 'context.Request.Body is null', 'default(int)']) {
      expect(compat(code)).toEqual([]);
    }
  });
});

describe('conversions', () => {
  it.each<[string, string, CodeKind?]>([
    ['int x = "a"; return x;', "Cannot implicitly convert type 'string' to 'int'.", 'block'],
    ['int i = 5L; return i;', "Cannot implicitly convert type 'long' to 'int'. An explicit conversion exists (are you missing a cast?)", 'block'],
    ['int n = context.Variables["n"]; return n;', "Cannot implicitly convert type 'object' to 'int'. An explicit conversion exists (are you missing a cast?)", 'block'],
    ['int i = null; return i;', "Cannot convert null to 'int' because it's a non-nullable value type.", 'block'],
    ['JToken t = JToken.Parse("1"); string s = t; return s;', "Cannot implicitly convert type 'JToken' to 'string'. An explicit conversion exists (are you missing a cast?)", 'block'],
    ['if (context.Request.Method) { return 1; } return 2;', "Cannot implicitly convert type 'string' to 'bool'.", 'block'],
    ['context.Request.Method && true', "Cannot implicitly convert type 'string' to 'bool'."],
    ['!context.Request.Method', "Operator '!' cannot be applied to an operand of type 'string'."],
    ['Math.Abs("a")', "Argument 1: cannot convert from 'string' to 'decimal'."],
    ['DateTime.UtcNow.AddSeconds("60")', "Argument 1: cannot convert from 'string' to 'double'."],
    ['context.Request.Url.Host.Substring("1")', "Argument 1: cannot convert from 'string' to 'int'."],
    ['var l = new List<int>(); l.Add("a"); return l;', "Argument 1: cannot convert from 'string' to 'int'.", 'block'],
    ['int[] a = { 1, "b" }; return a;', "Cannot implicitly convert type 'string' to 'int'.", 'block'],
    ['var x = 1; x = "a"; return x;', "Cannot implicitly convert type 'string' to 'int'.", 'block'],
    ['int F() => "a"; return F();', "Cannot implicitly convert type 'string' to 'int'.", 'block'],
    ['int F() { return; } return F();', "A value convertible to 'int' is required.", 'block'],
    ['void F() { return 1; } F(); return 0;', 'This local function returns void, so return must not be followed by a value.', 'block'],
  ])('%s', (code, message, kind = 'expr') => {
    expect(errors(code, kind)).toContain(message);
  });

  it.each<[string, CodeKind?]>([
    // Constants narrow; null and 0 convert where they should.
    ['byte b = 1; short s = 2 + 3; uint u = 4; return b + s + u;', 'block'],
    ['string s = null; int? n = null; RegexOptions o = 0; return s;', 'block'],
    // Widening, boxing, variance, user-defined conversions, nullable lifting.
    ['long l = 1; double d = l; object o = d; return o;', 'block'],
    ['IEnumerable<object> xs = new List<string>(); return xs;', 'block'],
    ['JToken t = "text"; JValue v = new JValue(1); return t;', 'block'],
    ['int? n = 1; long? m = n; return m;', 'block'],
    ['TimeSpan t = DateTime.UtcNow - context.Timestamp; return t;', 'block'],
    // Lambdas, method groups and interpolated strings are target-typed; not checked here.
    ['Func<int, int> f = x => x + 1; Func<string, int> p = int.Parse; IFormattable s = $"{1}"; return f(1);', 'block'],
    // Casts are explicit, so they're not checked here.
    ['var b = context.Request.Body.As<JObject>(); int n = (int)b["a"]; return n;', 'block'],
    // `params` expanded and normal forms, optional parameters, named arguments.
    ['string.Format("{0}{1}", 1, "a")', 'expr'],
    ['string.Join(",", new[] { "a" })', 'expr'],
    ['context.Variables.GetValueOrDefault<string>(name: "x", defaultValue: "")', 'expr'],
  ])("doesn't report a valid conversion: %s", (code, kind = 'expr') => {
    expect(errors(code, kind)).toEqual([]);
  });

  it('checks an expression against the type its attribute needs', () => {
    expect(errors('context.Request.Method', 'expr', 'bool')).toContain("Cannot implicitly convert type 'string' to 'bool'.");
    expect(errors('context.Request.Method == "GET"', 'expr', 'bool')).toEqual([]);
    expect(errors('if (context.Request.Method == "GET") { return "yes"; } return false;', 'block', 'bool')).toContain("Cannot implicitly convert type 'string' to 'bool'.");
    expect(errors('return context.Variables.ContainsKey("x");', 'block', 'bool')).toEqual([]);
  });
});

describe('missing returns', () => {
  const missing = 'Not all code paths return a value. Every path through a policy expression block must end in a return.';

  it.each<string>([
    '',
    'var x = 1;',
    'if (context.Tracing) { return 1; }',
    'if (context.Tracing) { return 1; } else { var y = 2; }',
    'foreach (var h in context.Request.Headers) { return h.Key; }',
    'while (context.Tracing) { return 1; }',
    'switch (context.Request.Method) { case "GET": return 1; }',
    'try { return 1; } catch { }',
    'while (true) { if (context.Tracing) { break; } }',
  ])('reports: %s', (code) => {
    expect(errors(code, 'block')).toContain(missing);
  });

  it.each<string>([
    'return 1;',
    'if (context.Tracing) { return 1; } else { return 2; }',
    'if (context.Tracing) { return 1; } return 2;',
    'throw new Exception("x");',
    'while (true) { }',
    'for (;;) { if (context.Tracing) { return 1; } }',
    'do { return 1; } while (context.Tracing);',
    'switch (context.Request.Method) { case "GET": return 1; default: return 2; }',
    'switch (context.Request.Method) { case "GET": while (true) { break; } return 1; default: throw new Exception(); }',
    'try { return 1; } catch { return 2; }',
    'try { var x = 1; } finally { } return 2;',
    'using (var r = new StringReader("x")) { return r.ReadToEnd(); }',
    'if (true) { return 1; }',
  ])('accepts: %s', (code) => {
    expect(errors(code, 'block')).not.toContain(missing);
  });

  it('checks lambda and local function bodies that must return a value', () => {
    expect(errors('context.User.Groups.Select(g => { if (g.Id == "a") { return 1; } })')).toContain('Not all code paths return a value in this lambda.');
    expect(errors('int F(bool b) { if (b) { return 1; } } return F(true);', 'block')).toContain("Not all code paths in 'F' return a value.");
    expect(errors('context.User.Groups.ToList().ForEach(g => { if (g.Id == "a") { context.Trace(g.Id); } })')).toEqual([]);
  });
});

describe('the .NET Framework 4.8 surface', () => {
  it.each<[string, string]>([
    ['new[] { 1, 2, 3 }.Chunk(2)', "'Enumerable.Chunk' isn't in .NET Framework 4.8"],
    ['context.User.Groups.CountBy(g => g.Name)', "'Enumerable.CountBy' isn't in .NET Framework 4.8"],
    ['Convert.ToHexString(new byte[0])', "'Convert.ToHexString' isn't in .NET Framework 4.8"],
    ['DateTime.UnixEpoch', "'DateTime.UnixEpoch' isn't in .NET Framework 4.8"],
    ['"a,b".Split(",", StringSplitOptions.None)', "This overload of 'String.Split' isn't in .NET Framework 4.8"],
    ['"a".Replace("a", "b", StringComparison.Ordinal)', "This overload of 'String.Replace' isn't in .NET Framework 4.8"],
  ])('%s', (code, message) => {
    expect(compat(code).join('\n')).toContain(message);
  });

  it('binds overloads the way .NET Framework would, so common calls stay quiet', () => {
    // .NET Core adds Split(char, options) and Trim(char); Framework uses the params char[] forms.
    for (const code of ['"a,b".Split(\',\')', '" a ".Trim(\' \')', '"abc".Contains(\'a\')', 'string.Join(",", new List<string>())', 'new[] { 1 }.ToHashSet()']) {
      expect(compat(code)).toEqual([]);
      expect(errors(code)).toEqual([]);
    }
    expect(engine.resultType('"abc".Contains(\'a\')', 'expr')).toBe('bool');
  });

  it('leaves what .NET Framework lacks out of completion', () => {
    const linq = labels('new[] { 1 }.|');
    expect(linq).toContain('Where');
    expect(linq).not.toContain('Chunk');
    expect(linq).not.toContain('CountBy');
    expect(labels('DateTime.|')).not.toContain('UnixEpoch');
  });
});

describe('editor features in the new constructs', () => {
  it('completes range variables and local functions', () => {
    expect(labels('from h in context.Request.Headers where h.|')).toEqual(expect.arrayContaining(['Key', 'Value']));
    expect(labels('from h in context.Request.Headers let k = h.Key select |')).toEqual(expect.arrayContaining(['h', 'k']));
    expect(labels('int Twice(int x) => x * 2; return T|', 'block')).toContain('Twice');
  });

  it('hovers a local function with its signature', () => {
    const [code, offset] = at('int Twice(int x) => x * 2; return Tw|ice(1);');
    expect(engine.hover(code, 'block', offset)?.signature).toBe('(local function) int Twice(int x)');
  });
});
