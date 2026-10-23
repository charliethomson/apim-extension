/**
 * The type universe the engine binds against: the BCL and Newtonsoft surface from
 * assets/csharp-model.json plus the APIM stubs, with the operations the binder needs on top
 * (type references, substitution, member lookup, conversions and display).
 */

import type { JsonShape } from './json';
import { PREDEFINED_TYPES } from './lexer';

// ---- definitions ------------------------------------------------------------------------------

/** A type reference as written in a signature, before substitution. */
export type TypeRef = { kind: 'named'; key: string; args: TypeRef[] } | { kind: 'array'; element: TypeRef; rank: number } | { kind: 'param'; name: string };

export interface ParamDef {
  name: string;
  type: TypeRef;
  modifier?: 'out' | 'ref' | 'in' | 'params' | 'this';
  /** Default value as source text, when the parameter is optional. */
  defaultText?: string;
}

export type MemberKind = 'method' | 'property' | 'field' | 'const' | 'enumMember' | 'ctor' | 'indexer' | 'operator';

export interface Location {
  line: number;
  character: number;
}

export interface MemberDef {
  name: string;
  kind: MemberKind;
  isStatic: boolean;
  isExtension: boolean;
  typeParams: string[];
  /** Constraints per type parameter: base types and interfaces, or `class`/`struct`. */
  constraints?: (TypeRef | 'class' | 'struct')[][];
  type: TypeRef;
  params: ParamDef[];
  doc?: string;
  writable?: boolean;
  declaring: TypeDef;
  /** Where a stub member is declared in assets/ApimContext.cs. */
  location?: Location;
  /** .NET Framework 4.8, which APIM's expression types come from, doesn't have this member (or overload). */
  notInFramework?: boolean;
}

export type TypeKind = 'class' | 'struct' | 'interface' | 'enum' | 'delegate';

export interface TypeDef {
  /** Metadata name: `System.Collections.Generic.List`1`, nested types with `+`. */
  key: string;
  /** Simple name without arity. */
  name: string;
  namespace: string;
  kind: TypeKind;
  typeParams: string[];
  variance: ('in' | 'out' | '')[];
  isStatic: boolean;
  isAbstract: boolean;
  base?: TypeRef;
  interfaces: TypeRef[];
  members: MemberDef[];
  doc?: string;
  origin: 'bcl' | 'stub';
  location?: Location;
  /** .NET Framework 4.8 doesn't have this type. */
  notInFramework?: boolean;
  /** Members by name, built on first use. */
  byName?: Map<string, MemberDef[]>;
}

// ---- semantic types ---------------------------------------------------------------------------

export type Type =
  /** `shape`: what a JSON value holds (see json.ts); ignored by everything that decides what compiles. */
  | { k: 'named'; def: TypeDef; args: Type[]; shape?: JsonShape }
  | { k: 'array'; element: Type; rank: number }
  | { k: 'param'; name: string }
  | { k: 'null' }
  | { k: 'unknown' }
  | { k: 'anon'; props: { name: string; type: Type }[] }
  | { k: 'tuple'; elements: { name?: string; type: Type }[] };

export const UNKNOWN: Type = { k: 'unknown' };
export const NULL: Type = { k: 'null' };

export type Subst = ReadonlyMap<string, Type>;
export const EMPTY_SUBST: Subst = new Map();

// ---- the generated data -----------------------------------------------------------------------

interface RawParam {
  n: string;
  t: string;
  m?: ParamDef['modifier'];
  o?: string;
}

interface RawMember {
  n: string;
  k: 'm' | 'p' | 'f' | 'c' | 'e' | 'ctor' | 'i' | 'op';
  s?: 1;
  x?: 1;
  g?: string[];
  gc?: string[][];
  t?: string;
  p?: RawParam[];
  w?: 1;
  d?: string;
  nf?: 1;
}

interface RawType {
  k: TypeKind;
  g?: string[];
  v?: ('in' | 'out' | '')[];
  f?: string[];
  b?: string;
  i?: string[];
  d?: string;
  nf?: 1;
  m: RawMember[];
}

export interface RawModel {
  types: Record<string, RawType>;
}

