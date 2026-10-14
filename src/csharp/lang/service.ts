/**
 * The built-in C# engine's editor features, over plain code strings: completion, hover,
 * signature help, go-to-definition and diagnostics for one policy expression at a time. Nothing
 * here knows about VS Code or the policy document; callers map offsets in and out.
 */

import { bind, Binder, type BindResult, type BoundSymbol, type Candidate, type CompletionSite, type Reference } from './binder';
import { offsetContext, PREDEFINED_TYPES } from './lexer';
import { TypeModel, type Location, type MemberDef, type RawModel, type Subst, type Type, type TypeDef } from './model';
import { parse, type Parsed } from './parser';
import { readStubs } from './stubs';
import type { Span } from './syntax';

export type CodeKind = 'expr' | 'block';

export type EntryKind = 'method' | 'property' | 'field' | 'constant' | 'enumMember' | 'class' | 'interface' | 'struct' | 'enum' | 'delegate' | 'namespace' | 'local' | 'parameter' | 'keyword';

export interface CompletionEntry {
  label: string;
  kind: EntryKind;
  detail?: string;
  documentation?: string;
  /** Plain text to insert, when it differs from the label. */
  insertText?: string;
  sortText: string;
}

export interface CompletionResult {
  entries: CompletionEntry[];
  /** Range of the word being completed, in code offsets. */
  span: Span;
}

export interface HoverResult {
  span: Span;
  /** C# signature line, shown as a code block. */
  signature: string;
  documentation?: string;
}

export interface SignatureInfo {
  label: string;
  /** Parameter label ranges inside `label`. */
  parameters: { label: [number, number]; name: string }[];
  documentation?: string;
}

export interface SignatureResult {
  signatures: SignatureInfo[];
  activeSignature: number;
  activeParameter: number;
}

export type DefinitionResult = { kind: 'local'; span: Span } | { kind: 'stub'; location: Location };

export interface EngineDiagnostic extends Span {
  message: string;
}

/** Hides what policy expressions may not use from completion. */
export interface UsageFilter {
  type(def: TypeDef): boolean;
  member(def: TypeDef, member: MemberDef): boolean;
}

const ALLOW_ALL: UsageFilter = { type: () => true, member: () => true };

/** Stands in for a missing identifier at the cursor, so `a.|` parses as a member access. */
const CURSOR = '__apim_cursor__';

const EXPRESSION_KEYWORDS = ['true', 'false', 'null', 'new', 'typeof', 'default', 'nameof', 'checked', 'unchecked'];
const STATEMENT_KEYWORDS = ['if', 'else', 'return', 'var', 'foreach', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'try', 'catch', 'finally', 'throw', 'using', 'const'];

export class CSharpEngine {
  private readonly cache = new Map<string, { parsed: Parsed; bound: BindResult }>();

  constructor(
    readonly model: TypeModel,
    private readonly filter: UsageFilter = ALLOW_ALL,
  ) {}

  static load(raw: RawModel, stubSource: string, filter?: UsageFilter): CSharpEngine {
    return new CSharpEngine(new TypeModel(raw, readStubs(stubSource, raw)), filter);
  }

  /** Stub type names (for the allowlist, which always allows them). */
  stubTypeNames(): string[] {
    return [...this.model.defs.values()].filter((d) => d.origin === 'stub').map((d) => d.name);
  }

  private analyze(code: string, kind: CodeKind): { parsed: Parsed; bound: BindResult } {
    const key = `${kind}\u0000${code}`;
    let hit = this.cache.get(key);
    if (!hit) {
      const parsed = parse(code, kind);
      hit = { parsed, bound: bind(this.model, parsed) };
      if (this.cache.size > 200) this.cache.clear();
      this.cache.set(key, hit);
    }
    return hit;
  }

  diagnostics(code: string, kind: CodeKind): EngineDiagnostic[] {
    const { parsed, bound } = this.analyze(code, kind);
    return [...parsed.errors, ...bound.diagnostics].sort((a, b) => a.start - b.start);
  }

  references(code: string, kind: CodeKind): Reference[] {
    return this.analyze(code, kind).bound.references;
  }

