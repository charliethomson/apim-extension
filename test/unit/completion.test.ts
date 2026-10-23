import { describe, expect, it } from 'vitest';
import { parse } from '../../src/parser/scanner';
import { catalog } from '../../src/policy/catalog';
import { xmlCompletions } from '../../src/policy/completion';

/** Completes at the `|` in `text`. */
function complete(text: string, extra: { fragmentIds?: string[]; namedValues?: string[] } = {}) {
  const offset = text.indexOf('|');
  const src = text.slice(0, offset) + text.slice(offset + 1);
  const items = xmlCompletions(parse(src), offset, { catalog, ...extra });
  return { items, labels: items?.map((i) => i.label) ?? [], src, offset };
}

describe('xmlCompletions: elements', () => {
  it('offers the root elements in an empty document', () => {
    expect(complete('<|').labels).toEqual(['policies', 'fragment']);
  });

  it('offers missing sections under policies', () => {
    expect(complete('<policies>\n  <inbound><base/></inbound>\n  <|\n</policies>').labels).toEqual(['backend', 'outbound', 'on-error']);
  });

  it('offers only the policies allowed in the current section', () => {
    const inbound = complete('<policies><inbound>\n<|\n</inbound></policies>').labels;
    expect(inbound).toContain('validate-jwt');
    expect(inbound).toContain('set-header');
    expect(inbound).not.toContain('forward-request');
    const backend = complete('<policies><backend>\n<|\n</backend></policies>').labels;
    expect(backend).toContain('forward-request');
    expect(backend).not.toContain('validate-jwt');
  });

  it('keeps the section through nesting', () => {
    const labels = complete('<policies><outbound><choose><when condition="@(true)">\n<|\n</when></choose></outbound></policies>').labels;
    expect(labels).toContain('cache-store');
    expect(labels).not.toContain('validate-jwt');
  });

  it('offers child elements for elements with a fixed content model', () => {
    expect(complete('<policies><inbound><choose>\n<|\n</choose></inbound></policies>').labels).toEqual(['when', 'otherwise']);
    expect(complete('<policies><inbound><set-header name="a">\n<|\n</set-header></inbound></policies>').labels).toEqual(['value']);
  });

  it('respects only/exclude on nested policies', () => {
    const labels = complete('<policies><inbound><wait>\n<|\n</wait></inbound></policies>').labels;
    expect(labels.sort()).toEqual(['cache-lookup-value', 'choose', 'send-request']);
  });

  it('offers any policy but base in a fragment', () => {
    const labels = complete('<fragment>\n<|\n</fragment>').labels;
    expect(labels).toContain('validate-jwt');
    expect(labels).toContain('forward-request');
    expect(labels).not.toContain('base');
  });

  it('replaces the partially typed name and fills required attributes', () => {
    const { items, src, offset } = complete('<policies><inbound>\n<set-he|\n</inbound></policies>');
    const item = items!.find((i) => i.label === 'set-header')!;
    expect(src.slice(item.range.start, item.range.end)).toBe('set-he');
    expect(item.range.end).toBe(offset);
    expect(item.insert).toBe('set-header name="$1">\n\t$0\n</set-header>');
  });

  it('makes empty policies self-closing and text policies inline', () => {
    const items = complete('<policies><inbound>\n<|\n</inbound></policies>').items!;
    expect(items.find((i) => i.label === 'base')?.insert).toBe('base />');
    expect(items.find((i) => i.label === 'set-method')?.insert).toBe('set-method>$1</set-method>');
  });

  it('closes the innermost open element', () => {
    expect(complete('<policies><inbound><choose></|').items?.map((i) => i.insert)).toEqual(['choose>']);
  });
});

describe('xmlCompletions: bare element names', () => {
  it('offers elements for a name typed without <, inserting the <', () => {
    const { items, src } = complete('<policies><inbound>\n  set-var|\n</inbound></policies>');
    const item = items!.find((i) => i.label === 'set-variable')!;
    expect(item.insert).toBe('<set-variable name="$1" value="$2" />');
    expect(src.slice(item.range.start, item.range.end)).toBe('set-var');
  });

  it('respects the section and content model', () => {
    expect(complete('<policies><backend>\n  forw|\n</backend></policies>').labels).toContain('forward-request');
    expect(complete('<policies><backend>\n  valid|\n</backend></policies>').labels).not.toContain('validate-jwt');
    expect(complete('<policies><inbound><choose>\n  wh|\n</choose></inbound></policies>').labels).toEqual(['when', 'otherwise']);
  });

  it('stays out of text content, comments and CDATA', () => {
    expect(complete('<policies><inbound><set-method>GE|</set-method></inbound></policies>').items).toBeUndefined();
    expect(complete('<policies><inbound><!-- set-var| --></inbound></policies>').items).toBeUndefined();
    expect(complete('<policies><inbound><set-body><![CDATA[ set-var| ]]></set-body></inbound></policies>').items).toBeUndefined();
  });
});