const MEMBER_KIND: Record<RawMember['k'], MemberKind> = { m: 'method', p: 'property', f: 'field', c: 'const', e: 'enumMember', ctor: 'ctor', i: 'indexer', op: 'operator' };

/** Parses `System.Collections.Generic.Dictionary`2<System.String,T[]>[]`. */
export function parseTypeRef(text: string): TypeRef {
  let i = 0;
  const read = (): TypeRef => {
    let j = i;
    while (j < text.length && !'<>,['.includes(text[j])) j++;
    const name = text.slice(i, j);
    i = j;
    let ref: TypeRef;
    if (text[i] === '<') {
      i++;
      const args: TypeRef[] = [];
      for (;;) {
        args.push(read());
        if (text[i] === ',') i++;
        else break;
      }
      i++; // >
      ref = { kind: 'named', key: name, args };
    } else {
      ref = name.includes('.') ? { kind: 'named', key: name, args: [] } : { kind: 'param', name };
    }
    while (text[i] === '[') {
      let rank = 1;
      i++;
      while (text[i] === ',') {
        rank++;
        i++;
      }
      i++; // ]
      ref = { kind: 'array', element: ref, rank };
    }
    return ref;
  };
  return read();
}

function typeDefFromRaw(key: string, raw: RawType): TypeDef {
  const nested = key.lastIndexOf('+');
  const dot = key.lastIndexOf('.', nested >= 0 ? nested : undefined);
  const def: TypeDef = {
    key,
    name: key.slice(Math.max(dot, nested) + 1).replace(/`\d+$/, ''),
    namespace: key.slice(0, dot),
    kind: raw.k,
    typeParams: raw.g ?? [],
    variance: raw.v ?? [],
    isStatic: raw.f?.includes('static') ?? false,
    isAbstract: raw.f?.includes('abstract') ?? false,
    base: raw.b ? parseTypeRef(raw.b) : undefined,
    interfaces: (raw.i ?? []).map(parseTypeRef),
    members: [],
    doc: raw.d,
    origin: 'bcl',
    notInFramework: raw.nf === 1 || undefined,
  };
  for (const m of raw.m) {
    def.members.push({
      name: m.n === 'this[]' ? 'this[]' : m.n,
      kind: MEMBER_KIND[m.k],
      isStatic: !!m.s || m.k === 'c' || m.k === 'e' || m.k === 'op',
      isExtension: !!m.x,
      typeParams: m.g ?? [],
      constraints: m.gc?.map((list) => list.map((c) => (c === 'class' || c === 'struct' ? c : parseTypeRef(c)))),
      type: m.k === 'ctor' ? { kind: 'named', key, args: def.typeParams.map((name) => ({ kind: 'param', name })) } : parseTypeRef(m.t ?? 'System.Void'),
      params: (m.p ?? []).map((p) => ({ name: p.n, type: parseTypeRef(p.t), modifier: p.m, defaultText: p.o })),
      doc: m.d,
      writable: !!m.w,
      declaring: def,
      notInFramework: m.nf === 1 || undefined,
    });
  }
  return def;
}

// ---- the model --------------------------------------------------------------------------------

/** Namespaces APIM imports for every expression, plus our stubs' namespace. */
export const IMPLICIT_NAMESPACES = [
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
  'Apim.Policies',
];

const NUMERIC_RANK = ['System.SByte', 'System.Byte', 'System.Int16', 'System.UInt16', 'System.Char', 'System.Int32', 'System.UInt32', 'System.Int64', 'System.UInt64', 'System.Single', 'System.Double', 'System.Decimal'];

/** Implicit numeric conversions (C# spec §6.1.2): from → the types it widens to. */
const IMPLICIT_NUMERIC: Record<string, string[]> = {
  'System.SByte': ['System.Int16', 'System.Int32', 'System.Int64', 'System.Single', 'System.Double', 'System.Decimal'],
  'System.Byte': ['System.Int16', 'System.UInt16', 'System.Int32', 'System.UInt32', 'System.Int64', 'System.UInt64', 'System.Single', 'System.Double', 'System.Decimal'],
  'System.Int16': ['System.Int32', 'System.Int64', 'System.Single', 'System.Double', 'System.Decimal'],
  'System.UInt16': ['System.Int32', 'System.UInt32', 'System.Int64', 'System.UInt64', 'System.Single', 'System.Double', 'System.Decimal'],
  'System.Int32': ['System.Int64', 'System.Single', 'System.Double', 'System.Decimal'],
  'System.UInt32': ['System.Int64', 'System.UInt64', 'System.Single', 'System.Double', 'System.Decimal'],
  'System.Int64': ['System.Single', 'System.Double', 'System.Decimal'],
  'System.UInt64': ['System.Single', 'System.Double', 'System.Decimal'],
  'System.Char': ['System.UInt16', 'System.Int32', 'System.UInt32', 'System.Int64', 'System.UInt64', 'System.Single', 'System.Double', 'System.Decimal'],
  'System.Single': ['System.Double'],
};

const KEYWORD_FOR: Record<string, string> = Object.fromEntries(Object.entries(PREDEFINED_TYPES).map(([k, v]) => [v, k]));

export class TypeModel {
  readonly defs = new Map<string, TypeDef>();
  /** Simple name (with `N for generics) → types in the implicit namespaces. */
  private readonly implicit = new Map<string, TypeDef[]>();
  private readonly namespaceSet = new Set<string>();
  /** Extension methods from static classes in the implicit namespaces. */
  readonly extensions: MemberDef[] = [];
  private readonly baseCache = new Map<string, Type[]>();

  constructor(raw: RawModel, stubs: TypeDef[] = []) {
    for (const [key, t] of Object.entries(raw.types)) this.defs.set(key, typeDefFromRaw(key, t));
    for (const def of stubs) this.defs.set(def.key, def);
    for (const def of this.defs.values()) {
      const parts = def.namespace.split('.');
      for (let i = 1; i <= parts.length; i++) this.namespaceSet.add(parts.slice(0, i).join('.'));
      if (!def.key.includes('+') && IMPLICIT_NAMESPACES.includes(def.namespace)) {
        const simple = def.typeParams.length ? `${def.name}\`${def.typeParams.length}` : def.name;
        const list = this.implicit.get(simple) ?? [];
        list.push(def);
        this.implicit.set(simple, list);
        if (def.isStatic) for (const m of def.members) if (m.isExtension) this.extensions.push(m);
      }
    }
  }

  get(key: string): TypeDef | undefined {
    return this.defs.get(key);
  }

  /** The named type for a metadata key with no type arguments (`System.String`). */
  named(key: string, args: Type[] = []): Type {
    const def = this.defs.get(key);
    return def ? { k: 'named', def, args } : UNKNOWN;
  }

  isNamespace(name: string): boolean {
    return this.namespaceSet.has(name);
  }

  /** Child namespace names directly under `ns` ('' for the roots). */
  childNamespaces(ns: string): string[] {
    const out = new Set<string>();
    const prefix = ns ? `${ns}.` : '';
    for (const n of this.namespaceSet) {
      if (!n.startsWith(prefix)) continue;
      const rest = n.slice(prefix.length);
      if (rest && !rest.includes('.')) out.add(rest);
    }
    return [...out];
  }

  /** Top-level types declared directly in `ns`. */
  typesIn(ns: string): TypeDef[] {
    return [...this.defs.values()].filter((d) => d.namespace === ns && !d.key.includes('+'));
  }

  /** Types visible by simple name through the implicit usings. */
  implicitTypes(): TypeDef[] {
    return [...this.implicit.values()].flat();
  }

  /** Resolves a simple type name with `arity` type arguments through the implicit usings. */
  lookupSimple(name: string, arity: number): TypeDef | undefined {
    const list = this.implicit.get(arity ? `${name}\`${arity}` : name);
    if (!list) return undefined;
    // Prefer our stubs, then System over the rest when a name is ambiguous.
    return list.find((d) => d.origin === 'stub') ?? list.find((d) => d.namespace === 'System') ?? list[0];
  }

  /** A type in namespace `ns` or nested in type `outer`. */
  lookupQualified(container: string, name: string, arity: number, nested: boolean): TypeDef | undefined {
    const key = `${container}${nested ? '+' : '.'}${name}${arity ? `\`${arity}` : ''}`;
    return this.defs.get(key);
  }

  // ---- references -----------------------------------------------------------------------------

  resolve(ref: TypeRef, subst: Subst = EMPTY_SUBST): Type {
    switch (ref.kind) {
      case 'param':
        return subst.get(ref.name) ?? { k: 'param', name: ref.name };
      case 'array':
        return { k: 'array', element: this.resolve(ref.element, subst), rank: ref.rank };
      case 'named': {
        const def = this.defs.get(ref.key);
        if (!def) return UNKNOWN;
        return { k: 'named', def, args: ref.args.map((a) => this.resolve(a, subst)) };
      }
    }
  }

  /** Substitution for a constructed type's own type parameters. */
  substOf(t: Type): Map<string, Type> {
    const m = new Map<string, Type>();
    if (t.k === 'named') t.def.typeParams.forEach((p, i) => m.set(p, t.args[i] ?? UNKNOWN));
    return m;
  }

  /** Base class and interfaces of a type, constructed. */
  directSupertypes(t: Type): Type[] {
    if (t.k === 'array') {
      const e = [t.element];
      const out = [this.named('System.Array')];
      if (t.rank === 1) {
        for (const k of ['System.Collections.Generic.IList`1', 'System.Collections.Generic.ICollection`1', 'System.Collections.Generic.IEnumerable`1', 'System.Collections.Generic.IReadOnlyList`1', 'System.Collections.Generic.IReadOnlyCollection`1']) {
          out.push(this.named(k, e));
        }
      }
      return out.filter((x) => x.k !== 'unknown');
    }
    if (t.k !== 'named') return t.k === 'param' || t.k === 'anon' || t.k === 'tuple' ? [this.named('System.Object')] : [];
    const s = this.substOf(t);
    const out: Type[] = [];
    if (t.def.base) out.push(this.resolve(t.def.base, s));
    else if (t.def.kind === 'interface' || t.def.kind === 'enum' || t.def.kind === 'delegate') {
      out.push(this.named(t.def.kind === 'enum' ? 'System.Enum' : t.def.kind === 'delegate' ? 'System.MulticastDelegate' : 'System.Object'));
    } else if (t.def.kind === 'struct') out.push(this.named('System.ValueType'));
    else if (t.def.key !== 'System.Object') out.push(this.named('System.Object'));
    for (const i of t.def.interfaces) out.push(this.resolve(i, s));
    return out.filter((x) => x.k !== 'unknown');
  }

  /** Every supertype, nearest first, without duplicates. Includes `t` itself. */
  supertypes(t: Type): Type[] {
    // The key ignores JSON shapes, so a type carrying one mustn't get (or leave) another's answer.
    const shaped = hasShape(t);
    const id = typeKey(t);
    const cached = shaped ? undefined : this.baseCache.get(id);
    if (cached) return cached;
    const out: Type[] = [];
    const seen = new Set<string>();
    const queue = [t];
    while (queue.length) {
      const x = queue.shift()!;
      const k = typeKey(x);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(x);
      queue.push(...this.directSupertypes(x));
    }
    if (shaped) return out;
    if (this.baseCache.size > 2000) this.baseCache.clear();
    this.baseCache.set(id, out);
    return out;
  }

  /** The constructed supertype of `t` whose definition is `key`, e.g. IEnumerable<T> of List<string>. */
  findSupertype(t: Type, key: string): Type | undefined {
    return this.supertypes(t).find((x) => x.k === 'named' && x.def.key === key);
  }

  // ---- members --------------------------------------------------------------------------------

  /**
   * Members of a type, nearest declaration first, each with the substitution for its declaring
   * type. A property or field hides same-named ones further up; methods are kept unless an
   * override with the same parameter types was already found.
   */
  members(t: Type, name?: string): { member: MemberDef; subst: Subst }[] {
    const out: { member: MemberDef; subst: Subst }[] = [];
    const hidden = new Set<string>();
    this.supertypes(t).forEach((sup, depth) => {
      if (sup.k !== 'named') return;
      // A class's interface members are either its own public ones or explicit implementations,
      // which aren't accessible through the class.
      if (depth > 0 && sup.def.kind === 'interface' && !(t.k === 'named' && t.def.kind === 'interface')) return;
      const s = this.substOf(sup);
      const list = name === undefined ? sup.def.members : (byName(sup.def).get(name) ?? []);
      for (const m of list) {
        if (m.kind === 'ctor' && depth > 0) continue;
        const valueLike = m.kind === 'property' || m.kind === 'field' || m.kind === 'const' || m.kind === 'enumMember';
        const sig = valueLike ? `value:${m.name}` : `${m.name}(${m.params.map((p) => typeKey(this.resolve(p.type, s))).join(',')})`;
        if (hidden.has(sig) || (!valueLike && m.kind !== 'operator' && hidden.has(`value:${m.name}`))) continue;
        hidden.add(sig);
        out.push({ member: m, subst: s });
      }
    });
    return out;
  }

  // ---- conversions ----------------------------------------------------------------------------

  isReferenceType(t: Type): boolean {
    if (t.k === 'array' || t.k === 'null' || t.k === 'anon') return true;
    if (t.k !== 'named') return false;
    return t.def.kind === 'class' || t.def.kind === 'interface' || t.def.kind === 'delegate';
  }

  isValueType(t: Type): boolean {
    return t.k === 'tuple' || (t.k === 'named' && (t.def.kind === 'struct' || t.def.kind === 'enum'));
  }

  isNullable(t: Type): boolean {
    return t.k === 'named' && t.def.key === 'System.Nullable`1';
  }

  nullableOf(t: Type): Type {
    if (!this.isValueType(t) || this.isNullable(t)) return t;
    return this.named('System.Nullable`1', [t]);
  }

  /** `T` for `T?`, otherwise `t`. */
  underlying(t: Type): Type {
    return t.k === 'named' && this.isNullable(t) ? (t.args[0] ?? UNKNOWN) : t;
  }

  isNumeric(t: Type): boolean {
    return t.k === 'named' && NUMERIC_RANK.includes(t.def.key);
  }

  numericKey(t: Type): string | undefined {
    return t.k === 'named' && NUMERIC_RANK.includes(t.def.key) ? t.def.key : undefined;
  }

  /**
   * Cost of an implicit conversion from `from` to `to`: 0 identity, higher is worse, undefined
   * when there's none. Unknown types convert to anything so that gaps in the model never produce
   * errors. `literal` marks an integer literal, which also converts to smaller integral types.
   */
  conversion(from: Type, to: Type, literal?: 'int' | 'zero'): number | undefined {
    if (from.k === 'unknown' || to.k === 'unknown') return 1;
    if (to.k === 'param' || from.k === 'param') return to.k === 'param' && from.k === 'param' && to.name === from.name ? 0 : 2;
    if (sameType(from, to)) return 0;
    if (from.k === 'null') return this.isReferenceType(to) || this.isNullable(to) ? 1 : undefined;
    if (to.k === 'named' && to.def.key === 'System.Object') return 3;
    if (to.k === 'anon' || from.k === 'anon') return undefined;
    if (from.k === 'tuple' || to.k === 'tuple') {
      if (from.k === 'tuple' && to.k === 'tuple' && from.elements.length === to.elements.length) {
        let cost = 0;
        for (let i = 0; i < from.elements.length; i++) {
          const c = this.conversion(from.elements[i].type, to.elements[i].type);
          if (c === undefined) return undefined;
          cost += c;
        }
        return cost;
      }
      return undefined;
    }
    // Numeric widening.
    const fk = this.numericKey(from);
    const tk = this.numericKey(this.underlying(to));
    if (fk && tk) {
      if (fk === tk) return this.isNullable(to) ? 1 : 0;
      if (IMPLICIT_NUMERIC[fk]?.includes(tk)) return 1 + NUMERIC_RANK.indexOf(tk) / 100;
      if (literal && fk === 'System.Int32' && tk !== 'System.Char') return 1.5; // constant conversion
      return undefined;
    }
    if (literal === 'zero' && this.underlying(to).k === 'named' && (this.underlying(to) as { def: TypeDef }).def.kind === 'enum') return 1;
    // T → T?, and lifted S? → T?
    if (this.isNullable(to)) {
      const c = this.conversion(this.underlying(from), this.underlying(to));
      return c === undefined ? undefined : c + 1;
    }
    // Reference and boxing conversions to a supertype.
    const target = to.k === 'named' ? to : undefined;
    if (target) {
      for (const sup of this.supertypes(from)) {
        if (sup.k !== 'named' || sup.def !== target.def) continue;
        if (this.argsCompatible(target.def, sup.args, target.args)) return 2;
      }
    }
    if (from.k === 'array' && to.k === 'array' && from.rank === to.rank && this.isReferenceType(from.element)) {
      const c = this.conversion(from.element, to.element);
      return c !== undefined && this.isReferenceType(to.element) ? c + 1 : undefined;
    }
    // User-defined implicit operators on either type.
    if (this.userConversion(from, to)) return 4;
    return undefined;
  }

  /**
   * Whether the model knows `t` completely: its type arguments, every supertype, and the types
   * its conversion operators use. Only then can a missing conversion be reported as an error,
   * since anything the model can't see might supply one.
   */
  isDefinite(t: Type): boolean {
    switch (t.k) {
      case 'null':
        return true;
      case 'array':
        return this.isDefinite(t.element);
      case 'named':
        return t.args.every((a) => this.isDefinite(a)) && this.supertypes(t).every((s) => s.k !== 'named' || this.isComplete(s.def));
      default:
        return false;
    }
  }

  private readonly completeCache = new Map<string, boolean>();

  private isComplete(def: TypeDef): boolean {
    const hit = this.completeCache.get(def.key);
    if (hit !== undefined) return hit;
    const known = (r: TypeRef): boolean => r.kind === 'param' || (r.kind === 'array' ? known(r.element) : this.defs.has(r.key) && r.args.every(known));
    const ops = [...(byName(def).get('op_Implicit') ?? []), ...(byName(def).get('op_Explicit') ?? [])];
    const ok = (!def.base || known(def.base)) && def.interfaces.every(known) && ops.every((m) => known(m.type) && m.params.every((p) => known(p.type)));
    this.completeCache.set(def.key, ok);
    return ok;
  }

  /** Whether a cast from `from` to `to` could compile, for the "missing a cast?" hint. */
  explicitConversion(from: Type, to: Type): boolean {
    const f = this.underlying(from);
    const t = this.underlying(to);
    const enumOrNumeric = (x: Type) => this.isNumeric(x) || (x.k === 'named' && x.def.kind === 'enum');
    if (enumOrNumeric(f) && enumOrNumeric(t)) return true;
    // Downcasts and unboxing.
    if (this.conversion(to, from) !== undefined) return true;
    if (this.isReferenceType(f) && this.isReferenceType(t) && ((f.k === 'named' && f.def.kind === 'interface') || (t.k === 'named' && t.def.kind === 'interface'))) return true;
    for (const x of [t, f]) {
      if (x.k !== 'named') continue;
      for (const { member, subst } of this.members(x, 'op_Explicit')) {
        const p = member.params[0];
        if (p && sameType(this.resolve(p.type, subst), f) && sameType(this.resolve(member.type, subst), t)) return true;
      }
    }
    return false;
  }

  /** Whether `t` declares the operator `name` (`op_LogicalNot`, say). */
  userOperator(t: Type, name: string): boolean {
    return t.k === 'named' && this.members(t, name).length > 0;
  }

  private argsCompatible(def: TypeDef, from: Type[], to: Type[]): boolean {
    for (let i = 0; i < to.length; i++) {
      const a = from[i] ?? UNKNOWN;
      const b = to[i] ?? UNKNOWN;
      if (sameType(a, b) || a.k === 'unknown' || b.k === 'unknown') continue;
      const v = def.variance[i];
      if (v === 'out' && this.isReferenceType(a) && this.conversion(a, b) !== undefined) continue;
      if (v === 'in' && this.isReferenceType(b) && this.conversion(b, a) !== undefined) continue;
      return false;
    }
    return true;
  }

  private userConversion(from: Type, to: Type): boolean {
    for (const t of [this.underlying(to), from]) {
      if (t.k !== 'named') continue;
      for (const { member, subst } of this.members(t, 'op_Implicit')) {
        const p = member.params[0];
        if (!p) continue;
        const pt = this.resolve(p.type, subst);
        const rt = this.resolve(member.type, subst);
        // Standard conversions only on each side, so this can't recurse.
        if ((sameType(pt, from) || this.standardConversion(from, pt)) && (sameType(rt, to) || this.standardConversion(rt, to))) return true;
      }
    }
    return false;
  }

  private standardConversion(from: Type, to: Type): boolean {
    if (from.k === 'unknown' || to.k === 'unknown') return false;
    const fk = this.numericKey(from);
    const tk = this.numericKey(this.underlying(to));
    if (fk && tk) return fk === tk || !!IMPLICIT_NUMERIC[fk]?.includes(tk);
    if (to.k === 'named' && to.def.key === 'System.Object') return true;
    if (this.isNullable(to)) return sameType(from, this.underlying(to));
    return to.k === 'named' && this.supertypes(from).some((s) => s.k === 'named' && s.def === to.def && this.argsCompatible(to.def, s.args, to.args));
  }

  /** Whether the inferred type arguments in `subst` meet the method's constraints. Unknowns pass. */
  satisfiesConstraints(member: MemberDef, subst: Subst): boolean {
    if (!member.constraints) return true;
    return member.typeParams.every((p, i) => {
      const arg = subst.get(p);
      if (!arg || arg.k === 'unknown' || arg.k === 'param') return true;
      return (member.constraints![i] ?? []).every((c) => {
        if (c === 'class') return this.isReferenceType(arg);
        if (c === 'struct') return this.isValueType(arg) && !this.isNullable(arg);
        return this.conversion(arg, this.resolve(c, subst)) !== undefined;
      });
    });
  }

  /** The element type `foreach` sees. */
  elementType(t: Type): Type {
    if (t.k === 'array') return t.element;
    if (t.k === 'named' && t.def.key === 'System.String') return this.named('System.Char');
    const e = this.findSupertype(t, 'System.Collections.Generic.IEnumerable`1');
    if (e && e.k === 'named') return e.args[0] ?? UNKNOWN;
    if (this.findSupertype(t, 'System.Collections.IEnumerable')) return this.named('System.Object');
    return UNKNOWN;
  }

  /** Parameter and return types of a delegate type. */
  delegateSignature(t: Type): { params: Type[]; ret: Type } | undefined {
    if (t.k !== 'named' || t.def.kind !== 'delegate') return undefined;
    const invoke = byName(t.def).get('Invoke')?.[0];
    if (!invoke) return undefined;
    const s = this.substOf(t);
    return { params: invoke.params.map((p) => this.resolve(p.type, s)), ret: this.resolve(invoke.type, s) };
  }

  // ---- display --------------------------------------------------------------------------------

  display(t: Type): string {
    switch (t.k) {
      case 'unknown':
        return '?';
      case 'null':
        return 'null';
      case 'param':
        return t.name;
      case 'array':
        return `${this.display(t.element)}[${','.repeat(t.rank - 1)}]`;
      case 'anon':
        return `new { ${t.props.map((p) => `${this.display(p.type)} ${p.name}`).join(', ')} }`;
      case 'tuple':
        return `(${t.elements.map((e) => (e.name ? `${this.display(e.type)} ${e.name}` : this.display(e.type))).join(', ')})`;
      case 'named': {
        if (KEYWORD_FOR[t.def.key]) return KEYWORD_FOR[t.def.key];
        if (this.isNullable(t)) return `${this.display(this.underlying(t))}?`;
        let args = t.args;
        let outer = '';
        const nested = t.def.key.lastIndexOf('+');
        const outerDef = nested > 0 ? this.defs.get(t.def.key.slice(0, nested)) : undefined;
        if (outerDef) {
          // A nested type's arguments start with its outer type's: Dictionary<K, V>.KeyCollection.
          const n = outerDef.typeParams.length;
          outer = `${this.display({ k: 'named', def: outerDef, args: args.slice(0, n) })}.`;
          args = args.slice(n);
        }
        return args.length ? `${outer}${t.def.name}<${args.map((a) => this.display(a)).join(', ')}>` : outer + t.def.name;
      }
    }
  }

  /** `List<T>` for a definition, with its own type parameter names. */
  displayDef(def: TypeDef): string {
    return this.display({ k: 'named', def, args: def.typeParams.map((name) => ({ k: 'param', name })) });
  }

  /** The C# full name: `System.Collections.Generic.List<T>`. */
  fullName(def: TypeDef): string {
    return `${def.namespace}.${def.key.slice(def.namespace.length + 1).replace(/`\d+/g, '').replace(/\+/g, '.')}`;
  }

  /** Allowlist name of a definition: `System.Collections.Generic.List`, `System.TimeZoneInfo.AdjustmentRule`. */
  allowlistName(def: TypeDef): string {
    return def.key.replace(/`\d+/g, '').replace(/\+/g, '.');
  }
}

