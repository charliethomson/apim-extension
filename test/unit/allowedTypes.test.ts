import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Allowlist, lintAllowedTypes, lintReferences, type AllowlistData, type BclIndex } from '../../src/csharp/allowedTypes';
import type { RawModel } from '../../src/csharp/lang/model';
import { CSharpEngine } from '../../src/csharp/lang/service';
import { readStubs } from '../../src/csharp/lang/stubs';
import { parse } from '../../src/parser/scanner';

const root = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const allow = new Allowlist(
  JSON.parse(read('data/allowed-types.json')) as AllowlistData,
  JSON.parse(read('data/bcl-types.json')) as BclIndex,
  new Set(readStubs(read('stubs/ApimContext.cs'), { types: {} }).map((d) => d.name)),
);

const lint = (code: string) => lintAllowedTypes(code, allow).map((f) => code.slice(f.range.start, f.range.end));
const names = (code: string) => lintAllowedTypes(code, allow).map((f) => f.name);

describe('lintAllowedTypes: forbidden types', () => {
  it.each([
    ['System.IO.File.ReadAllText("x")', 'System.IO.File'],
    ['File.ReadAllText("x")', 'System.IO.File'],
    ['Environment.GetEnvironmentVariable("X")', 'System.Environment'],
    ['new System.Net.Http.HttpClient()', 'System.Net.Http.HttpClient'],
    ['new StreamReader(s)', 'System.IO.StreamReader'],
    ['typeof(Type)', 'System.Type'],
    ['(Uri)x ?? (Type)y', 'System.Type'],
    ['x is Stream', 'System.IO.Stream'],
    ['x as MemoryStream', 'System.IO.MemoryStream'],
    ['context.Variables.GetValueOrDefault<Stream>("s")', 'System.IO.Stream'],
    ['new List<FileInfo>()', 'System.IO.FileInfo'],
    ['global::System.Threading.Thread.Sleep(1)', 'System.Threading.Thread'],
    ['$"{Environment.MachineName}"', 'System.Environment'],
  ])('%s', (code, name) => {
    expect(names(code)).toEqual([name]);
  });

  it('flags declarations', () => {
    expect(lint('{ FileInfo f = null; return f; }')).toEqual(['FileInfo']);
    expect(lint('{ foreach (DirectoryInfo d in xs) { } return 1; }')).toEqual(['DirectoryInfo']);
  });
});

describe('lintAllowedTypes: allowed code', () => {
  it.each([
    'context.Request.Headers.GetValueOrDefault("Authorization", "").AsJwt()?.Subject',
    'context.Request.Body.As<JObject>(preserveContent: true)["x"].Value<string>()',
    'new JObject { ["a"] = 1, ["b"] = new JArray(1, 2) }.ToString(Formatting.None)',
    'JsonConvert.SerializeObject(new { a = 1 })',
    'Regex.Match(x, "a").Groups["g"].Value',
    'new Regex("a").IsMatch(s)',
    'DateTime.UtcNow.AddMinutes(5).ToString("o")',
    'DateTime.Parse(s) < DateTime.Now',
    'Convert.ToBase64String(Encoding.UTF8.GetBytes(s))',
    'xs.Select(i => (string)i["id"]).Where(id => id.Length < 10).ToList()',
    'new Dictionary<string, List<int>>()',
    'Guid.NewGuid().ToString("N")',
    'TimeSpan.FromSeconds(30)',
    'string.Join(",", new[] { "a" })',
    'Math.Max(1, 2) + int.Parse("3")',
    '(int)context.Variables["n"]',
    'context.Variables.GetValueOrDefault<JArray>("items").Count',
    'new HMACSHA256(key).ComputeHash(bytes)',
    'XDocument.Parse(s).Root',
    'NamedValues.Get("k")',
    'context.Request.Url.Path.Split(\'/\').Last()',
    'Uri.EscapeDataString(s)',
    'Tuple.Create(1, 2)',
    'IPAddress.Parse(context.Request.IpAddress).GetAddressBytes()',
  ])('%s', (code) => {
    expect(lint(code)).toEqual([]);
  });

  it('ignores locals that share a BCL type name', () => {
    expect(lint('{ var File = "x"; return File.Length; }')).toEqual([]);
    expect(lint('xs.Select(Path => Path.Length)')).toEqual([]);
    expect(lint('xs.Select((Stream, i) => Stream)')).toEqual([]);
  });

  it('ignores context members whose names are BCL types', () => {
    expect(lint('context.Request.Url.Path + context.Deployment.Gateway.Id')).toEqual([]);
  });

  it('ignores names in strings and comments', () => {
    expect(lint('"File.ReadAllText" /* Environment.Exit */')).toEqual([]);
  });
});

