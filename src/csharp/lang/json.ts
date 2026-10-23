/**
 * Shapes of JSON values: which keys a JObject has and what each holds, what a JArray holds.
 *
 * A shape rides on a JToken-family type (`JObject`, `JArray`, `JToken`, or `object` for what
 * `context.Variables` holds) as an annotation. It never changes what compiles: conversions,
 * overloads and members ignore it. It only feeds completion of keys in `["…"]`, hover, and what
 * the extension infers for variables and fragment outputs.
 *
 * Shapes come from code (`new JObject { ["k"] = v }`, `o["k"] = v`, `new JArray(items)`,
 * `.Select(x => new JObject { … })`), from a `set-variable` whose value has one (see
 * `ShapeEnv`), and from types written in a fragment header (`declaredType`).
 */

import type { Type, TypeModel } from './model';

export type JsonShape =
  /**
   * A JObject. `fields` is mutable: `o["k"] = v` after `new JObject()` adds to it. `docs` holds
   * the `@property` descriptions of a declared one.
   */
  | { kind: 'object'; fields: Map<string, Type>; optional?: Set<string>; docs?: Map<string, string> }
  | { kind: 'array'; element: Type }
  /** A JValue holding a value of `type` (what `o["k"]` gives when `k` holds an int). */
  | { kind: 'value'; type: Type };

/** Shapes of the context variables an expression can read, by name. */
export interface ShapeEnv {
  /** Identifies the contents, for caches. */
  readonly key: string;
  get(name: string): JsonShape | undefined;
}

export const NO_SHAPES: ShapeEnv = { key: '', get: () => undefined };

const J = 'Newtonsoft.Json.Linq.';
const OBJECT_HOLDERS = new Set([`${J}JObject`, `${J}JToken`, `${J}JContainer`, 'System.Object']);
const ARRAY_HOLDERS = new Set([`${J}JArray`, `${J}JToken`, `${J}JContainer`, 'System.Object']);
const VALUE_HOLDERS = new Set([`${J}JValue`, `${J}JToken`, 'System.Object']);

export function shapeOf(t: Type): JsonShape | undefined {
  return t.k === 'named' ? t.shape : undefined;
}

/** Whether a value of static type `t` can carry `shape` (a JObject shape on JObject or JToken, …). */
export function canHold(t: Type, shape: JsonShape): boolean {
  if (t.k !== 'named') return false;
  const holders = shape.kind === 'object' ? OBJECT_HOLDERS : shape.kind === 'array' ? ARRAY_HOLDERS : VALUE_HOLDERS;
  return holders.has(t.def.key);
}

/** `t` carrying `shape`, when it can; otherwise `t` unchanged. */
export function withShape(t: Type, shape: JsonShape | undefined): Type {
  return shape && t.k === 'named' && canHold(t, shape) ? { ...t, shape } : t;
}

export function isJObject(t: Type): boolean {
  return t.k === 'named' && t.def.key === `${J}JObject`;
}

export function isJArray(t: Type): boolean {
  return t.k === 'named' && t.def.key === `${J}JArray`;
}

/** What a field or element of type `t` looks like as a JToken: its own shape, or a value. */
export function tokenShape(t: Type): JsonShape | undefined {
  if (t.k === 'unknown' || t.k === 'null') return undefined;
  const own = shapeOf(t);
  if (own) return own;
  if (t.k === 'named' && t.def.key.startsWith(J)) return undefined;
  return { kind: 'value', type: t };
}

/** The type a field of shape `s` reads as, for display: the value's type, or the shaped token. */
export function shapeAsType(model: TypeModel, s: JsonShape): Type {
  if (s.kind === 'value') return s.type;
  return { ...(model.named(`${J}${s.kind === 'object' ? 'JObject' : 'JArray'}`) as Type & { k: 'named' }), shape: s };
}

/** A string literal's value, for literal keys: `"someData"`. Undefined for anything fancier. */
export function literalKey(text: string): string | undefined {
  return /^"[^"\\]*"$/.test(text) ? text.slice(1, -1) : undefined;
}

/** `{ someData: int, error: { source: string } }`, `{ id: string }[]`, or the type itself. */
export function displayShaped(model: TypeModel, t: Type, depth = 0): string {
  const s = shapeOf(t);
  if (!s) return model.display(t);
  return displayShape(model, s, depth);
}

export function displayShape(model: TypeModel, s: JsonShape, depth = 0): string {
  if (depth > 4) return '…';
  if (s.kind === 'value') return model.display(s.type);
  if (s.kind === 'array') return `${displayShaped(model, s.element, depth + 1)}[]`;
  if (!s.fields.size) return '{}';
  const fields = [...s.fields].map(([k, v]) => `${/^[A-Za-z_][\w-]*$/.test(k) ? k : JSON.stringify(k)}${s.optional?.has(k) ? '?' : ''}: ${displayShaped(model, v, depth + 1)}`);
  return `{ ${fields.join(', ')} }`;
}