  /** Type of an `@(...)` expression's value, or of what a block returns. */
  resultType(code: string, kind: CodeKind): string {
    return this.model.display(this.analyze(code, kind).bound.resultType);
  }

  // ---- completion -------------------------------------------------------------------------------

  complete(code: string, kind: CodeKind, offset: number): CompletionResult | undefined {
    if (offsetContext(code, offset) !== 'code') return undefined;
    const atWord = offset > 0 && /[\p{L}\p{Nd}_]/u.test(code[offset - 1]);
    const text = atWord ? code : code.slice(0, offset) + CURSOR + code.slice(offset);
    const bound = bind(this.model, parse(text, kind), offset);
    const site = bound.completion;
    if (!site) return undefined;
    const span = atWord ? site.span : { start: offset, end: offset };
    // A completion site past the cursor's word belongs to something else.
    if (span.start > offset || span.end < offset) return undefined;
    return { entries: this.entries(site, kind), span };
  }

  private entries(site: CompletionSite, kind: CodeKind): CompletionEntry[] {
    const m = this.model;
    switch (site.kind) {
      case 'member': {
        const r = site.receiver;
        if (r.kind === 'namespace') return this.namespaceEntries(r.name);
        if (r.kind === 'methods') return [];
        if (r.kind === 'type') return [...this.memberEntries(r.type, true), ...this.nestedTypeEntries(r.type)];
        let t = r.type;
        if (site.conditional) t = m.underlying(t);
        if (t.k === 'anon') return t.props.map((p) => ({ label: p.name, kind: 'property', detail: `${m.display(p.type)} ${p.name}`, sortText: `1${p.name}` }));
        if (t.k === 'tuple') return t.elements.map((e, i) => ({ label: e.name ?? `Item${i + 1}`, kind: 'field', detail: m.display(e.type), sortText: `1${i}` }));
        return this.memberEntries(t, false);
      }
      case 'initializer': {
        if (site.type.k !== 'named') return [];
        return this.memberEntries(site.type, false).filter((e) => (e.kind === 'property' || e.kind === 'field') && !site.assigned.includes(e.label) && this.isWritable(site.type, e.label));
      }
      case 'name': {
        const out: CompletionEntry[] = [];
        if (!site.typeOnly) {
          for (const l of site.locals) {
            out.push({ label: l.name, kind: l.kind === 'local' ? 'local' : 'parameter', detail: `${m.display(l.type)} ${l.name}`, documentation: l.kind === 'context' ? docOf(l.type) : undefined, sortText: `0${l.name}` });
          }
          for (const k of EXPRESSION_KEYWORDS) out.push({ label: k, kind: 'keyword', sortText: `3${k}` });
          if (kind === 'block') for (const k of STATEMENT_KEYWORDS) out.push({ label: k, kind: 'keyword', sortText: `3${k}` });
        }
        for (const k of Object.keys(PREDEFINED_TYPES)) if (k !== 'void') out.push({ label: k, kind: 'keyword', sortText: `3${k}` });
        for (const def of m.implicitTypes()) {
          if (!this.filter.type(def) && def.origin !== 'stub') continue;
          out.push(this.typeEntry(def));
        }
        for (const ns of m.childNamespaces('')) out.push({ label: ns, kind: 'namespace', sortText: `4${ns}` });
        return dedupe(out);
      }
    }
  }

  private isWritable(t: Type, name: string): boolean {
    const found = this.model.members(t, name)[0]?.member;
    return !!found && (found.kind === 'field' || found.writable === true);
  }

  private namespaceEntries(ns: string): CompletionEntry[] {
    const out: CompletionEntry[] = this.model.childNamespaces(ns).map((n) => ({ label: n, kind: 'namespace', sortText: `4${n}` }));
    for (const def of this.model.typesIn(ns)) if (this.filter.type(def) || def.origin === 'stub') out.push(this.typeEntry(def));
    return out;
  }

  private nestedTypeEntries(t: Type): CompletionEntry[] {
    if (t.k !== 'named') return [];
    const prefix = `${t.def.key}+`;
    return [...this.model.defs.values()].filter((d) => d.key.startsWith(prefix) && !d.key.slice(prefix.length).includes('+') && this.filter.type(d)).map((d) => this.typeEntry(d));
  }

