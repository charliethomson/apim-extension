/**
 * The APIM allowlist lint: flags .NET types and members that policy expressions may not use.
 *
 * Syntactic and best-effort. It finds type references by shape (qualified names, `new X`,
 * `typeof(X)`, casts, declarations, generic arguments, `is`/`as`, and `X.Member` static access)
 * and resolves simple names through APIM's implicit namespaces using an index of every public
 * BCL type name. A name only counts as a type when the index knows it and it isn't a local, so
 * ordinary variables never trip it. Members are only checked where the receiver is a type
 * written in the code (`DateTime.FromBinary`); the semantic pass covers the rest.
 */

import { KEYWORDS, significantTokens, type Token } from '../parser/csharpLexer';
import type { OffsetRange } from '../sourceMap';
import type { Reference } from './lang/binder';

export interface AllowlistData {
  /** Full type name (with `N arity for generics) → "*", allowed members, or { except }. */
  types: Record<string, '*' | string[] | { except: string[] }>;
  implicit: { types: string[]; members: string[] };
}

export interface BclIndex {
  /** Simple type name → namespaces that define it. */
  types: Record<string, string[]>;
  /** Restricted type full name → all of its public member names. */
  members: Record<string, string[]>;
}

export interface LintFinding {
  range: OffsetRange;
  message: string;
  kind: 'type' | 'member';
  /** Full name of the offending type or member. */
  name: string;
}

/** Namespaces APIM imports into every expression. */
export const APIM_NAMESPACES = [
  'System',
  'System.Collections.Generic',
  'System.IO',
  'System.Linq',
  'System.Net',
  'System.Security.Cryptography',
  'System.Security.Cryptography.X509Certificates',
  'System.Text',
  'System.Text.RegularExpressions',
  'System.Xml',
  'System.Xml.Linq',
  'Newtonsoft.Json',
  'Newtonsoft.Json.Linq',
];

/** C# keyword types and their System names; all allowed. */
const BUILTIN = new Set(['bool', 'byte', 'sbyte', 'char', 'decimal', 'double', 'float', 'int', 'uint', 'long', 'ulong', 'short', 'ushort', 'string', 'object', 'void', 'var', 'dynamic']);

export class Allowlist {
  private readonly allowed = new Map<string, '*' | string[] | { except: string[] }>();
  private readonly namespaces = new Set<string>();

  constructor(
    data: AllowlistData,
    private readonly bcl: BclIndex,
    /** Types our stubs define (context and helpers); always allowed. */
    private readonly stubTypes: ReadonlySet<string>,
  ) {
    for (const [name, rule] of Object.entries(data.types)) this.allowed.set(stripArity(name), rule);
    for (const t of data.implicit.types) this.allowed.set(t, '*');
    for (const nss of Object.values(bcl.types)) for (const ns of nss) addNamespaceAndParents(this.namespaces, ns);
    this.implicitMembers = new Set(data.implicit.members);
  }

  private readonly implicitMembers: Set<string>;



  isNamespace(name: string): boolean {
    return this.namespaces.has(name);
  }

  isStubType(name: string): boolean {
    return this.stubTypes.has(name);
  }

  /** Full names a simple type name can mean given APIM's implicit namespaces. */
  resolveSimple(name: string): string[] {
    return (this.bcl.types[name] ?? []).filter((ns) => APIM_NAMESPACES.includes(ns)).map((ns) => `${ns}.${name}`);
  }

  knowsType(fullName: string): boolean {
    const i = fullName.lastIndexOf('.');
    return i > 0 && (this.bcl.types[fullName.slice(i + 1)] ?? []).includes(fullName.slice(0, i));
  }

  /** Members every type has (ToString, Equals, …), which never make a type count as used. */
  isImplicitMember(member: string): boolean {
    return this.implicitMembers.has(member);
  }

  isTypeAllowed(fullName: string): boolean {
    return this.allowed.has(fullName);
  }