/** Combines two shapes for the same variable: an object gets every key either has. */
export function mergeShapes(a: JsonShape, b: JsonShape): JsonShape {
  if (a.kind === 'object' && b.kind === 'object') {
    const fields = new Map(a.fields);
    for (const [k, v] of b.fields) if (!fields.has(k)) fields.set(k, v);
    return { kind: 'object', fields, optional: new Set([...(a.optional ?? []), ...(b.optional ?? [])]), docs: a.docs ?? b.docs };
  }
  return a;
}

// ---- declared types ---------------------------------------------------------------------------

const SCALARS: Record<string, string> = {
  string: 'System.String',
  int: 'System.Int32',
  long: 'System.Int64',
  short: 'System.Int16',
  bool: 'System.Boolean',
  double: 'System.Double',
  float: 'System.Single',
  decimal: 'System.Decimal',
  char: 'System.Char',
  byte: 'System.Byte',
  object: 'System.Object',
  DateTime: 'System.DateTime',
  DateTimeOffset: 'System.DateTimeOffset',
  TimeSpan: 'System.TimeSpan',
  Guid: 'System.Guid',
  Uri: 'System.Uri',
  JObject: `${J}JObject`,
  JArray: `${J}JArray`,
  JToken: `${J}JToken`,
  JValue: `${J}JValue`,
};

/**
 * The type a fragment header writes (`string`, `int?`, `{ id: string, age?: int }`, `User[]`,
 * `JArray<User>`), with `typedefs` naming shapes. Undefined when it doesn't parse; the header's
 * type is free text, so that isn't an error.
 */
export function declaredType(
  model: TypeModel,
  text: string,
  typedefs: ReadonlyMap<string, string> = new Map(),
  /** `@property` descriptions by typedef name, then key path (`address.city`). */
  docs: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map(),
  seen: ReadonlySet<string> = new Set(),
): Type | undefined {
  const p = new DeclParser(model, text, typedefs, docs, seen);
  const t = p.type();
  return t && p.done() ? t : undefined;
}

/** Puts a typedef's `@property` descriptions on its shape, nested objects included. */
function attachDocs(t: Type, docs: ReadonlyMap<string, string>, prefix = ''): void {
  const s = shapeOf(t);
  if (s?.kind !== 'object') return;
  for (const [k, v] of s.fields) {
    const path = prefix + k;
    const d = docs.get(path);
    if (d) (s.docs ??= new Map()).set(k, d);
    attachDocs(v, docs, `${path}.`);
  }
}

class DeclParser {
  private i = 0;

  constructor(
    private readonly model: TypeModel,
    private readonly s: string,
    private readonly typedefs: ReadonlyMap<string, string>,
    private readonly docs: ReadonlyMap<string, ReadonlyMap<string, string>>,
    private readonly seen: ReadonlySet<string>,
  ) {}

  done(): boolean {
    this.ws();
    return this.i >= this.s.length;
  }

  private ws(): void {
    while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++;
  }

  private eat(c: string): boolean {
    this.ws();
    if (this.s[this.i] !== c) return false;
    this.i++;
    return true;
  }

  private word(): string | undefined {
    this.ws();
    const m = /^[A-Za-z_][\w.]*/.exec(this.s.slice(this.i));
    if (!m) return undefined;
    this.i += m[0].length;
    return m[0];
  }

  type(): Type | undefined {
    let t = this.primary();
    if (!t) return undefined;
    for (;;) {
      if (this.eat('?')) {
        t = this.model.nullableOf(t);
        continue;
      }
      if (this.s.startsWith('[]', (this.ws(), this.i))) {
        this.i += 2;
        t = shapeAsType(this.model, { kind: 'array', element: t });
        continue;
      }
      return t;
    }
  }

  private primary(): Type | undefined {
    if (this.eat('{')) {
      const fields = new Map<string, Type>();
      const optional = new Set<string>();
      while (!this.eat('}')) {
        this.ws();
        let name: string | undefined;
        const quoted = /^"([^"]*)"/.exec(this.s.slice(this.i));
        if (quoted) {
          name = quoted[1];
          this.i += quoted[0].length;
        } else {
          const m = /^[A-Za-z_][\w-]*/.exec(this.s.slice(this.i));
          if (!m) return undefined;
          name = m[0];
          this.i += m[0].length;
        }
        if (this.eat('?')) optional.add(name);
        if (!this.eat(':')) return undefined;
        const t = this.type();
        if (!t) return undefined;
        fields.set(name, t);
        if (!this.eat(',') && !this.eat(';')) {
          if (!this.eat('}')) return undefined;
          break;
        }
      }
      return shapeAsType(this.model, { kind: 'object', fields, optional });
    }
    const name = this.word();
    if (!name) return undefined;
    if ((name === 'JArray' || name === 'IEnumerable' || name === 'List') && this.eat('<')) {
      const element = this.type();
      if (!element || !this.eat('>')) return undefined;
      return shapeAsType(this.model, { kind: 'array', element });
    }
    const def = this.typedefs.get(name);
    if (def !== undefined && !this.seen.has(name)) {
      const t = declaredType(this.model, def, this.typedefs, this.docs, new Set([...this.seen, name]));
      const d = this.docs.get(name);
      if (t && d) attachDocs(t, d);
      return t;
    }
    const key = SCALARS[name] ?? (name.includes('.') ? name : undefined);
    const t = key ? this.model.named(key) : undefined;
    return t && t.k !== 'unknown' ? t : undefined;
  }
}

