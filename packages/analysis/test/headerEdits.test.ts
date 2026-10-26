import { describe, expect, it } from 'vitest';
import { parse } from '@charliethomson/apim-document';
import {
  emptySetVariable,
  guardedRead,
  headerFor,
  inlineShape,
  namedTypedefs,
  outputsFirst,
  rewriteHeader,
  tagInsertion,
  tagLine,
  typedefAsProperties,
  typedefFromText,
  typedefNameAt,
  typedefReferenceAt,
  variableFamily,
} from '../src/headerEdits';
import { readHeaderComment, type HeaderModel } from '../src/headerShape';
import { unguardedReads } from '../src/variableSafety';
import { summarize } from '../src/variables';

const headerOf = (src: string) => summarize(parse(src)).header!;
/** The text with `edit` applied. */
const apply = (src: string, offset: number, text: string, end = offset) => src.slice(0, offset) + text + src.slice(end);

describe('where a new tag line goes', () => {
  const src = `<!--
    Signs requests.

    @in  {string} key   The key,
                        over two lines.
    @out {string} sig   The signature.
-->
<fragment />
`;

  it.each<['in' | 'out' | 'internal', string]>([
    ['in', '                        over two lines.\n'],
    ['out', '    @out {string} sig   The signature.\n'],
    ['internal', '    @out {string} sig   The signature.\n'],
  ])('a new @%s goes after its group or the one before it', (kind, lineBefore) => {
    const at = tagInsertion(src, headerOf(src), kind);
    expect(src.slice(0, at.offset).endsWith(lineBefore)).toBe(true);
    expect(at.indent).toBe('    ');
  });

  it('goes before the groups after it when there are none before', () => {
    const outsOnly = '<!--\n  Sets.\n\n  @out sig  The signature.\n-->\n<fragment />\n';
    const at = tagInsertion(outsOnly, headerOf(outsOnly), 'in');
    expect(outsOnly.slice(at.offset).startsWith('  @out sig')).toBe(true);
    expect(at.indent).toBe('  ');
  });

  it('goes before the end of a header with no tags, indented one step', () => {
    // A header always has a tag once read; one with its tags taken out stands for a header being written.
    const bare = '<!--\n  Sets.\n\n  @out sig\n-->\n<fragment />\n';
    const at = tagInsertion(bare, { ...headerOf(bare), outputs: [] }, 'in');
    expect(bare.slice(at.offset).startsWith('-->')).toBe(true);
    expect(at.indent).toBe('    ');
  });

  it('writes the line with its description as the tab stop, escaping snippet syntax', () => {
    expect(tagLine('  ', 'in', 'key', 'string')).toBe('  @in  {string} key  ${1:description}\n');
    expect(tagLine('', 'internal', 'a$b', '{ x: Y }')).toBe('@internal {{ x: Y \\}} a\\$b  ${1:description}\n');
  });
});

describe('rewriting a header through its model', () => {
  const src = `<fragment>
    <!--
        Signs requests.

        @in key  The key.
    -->
</fragment>
`;

  it("renders the changed model at the header's own indentation, with tab stops", async () => {
    const header = headerOf(src);
    const edit = await rewriteHeader(src, header, '    ', (model, stop) => {
      model.entries.push({ kind: 'out', name: 'sig', optional: false, description: [stop('what it is')] });
    });
    expect(edit).toContain('\n        @out sig  ${1:what it is}\n    -->');
    expect(edit!.startsWith('<!--\n        Signs requests.')).toBe(true);
  });

  it("gives up on a header the model can't hold", async () => {
    const prose = '<!--\n  Sets.\n\n  @out sig  The signature.\n\n  More prose after the tags.\n-->\n<fragment />\n';
    expect(await rewriteHeader(prose, headerOf(prose), '  ', () => {})).toBeUndefined();
  });

  it('starts a header holding just a generated typedef, its name a tab stop', () => {
    const text = headerFor({ type: 'User[]', name: 'User', entries: [{ kind: 'typedef', name: 'User', optional: false, description: [] }, { kind: 'property', name: 'id', type: 'string', optional: false, description: [] }] }, '  ');
    // Literal text is escaped for the snippet, so its braces stay text.
    expect(text).toBe('<!--\n  @typedef ${1:User}\n  @property {string\\} id\n-->\n');
  });

  it("names generated typedefs in a model and gives the tag's type, an array keeping its []", () => {
    const model: HeaderModel = { summary: [], entries: [] };
    const stop = (t: string) => `<${t}>`;
    expect(namedTypedefs(model, stop, { type: 'Rule[]', name: 'Rule', entries: [{ kind: 'typedef', name: 'Rule', optional: false, description: [] }] })).toBe('<Rule>[]');
    expect(model.entries.map((e) => e.name)).toEqual(['<Rule>']);
  });
});