describe('xmlCompletions: attributes', () => {
  it('offers attributes not yet present, required first', () => {
    const { items } = complete('<policies><inbound><set-header exists-action="skip" |/></inbound></policies>');
    const labels = items!.map((i) => i.label);
    expect(labels).not.toContain('exists-action');
    expect([...items!].sort((a, b) => (a.sortText ?? '').localeCompare(b.sortText ?? ''))[0].label).toBe('name');
    expect(labels).toContain('id');
  });

  it('uses choice snippets for enums', () => {
    const { items } = complete('<policies><inbound><set-header |/></inbound></policies>');
    expect(items!.find((i) => i.label === 'exists-action')?.insert).toBe('exists-action="${1|override,skip,append,delete|}"');
  });

  it('works in child elements and unterminated tags', () => {
    expect(complete('<policies><inbound><choose><when |').labels).toContain('condition');
  });

  it('does nothing on the element name itself', () => {
    expect(complete('<policies><inbound><set-hea|der /></inbound></policies>').labels).toContain('set-header');
  });
});

describe('xmlCompletions: values', () => {
  it('offers enum values replacing the whole value', () => {
    const { items, src } = complete('<policies><inbound><set-header name="a" exists-action="sk|ip"/></inbound></policies>');
    const item = items!.find((i) => i.label === 'skip')!;
    expect(src.slice(item.range.start, item.range.end)).toBe('skip');
  });

  it('offers expression snippets where expressions are allowed', () => {
    expect(complete('<policies><inbound><set-variable name="a" value="|"/></inbound></policies>').labels).toEqual(['@(…)', '@{…}']);
    expect(complete('<policies><inbound><include-fragment fragment-id="|"/></inbound></policies>').labels).toEqual([]);
  });

  it('offers known fragment ids for include-fragment', () => {
    const r = complete('<policies><inbound><include-fragment fragment-id="|"/></inbound></policies>', { fragmentIds: ['rate-limit', 'auth'] });
    expect(r.labels).toEqual(['rate-limit', 'auth']);
  });

  it('defers to C# inside expressions', () => {
    expect(complete('<policies><inbound><set-variable name="a" value="@(context.|)"/></inbound></policies>').items).toBeUndefined();
  });
});

describe('xmlCompletions: named values and text', () => {
  it('completes named values anywhere, adding the closing braces when missing', () => {
    const open = complete('<a x="{{ten|"/>', { namedValues: ['tenant-id', 'api-key'] });
    expect(open.items!.map((i) => i.insert)).toEqual(['tenant-id}}', 'api-key}}']);
    expect(open.src.slice(open.items![0].range.start, open.items![0].range.end)).toBe('ten');
    const closed = complete('<a>@("{{|}}")</a>', { namedValues: ['k'] });
    expect(closed.items!.map((i) => i.insert)).toEqual(['k']);
  });

  it('offers expression snippets after @ in expression-capable text', () => {
    expect(complete('<policies><inbound><set-body>@|</set-body></inbound></policies>').labels).toEqual(['@(…)', '@{…}']);
    expect(complete('<policies><inbound><base>@|</base></inbound></policies>').items).toBeUndefined();
  });
});

describe('xmlCompletions: variable names', () => {
  const variables = [{ name: 'sig-key', detail: '@in of signing (required)', sortText: '00000' }];
  const names = (text: string) => {
    const offset = text.indexOf('|');
    const src = text.slice(0, offset) + text.slice(offset + 1);
    return (xmlCompletions(parse(src), offset, { catalog, variables }) ?? []).filter((i) => i.kind === 'variable').map((i) => i.label);
  };

  it("offers them in set-variable's name and any *-variable-name attribute", () => {
    expect(names('<policies><inbound><set-variable name="|" value="1" /></inbound></policies>')).toEqual(['sig-key']);
    expect(names('<policies><inbound><send-request response-variable-name="|" /></inbound></policies>')).toEqual(['sig-key']);
  });

  it('and nowhere else', () => {
    expect(names('<policies><inbound><set-variable name="x" value="|" /></inbound></policies>')).toEqual([]);
    expect(names('<policies><inbound><set-header name="|" /></inbound></policies>')).toEqual([]);
  });
});