  /** undefined when the member is fine; otherwise the allowed member list for the message. */
  memberProblem(typeName: string, member: string): string[] | undefined {
    const rule = this.allowed.get(typeName);
    if (!rule || rule === '*' || this.implicitMembers.has(member)) return undefined;
    const all = this.bcl.members[typeName];
    if (all && !all.includes(member)) return undefined; // not a real member; the compiler reports it
    if (Array.isArray(rule)) return rule.includes(member) ? undefined : rule;
    return rule.except.some((e) => e === member || e.startsWith(`${member}(`)) ? (all ?? []).filter((m) => !rule.except.includes(m)) : undefined;
  }
}

function stripArity(name: string): string {
  return name.replace(/`\d+$/, '').replace(/\+/g, '.');
}

function addNamespaceAndParents(set: Set<string>, ns: string): void {
  const parts = ns.split('.');
  for (let i = 1; i <= parts.length; i++) set.add(parts.slice(0, i).join('.'));
}

interface Chain {
  /** Identifier tokens, in order. */
  parts: Token[];
  /** Index (in the significant token list) of the first and last identifier. */
  first: number;
  last: number;
}

/** Lints one expression's code. Ranges are in code coordinates. */
export function lintAllowedTypes(code: string, allow: Allowlist): LintFinding[] {
  const toks = significantTokens(code);
  const text = (t: Token | undefined) => (t ? code.slice(t.start, t.end) : '');
  const locals = collectLocals(code, toks);
  const findings: LintFinding[] = [];
  const seen = new Set<number>();

  const report = (f: LintFinding) => {
    if (seen.has(f.range.start)) return;
    seen.add(f.range.start);
    findings.push(f);
  };

  for (const chain of chains(code, toks)) {
    const names = chain.parts.map(text);
    if (names[0] === 'context' || locals.has(names[0]) || BUILTIN.has(names[0])) continue;
    if (names[0] === 'global' && text(toks[chain.first + 1]) === ':') continue; // handled via the :: form below
    const prev = text(toks[chain.first - 1]);
    if (prev === '.') continue; // a member of something else
    if (prev === ':' && text(toks[chain.first - 2]) === ':') continue; // global::X, handled below

    // Find where the type is: a namespace prefix then a type, or a simple name via the usings.
    let typeIdx = -1;
    let fullType: string | undefined;
    for (let k = names.length - 1; k >= 1; k--) {
      const ns = names.slice(0, k).join('.');
      if (allow.isNamespace(ns) && allow.knowsType(`${ns}.${names[k]}`)) {
        typeIdx = k;
        fullType = `${ns}.${names[k]}`;
        break;
      }
    }
    const typeContext = isTypePosition(code, toks, chain);
    if (fullType === undefined) {
      const candidates = allow.resolveSimple(names[0]);
      if (candidates.length === 0 || allow.isStubType(names[0])) continue;
      // A bare simple name only counts as a type in a type position or as a static receiver.
      if (!typeContext && names.length < 2) continue;
      typeIdx = 0;
      fullType = candidates.find((c) => allow.isTypeAllowed(c)) ?? candidates[0];
    }

    const typeTok = chain.parts[typeIdx];
    const typeRange = { start: chain.parts[0].start, end: typeTok.end };
    if (!allow.isTypeAllowed(fullType)) {
      report({
        range: typeRange,
        kind: 'type',
        name: fullType,
        message: `'${fullType}' isn't on the APIM policy expression allowlist.`,
      });
      continue;
    }

    // Static member access on a restricted type: Type.Member
    const memberTok = chain.parts[typeIdx + 1];
    if (memberTok) {
      const member = text(memberTok);
      const allowed = allow.memberProblem(fullType, member);
      if (allowed) report(memberFinding(fullType, member, memberTok, allowed));
    } else if (text(toks[chain.first - 1]) === 'new') {
      const allowed = allow.memberProblem(fullType, '(Constructor)');
      if (allowed) {
        report({ range: typeRange, kind: 'member', name: `${fullType}..ctor`, message: `APIM doesn't allow constructing '${shortName(fullType)}'.` });
      }
    }
  }

  // global::System.IO.File
  for (let i = 0; i + 2 < toks.length; i++) {
    if (text(toks[i]) !== 'global' || text(toks[i + 1]) !== ':' || text(toks[i + 2]) !== ':') continue;
    const parts: Token[] = [];
    for (let j = i + 3; j < toks.length && toks[j].kind === 'identifier'; j += 2) {
      parts.push(toks[j]);
      if (text(toks[j + 1]) !== '.') break;
    }
    const names = parts.map(text);
    for (let k = names.length - 1; k >= 1; k--) {
      const full = names.slice(0, k + 1).join('.');
      if (allow.knowsType(full)) {
        if (!allow.isTypeAllowed(full)) report({ range: { start: toks[i].start, end: parts[k].end }, kind: 'type', name: full, message: `'${full}' isn't on the APIM policy expression allowlist.` });
        break;
      }
    }
  }

  return findings.sort((a, b) => a.range.start - b.range.start);
}