describe('typedefs from type text', () => {
  it('knows an inline shape from a name', () => {
    expect([inlineShape('{ a: int }'), inlineShape('{ a: int }[]'), inlineShape('User'), inlineShape('JObject')]).toEqual([true, true, false, false]);
  });

  it('splits an object, an array of one and a JArray<…> into @property lines, keeping named types', () => {
    const taken = new Set<string>();
    const object = typedefFromText('{ id: string, rules?: Rule[] }', 'ru-arg-filter', taken);
    expect(object?.type).toBe('Filter');
    expect(object?.entries.map((e) => [e.kind, e.name, e.type, e.optional])).toEqual([
      ['typedef', 'Filter', undefined, false],
      ['property', 'id', 'string', false],
      ['property', 'rules', 'Rule[]', true],
    ]);
    expect(typedefFromText('{ a: int }[]', 'ru-ret-users', taken)?.type).toBe('User[]');
    expect(typedefFromText('JArray<{ a: int }>', 'ru-ret-users', taken)?.type).toBe('User2[]');
    expect(typedefFromText('{ a: int }', 'filter', taken)?.name).toBe('Filter2');
  });

  it("leaves text it can't split", () => {
    expect(typedefFromText('User', 'u', new Set())).toBeUndefined();
    expect(typedefFromText('{ }', 'u', new Set())).toBeUndefined();
  });

  it('rewrites an old one-line typedef as @property lines, keeping its description', () => {
    const src = '<!--\n  Sets.\n\n  @typedef {{ id: string, tags: string[] }} User  Who it is.\n  @out {User} user\n-->\n<fragment />\n';
    const header = headerOf(src);
    const model = readHeaderComment(src.slice(header.range.start, header.range.end))!;
    expect(typedefAsProperties(header, header.typedefDocs.get('User')!, model)).toBe(true);
    expect(model.entries.filter((e) => e.kind === 'typedef' || e.kind === 'property').map((e) => [e.kind, e.name, e.type, e.description])).toEqual([
      ['typedef', 'User', undefined, ['Who it is.']],
      ['property', 'id', 'string', []],
      ['property', 'tags', 'string[]', []],
    ]);
  });
});

describe('setting outputs at the start', () => {
  it('puts empty values of each type after the start tag, once each, a step in from <fragment>', () => {
    const src = '<!--\n  Sets.\n\n  @out {bool} ok\n  @out n\n-->\n  <fragment>\n    <set-variable name="ok" value="@(true)" />\n  </fragment>\n';
    const doc = parse(src);
    const edit = outputsFirst(doc, summarize(doc), ['ok', 'n', 'ok'], '  ')!;
    expect(edit.count).toBe(2);
    expect(apply(src, edit.offset, edit.text)).toContain('<fragment>\n    <set-variable name="ok" value="@(false)" />\n    <set-variable name="n" value="" />\n    <set-variable name="ok" value="@(true)" />');
  });

  it('goes after a header written inside <fragment>', () => {
    const src = '<fragment>\n  <!--\n    Sets.\n\n    @out n\n  -->\n</fragment>\n';
    const doc = parse(src);
    const edit = outputsFirst(doc, summarize(doc), ['n'], '  ')!;
    expect(src.slice(0, edit.offset).endsWith('-->')).toBe(true);
  });

  it('needs a whole fragment', () => {
    for (const src of ['<policies />', '<fragment>']) {
      const doc = parse(src);
      expect(outputsFirst(doc, summarize(doc), ['n'], '  ')).toBeUndefined();
    }
  });
});

