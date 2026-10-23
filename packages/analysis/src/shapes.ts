/**
 * What each context variable's JSON value looks like in one document: the shapes C# completion
 * and hover use for `context.Variables["x"]` (see json.ts in @apim-policy/csharp-engine).
 *
 * In order of precedence: types written in a fragment header (the document's own `@in`s and
 * `@out`s, and the `@out`s of the fragments it includes), then what the document's own
 * `set-variable`s build, worked out in document order so one variable's shape can come from
 * another's. A declared shape keeps its keys; an inferred one adds any it lacks.
 */

import type { Document, Expression, Node } from '@apim-policy/document';
import { type CodeKind, declaredType, displayShape, displayShaped, type JsonShape, mergeShapes, type ShapeEnv, shapeFits, shapeOf, type TypeModel } from '@apim-policy/csharp-engine';
import type { HeaderEntry } from './headerShape';
import { propertyDocs, type FragmentDoc } from './fragmentDoc';
import { summarize } from './variables';

/** The engine calls this needs: a pure function of code and the shapes so far. */
export interface ShapeEngine {
  readonly model: TypeModel;
  resultShape(code: string, kind: CodeKind, shapes: ShapeEnv): JsonShape | undefined;
}

/** The shapes a header declares, by variable name: its `@in`s and `@out`s, or only its outputs. */
export function declaredShapes(model: TypeModel, header: FragmentDoc | undefined, which: 'all' | 'outputs' = 'all'): Map<string, JsonShape> {
  const out = new Map<string, JsonShape>();
  if (!header) return out;
  const own = header.internals.filter((v) => !v.name.includes('*'));
  for (const v of which === 'all' ? [...header.inputs, ...header.outputs, ...own] : header.outputs) {
    const shape = v.type ? shapeOf(declaredType(model, v.type, header.typedefs, propertyDocs(header)) ?? { k: 'unknown' }) : undefined;
    if (shape) out.set(v.name, shape);
  }
  return out;
}

export function documentShapes(doc: Document, engine: ShapeEngine, outside: ReadonlyMap<string, JsonShape> = new Map()): ShapeEnv {
  const shapes = new Map(outside);
  for (const [name, shape] of declaredShapes(engine.model, summarize(doc).header)) shapes.set(name, shape);
  const visit = (nodes: readonly Node[]) => {
    for (const n of nodes) {
      if (n.type !== 'element') continue;
      if (n.name === 'set-variable') {
        const name = n.attributes.find((a) => a.name === 'name' && !a.expression)?.value?.trim();
        const value = n.attributes.find((a) => a.name === 'value')?.expression;
        if (name && value) {
          const inferred = engine.resultShape(value.code, value.kind, envOf(engine.model, shapes));
          const known = shapes.get(name);
          if (inferred) shapes.set(name, known ? mergeShapes(known, inferred) : inferred);
        }
      }
      visit(n.children);
    }
  };
  visit(doc.children);
  return envOf(engine.model, shapes);
}

export function envOf(model: TypeModel, shapes: ReadonlyMap<string, JsonShape>): ShapeEnv {
  const snapshot = new Map(shapes);
  const key = [...snapshot].map(([k, s]) => `${k}=${displayShape(model, s)}`).sort().join('\n');
  return { key, get: (name) => snapshot.get(name) };
}

/**
 * What a fragment hands its caller: the shapes of its `@out`s, or, without a header, of
 * everything it sets. `env` is the fragment's own (from `documentShapes`).
 */
export function outputShapes(doc: Document, env: ShapeEnv): Map<string, JsonShape> {
  const summary = summarize(doc);
  const names = summary.header ? summary.header.outputs.map((v) => v.name) : summary.variables.map((v) => v.name);
  const out = new Map<string, JsonShape>();
  for (const name of names) {
    const s = env.get(name);
    if (s) out.set(name, s);
  }
  return out;
}

/** The variable each `set-variable` value expression sets, for checking what it builds. */
export function setVariableTargets(doc: Document): Map<Expression, string> {
  const out = new Map<Expression, string>();
  const visit = (nodes: readonly Node[]) => {
    for (const n of nodes) {
      if (n.type !== 'element') continue;
      if (n.name === 'set-variable') {
        const name = n.attributes.find((a) => a.name === 'name' && !a.expression)?.value?.trim();
        const value = n.attributes.find((a) => a.name === 'value')?.expression;
        if (name && value) out.set(value, name);
      }
      visit(n.children);
    }
  };
  visit(doc.children);
  return out;
}

/**
 * The declared shape each variable should have where `doc` sets it: its own `@out`s and
 * `@internal`s, and the `@in`s of the fragments it includes (so a caller building a fragment's
 * input is checked against what the fragment says it takes).
 */
export function wantedShapes(model: TypeModel, own: FragmentDoc | undefined, included: readonly FragmentDoc[]): Map<string, JsonShape> {
  const out = new Map<string, JsonShape>();
  const add = (header: FragmentDoc, vars: readonly { name: string; type?: string }[]) => {
    for (const v of vars) {
      if (!v.type || v.name.includes('*') || out.has(v.name)) continue;
      const shape = shapeOf(declaredType(model, v.type, header.typedefs, propertyDocs(header)) ?? { k: 'unknown' });
      if (shape) out.set(v.name, shape);
    }
  };
  if (own) add(own, [...own.outputs, ...own.internals]);
  for (const h of included) add(h, h.inputs);
  return out;
}

/**
 * The type of what each variable is set to, as header text: a `set-variable` expression's result
 * type (from `typeOf`), `string` for a literal, `IResponse` for `send-request`. A literal `""` that
 * only blanks a variable something else sets doesn't decide its type.
 */