/**
 * The semantic half of the lint, from what the built-in engine bound: every type written in the
 * code, and every member used on a restricted type, whatever the receiver's spelling.
 */
export function lintReferences(refs: readonly Reference[], allow: Allowlist): LintFinding[] {
  const out: LintFinding[] = [];
  for (const r of refs) {
    if (r.def.origin === 'stub') continue;
    const type = r.def.key.replace(/`\d+/g, '').replace(/\+/g, '.');
    if (!r.member) {
      if (!allow.isTypeAllowed(type)) out.push({ range: r.span, kind: 'type', name: type, message: `'${type}' isn't on the APIM policy expression allowlist.` });
      continue;
    }
    const member = r.member.kind === 'ctor' ? '(Constructor)' : r.member.kind === 'indexer' ? 'Item' : r.member.name;
    // The gateway also rejects a member of a type outside the allowlist when the type is only
    // inferred: `g.Key` on the IGrouping that GroupBy returns.
    // Reported once per expression, and not again when the type is written out too.
    if (!allow.isTypeAllowed(type) && !allow.isImplicitMember(member) && r.member.kind !== 'ctor') {
      if (!refs.some((o) => !o.member && o.def === r.def) && !out.some((f) => f.name === type)) out.push({ range: r.span, kind: 'type', name: type, message: `'${type}' isn't on the APIM policy expression allowlist ('${member}' is one of its members).` });
      continue;
    }
    const allowed = allow.memberProblem(type, member);
    if (!allowed) continue;
    if (member === '(Constructor)') out.push({ range: r.span, kind: 'member', name: `${type}..ctor`, message: `APIM doesn't allow constructing '${shortName(type)}'.` });
    else out.push(memberFinding(type, member, r.span, allowed));
  }
  return out.sort((a, b) => a.range.start - b.range.start);
}

function memberFinding(type: string, member: string, tok: OffsetRange, allowed: string[]): LintFinding {
  const list = allowed.filter((m) => m !== '(Constructor)');
  const shown = list.length > 8 ? `${list.slice(0, 8).join(', ')}, …` : list.join(', ');
  return {
    range: { start: tok.start, end: tok.end },
    kind: 'member',
    name: `${type}.${member}`,
    message: `APIM doesn't allow '${shortName(type)}.${member}'.${shown ? ` Allowed: ${shown}.` : ''}`,
  };
}

function shortName(full: string): string {
  return full.slice(full.lastIndexOf('.') + 1);
}


/** Maximal `a.b.c` identifier chains (skipping generic argument lists between parts). */
function* chains(code: string, toks: Token[]): Generator<Chain> {
  const text = (k: number) => (toks[k] ? code.slice(toks[k].start, toks[k].end) : '');
  for (let i = 0; i < toks.length; i++) {
    if (toks[i].kind !== 'identifier') continue;
    if (text(i - 1) === '.' && i >= 2 && (toks[i - 2].kind === 'identifier' || text(i - 2) === '>')) continue; // inside a chain
    const parts = [toks[i]];
    let last = i;
    let k = i + 1;
    for (;;) {
      if (text(k) === '<') {
        const close = genericClose(code, toks, k);
        if (close > 0 && text(close + 1) === '.') k = close + 1;
      }
      if (text(k) === '.' && toks[k + 1]?.kind === 'identifier') {
        parts.push(toks[k + 1]);
        last = k + 1;
        k += 2;
      } else break;
    }
    yield { parts, first: i, last };
  }
}

