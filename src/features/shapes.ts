import type * as vscode from 'vscode';
import { declaredType, displayShaped, exampleCSharp, exampleJson, shapeOf, type JsonShape, type ShapeEnv } from '../csharp/lang/json';
import type { CSharpEngine } from '../csharp/lang/service';
import type { Document, Expression } from '../parser/ast';
import { propertyDocs, type FragmentDoc } from '../policy/fragmentDoc';
import { documentShapes, generateTypedefs, outputShapes, setterTypes, setVariableTargets, typedefFor, wantedShapes, type GeneratedTypedefs } from '../policy/shapes';
import { summarize } from '../policy/variables';
import type { PolicyIndex } from './policyIndex';

/** How deep includes are followed for shapes; fragments rarely nest more than once. */
const MAX_DEPTH = 4;

/**
 * The JSON shapes each document's variables have (policy/shapes.ts), including what the
 * fragments it includes set: their declared `@out` types, else what their code builds. Computed
 * once per document version, and again after any indexed file changes.
 */
export class ShapeService {
  private memo = new WeakMap<Document, Promise<ShapeEnv>>();

  constructor(
    private readonly index: PolicyIndex,
    private readonly engine: () => Promise<CSharpEngine | undefined>,
    /** Where a parse came from, so an instance policy reads the instance's fragments. */
    private readonly originOf: (doc: Document) => vscode.Uri | undefined = () => undefined,
  ) {
    index.onDidChange(() => {
      this.memo = new WeakMap();
      this.wantedMemo = new WeakMap();
    });
  }

  /** The shapes `doc`'s expressions can read; undefined when C# features are off. */
  async forDocument(doc: Document): Promise<ShapeEnv | undefined> {
    const engine = await this.engine();
    return engine && this.compute(doc, engine, new Set(), 0);
  }

  /**
   * The type of each variable `doc` sets, as header type text: its JSON shape (`{ someData: int }`,
   * or `User[]` when a @typedef fits), else the result type of what sets it (`long`, `IResponse`).
   * For the drafted header, the expansions and the declare-variable fixes. Nothing without the engine.
   */
  async typeTexts(doc: Document): Promise<(name: string) => string | undefined> {
    const engine = await this.engine();
    if (!engine) return () => undefined;
    const env = await this.compute(doc, engine, new Set(), 0);
    const header = summarize(doc).header;
    const setters = setterTypes(doc, (code, kind) => engine.resultType(code, kind));
    return (name) => {
      // A JSON shape, named by a matching @typedef when there is one; else the type of what sets it.
      const s = env.get(name);
      // An object whose keys are only added at run time (histogram[key] = …) is just a JObject.
      if (s?.kind === 'object' && !s.fields.size) return 'JObject';
      if (s && s.kind !== 'value') return typedefFor(engine.model, s, header) ?? engine.displayShape(s);
      return setters.get(name);
    };
  }

  /**
   * For each `set-variable` value in `doc`, the declared shape its variable should have (see
   * policy/shapes.ts `wantedShapes`), keyed by the value's expression.
   */
  async wanted(doc: Document): Promise<Map<Expression, JsonShape>> {
    let hit = this.wantedMemo.get(doc);
    if (!hit) {
      hit = this.computeWanted(doc);
      this.wantedMemo.set(doc, hit);
    }
    return hit;
  }

  private wantedMemo = new WeakMap<Document, Promise<Map<Expression, JsonShape>>>();

  private async computeWanted(doc: Document): Promise<Map<Expression, JsonShape>> {
    const engine = await this.engine();
    const out = new Map<Expression, JsonShape>();
    if (!engine) return out;
    const summary = summarize(doc);
    const included: FragmentDoc[] = [];
    for (const id of new Set(summary.includes)) {
      const h = (await this.index.fragment(id, this.originOf(doc)))?.summary.header;
      if (h) included.push(h);
    }
    const shapes = wantedShapes(engine.model, summary.header, included);
    if (!shapes.size) return out;
    for (const [expr, name] of setVariableTargets(doc)) {
      const s = shapes.get(name);
      if (s) out.set(expr, s);
    }
    return out;
  }

  /**
   * A type written in `header` (a `@typedef` name, `{ … }`, `T[]`) spelled out, with a value of
   * it, every key filled in, as JSON and as the C# that builds it.
   */
  async example(header: FragmentDoc, typeText: string, options: { strings: 'placeholder' | 'empty'; indent?: string; unit?: string } = { strings: 'placeholder' }): Promise<{ shape: string; json: string; csharp: string } | undefined> {
    const engine = await this.engine();
    const t = engine && declaredType(engine.model, typeText, header.typedefs, propertyDocs(header));
    if (!engine || !t) return undefined;
    return {
      shape: displayShaped(engine.model, t),
      json: JSON.stringify(exampleJson(engine.model, t, options), null, 2),
      csharp: exampleCSharp(engine.model, t, options, options.indent ?? '', options.unit ?? '    '),
    };
  }

