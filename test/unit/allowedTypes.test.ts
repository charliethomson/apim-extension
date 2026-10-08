import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Allowlist, lintAllowedTypes, type AllowlistData, type BclIndex } from '../../src/csharp/allowedTypes';
import { parseStubs } from '../../src/csharp/stubModel';
import { parse } from '../../src/parser/scanner';

const root = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const stubs = parseStubs(read('stubs/ApimContext.cs'));
const allow = new Allowlist(
  JSON.parse(read('data/allowed-types.json')) as AllowlistData,
  JSON.parse(read('data/bcl-types.json')) as BclIndex,
  new Set([...stubs.keys(), 'PolicyExtensions', 'NamedValues']),
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

  it.each(['raw/echo.policy.xml', 'escaped/echo.policy.xml', 'apiops/apis/random-users/policy.xml'])('%s has no findings', (file) => {
    expect(findings(file)).toEqual([]);
  });

  // Func<> delegates, IComparable and UriKind aren't in the documented allowlist.
  it('flags the types the fixtures use outside the allowlist', () => {
    expect(findings('raw/tricky.policy.xml')).toEqual(['System.Func']);
    expect(findings('apiops/policyFragments/random-user-pipeline/policy.xml').sort()).toEqual(['System.Func', 'System.Func', 'System.IComparable', 'System.UriKind']);
  });
});

it('flags delegate types, which the allowlist leaves out', () => {
  expect(names('{ Func<string, int> f = s => s.Length; return f("a"); }')).toEqual(['System.Func']);
});