/** If toks[open] is '<' starting a generic argument list, the index of its '>' (or -1). */
export function genericClose(code: string, toks: Token[], open: number): number {
  let depth = 0;
  for (let k = open; k < toks.length; k++) {
    const t = code.slice(toks[k].start, toks[k].end);
    if (t === '<') depth++;
    else if (t === '>') {
      if (--depth === 0) return k;
    } else if (!(toks[k].kind === 'identifier' || (toks[k].kind === 'keyword' && BUILTIN.has(t)) || t === '.' || t === ',' || t === '[' || t === ']' || t === '?')) {
      return -1;
    }
  }
  return -1;
}

/** Whether a chain sits where only a type can: after new/is/as/typeof, in generic args, a cast, or a declaration. */
function isTypePosition(code: string, toks: Token[], chain: Chain): boolean {
  const text = (k: number) => (toks[k] ? code.slice(toks[k].start, toks[k].end) : '');
  const before = text(chain.first - 1);
  const after = text(chain.last + 1);
  if (before === 'new' || before === 'is' || before === 'as' || before === 'out' && toks[chain.last + 1]?.kind === 'identifier') return true;
  if (before === '(' && text(chain.first - 2) === 'typeof') return true;
  if (insideGenericArgs(code, toks, chain.first)) return true;
  // Cast: ( Type ) followed by something that starts an operand.
  if (before === '(' && after === ')') {
    const next = toks[chain.last + 2];
    const n = text(chain.last + 2);
    if (next && (next.kind === 'identifier' || next.kind === 'string' || next.kind === 'number' || next.kind === 'char' || n === '(' || (next.kind === 'keyword' && !['is', 'as'].includes(n)))) return true;
  }
  // Declaration: Type name [=;,)] or foreach (Type name in
  const next = toks[chain.last + 1];
  if (next?.kind === 'identifier' && ['=', ';', ',', ')', 'in'].includes(text(chain.last + 2))) return true;
  if (after === '<') {
    const close = genericClose(code, toks, chain.last + 1);
    if (close > 0 && toks[close + 1]?.kind === 'identifier') return true;
  }
  if (after === '[' && text(chain.last + 2) === ']' && toks[chain.last + 3]?.kind === 'identifier') return true;
  return false;
}

function insideGenericArgs(code: string, toks: Token[], idx: number): boolean {
  const text = (k: number) => (toks[k] ? code.slice(toks[k].start, toks[k].end) : '');
  for (let k = idx - 1; k >= 0; k--) {
    const t = text(k);
    if (t === '<' && toks[k - 1]?.kind === 'identifier') {
      const close = genericClose(code, toks, k);
      return close > idx;
    }
    if (!(toks[k].kind === 'identifier' || t === '.' || t === ',' || t === '<' || t === '>' || t === '[' || t === ']' || t === '?' || (toks[k].kind === 'keyword' && BUILTIN.has(t)))) return false;
  }
  return false;
}

/** Names declared in the code: locals, lambda parameters, foreach/out/catch variables. */
function collectLocals(code: string, toks: Token[]): Set<string> {
  const text = (k: number) => (toks[k] ? code.slice(toks[k].start, toks[k].end) : '');
  const out = new Set<string>();
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.kind !== 'identifier') continue;
    const name = text(k);
    const next = text(k + 1);
    const prev = toks[k - 1];
    const prevText = text(k - 1);
    // x => ...
    if (next === '=' && text(k + 2) === '>') out.add(name);
    // (a, b) => ...
    if ((prevText === '(' || prevText === ',') && (next === ',' || next === ')')) {
      let j = k;
      while (j < toks.length && text(j) !== ')') j++;
      if (text(j + 1) === '=' && text(j + 2) === '>') out.add(name);
    }
    // Type name = / ; / in / ) / ,  (declarations, foreach, out vars, catch, typed lambda params)
    if (prev && (prev.kind === 'identifier' || (prev.kind === 'keyword' && BUILTIN.has(prevText)) || prevText === '>' || prevText === ']' || prevText === '?') && ['=', ';', 'in', ')', ','].includes(next) && !KEYWORDS.has(name)) {
      if (text(k + 2) !== '>' || next !== '=') out.add(name);
    }
  }
  return out;
}