export function byName(def: TypeDef): Map<string, MemberDef[]> {
  if (!def.byName) {
    def.byName = new Map();
    for (const m of def.members) {
      const list = def.byName.get(m.name) ?? [];
      list.push(m);
      def.byName.set(m.name, list);
    }
  }
  return def.byName;
}

export function sameType(a: Type, b: Type): boolean {
  if (a === b) return true;
  if (a.k !== b.k) return false;
  switch (a.k) {
    case 'named': {
      const bb = b as typeof a;
      return a.def === bb.def && a.args.length === bb.args.length && a.args.every((x, i) => sameType(x, bb.args[i]));
    }
    case 'array': {
      const bb = b as typeof a;
      return a.rank === bb.rank && sameType(a.element, bb.element);
    }
    case 'param':
      return a.name === (b as typeof a).name;
    case 'anon': {
      const bb = b as typeof a;
      return a.props.length === bb.props.length && a.props.every((p, i) => p.name === bb.props[i].name && sameType(p.type, bb.props[i].type));
    }
    case 'tuple': {
      const bb = b as typeof a;
      return a.elements.length === bb.elements.length && a.elements.every((e, i) => sameType(e.type, bb.elements[i].type));
    }
    default:
      return true;
  }
}

/** Whether `t` or a type argument in it carries a JSON shape. */
function hasShape(t: Type): boolean {
  switch (t.k) {
    case 'named':
      return !!t.shape || t.args.some(hasShape);
    case 'array':
      return hasShape(t.element);
    default:
      return false;
  }
}

