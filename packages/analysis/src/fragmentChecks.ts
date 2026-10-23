/**
 * Everything the editor reports about fragment headers in one document, and what each include's
 * inlay hint says, from the document and what its includes declare. The editor gathers the
 * includes (from the workspace and the instance) and turns the results into its own diagnostics
 * and hints.
 */

import type { OffsetRange } from '@apim-policy/core';
import type { Document } from '@apim-policy/document';
import { checkFragmentHeader, checkIncludes, checkInternalUse, type FragmentDoc, type FragmentProblem, type FragmentVariable, type IncludedFragment } from './fragmentDoc';
import type { OuterSet } from './scopes';
import { outputsNotAlwaysSet, unguardedReads } from './variableSafety';
import type { PolicySummary } from './variables';

/** What a document's includes declare and set, by fragment id. */
export interface Includes {
  /** The included fragment's header, when it has one. */
  header(id: string): FragmentDoc | undefined;
  /** What it hands its caller: its @outs, or everything it sets when undocumented. */
  sets(id: string): readonly string[] | undefined;
  /** Its header with everything it sets, for the internal-use checks. */
  internals(id: string): IncludedFragment | undefined;
}

export type Level = 'warning' | 'information';

export interface FragmentDiagnostic {
  range: OffsetRange;
  message: string;
  severity: Level;
  code: FragmentProblem['code'] | 'unguarded-variable';
  /** Shown faded, as code that does nothing. */
  unnecessary?: boolean;
}

export interface FragmentCheckOptions {
  /** `apimPolicy.lint.missingInput`: how a required input nothing sets is reported. */
  missingInput: Level | 'off';
  /** `apimPolicy.lint.unguardedVariableAccess`: undefined when off. */
  unguarded?: Level;
}

/** Variables set before each point: the document's own, and what broader scopes set. */
function setBefore(summary: PolicySummary, outer: readonly OuterSet[]) {
  return [...summary.variables, ...outer.map((o) => ({ name: o.name, range: { start: o.at, end: o.at } }))];
}

/**
 * The header and include diagnostics for `doc`: a header that disagrees with its fragment, outputs
 * not set on every path, a caller reading an include's internals, inputs an include leaves unset,
 * and (when on) reads of variables nothing guarantees are set. `outer` is what broader scopes set.
 */
export function fragmentDiagnostics(doc: Document, summary: PolicySummary, includes: Includes, outer: readonly OuterSet[], options: FragmentCheckOptions): FragmentDiagnostic[] {
  const problems: FragmentProblem[] = [];
  if (summary.header) {
    problems.push(...checkFragmentHeader(summary.header, summary.variables, summary.reads));
    for (const v of outputsNotAlwaysSet(doc, summary.header, (id) => includes.sets(id))) {
      problems.push({
        range: v.range,
        severity: 'warning',
        code: 'fragment-out-maybe-unset',
        variable: v.name,
        message: `'${v.name}' isn't set on every path through this fragment, so after the include a caller may read whatever it held before. Set it at the start, before the steps that set it for real.`,
      });
    }
  }
  // A caller reading an included fragment's internals, or having its own variable overwritten by one.
  if (summary.includeSites.length) problems.push(...checkInternalUse(summary.includeSites, summary.variables, summary.reads, (id) => includes.internals(id)));
  problems.push(...checkIncludes(summary.includeSites, setBefore(summary, outer), summary.header?.inputs.map((v) => v.name) ?? [], (id) => includes.header(id)));
  const out: FragmentDiagnostic[] = problems
    .filter((p) => p.code !== 'fragment-in-unset' || options.missingInput !== 'off')
    .map((p) => ({
      range: p.range,
      message: p.message,
      // A missing required input is information in the model (a broader scope may set it); the setting decides here.
      severity: p.code === 'fragment-in-unset' ? (options.missingInput === 'warning' ? 'warning' : 'information') : p.severity,
      code: p.code,
      ...(p.code === 'fragment-in-unused' ? { unnecessary: true } : {}),
    }));
  if (options.unguarded) {
    for (const r of unguardedReads(doc, summary.header, (id) => includes.sets(id), outer)) {
      out.push({
        range: r.range,
        message: `context.Variables["${r.name}"] throws if '${r.name}' isn't set, and nothing earlier guarantees it is. Use GetValueOrDefault, or check ContainsKey first.`,
        severity: options.unguarded,
        code: 'unguarded-variable',
      });
    }
  }
  return out;
}

/** How many variables a hint lists per side before "+N". */
const HINT_NAMES = 6;

/** One piece of an include's hint; one that names a variable can show its tag and lead to the fragment. */
export interface HintPart {
  text: string;
  variable?: { kind: 'in' | 'out'; v: FragmentVariable };
}

/**
 * The hint after each include of a documented fragment: the required inputs nothing sets before
 * it, then what the fragment takes and sets. `at` is where it goes, the end of the include.
 */
export function includeHints(summary: PolicySummary, header: (id: string) => FragmentDoc | undefined, outer: readonly OuterSet[]): { at: number; id: string; parts: HintPart[] }[] {
  const missing = new Map(checkIncludes(summary.includeSites, setBefore(summary, outer), summary.header?.inputs.map((v) => v.name) ?? [], header).map((p) => [p.range.start, p.missing ?? []]));
  const out: { at: number; id: string; parts: HintPart[] }[] = [];
  for (const site of summary.includeSites) {
    const h = header(site.id);
    if (!h) continue;
    const absent = missing.get(site.range.start) ?? [];
    const parts: HintPart[] = [...(absent.length ? [{ text: `missing: ${absent.join(', ')} · ` }] : []), ...side('in', h.inputs), ...side('out', h.outputs, h.inputs.length > 0)];
    if (parts.length) out.push({ at: site.end, id: site.id, parts });
  }
  return out;
}

/** One side of a hint: `in: a, b?`, each name its own part. */
function side(kind: 'in' | 'out', vars: readonly FragmentVariable[], separated = false): HintPart[] {
  if (!vars.length) return [];
  const parts: HintPart[] = [{ text: `${separated ? ' · ' : ''}${kind}: ` }];
  vars.slice(0, HINT_NAMES).forEach((v, i) => parts.push({ text: `${i ? ', ' : ''}${v.name}${v.optional ? '?' : ''}`, variable: { kind, v } }));
  if (vars.length > HINT_NAMES) parts.push({ text: `, +${vars.length - HINT_NAMES}` });
  return parts;
}