  /** The shape of the `new JObject` at code offset `offset` of `expr`, as header type text. */
  async createdShapeAt(doc: Document, expr: Expression, offset: number): Promise<string | undefined> {
    const engine = await this.engine();
    if (!engine) return undefined;
    const env = await this.compute(doc, engine, new Set(), 0);
    const hit = engine.createdShapeAt(expr.code, expr.kind, offset, env);
    return hit && engine.displayShape(hit.shape);
  }

  /**
   * `@typedef` / `@property` entries for what `doc` builds for `variable`, when it's a JSON
   * object (or array of them) that no typedef in `header` already fits. `taken` holds names in use.
   */
  async typedefsFor(doc: Document, variable: string, taken: Set<string>, name?: string): Promise<GeneratedTypedefs | undefined> {
    const engine = await this.engine();
    if (!engine) return undefined;
    const env = await this.compute(doc, engine, new Set(), 0);
    const shape = env.get(variable);
    if (!shape || typedefFor(engine.model, shape, summarize(doc).header)) return undefined;
    return generateTypedefs(engine.model, variable, shape, taken, name);
  }

  /** The same, for a type written in `header` (an old inline `{{ … }}`, or a one-line typedef). */
  async typedefsForType(header: FragmentDoc, typeText: string, variable: string, taken: Set<string>, name?: string): Promise<GeneratedTypedefs | undefined> {
    const engine = await this.engine();
    const shape = engine && shapeOf(declaredType(engine.model, typeText, header.typedefs, propertyDocs(header)) ?? { k: 'unknown' });
    return engine && shape ? generateTypedefs(engine.model, variable, shape, taken, name) : undefined;
  }

  /** Typedefs for every variable `doc` sets whose shape has none yet, names kept apart, for a drafted header. */
  async draftTypedefs(doc: Document): Promise<Map<string, GeneratedTypedefs>> {
    const out = new Map<string, GeneratedTypedefs>();
    const taken = new Set(summarize(doc).header?.typedefDocs.keys() ?? []);
    for (const name of new Set(summarize(doc).variables.map((v) => v.name))) {
      const g = await this.typedefsFor(doc, name, taken);
      if (g) out.set(name, g);
    }
    return out;
  }

  /** Typedefs for the `new JObject` at code offset `offset` of `expr`, named for `variable`. */
  async typedefsForCreated(doc: Document, expr: Expression, offset: number, variable: string, taken: Set<string>): Promise<GeneratedTypedefs | undefined> {
    const engine = await this.engine();
    if (!engine) return undefined;
    const env = await this.compute(doc, engine, new Set(), 0);
    const hit = engine.createdShapeAt(expr.code, expr.kind, offset, env);
    return hit ? generateTypedefs(engine.model, variable, hit.shape, taken) : undefined;
  }

  /** What fragment `id` hands its callers, by variable. */
  async outputsOf(id: string): Promise<Map<string, JsonShape>> {
    const engine = await this.engine();
    return engine ? this.outputs(id, engine, new Set(), 0) : new Map();
  }

  private compute(doc: Document, engine: CSharpEngine, seen: ReadonlySet<string>, depth: number, from = this.originOf(doc)): Promise<ShapeEnv> {
    const hit = this.memo.get(doc);
    if (hit) return hit;
    const value = (async () => {
      const outside = new Map<string, JsonShape>();
      for (const id of new Set(summarize(doc).includes)) {
        for (const [name, shape] of await this.outputs(id, engine, seen, depth, from)) outside.set(name, shape);
      }
      return documentShapes(doc, engine, outside);
    })();
    // Only a top-level computation is memoised: a nested one depends on where it was reached from.
    if (depth === 0) this.memo.set(doc, value);
    return value;
  }

  private async outputs(id: string, engine: CSharpEngine, seen: ReadonlySet<string>, depth: number, from?: vscode.Uri): Promise<Map<string, JsonShape>> {
    if (seen.has(id) || depth >= MAX_DEPTH) return new Map();
    const f = await this.index.fragment(id, from);
    if (!f?.doc) return new Map();
    const env = await this.compute(f.doc, engine, new Set([...seen, id]), depth + 1, f.uri);
    return outputShapes(f.doc, env);
  }
}