  private typeEntry(def: TypeDef): CompletionEntry {
    return { label: def.name, kind: def.kind, detail: `${def.kind} ${this.model.fullName(def)}`, documentation: def.doc, sortText: `2${def.name}` };
  }

  /** Members of `t`, one entry per name, plus applicable extension methods for instances. */
  private memberEntries(t: Type, statics: boolean): CompletionEntry[] {
    const m = this.model;
    if (t.k === 'unknown' || t.k === 'null') return [];
    const groups = new Map<string, { member: MemberDef; subst: Subst; extension?: boolean }[]>();
    const add = (c: { member: MemberDef; subst: Subst; extension?: boolean }) => {
      const list = groups.get(c.member.name) ?? [];
      list.push(c);
      groups.set(c.member.name, list);
    };
    for (const x of m.members(t)) {
      const mem = x.member;
      if (mem.kind === 'ctor' || mem.kind === 'operator' || mem.kind === 'indexer') continue;
      if (mem.isStatic !== statics) continue;
      if (!this.filter.member(mem.declaring, mem)) continue;
      add(x);
    }
    if (!statics) {
      for (const c of new Binder(m).extensionsFor(t)) {
        if (!this.filter.member(c.member.declaring, c.member)) continue;
        // An instance member of the same name hides the extension in the list.
        if (groups.get(c.member.name)?.some((x) => !x.extension && x.member.kind !== 'method')) continue;
        add(c);
      }
    }
    const out: CompletionEntry[] = [];
    for (const [name, list] of groups) {
      const first = list[0];
      const mem = first.member;
      const overloads = list.length > 1 ? ` (+${list.length - 1} overload${list.length > 2 ? 's' : ''})` : '';
      out.push({
        label: name,
        kind: entryKind(mem),
        detail: this.signatureOf(first, first.subst) + overloads,
        documentation: mem.doc,
        sortText: `1${name}`,
      });
    }
    return out;
  }

  // ---- hover --------------------------------------------------------------------------------------

  hover(code: string, kind: CodeKind, offset: number): HoverResult | undefined {
    if (offsetContext(code, offset) !== 'code') return undefined;
    const bound = bind(this.model, parse(code, kind), offset);
    const h = bound.hover;
    if (!h) return undefined;
    return { span: h.span, ...this.describe(h.symbol) };
  }

  private describe(symbol: BoundSymbol): { signature: string; documentation?: string } {
    const m = this.model;
    switch (symbol.kind) {
      case 'local': {
        const l = symbol.local;
        const label = l.kind === 'local' ? '(local variable)' : '(parameter)';
        return { signature: `${label} ${m.display(l.type)} ${l.name}`, documentation: l.kind === 'context' ? docOf(l.type) : undefined };
      }
      case 'namespace':
        return { signature: `namespace ${symbol.name}` };
      case 'type': {
        const t = symbol.type;
        if (t.k !== 'named') return { signature: m.display(t) };
        const def = t.def;
        const kw = PREDEFINED_TYPES[m.display(t)] ? `${def.kind} ${m.fullName(def)}` : `${def.kind} ${def.namespace}.${m.display(t)}`;
        return { signature: kw, documentation: def.doc };
      }
      case 'member': {
        const c = { member: symbol.member, subst: symbol.subst, extension: symbol.member.isExtension && !!symbol.receiver };
        return { signature: this.signatureOf(c, symbol.subst), documentation: symbol.member.doc };
      }
    }
  }

  /** `string string.Substring(int startIndex, int length)`, `IRequest IProxyRequestContext.Request { get; }`. */
  private signatureOf(c: Candidate, subst: Subst): string {
    return this.signatureParts(c, subst).label;
  }