/** A stable string for a type, for caches and signature comparison. */
export function typeKey(t: Type): string {
  switch (t.k) {
    case 'named':
      return t.args.length ? `${t.def.key}<${t.args.map(typeKey).join(',')}>` : t.def.key;
    case 'array':
      return `${typeKey(t.element)}[${t.rank}]`;
    case 'param':
      return `!${t.name}`;
    case 'anon':
      return `{${t.props.map((p) => `${p.name}:${typeKey(p.type)}`).join(',')}}`;
    case 'tuple':
      return `(${t.elements.map((e) => typeKey(e.type)).join(',')})`;
    default:
      return t.k;
  }
}

/** Whether a type mentions a type parameter in `names`. */
export function mentions(t: Type, names: ReadonlySet<string>): boolean {
  switch (t.k) {
    case 'param':
      return names.has(t.name);
    case 'array':
      return mentions(t.element, names);
    case 'named':
      return t.args.some((a) => mentions(a, names));
    case 'tuple':
      return t.elements.some((e) => mentions(e.type, names));
    case 'anon':
      return t.props.some((p) => mentions(p.type, names));
    default:
      return false;
  }
}

/** Replaces type parameters in an already-resolved type. */
export function substitute(t: Type, s: Subst): Type {
  switch (t.k) {
    case 'param':
      return s.get(t.name) ?? t;
    case 'array':
      return { k: 'array', element: substitute(t.element, s), rank: t.rank };
    case 'named':
      return t.args.length ? { k: 'named', def: t.def, args: t.args.map((a) => substitute(a, s)) } : t;
    case 'tuple':
      return { k: 'tuple', elements: t.elements.map((e) => ({ name: e.name, type: substitute(e.type, s) })) };
    case 'anon':
      return { k: 'anon', props: t.props.map((p) => ({ name: p.name, type: substitute(p.type, s) })) };
    default:
      return t;
  }
}
