import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from '../../src/parser/scanner';
import { applyEdits, codeLevels, formatPolicy } from '../../src/policy/format';

const SPACES = { tabSize: 4, insertSpaces: true };
const format = (src: string, options = SPACES) => applyEdits(src, formatPolicy(parse(src), options));

const fixtures = join(__dirname, '..', 'fixtures');
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : f.endsWith('.xml') ? [join(d, f)] : []));

/** Each expression's code with every line's indentation dropped: what formatting may not change. */
const codeOf = (src: string) => parse(src).expressions.map((e) => e.code.replace(/^[ \t]+/gm, ''));

describe('formatPolicy', () => {
  it('indents nested elements and puts each on its own line', () => {
    expect(format('<policies><inbound><base /><set-header name="a" exists-action="override"><value>x</value></set-header></inbound></policies>')).toBe(
      '<policies>\n    <inbound>\n        <base />\n        <set-header name="a" exists-action="override">\n            <value>x</value>\n        </set-header>\n    </inbound>\n</policies>\n',
    );
  });

  it('keeps one blank line between elements, and drops them at the edges', () => {
    expect(format('<policies>\n\n\n  <inbound />\n\n\n\n  <outbound />\n\n</policies>')).toBe('<policies>\n    <inbound />\n\n    <outbound />\n</policies>\n');
  });

  it('re-indents the C# in a multi-line expression from its brackets, wherever its element moves', () => {
    const src = '<policies>\n<inbound>\n<set-variable name="x" value="@{\n var a = 1;\n          return a;\n}" />\n<set-body>@{\n  return new JObject {\n["code"] = 500,\n      ["error"] = new JObject {\n  ["source"] = context.LastError.Source,\n        },\n  }.ToString();\n}</set-body>\n</inbound>\n</policies>';
    expect(format(src)).toBe(
      [
        '<policies>',
        '    <inbound>',
        '        <set-variable name="x" value="@{',
        '            var a = 1;',
        '            return a;',
        '        }" />',
        '        <set-body>@{',
        '            return new JObject {',
        '                ["code"] = 500,',
        '                ["error"] = new JObject {',
        '                    ["source"] = context.LastError.Source,',
        '                },',
        '            }.ToString();',
        '        }</set-body>',
        '    </inbound>',
        '</policies>',
        '',
      ].join('\n'),
    );
  });

  it('indents continued lines once more, and leaves text mixed with markup as written', () => {
    const src = '<policies><inbound><set-variable name="u" value="@(users\n.Where(u => u != null)\n.Count() &gt; 0 &&\nok)" /><trace source="t"><message>a\n   b</message></trace></inbound></policies>';
    expect(format(src)).toContain('value="@(users\n            .Where(u => u != null)\n            .Count() &gt; 0 &&\n            ok)"');
    expect(format(src)).toContain('<message>a\n   b</message>');
  });

  it('lays out switch cases, and chains that continue after a lambda', () => {
    const levels = (code: string) => codeLevels(code, 0).map((l) => (l === undefined ? '-' : String(l))).join('');
    expect(levels('\nswitch (x) {\ncase 1:\na();\nbreak;\ndefault:\nb();\nbreak;\n}\n')).toBe('-12332331-');
    expect(levels('\nvar u = xs\n.Where(u => {\nreturn true;\n})\n.Select(u => u)\n.ToList();\n')).toBe('-123222-');
  });

  it("keeps the whitespace inside a multi-line string or comment, which is part of it", () => {
    const src = '<policies>\n<inbound>\n<set-body>@{\nvar s = @"a\n  b";\n/* x\n     y */\nreturn s;\n}</set-body>\n</inbound>\n</policies>';
    const out = format(src);
    expect(out).toContain('var s = @"a\n  b";');
    expect(out).toContain('/* x\n     y */');
    expect(out).toContain('\n            return s;\n');
  });

  it('groups each element\'s edits, so a partial format moves an element and its content together', () => {
    const src = '<policies>\n<inbound>\n<set-body>@{\nreturn 1;\n}</set-body>\n</inbound>\n</policies>';
    const edits = formatPolicy(parse(src), SPACES);
    const body = src.indexOf('<set-body>');
    expect(edits.filter((e) => e.group === body).map((e) => e.text)).toEqual(['\n        ', '            ', '        ']);
  });

  it("doesn't move the lines of a verbatim string, whose whitespace is its value", () => {
    const src = '<policies>\n<inbound>\n<set-body>@(@"a\n  b")</set-body>\n</inbound>\n</policies>';
    expect(format(src)).toContain('@(@"a\n  b")');
  });

  it('uses tabs when asked, and keeps comments with their element', () => {
    expect(format('<policies>\n<!-- a\n     b -->\n<inbound />\n</policies>', { tabSize: 4, insertSpaces: false })).toBe('<policies>\n\t<!-- a\n\t     b -->\n\t<inbound />\n</policies>\n');
  });

  it("refuses a document whose structure isn't certain", () => {
    expect(formatPolicy(parse('<policies><inbound>'), SPACES)).toEqual([]);
    expect(formatPolicy(parse('<policies><inbound></outbound></policies>'), SPACES)).toEqual([]);
  });

  it.each(walk(fixtures).map((f) => [f.slice(fixtures.length + 1), f]))('%s: only whitespace changes, expressions keep their code, and a second run changes nothing', (_, file) => {
    const src = readFileSync(file, 'utf8');
    const once = format(src);
    expect(once.replace(/\s+/g, '')).toBe(src.replace(/\s+/g, ''));
    expect(codeOf(once)).toEqual(codeOf(src));
    expect(format(once)).toBe(once);
  });
});