// ---- examples ---------------------------------------------------------------------------------

/** What an example uses for a string: a placeholder that shows the type, or an empty string to fill in. */
export interface ExampleOptions {
  strings: 'placeholder' | 'empty';
}

/** A value of type `t`, every key filled in, as JSON (for a hover). */
export function exampleJson(model: TypeModel, t: Type, options: ExampleOptions = { strings: 'placeholder' }, depth = 0): unknown {
  const s = shapeOf(t);
  if (s && depth < 6) {
    if (s.kind === 'object') return Object.fromEntries([...s.fields].map(([k, v]) => [k, exampleJson(model, v, options, depth + 1)]));
    if (s.kind === 'array') return [exampleJson(model, s.element, options, depth + 1)];
    return exampleJson(model, s.type, options, depth + 1);
  }
  const key = t.k === 'named' ? model.underlying(t) : t;
  switch (key.k === 'named' ? key.def.key : '') {
    case 'System.Boolean':
      return false;
    case 'System.Int16':
    case 'System.Int32':
    case 'System.Int64':
    case 'System.Byte':
      return 0;
    case 'System.Double':
    case 'System.Single':
    case 'System.Decimal':
      return 0.0;
    case 'System.DateTime':
    case 'System.DateTimeOffset':
      return '2024-01-01T00:00:00Z';
    case 'System.Guid':
      return '00000000-0000-0000-0000-000000000000';
    case `${J}JObject`:
      return {};
    case `${J}JArray`:
      return [];
    default:
      return options.strings === 'placeholder' ? model.display(t).replace(/\?$/, '') : '';
  }
}

/**
 * C# that builds a value of type `t`, every key filled in: `new JObject { ["k"] = … }` and
 * `new JArray { … }` across lines, indented from `indent` by `unit`, with `// optional` after each
 * key the shape doesn't require. A string comes out as `""` or a placeholder.
 */
export function exampleCSharp(model: TypeModel, t: Type, options: ExampleOptions = { strings: 'placeholder' }, indent = '', unit = '    ', depth = 0): string {
  const s = shapeOf(t);
  const inner = indent + unit;
  if (s && depth < 6) {
    if (s.kind === 'object') {
      if (!s.fields.size) return 'new JObject()';
      const lines = [...s.fields].map(([k, v]) => `${inner}[${JSON.stringify(k)}] = ${exampleCSharp(model, v, options, inner, unit, depth + 1)},${s.optional?.has(k) ? ' // optional' : ''}`);
      return `new JObject {\n${lines.join('\n')}\n${indent}}`;
    }
    if (s.kind === 'array') return `new JArray {\n${inner}${exampleCSharp(model, s.element, options, inner, unit, depth + 1)},\n${indent}}`;
    return exampleCSharp(model, s.type, options, indent, unit, depth + 1);
  }
  const value = exampleJson(model, t, options, depth);
  const u = model.underlying(t);
  const key = u.k === 'named' ? u.def.key : '';
  if (key === 'System.Double') return '0d';
  if (key === 'System.Single') return '0f';
  if (key === 'System.Decimal') return '0m';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  return Array.isArray(value) ? 'new JArray()' : 'new JObject()';
}

/**
 * Whether a shape the code builds is the declared one: every key it has is declared with the same
 * type (nullability aside), and it has every key the declared one requires. Arrays compare their
 * elements.
 */
export function shapeFits(model: TypeModel, built: JsonShape, declared: JsonShape): boolean {
  const typeText = (t: Type) => displayShaped(model, t).replace(/\?$/, '');
  if (built.kind !== declared.kind) return false;
  if (built.kind === 'array' && declared.kind === 'array') {
    const b = shapeOf(built.element);
    const d = shapeOf(declared.element);
    return b && d ? shapeFits(model, b, d) : typeText(built.element) === typeText(declared.element);
  }
  if (built.kind === 'value' && declared.kind === 'value') return typeText(built.type) === typeText(declared.type);
  if (built.kind !== 'object' || declared.kind !== 'object') return false;
  for (const [k, t] of built.fields) {
    const want = declared.fields.get(k);
    if (!want) return false;
    const bs = shapeOf(t);
    const ds = shapeOf(want);
    if (bs && ds ? !shapeFits(model, bs, ds) : typeText(t) !== typeText(want) && t.k !== 'unknown') return false;
  }
  return [...declared.fields.keys()].every((k) => declared.optional?.has(k) || built.fields.has(k));
}