describe('an empty set-variable value', () => {
  const src = '<fragment>\n    <set-variable name="a" value="" />\n    <set-variable name="b" value="@( )" />\n    <set-variable name="c" value="@{}" />\n    <set-variable name="d" value="x" />\n</fragment>\n';
  const doc = parse(src);

  it.each(['a', 'b', 'c'])("is found for '%s', with its value's range and its line's indent", (name) => {
    const at = src.indexOf(`name="${name}"`);
    const hit = emptySetVariable(doc, at);
    expect(hit?.name).toBe(name);
    expect(hit?.indent).toBe('    ');
    expect(src.slice(hit!.range.start - 1, hit!.range.end + 1)).toMatch(/^"[^"]*"$/);
  });

  it("isn't one when the value has something in it, or the cursor isn't on a set-variable", () => {
    expect(emptySetVariable(doc, src.indexOf('name="d"'))).toBeUndefined();
    expect(emptySetVariable(doc, 2)).toBeUndefined();
  });
});

describe('typedef names in a header', () => {
  const src = '<!--\n  Uses User a lot.\n\n  @typedef {{ id: string }} User\n  @in {User[]} users  Each User once.\n-->\n<fragment />\n';
  const header = headerOf(src);

  it("links a name used in a tag's type to its @typedef, at either end of the word", () => {
    const at = src.indexOf('{User[]}') + 1;
    for (const offset of [at, at + 4]) {
      const ref = typedefReferenceAt(src, header, offset);
      expect(src.slice(ref!.range.start, ref!.range.end)).toBe('User');
      expect(ref?.typedef.name).toBe('User');
    }
  });

  it('ignores the name in a description, and anywhere outside the header', () => {
    expect(typedefReferenceAt(src, header, src.indexOf('Each User') + 6)).toBeUndefined();
    expect(typedefReferenceAt(src, header, src.indexOf('<fragment') + 2)).toBeUndefined();
  });

  it('finds a typedef named anywhere in the header for hover, and nothing for other words', () => {
    expect(typedefNameAt(src, header, src.indexOf('Uses User') + 6)?.name).toBe('User');
    expect(typedefNameAt(src, header, src.indexOf('Uses') + 1)).toBeUndefined();
  });
});

describe('guarding a read', () => {
  const fix = (src: string) => {
    const doc = parse(src);
    const [read] = unguardedReads(doc, undefined, () => undefined);
    const edit = guardedRead(doc, read)!;
    return apply(src, edit.range.start, edit.text, edit.range.end);
  };

  it('escapes the rewrite in the escaped format, and not in rawxml or CDATA', () => {
    expect(fix('<policies><inbound><set-header name="a"><value>@((string)context.Variables[&quot;x&quot;])</value></set-header></inbound></policies>')).toContain('GetValueOrDefault&lt;string&gt;(&quot;x&quot;)');
    expect(fix('<policies><inbound><set-header name="a"><value>@((string)context.Variables["x"])</value></set-header></inbound></policies>')).toContain('GetValueOrDefault<string>("x")');
  });
});

describe('variable families', () => {
  it('is everything up to the last dash', () => {
    expect([variableFamily('ru-tmp-count'), variableFamily('count'), variableFamily('-x')]).toEqual(['ru-tmp-', undefined, undefined]);
  });
});