  private signatureParts(c: Candidate, subst: Subst): SignatureInfo {
    const m = this.model;
    const mem = c.member;
    const declaring = mem.declaring;
    const owner = m.display({ k: 'named', def: declaring, args: declaring.typeParams.map((p) => subst.get(p) ?? { k: 'param', name: p }) });
    const type = m.display(m.resolve(mem.type, subst));
    switch (mem.kind) {
      case 'property':
        return { label: `${type} ${owner}.${mem.name} { get;${mem.writable ? ' set;' : ''} }`, parameters: [] };
      case 'field':
      case 'const':
        return { label: `${mem.kind === 'const' ? 'const ' : ''}${type} ${owner}.${mem.name}`, parameters: [] };
      case 'enumMember':
        return { label: `${owner}.${mem.name}`, parameters: [] };
      default: {
        const ext = mem.isExtension && c.extension;
        const shownParams = ext ? mem.params.slice(1) : mem.params;
        const receiver = ext ? m.display(m.resolve(mem.params[0].type, subst)) : owner;
        const typeArgs = mem.typeParams.length ? `<${mem.typeParams.map((p) => m.display(subst.get(p) ?? { k: 'param', name: p })).join(', ')}>` : '';
        let label: string;
        if (mem.kind === 'ctor') label = `${owner}(`;
        else if (mem.kind === 'indexer') label = `${type} ${owner}[`;
        else label = `${ext ? '(extension) ' : ''}${type} ${receiver}.${mem.name}${typeArgs}(`;
        const parameters: SignatureInfo['parameters'] = [];
        shownParams.forEach((p, i) => {
          if (i > 0) label += ', ';
          const mod = p.modifier && p.modifier !== 'this' ? `${p.modifier} ` : '';
          const text = `${mod}${m.display(m.resolve(p.type, subst))} ${p.name}${p.defaultText !== undefined ? ` = ${p.defaultText}` : ''}`;
          parameters.push({ label: [label.length, label.length + text.length], name: p.name });
          label += text;
        });
        label += mem.kind === 'indexer' ? ']' : ')';
        return { label, parameters, documentation: mem.doc };
      }
    }
  }

  // ---- signature help -----------------------------------------------------------------------------

  signatureHelp(code: string, kind: CodeKind, offset: number): SignatureResult | undefined {
    if (offsetContext(code, offset) !== 'code') return undefined;
    // An empty argument slot (`f(a, |)`) parses better with something in it.
    const text = /[(,]\s*$/.test(code.slice(0, offset)) ? code.slice(0, offset) + CURSOR + code.slice(offset) : code;
    const sig = bind(this.model, parse(text, kind), offset).signature;
    if (!sig || sig.candidates.length === 0) return undefined;
    const signatures = sig.candidates.map((c) => this.signatureParts(c, c.subst));
    const active = sig.active ?? 0;
    const chosen = sig.candidates[active];
    let param = sig.argIndex;
    const shown = chosen.member.isExtension && chosen.extension ? chosen.member.params.slice(1) : chosen.member.params;
    if (sig.argName) {
      const named = shown.findIndex((p) => p.name === sig.argName);
      if (named >= 0) param = named;
    }
    if (param >= shown.length && shown[shown.length - 1]?.modifier === 'params') param = shown.length - 1;
    return { signatures, activeSignature: active, activeParameter: param };
  }

  // ---- definition ---------------------------------------------------------------------------------

  definition(code: string, kind: CodeKind, offset: number): DefinitionResult | undefined {
    const h = bind(this.model, parse(code, kind), offset).hover;
    if (!h) return undefined;
    const s = h.symbol;
    if (s.kind === 'local') return s.local.decl ? { kind: 'local', span: s.local.decl } : undefined;
    if (s.kind === 'member' && s.member.location) return { kind: 'stub', location: s.member.location };
    if (s.kind === 'member' && s.member.declaring.location) return { kind: 'stub', location: s.member.declaring.location };
    if (s.kind === 'type' && s.type.k === 'named' && s.type.def.location) return { kind: 'stub', location: s.type.def.location };
    return undefined;
  }
}

function entryKind(m: MemberDef): EntryKind {
  switch (m.kind) {
    case 'method':
      return 'method';
    case 'property':
      return 'property';
    case 'const':
      return 'constant';
    case 'enumMember':
      return 'enumMember';
    default:
      return 'field';
  }
}

function docOf(t: Type): string | undefined {
  return t.k === 'named' ? t.def.doc : undefined;
}

function dedupe(entries: CompletionEntry[]): CompletionEntry[] {
  const seen = new Set<string>();
  return entries.filter((e) => {
    const k = `${e.label}\u0000${e.kind}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

