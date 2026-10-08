/**
 * Line/column handling for the shadow file and mapping of C# server results back into the
 * policy document. Pure, so it's testable without VS Code.
 */

import type { OffsetRange } from '../sourceMap';
import { methodAt, type Shadow } from './shadow';

export interface LinePos {
  line: number;
  character: number;
}

export class LineIndex {
  private readonly starts: number[] = [0];

  constructor(private readonly text: string) {
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) this.starts.push(i + 1);
  }

  offsetAt(p: LinePos): number {
    const line = Math.min(Math.max(p.line, 0), this.starts.length - 1);
    const lineEnd = line + 1 < this.starts.length ? this.starts[line + 1] - 1 : this.text.length;
    return Math.min(this.starts[line] + Math.max(p.character, 0), lineEnd);
  }

  positionAt(offset: number): LinePos {
    const o = Math.min(Math.max(offset, 0), this.text.length);
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= o) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo, character: o - this.starts[lo] };
  }
}

/** An LSP diagnostic as returned by textDocument/diagnostic. */
export interface LspDiagnostic {
  range: { start: LinePos; end: LinePos };
  severity?: number;
  code?: string | number | { value: string | number };
  message: string;
}

export interface MappedDiagnostic {
  range: OffsetRange;
  message: string;
  code: string;
  severity: 'error' | 'warning';
}

/** Codes that come from our scaffolding rather than the user's code. */
const IGNORED_CODES = new Set(['CS8321', 'CS0162', 'CS1591', 'CS8019']);

/**
 * Keeps compiler errors and warnings (CS codes) that fall inside an expression and maps them to
 * document offsets. Analyzer suggestions (IDE codes) and hints are dropped.
 */
export function mapDiagnostics(shadow: Shadow, index: LineIndex, diags: readonly LspDiagnostic[]): MappedDiagnostic[] {
  const out: MappedDiagnostic[] = [];
  for (const d of diags) {
    const code = String(typeof d.code === 'object' && d.code !== null ? d.code.value : (d.code ?? ''));
    if (!code.startsWith('CS') || IGNORED_CODES.has(code)) continue;
    if (d.severity !== undefined && d.severity > 2) continue;
    const start = index.offsetAt(d.range.start);
    const end = index.offsetAt(d.range.end);
    const method = methodAt(shadow, start);
    if (!method) continue;
    const clamped = { start: Math.max(start, method.codeRange.start), end: Math.min(Math.max(end, start), method.codeRange.end) };
    const range = shadow.map.rangeToSource(clamped);
    if (!range) continue;
    out.push({ range, message: d.message, code, severity: d.severity === 2 ? 'warning' : 'error' });
  }
  return out;
}

/** True for errors that only mean the shadow's package references haven't been restored yet. */
export function isRestorePending(d: MappedDiagnostic): boolean {
  return (d.code === 'CS0246' || d.code === 'CS0234' || d.code === 'CS0103') && /\b(Newtonsoft|JObject|JToken|JArray|JValue|JProperty|JsonConvert)\b/.test(d.message);
}

/**
 * Where a location in the shadow file points: back into the policy (inside an expression), into
 * the bundled stubs (inside the appended footer), or nowhere useful.
 */
export type ShadowTarget = { kind: 'policy'; range: OffsetRange } | { kind: 'stubs'; line: number; character: number } | { kind: 'none' };

export function classifyShadowLocation(shadow: Shadow, index: LineIndex, footerStart: number, pos: LinePos): ShadowTarget {
  const offset = index.offsetAt(pos);
  if (methodAt(shadow, offset)) {
    const src = shadow.map.toSource(offset);
    return src === undefined ? { kind: 'none' } : { kind: 'policy', range: { start: src, end: src } };
  }
  if (footerStart >= 0 && offset >= footerStart) {
    const footerLine = index.positionAt(footerStart).line;
    return { kind: 'stubs', line: pos.line - footerLine, character: pos.character };
  }
  return { kind: 'none' };
}