describe('lintAllowedTypes: restricted members', () => {
  it.each([
    ['DateTime.FromBinary(1)', 'System.DateTime.FromBinary'],
    ['DateTime.SpecifyKind(d, DateTimeKind.Local)', 'System.DateTime.SpecifyKind'],
    ['JsonConvert.PopulateObject(s, o)', 'Newtonsoft.Json.JsonConvert.PopulateObject'],
    ['Enum.GetValues(t)', 'System.Enum.GetValues'],
    ['Regex.Escape(s)', 'System.Text.RegularExpressions.Regex.Escape'],
    ['XDocument.Load("x")', 'System.Xml.Linq.XDocument.Load'],
  ])('%s', (code, name) => {
    expect(names(code)).toContain(name);
  });

  it('reports the allowed members in the message', () => {
    const [f] = lintAllowedTypes('Enum.GetValues(t)', allow);
    expect(f.message).toContain('Parse, TryParse, ToString');
  });

  it('flags disallowed enum members of restricted enums', () => {
    expect(names('DateTimeKind.Local')).toEqual(['System.DateTimeKind.Local']);
    expect(names('DateTimeKind.Utc')).toEqual([]);
  });
});

describe('lintAllowedTypes on fixtures', () => {
  const findings = (file: string) => parse(read(`test/fixtures/${file}`)).expressions.flatMap((e) => lintAllowedTypes(e.code, allow).map((f) => f.name));

  it.each(['raw/echo.policy.xml', 'escaped/echo.policy.xml', 'apiops/apis/random-users/policy.xml', 'apiops/policyFragments/random-user/policy.xml'])('%s has no findings', (file) => {
    expect(findings(file)).toEqual([]);
  });

  // Func<> delegates aren't in the documented allowlist.
  it('flags the types the fixtures use outside the allowlist', () => {
    expect(findings('raw/tricky.policy.xml')).toEqual(['System.Func']);
  });
});

it('flags delegate types, which the allowlist leaves out', () => {
  expect(names('{ Func<string, int> f = s => s.Length; return f("a"); }')).toEqual(['System.Func']);
});

describe('lintReferences (built-in engine semantic pass)', () => {
  const engine = CSharpEngine.load(JSON.parse(read('data/csharp-model.json')) as RawModel, read('stubs/ApimContext.cs'));
  const lint = (code: string, kind: 'expr' | 'block' = 'expr') => lintReferences(engine.references(code, kind), allow).map((f) => `${code.slice(f.range.start, f.range.end)}: ${f.name}`);

  it('flags restricted instance members whose receiver type is never written', () => {
    // The syntactic pass can't see that `d` is a DateTime.
    expect(lint('var d = context.Timestamp; return d.ToBinary();', 'block')).toEqual(['ToBinary: System.DateTime.ToBinary']);
    expect(lintAllowedTypes('var d = context.Timestamp; return d.ToBinary();', allow)).toEqual([]);
  });

  it('flags forbidden types the model knows, and leaves allowed ones and the stubs alone', () => {
    expect(lint('new XmlDocument().InnerXml')).toEqual(['XmlDocument: System.Xml.XmlDocument']);
    expect(lint('context.Request.Headers.GetValueOrDefault("a", "").AsJwt()?.Subject')).toEqual([]);
    expect(lint('JObject.Parse("{}")["a"].ToString() + DateTime.UtcNow.Year')).toEqual([]);
  });

  it('flags a type that is only inferred when one of its members is used, once', () => {
    // The gateway rejects `g.Key` on GroupBy's IGrouping though the code never names the type.
    expect(lint('new[] { "a" }.GroupBy(s => s.Length).Select(g => g.Key + g.Key).ToList()')).toEqual(['Key: System.Linq.IGrouping']);
    expect(lint('new[] { "a" }.GroupBy(s => s.Length).Select(g => g.Count()).ToList()')).toEqual([]);
    expect(lint('new[] { "a" }.OrderBy(s => s).ThenBy(s => s.Length).ToString()')).toEqual([]);
  });
});
