import { describe, expect, it } from 'vitest';
import { parse } from '@apim-policy/document';
import { draftModel, headerExpansions, inferredTypes, readHeaderComment, renderHeader } from '../src/headerShape';
import { summarize } from '../src/variables';

const MESSY = `<!-- Signs the request.
  Second summary line.
  @in {string} sig-key The HMAC key.
     @in {int} [sig-ttl=300]   Seconds.
  @in [sig-scope]
  @out {string} sig-header The value
          for the Authorization header.
-->`;

describe('header shape', () => {
  it('reads a header with its description lines, and renders the standard shape', () => {
    const model = readHeaderComment(MESSY)!;
    expect(model.summary).toEqual(['Signs the request.', 'Second summary line.']);
    expect(model.entries.map((e) => [e.kind, e.type, e.name, e.optional, e.default, e.description])).toEqual([
      ['in', 'string', 'sig-key', false, undefined, ['The HMAC key.']],
      ['in', 'int', 'sig-ttl', true, '300', ['Seconds.']],
      ['in', undefined, 'sig-scope', true, undefined, []],
      ['out', 'string', 'sig-header', false, undefined, ['The value', 'for the Authorization header.']],
    ]);
    expect(renderHeader(model, '', '    ')).toBe(
      [
        '<!--',
        '    Signs the request.',
        '    Second summary line.',
        '',
        '    @in  {string} sig-key        The HMAC key.',
        '    @in  {int}    [sig-ttl=300]  Seconds.',
        '    @in           [sig-scope]',
        '',
        '    @out {string} sig-header  The value',
        '                              for the Authorization header.',
        '-->',
      ].join('\n'),
    );
  });

  it("lets a very long name overflow its column instead of pushing every description out", () => {
    const model = readHeaderComment('<!--\n@in [a-very-long-optional-input-name=https://example.com/api/] x\n@in b y\n-->')!;
    expect(renderHeader(model, '  ', '  ').split('\n').slice(1, 3)).toEqual(['    @in  [a-very-long-optional-input-name=https://example.com/api/]  x', '    @in  b  y']);
  });

  it('leaves typedefs unaligned, and lets a long inline type overflow its column', () => {
    const model = readHeaderComment('<!--\n@typedef {{ a: int }} A  Short.\n@typedef {{ id: string, email: string, age?: int }} User\n@in {A} a  x\n@in {{ id: string, email: string, age?: int }} b  y\n-->')!;
    expect(renderHeader(model, '', '  ').split('\n')).toEqual([
      '<!--',
      '  @typedef {{ a: int }} A  Short.',
      '  @typedef {{ id: string, email: string, age?: int }} User',
      '',
      '  @in  {A} a  x',
      '  @in  {{ id: string, email: string, age?: int }} b  y',
      '-->',
    ]);
  });

  it("won't read a header the shape can't hold", () => {
    expect(readHeaderComment('<!-- @in {x} [a -->')).toBeUndefined();
    expect(readHeaderComment('<!-- @out [a] -->')).toBeUndefined();
    expect(readHeaderComment('<!--\n@in a\n\nA note after the tags.\n-->')).toBeUndefined();
    expect(readHeaderComment('<!-- just text -->')).toBeUndefined();
  });
});

describe('drafting and expanding', () => {
  const FRAGMENT = (header: string) =>
    `${header}\n<fragment>\n    <set-variable name="out-a" value="@((int)context.Variables[&quot;in-a&quot;] + 1)" />\n    <set-variable name="out-b" value="literal" />\n    <set-header name="x"><value>@(context.Variables.GetValueOrDefault<string>("in-b"))</value></set-header>\n</fragment>`;

  it('infers types from casts, GetValueOrDefault<T> and obvious values', () => {
    const t = inferredTypes(parse(FRAGMENT('')));
    expect([...t.reads]).toEqual([['in-a', 'int'], ['in-b', 'string']]);
    expect([...t.sets]).toEqual([['out-a', 'int'], ['out-b', 'string']]);
  });

  it('drafts a header: what it reads as @in, what callers read as @out, the rest @internal', () => {
    const doc = parse(FRAGMENT(''));
    expect(renderHeader(draftModel(doc, summarize(doc), undefined, undefined, new Set(['out-a'])), '', '    ')).toBe(
      [
        '<!--',
        '    What this fragment does.',
        '',
        '    @in  {int}    in-a',
        '    @in  {string} [in-b]',
        '',
        '    @out {int} out-a',
        '',
        '    @internal {string} out-b',
        '-->',
      ].join('\n'),
    );
  });

  it('turns three or more internals with a prefix into one pattern, keeping JSON-shaped ones by name', () => {
    const doc = parse('<fragment><set-variable name="w-a" value="1" /><set-variable name="w-b" value="1" /><set-variable name="w-c" value="@(new JObject())" /><set-variable name="solo" value="1" /></fragment>');
    const model = draftModel(doc, summarize(doc), undefined, (n) => (n === 'w-c' ? '{ k: int }' : undefined));
    expect(model.entries.map((e) => `${e.kind} ${e.type ?? ''} ${e.name}`)).toEqual(['internal { k: int } w-c', 'internal string solo', 'internal  w-*']);
  });

  it('expands an empty comment where the header goes into the drafted header', () => {
    const src = FRAGMENT('<!---->');
    const [x] = headerExpansions(parse(src), 4, '    ');
    expect(x.label).toBe('Fragment header');
    expect(x.replace).toEqual({ start: 0, end: 7 });
    // Snippet text: a literal `}` is escaped.
    expect(x.snippet.split('\n').slice(0, 4)).toEqual(['<!--', '    ${1:What this fragment does.}', '', '    @in  {int\\}    in-a']);
    expect(headerExpansions(parse(src), 2, '    ')).toEqual([]);
  });

  it('offers @in and @out lines for what the header leaves out, then blank ones', () => {
    const src = FRAGMENT('<!--\n    @in  in-a\n    @i\n-->');
    const at = src.indexOf('@i\n') + 2;
    const items = headerExpansions(parse(src), at, '    ');
    expect(items.map((x) => x.label)).toEqual(['@in in-b', '@out out-a', '@internal out-a', '@out out-b', '@internal out-b', '@in', '@in [optional]', '@out', '@internal', '@typedef', '@property']);
    expect(items[0]).toMatchObject({ snippet: '@in  {string} [in-b]  ${1:What the caller sets.}', replace: { start: at - 2, end: at } });
    // Not mid-line, and not outside the header.
    expect(headerExpansions(parse(src), src.indexOf('in-a'), '    ')).toEqual([]);
    expect(headerExpansions(parse(src), src.indexOf('<fragment>') + 3, '    ')).toEqual([]);
  });
});
