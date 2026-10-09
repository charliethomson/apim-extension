import { describe, expect, it } from 'vitest';
import { classifyShadowLocation, isRestorePending, LineIndex, mapDiagnostics, type LspDiagnostic } from '../../src/csharp/mapping';
import { generateShadow } from '../../src/csharp/shadow';
import { parse } from '../../src/parser/scanner';

describe('LineIndex', () => {
  const idx = new LineIndex('ab\ncde\n\nf');

  it('round-trips offsets and positions', () => {
    for (let o = 0; o <= 9; o++) expect(idx.offsetAt(idx.positionAt(o))).toBe(o);
    expect(idx.positionAt(4)).toEqual({ line: 1, character: 1 });
  });

  it('counts every line break the C# server does', () => {
    const idx2 = new LineIndex('a\rb\nc\r\nd\u2028e\u0085f');
    expect([1, 2, 3, 4, 5].map((line) => idx2.offsetAt({ line, character: 0 }))).toEqual([2, 4, 7, 9, 11]);
    expect(idx2.positionAt(7)).toEqual({ line: 3, character: 0 });
    expect(idx2.offsetAt({ line: 2, character: 9 })).toBe(5); // clamped before the CRLF
  });

  it('clamps out-of-range positions', () => {
    expect(idx.offsetAt({ line: 0, character: 99 })).toBe(2);
    expect(idx.offsetAt({ line: 99, character: 0 })).toBe(8);
    expect(idx.positionAt(-5)).toEqual({ line: 0, character: 0 });
  });
});

const src = '<policies><inbound><set-variable name="a" value="@(context.Request.Nope + &quot;x&quot;)" /></inbound></policies>';
const doc = parse(src);
const footer = 'namespace Stubs\n{\n    class X {}\n}\n';
const shadow = generateShadow(doc, undefined, { footer });
const index = new LineIndex(shadow.text);
const footerStart = shadow.text.lastIndexOf(footer);

function diag(needle: string, len: number, code: string, severity = 1): LspDiagnostic {
  const at = shadow.text.indexOf(needle);
  return { range: { start: index.positionAt(at), end: index.positionAt(at + len) }, severity, code, message: `${code} message` };
}

describe('mapDiagnostics', () => {
  it('maps compiler errors inside expressions back to the policy', () => {
    const [d] = mapDiagnostics(shadow, index, [diag('Nope', 4, 'CS1061')]);
    expect(src.slice(d.range.start, d.range.end)).toBe('Nope');
    expect(d.severity).toBe('error');
  });

  it('maps ranges over decoded entities onto the entities', () => {
    const [d] = mapDiagnostics(shadow, index, [diag('"x"', 3, 'CS0019', 2)]);
    expect(src.slice(d.range.start, d.range.end)).toBe('&quot;x&quot;');
    expect(d.severity).toBe('warning');
  });

  it('drops scaffolding, analyzer, hint and ignored diagnostics', () => {
    expect(
      mapDiagnostics(shadow, index, [
        diag('static class', 6, 'CS0001'),
        diag('Nope', 4, 'IDE0005'),
        diag('Nope', 4, 'CS1061', 4),
        diag('Nope', 4, 'CS8321'),
        { ...diag('Nope', 4, 'CS1061'), code: { value: 'CS1061' } },
      ]).map((d) => d.code),
    ).toEqual(['CS1061']);
  });

  it('puts errors on a generated method header onto the expression start', () => {
    const blockSrc = '<a>@{ if (x) { return 1; } }</a>';
    const block = generateShadow(parse(blockSrc), undefined);
    const idx = new LineIndex(block.text);
    const at = block.text.indexOf('__E0');
    const [d] = mapDiagnostics(block, idx, [{ range: { start: idx.positionAt(at), end: idx.positionAt(at + 4) }, severity: 1, code: 'CS0161', message: 'not all code paths return a value' }]);
    expect(blockSrc.slice(d.range.start, d.range.end)).toBe('@{');
    expect(d.code).toBe('CS0161');
  });

  it('recognises restore-pending errors', () => {
    expect(isRestorePending({ code: 'CS0246', message: "The type or namespace name 'JObject' could not be found", range: { start: 0, end: 0 }, severity: 'error' })).toBe(true);
    expect(isRestorePending({ code: 'CS1061', message: 'JObject has no Nope', range: { start: 0, end: 0 }, severity: 'error' })).toBe(false);
  });
});

describe('classifyShadowLocation', () => {
  it('maps expression positions to the policy', () => {
    const at = shadow.text.indexOf('context.Request') + 'context.'.length;
    const t = classifyShadowLocation(shadow, index, footerStart, index.positionAt(at));
    expect(t.kind === 'policy' && src.slice(t.range.start, t.range.start + 7)).toBe('Request');
  });

  it('maps footer positions to stub file lines', () => {
    const at = shadow.text.indexOf('class X');
    expect(classifyShadowLocation(shadow, index, footerStart, index.positionAt(at))).toEqual({ kind: 'stubs', line: 2, character: 4 });
  });

  it('returns none for scaffolding', () => {
    expect(classifyShadowLocation(shadow, index, footerStart, { line: 0, character: 0 }).kind).toBe('none');
  });
});