export function setterTypes(doc: Document, typeOf: (code: string, kind: Expression['kind']) => string | undefined): Map<string, string> {
  const strong = new Map<string, string>();
  const blank = new Set<string>();
  const visit = (nodes: readonly Node[]) => {
    for (const n of nodes) {
      if (n.type !== 'element') continue;
      const literal = (name: string) => n.attributes.find((a) => a.name === name && !a.expression)?.value?.trim();
      if (n.name === 'set-variable') {
        const name = literal('name');
        const value = n.attributes.find((a) => a.name === 'value');
        if (name && value) {
          if (value.expression) {
            const t = typeOf(value.expression.code, value.expression.kind);
            if (t && t !== '?' && t !== 'object' && t !== 'void' && !strong.has(name)) strong.set(name, t);
          } else if (value.value?.trim()) {
            if (!strong.has(name)) strong.set(name, 'string');
          } else blank.add(name);
        }
      }
      if (n.name === 'send-request') {
        const name = literal('response-variable-name');
        if (name && !strong.has(name)) strong.set(name, 'IResponse');
      }
      visit(n.children);
    }
  };
  visit(doc.children);
  for (const name of blank) if (!strong.has(name)) strong.set(name, 'string');
  return strong;
}

/** The `@typedef` (in `header`) a shape is, as `User` or `User[]`, when one fits. */
export function typedefFor(model: TypeModel, shape: JsonShape, header: FragmentDoc | undefined): string | undefined {
  if (!header?.typedefs.size) return undefined;
  for (const name of header.typedefs.keys()) {
    const declared = shapeOf(declaredType(model, name, header.typedefs, propertyDocs(header)) ?? { k: 'unknown' });
    if (!declared) continue;
    if (shapeFits(model, shape, declared)) return name;
    if (shape.kind === 'array') {
      const element = shapeOf(shape.element);
      if (element && shapeFits(model, element, declared)) return `${name}[]`;
    }
  }
  return undefined;
}

/** Typedefs written for a variable's shape: the type to put on its tag, and the header entries. */
export interface GeneratedTypedefs {
  /** `Kept[]` or `Filter`: what the tag's `{type}` becomes. */
  type: string;
  /** The root typedef's name, for the cursor. */
  name: string;
  /** `@typedef` and `@property` entries, the root typedef first. */
  entries: HeaderEntry[];
}

/**
 * `@typedef` / `@property` entries describing `shape`, named for `variable` (`ru-int-kept` holding
 * objects gives `Kept[]`). A nested object's keys are dotted properties (`address.city`); an array
 * of objects gets its own typedef, named for its key (`UserFilter` → `UserFilterRule`). Undefined
 * for a shape with nothing to describe. `taken` holds names in use, and gains the new ones.
 */
export function generateTypedefs(model: TypeModel, variable: string, shape: JsonShape, taken: Set<string>, name?: string): GeneratedTypedefs | undefined {
  const element = shape.kind === 'array' ? shapeOf(shape.element) : undefined;
  const object = shape.kind === 'object' ? shape : element?.kind === 'object' ? element : undefined;
  if (!object?.fields.size) return undefined;
  const root = unique(name ?? typeNameFor(variable, shape.kind === 'array'), taken);
  const entries: HeaderEntry[] = [];
  const describe = (typedef: string, o: JsonShape & { kind: 'object' }) => {
    const props: HeaderEntry[] = [];
    const walk = (s: JsonShape & { kind: 'object' }, prefix: string) => {
      for (const [k, t] of s.fields) {
        const path = prefix + k;
        const ks = shapeOf(t);
        const optional = !!s.optional?.has(k);
        const doc = s.docs?.get(k);
        const property = (type?: string): HeaderEntry => ({ kind: 'property', name: path, type, optional, description: doc ? [doc] : [] });
        if (ks?.kind === 'object' && ks.fields.size) {
          props.push(property('JObject'));
          walk(ks, `${path}.`);
        } else if (ks?.kind === 'array' && shapeOf(ks.element)?.kind === 'object' && (shapeOf(ks.element) as JsonShape & { kind: 'object' }).fields.size) {
          const inner = unique(`${typedef}${pascal(singular(k))}`, taken);
          props.push(property(`${inner}[]`));
          pending.push([inner, shapeOf(ks.element) as JsonShape & { kind: 'object' }]);
        } else props.push(property(ks?.kind === 'object' ? 'JObject' : displayShaped(model, t).replace(/^\{\}$/, 'JObject')));
      }
    };
    walk(o, '');
    entries.push({ kind: 'typedef', name: typedef, optional: false, description: [] }, ...props);
  };
  const pending: [string, JsonShape & { kind: 'object' }][] = [[root, object]];
  for (let i = 0; i < pending.length; i++) describe(...pending[i]);
  return { type: shape.kind === 'array' ? `${root}[]` : root, name: root, entries };
}

/** `ru-int-kept` → `Kept`, `ru-ret-users` holding an array → `User`, `sh-result` → `ShResult`. */
export function typeNameFor(variable: string, array: boolean): string {
  const parts = variable.split(/[-_.]/).filter(Boolean);
  const words = parts.length >= 3 ? parts.slice(2) : parts;
  const name = pascal(words.join('-')) || 'Shape';
  return array ? singular(name) : name;
}

function pascal(s: string): string {
  return s
    .split(/[-_.\s]/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join('');
}

function singular(s: string): string {
  return /ies$/i.test(s) ? `${s.slice(0, -3)}y` : /[^s]s$/i.test(s) ? s.slice(0, -1) : s;
}

function unique(name: string, taken: Set<string>): string {
  let n = name;
  for (let i = 2; taken.has(n); i++) n = `${name}${i}`;
  taken.add(n);
  return n;
}
