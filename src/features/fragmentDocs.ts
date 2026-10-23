import * as vscode from 'vscode';
import { LANGUAGE_ID, toRange, type DocumentCache } from '../documents';
import { nodeAt } from '../parser/query';
import { checkFragmentHeader, checkIncludes, checkInternalUse, inputUse, propertiesOfTypeText, type TypedefDoc, type FragmentDoc, type FragmentProblem, type FragmentVariable, type IncludedFragment } from '../policy/fragmentDoc';
import { draftModel, headerExpansions, inferredTypes, insertTag, insertTypedefs, readHeaderComment, renderHeader, tabStops, type HeaderEntry, type HeaderModel } from '../policy/headerShape';
import { typeNameFor, type GeneratedTypedefs } from '../policy/shapes';
import type { Document } from '../parser/ast';
import { fragmentIdsFor } from '../parser/fragmentIds';
import { scopeFromInstancePath } from '../policy/scopes';
import { emptyValueFor, outputsNotAlwaysSet, unguardedReads } from '../policy/variableSafety';
import { escapeForDocument, expressionAt, isEscapedFormat, summarize, type PolicySummary } from '../policy/variables';
import type { PolicyIndex } from './policyIndex';
import type { ShapeService } from './shapes';

/** How many variables an inlay hint lists per side before "+N". */
const HINT_NAMES = 6;

/**
 * Fragment headers (`@in` / `@out`, see policy/fragmentDoc.ts) in the editor: an inlay hint after
 * each include-fragment listing what the fragment takes and sets, hover on its fragment-id,
 * diagnostics for a header that disagrees with its fragment and for an include that leaves a
 * required input unset, and code actions that write the header.
 */
export function registerFragmentDocs(cache: DocumentCache, index: PolicyIndex, shapes: ShapeService): vscode.Disposable {
  const summaryOf = (document: vscode.TextDocument) => summarize(cache.get(document));

  /** Headers of the fragments a summary includes, by id. */
  const headersFor = async (summary: PolicySummary, from: vscode.Uri) => {
    const out = new Map<string, { uri: vscode.Uri; header: FragmentDoc }>();
    for (const id of new Set(summary.includes)) {
      const f = await index.fragment(id, from);
      if (f?.summary.header) out.set(id, { uri: f.uri, header: f.summary.header });
    }
    return out;
  };

  /** What each included fragment sets: its @outs, or everything it sets when undocumented. */
  const setsFor = async (summary: PolicySummary, from: vscode.Uri) => {
    const out = new Map<string, string[]>();
    for (const id of new Set(summary.includes)) {
      const s = (await index.fragment(id, from))?.summary;
      if (s) out.set(id, s.header ? s.header.outputs.map((v) => v.name) : s.variables.map((v) => v.name));
    }
    return out;
  };

  const unguardedSeverity = (): vscode.DiagnosticSeverity | undefined => {
    const s = vscode.workspace.getConfiguration('apimPolicy').get<string>('lint.unguardedVariableAccess', 'off');
    return s === 'warning' ? vscode.DiagnosticSeverity.Warning : s === 'information' ? vscode.DiagnosticSeverity.Information : undefined;
  };

  const hintsChanged = new vscode.EventEmitter<void>();
  const collection = vscode.languages.createDiagnosticCollection('apim-fragments');
  const timers = new Map<string, NodeJS.Timeout>();

  const refresh = async (document: vscode.TextDocument) => {
    if (document.languageId !== LANGUAGE_ID || document.isClosed) return;
    const version = document.version;
    const summary = summaryOf(document);
    const headers = await headersFor(summary, document.uri);
    const severity = unguardedSeverity();
    const sets = severity === undefined ? undefined : await setsFor(summary, document.uri);
    // What broader scopes on the connected instance set; only fetched when something uses it.
    const outer = summary.includeSites.length || sets ? await index.outerVariables(document) : [];
    if (document.isClosed || document.version !== version) return;
    const problems: FragmentProblem[] = [];
    if (summary.header) {
      problems.push(...checkFragmentHeader(summary.header, summary.variables, summary.reads));
      const outs = sets ?? (await setsFor(summary, document.uri));
      if (document.isClosed || document.version !== version) return;
      for (const v of outputsNotAlwaysSet(cache.get(document), summary.header, (id) => outs.get(id))) {
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
    if (summary.includeSites.length) {
      const included = new Map<string, IncludedFragment>();
      for (const id of new Set(summary.includes)) {
        const f = await index.fragment(id, document.uri);
        if (f?.summary.header) included.set(id, { header: f.summary.header, sets: f.summary.variables.map((v) => v.name) });
      }
      if (document.isClosed || document.version !== version) return;
      problems.push(...checkInternalUse(summary.includeSites, summary.variables, summary.reads, (id) => included.get(id)));
    }
    const setBefore = [...summary.variables, ...outer.map((o) => ({ name: o.name, range: { start: o.at, end: o.at } }))];
    problems.push(...checkIncludes(summary.includeSites, setBefore, summary.header?.inputs.map((v) => v.name) ?? [], (id) => headers.get(id)?.header));
    const missingSeverity = vscode.workspace.getConfiguration('apimPolicy').get<string>('lint.missingInput', 'warning');
    const diagnostics = problems.filter((p) => p.code !== 'fragment-in-unset' || missingSeverity !== 'off').map((p) => {
      // A missing required input is information in the model (a broader scope may set it); the setting decides here.
      const warning = p.code === 'fragment-in-unset' ? missingSeverity === 'warning' : p.severity === 'warning';
      const d = new vscode.Diagnostic(toRange(document, p.range), p.message, warning ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information);
      d.source = 'apim';
      d.code = p.code;
      if (p.code === 'fragment-in-unused') d.tags = [vscode.DiagnosticTag.Unnecessary];
      return d;
    });
    if (sets && severity !== undefined) {
      const unguarded = unguardedReads(cache.get(document), summary.header, (id) => sets.get(id), outer).map((r) => {
        const d = new vscode.Diagnostic(
          toRange(document, r.range),
          `context.Variables["${r.name}"] throws if '${r.name}' isn't set, and nothing earlier guarantees it is. Use GetValueOrDefault, or check ContainsKey first.`,
          severity,
        );
        d.source = 'apim';
        d.code = 'unguarded-variable';
        return d;
      });
      diagnostics.push(...unguarded);
    }
    collection.set(document.uri, diagnostics);
  };

  const schedule = (document: vscode.TextDocument, delay = 300) => {
    const key = document.uri.toString();
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => {
      timers.delete(key);
      void refresh(document);
    }, delay));
  };
  const refreshAll = () => vscode.workspace.textDocuments.forEach((d) => schedule(d, 0));

  // ---- inlay hints ------------------------------------------------------------------------------

  const inlayHints: vscode.InlayHintsProvider = {
    onDidChangeInlayHints: hintsChanged.event,
    async provideInlayHints(document, range) {
      const summary = summaryOf(document);
      if (!summary.includeSites.length) return [];
      const headers = await headersFor(summary, document.uri);
      // Required inputs nothing sets before each include lead its hint, so they're seen without hovering.
      const outer = await index.outerVariables(document);
      const setBefore = [...summary.variables, ...outer.map((o) => ({ name: o.name, range: { start: o.at, end: o.at } }))];
      const missing = new Map(checkIncludes(summary.includeSites, setBefore, summary.header?.inputs.map((v) => v.name) ?? [], (id) => headers.get(id)?.header).map((p) => [p.range.start, p.missing ?? []]));
      const hints: vscode.InlayHint[] = [];
      for (const site of summary.includeSites) {
        const f = headers.get(site.id);
        if (!f) continue;
        const position = document.positionAt(site.end);
        if (!range.contains(position)) continue;
        const absent = missing.get(site.range.start) ?? [];
        const lead = absent.length ? [new vscode.InlayHintLabelPart(`missing: ${absent.join(', ')} · `)] : [];
        const parts = [...lead, ...side('in', f.header.inputs, f.uri), ...side('out', f.header.outputs, f.uri, f.header.inputs.length > 0)];
        if (!parts.length) continue;
        const hint = new vscode.InlayHint(position, parts);
        hint.paddingLeft = true;
        hints.push(hint);
      }
      return hints;
    },
  };

  /** A typedef name used in a header tag's `{type}`: a link to its `@typedef` line. */
  const typedefUseAt = (document: vscode.TextDocument, position: vscode.Position): vscode.LocationLink | undefined => {
    const own = summaryOf(document).header;
    const offset = document.offsetAt(position);
    if (!own || offset <= own.range.start || offset >= own.range.end) return undefined;
    const word = document.getWordRangeAtPosition(position, /[A-Za-z_]\w*/);
    const target = word && own.typedefDocs.get(document.getText(word));
    if (!word || !target) return undefined;
    // Only inside a `{…}` on its line, so a description that mentions the name isn't a link.
    const before = document.lineAt(word.start.line).text.slice(0, word.start.character);
    if ((before.match(/\{/g)?.length ?? 0) <= (before.match(/\}/g)?.length ?? 0)) return undefined;
    return { originSelectionRange: word, targetUri: document.uri, targetRange: toRange(document, target.block), targetSelectionRange: toRange(document, target.range) };
  };

  // ---- hover --------------------------------------------------------------------------------------

  const hover: vscode.HoverProvider = {
    async provideHover(document, position) {
      // A @typedef name in the header (where it's defined, or used in a tag's type): its shape and an example.
      const own = summaryOf(document).header;
      const offset = document.offsetAt(position);
      if (own && offset > own.range.start && offset < own.range.end) {
        const word = document.getWordRangeAtPosition(position, /[A-Za-z_]\w*/);
        const name = word && document.getText(word);
        if (name && own.typedefs.has(name)) {
          const example = await shapes.example(own, name);
          if (example) return new vscode.Hover(typedefMarkdown(name, example, own.typedefDocs.get(name)), word);
        }
        return undefined;
      }
      const hit = nodeAt(cache.get(document), offset);
      if (hit.element?.name !== 'include-fragment' || hit.attribute?.name !== 'fragment-id' || !hit.onAttributeValue || !hit.attribute.valueRange) return undefined;
      const id = hit.attribute.value?.trim();
      const f = id ? await index.fragment(id, document.uri) : undefined;
      if (!id || !f?.summary.header) return undefined;
      return new vscode.Hover(headerMarkdown(id, f.summary.header), toRange(document, hit.attribute.valueRange));
    },
  };

  // ---- code actions ---------------------------------------------------------------------------------

  const actions: vscode.CodeActionProvider = {
    async provideCodeActions(document, range, context) {
      const summary = summaryOf(document);
      const out: vscode.CodeAction[] = [];
      const unset = context.diagnostics.filter((d) => d.code === 'fragment-in-unset');
      if (unset.length) out.push(...(await setInputs(document, summary, unset)));
      out.push(...(await setEveryInput(document, summary, range)));
      out.push(...(await fillValue(document, range)));
      out.push(...(await extractTypedef(document, range)));
      out.push(...(await typedefActions(document, range)));
      const maybeUnset = context.diagnostics.filter((d) => d.code === 'fragment-out-maybe-unset');
      if (maybeUnset.length) out.push(...setOutputsFirst(document, summary, maybeUnset.map((d) => document.getText(d.range)), maybeUnset));
      const unguarded = context.diagnostics.filter((d) => d.code === 'unguarded-variable');
      if (unguarded.length) out.push(...(await useGetValueOrDefault(document, summary, unguarded)));
      const header = summary.header;
      if (header) {
        const names = [...new Set(context.diagnostics.filter((d) => d.code === 'fragment-in-undocumented').map((d) => document.getText(d.range)))];
        const codes = cache.get(document).expressions.map((e) => e.code);
        for (const name of names) {
          // What the reads say: GetValueOrDefault<bool>("x", false) is an optional bool defaulting to false.
          const use = inputUse(name, codes);
          const label = use.optional ? `[${name}${use.default !== undefined ? `=${use.default}` : ''}]` : name;
          const action = new vscode.CodeAction(`Document '${name}' as @in${use.optional ? ' (optional)' : ''}`, vscode.CodeActionKind.QuickFix);
          action.edit = new vscode.WorkspaceEdit();
          const at = tagInsertion(document, header);
          action.edit.set(document.uri, [tagSnippet(at, 'in', label, use.type)]);
          action.diagnostics = context.diagnostics.filter((d) => d.code === 'fragment-in-undocumented' && document.getText(d.range) === name);
          out.push(action);
        }
        out.push(...(await declareVariables(document, header, context.diagnostics.filter((d) => d.code === 'fragment-var-undeclared'))));
        return out;
      }
      // No header yet: offer one on the fragment element, drafted from what the fragment does.
      const doc = cache.get(document);
      const root = doc.root;
      if (root?.name !== 'fragment' || !toRange(document, root.startTag).intersection(range)) return out;
      const action = new vscode.CodeAction('Add a header documenting @in and @out', vscode.CodeActionKind.RefactorRewrite);
      action.edit = new vscode.WorkspaceEdit();
      action.edit.insert(document.uri, document.positionAt(root.range.start), `${renderHeader(draftModel(doc, summary, undefined, await shapes.typeTexts(doc), await publicNames(document), await shapes.draftTypedefs(doc)), '', indentUnit(document))}\n`);
      out.push(action);
      return out;
    },
  };

  /** For each include missing required inputs: set-variable lines for them, just above it. */
  const setInputs = async (document: vscode.TextDocument, summary: PolicySummary, diagnostics: vscode.Diagnostic[]) => {
    const headers = await headersFor(summary, document.uri);
    const problems = checkIncludes(summary.includeSites, summary.variables, summary.header?.inputs.map((v) => v.name) ?? [], (id) => headers.get(id)?.header);
    const out: vscode.CodeAction[] = [];
    for (const d of diagnostics) {
      const offset = document.offsetAt(d.range.start);
      const problem = problems.find((p) => p.range.start === offset && p.missing?.length);
      const site = summary.includeSites.find((s) => s.range.start === offset);
      const element = nodeAt(cache.get(document), offset).element;
      if (!problem?.missing || !site || element?.name !== 'include-fragment') continue;
      const header = headers.get(site.id)?.header;
      if (!header) continue;
      const line = document.lineAt(document.positionAt(element.range.start).line);
      const indent = line.text.slice(0, line.firstNonWhitespaceCharacterIndex);
      const text = (await Promise.all(problem.missing.map((name) => inputLine(document, header, header.inputs.find((v) => v.name === name) ?? { name, optional: false, description: '', range: { start: 0, end: 0 } }, indent)))).join('');
      const n = problem.missing.length;
      const action = new vscode.CodeAction(n === 1 ? `Set '${problem.missing[0]}' before this include` : `Set the ${n} required inputs before this include`, vscode.CodeActionKind.QuickFix);
      action.edit = new vscode.WorkspaceEdit();
      action.edit.insert(document.uri, new vscode.Position(line.lineNumber, 0), text);
      action.diagnostics = [d];
      action.isPreferred = true;
      out.push(action);
    }
    return out;
  };

  /**
   * For variables a documented fragment sets but doesn't declare: document one as @out or
   * @internal (typed from the code), or opt a family out with an @internal pattern.
   */
  /**
   * Rewrites the whole header through its model (policy/headerShape.ts): `change` adds or edits
   * entries, using `stop` for text that should become a tab stop. Undefined when the header has
   * something the model can't hold; callers then fall back to inserting a line.
   */
  const rewriteHeader = async (
    document: vscode.TextDocument,
    header: FragmentDoc,
    change: (model: HeaderModel, stop: (text: string, key?: string) => string) => void | Promise<void>,
  ): Promise<vscode.SnippetTextEdit | undefined> => {
    const range = toRange(document, header.range);
    const model = readHeaderComment(document.getText(range));
    if (!model) return undefined;
    const stops = tabStops();
    await change(model, stops.stop);
    const line = document.lineAt(range.start.line);
    return new vscode.SnippetTextEdit(range, new vscode.SnippetString(stops.snippet(renderHeader(model, line.text.slice(0, line.firstNonWhitespaceCharacterIndex), indentUnit(document)))));
  };

  /**
   * The type to write on a new tag for `variable`: when what the code builds is a JSON object (or
   * array of them) no typedef fits, a new `@typedef` with `@property` lines is added to `model` and
   * named here, its name a tab stop that follows into the tag.
   */
  const typeForTag = async (doc: Document, model: HeaderModel, stop: (text: string, key?: string) => string, variable: string, type: string | undefined, taken: Set<string>): Promise<string | undefined> => {
    if (!type || !inlineShape(type)) return type;
    const generated = await shapes.typedefsFor(doc, variable, taken);
    if (!generated) return type;
    return named(model, stop, generated);
  };

  const declareVariables = async (document: vscode.TextDocument, header: FragmentDoc, diagnostics: vscode.Diagnostic[]): Promise<vscode.CodeAction[]> => {
    const names = [...new Set(diagnostics.map((d) => document.getText(d.range)))];
    if (!names.length) return [];
    const doc = cache.get(document);
    const shapeText = await shapes.typeTexts(doc);
    const inferred = inferredTypes(doc).sets;
    const typeOf = (name: string) => shapeText(name) ?? inferred.get(name);
    const all = vscode.languages.getDiagnostics(document.uri).filter((d) => d.code === 'fragment-var-undeclared');
    const out: vscode.CodeAction[] = [];
    const action = (title: string, edit: vscode.SnippetTextEdit | vscode.TextEdit, fixes: vscode.Diagnostic[], preferred = false) => {
      const a = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
      a.edit = new vscode.WorkspaceEdit();
      a.edit.set(document.uri, [edit]);
      a.diagnostics = fixes;
      a.isPreferred = preferred;
      out.push(a);
    };
    /** Tags for `vars` (typed, typedefs made where needed), each description a tab stop. */
    const declare = async (vars: readonly string[], kind: 'out' | 'internal') => {
      const taken = new Set(header.typedefDocs.keys());
      const edit = await rewriteHeader(document, header, async (model, stop) => {
        for (const name of vars) {
          const type = await typeForTag(doc, model, stop, name, typeOf(name), taken);
          insertTag(model, { kind, name, type, optional: false, description: [stop('description', `description:${name}`)] });
        }
      });
      // A header the model can't hold: insert the line as it is.
      return edit ?? tagSnippet(tagInsertion(document, header, kind), kind, vars[0], typeOf(vars[0]));
    };
    for (const name of names) {
      const mine = diagnostics.filter((d) => document.getText(d.range) === name);
      action(`Document '${name}' as @internal`, await declare([name], 'internal'), mine, true);
      action(`Document '${name}' as @out`, await declare([name], 'out'), mine);
      const prefix = /^(.+-)[^-]+$/.exec(name)?.[1];
      if (prefix) {
        const at = tagInsertion(document, header, 'internal');
        action(`Treat every '${prefix}*' variable as internal`, vscode.TextEdit.insert(at.position, `${at.indent}@internal ${prefix}*\n`), all.filter((d) => document.getText(d.range).startsWith(prefix)));
      }
    }
    // Every undeclared variable at once, one typed line each, Tab moving through their descriptions.
    const everyName = [...new Set(all.map((d) => document.getText(d.range)))];
    if (everyName.length > 1) action(`Document every undeclared variable as @internal (${everyName.length})`, await declare(everyName, 'internal'), all);
    const at = tagInsertion(document, header, 'internal');
    action('Treat every undocumented variable as internal (@internal *)', vscode.TextEdit.insert(at.position, `${at.indent}@internal *\n`), all);
    return out;
  };

  /**
   * On a tag in the header whose type is plain `JObject` / `JArray` or an old inline shape, when the
   * code (or the inline type) says more: a `@typedef` for it, and the tag pointed at it. On an old
   * one-line `@typedef {{ … }} Name`: the same typedef as `@property` lines.
   */
  const typedefActions = async (document: vscode.TextDocument, range: vscode.Range): Promise<vscode.CodeAction[]> => {
    const header = summaryOf(document).header;
    if (!header) return [];
    const line = range.start.line;
    const onLine = (r: { start: number }) => document.positionAt(r.start).line === line;
    const doc = cache.get(document);
    const out: vscode.CodeAction[] = [];
    const legacy = [...header.typedefDocs.values()].find((t) => t.legacy && onLine(t.range));
    if (legacy) {
      // From the text as written, so a typedef it uses (`rules: UserRule[]`) stays a reference.
      const props = propertiesOfTypeText(header.typedefs.get(legacy.name) ?? '');
      const entries: HeaderEntry[] | undefined = props && [
        { kind: 'typedef', name: legacy.name, optional: false, description: [] },
        ...props.map((p): HeaderEntry => ({ kind: 'property', name: p.name, type: p.type, optional: p.optional, description: [] })),
      ];
      const edit = entries && (await rewriteHeader(document, header, (model) => {
        const at = model.entries.findIndex((e) => e.kind === 'typedef' && e.name === legacy.name);
        if (at >= 0) model.entries.splice(at, 1, ...withDescription(entries, model.entries[at].description));
      }));
      if (edit) {
        const a = new vscode.CodeAction(`Write ${legacy.name} as @property lines`, vscode.CodeActionKind.RefactorRewrite);
        a.edit = new vscode.WorkspaceEdit();
        a.edit.set(document.uri, [edit]);
        out.push(a);
      }
    }
    const tags: ['in' | 'out' | 'internal', FragmentVariable][] = [
      ...header.inputs.map((v) => ['in', v] as ['in', FragmentVariable]),
      ...header.outputs.map((v) => ['out', v] as ['out', FragmentVariable]),
      ...header.internals.map((v) => ['internal', v] as ['internal', FragmentVariable]),
    ];
    const tag = tags.find(([, v]) => onLine(v.range) && !v.name.includes('*'));
    if (tag) {
      const [kind, v] = tag;
      const taken = new Set(header.typedefDocs.keys());
      const generated =
        v.type && inlineShape(v.type)
          ? (typedefFromText(v.type, v.name, taken) ?? (await shapes.typedefsForType(header, v.type, v.name, taken)))
          : !v.type || /^(JObject|JArray|JToken)(\[\])?$/.test(v.type)
            ? await shapes.typedefsFor(doc, v.name, taken)
            : undefined;
      const edit = generated && (await rewriteHeader(document, header, (model, stop) => {
        const entry = model.entries.find((e) => e.kind === kind && e.name === v.name);
        if (entry) entry.type = named(model, stop, generated);
      }));
      if (edit) {
        const a = new vscode.CodeAction(`Generate a @typedef for '${v.name}'`, vscode.CodeActionKind.QuickFix);
        a.edit = new vscode.WorkspaceEdit();
        a.edit.set(document.uri, [edit]);
        a.isPreferred = true;
        out.push(a);
      }
    }
    return out;
  };

  /** Sets each output to an empty value at the start of the fragment, so every path leaves one. */
  const setOutputsFirst = (document: vscode.TextDocument, summary: PolicySummary, names: string[], diagnostics: vscode.Diagnostic[]): vscode.CodeAction[] => {
    const doc = cache.get(document);
    const root = doc.root;
    if (root?.name !== 'fragment' || !root.endTag) return [];
    // After the header when it's inside <fragment>, else straight after the start tag.
    const header = summary.header && summary.header.range.start > root.startTag.end ? summary.header.range.end : root.startTag.end;
    const rootLine = document.lineAt(document.positionAt(root.range.start).line);
    const indent = rootLine.text.slice(0, rootLine.firstNonWhitespaceCharacterIndex) + indentUnit(document);
    const types = new Map((summary.header?.outputs ?? []).map((v) => [v.name, v.type]));
    const unique = [...new Set(names)];
    const lines = unique.map((n) => `\n${indent}<set-variable name="${n}" value="${emptyValueFor(types.get(n))}" />`).join('');
    const action = new vscode.CodeAction(unique.length === 1 ? `Set '${unique[0]}' at the start of the fragment` : `Set the ${unique.length} outputs at the start of the fragment`, vscode.CodeActionKind.QuickFix);
    action.edit = new vscode.WorkspaceEdit();
    action.edit.insert(document.uri, document.positionAt(header), lines);
    action.diagnostics = diagnostics;
    action.isPreferred = true;
    return [action];
  };

  /**
   * A `set-variable` line for input `v` of a fragment: its default if it has one, else an empty
   * value of its type, and for a JSON type a `new JObject { … }` with every key filled in.
   */
  const inputLine = async (document: vscode.TextDocument, header: FragmentDoc, v: FragmentVariable, indent: string): Promise<string> => {
    const note = v.optional ? ` <!-- optional${v.default !== undefined ? `, default ${v.default}` : ''} -->` : '';
    const { value, known } = await valueFor(document, header, v, indent);
    const typeNote = v.type && !known ? ` <!-- ${v.type} -->` : '';
    return `${indent}<set-variable name="${v.name}" value="${value}" />${note || typeNote}\n`;
  };

  /**
   * A `set-variable` value for variable `v` as the header declares it (attribute text, escaped for
   * the document): its default, else an empty value of its type, a JSON type built out key by key.
   * `known` is false when the type couldn't be read, so the value is just empty.
   */
  const valueFor = async (document: vscode.TextDocument, header: FragmentDoc, v: FragmentVariable, indent: string): Promise<{ value: string; known: boolean }> => {
    if (v.default !== undefined) return { value: v.default.replace(/&/g, '&amp;').replace(/"/g, '&quot;'), known: true };
    const example = v.type ? await shapes.example(header, v.type, { strings: 'empty', indent, unit: indentUnit(document) }) : undefined;
    if (!example) return { value: '', known: false };
    if (example.csharp === '""') return { value: '', known: true };
    return { value: `@(${escapeForDocument(example.csharp, isEscapedFormat(cache.get(document)), false)})`, known: true };
  };

  /**
   * Where `name` is declared for a `set-variable` in `document`: an `@in` of a fragment it
   * includes, or (in a fragment) its own `@out` or `@internal`, with the header and its file.
   */
  const declaredFor = async (document: vscode.TextDocument, name: string): Promise<{ header: FragmentDoc; v: FragmentVariable; uri: vscode.Uri } | undefined> => {
    const summary = summaryOf(document);
    for (const id of new Set(summary.includes)) {
      const f = await index.fragment(id, document.uri);
      const v = f?.summary.header?.inputs.find((x) => x.name === name);
      if (f?.summary.header && v) return { header: f.summary.header, v, uri: f.uri };
    }
    const own = summary.header;
    const v = own && [...own.outputs, ...own.internals].find((x) => x.name === name);
    return own && v ? { header: own, v, uri: document.uri } : undefined;
  };

  /** The `set-variable` at `offset` whose value is still empty (`""`, `@()`, `@{}`), and what it sets. */
  const emptySetVariable = (document: vscode.TextDocument, offset: number) => {
    const doc = cache.get(document);
    const element = [...nodeAt(doc, offset).path].reverse().find((e) => e.name === 'set-variable');
    const name = element?.attributes.find((a) => a.name === 'name' && !a.expression)?.value?.trim();
    const value = element?.attributes.find((a) => a.name === 'value');
    if (!element || !name || !value?.valueRange || !/^\s*(@\(\s*\)|@\{\s*\})?\s*$/.test(value.value ?? '')) return undefined;
    const line = document.lineAt(document.positionAt(element.range.start).line);
    return { name, range: toRange(document, value.valueRange), indent: line.text.slice(0, line.firstNonWhitespaceCharacterIndex) };
  };

  /** On a `set-variable` with an empty value for a variable whose type is declared: fill the value in. */
  const fillValue = async (document: vscode.TextDocument, range: vscode.Range): Promise<vscode.CodeAction[]> => {
    const target = emptySetVariable(document, document.offsetAt(range.start));
    const declared = target && (await declaredFor(document, target.name));
    if (!target || !declared) return [];
    const { value, known } = await valueFor(document, declared.header, declared.v, target.indent);
    if (!known || !value) return [];
    const action = new vscode.CodeAction(`Fill in '${target.name}'${declared.v.type ? ` (${declared.v.type})` : ''}`, vscode.CodeActionKind.QuickFix);
    action.edit = new vscode.WorkspaceEdit();
    action.edit.replace(document.uri, target.range, value);
    action.isPreferred = true;
    return [action];
  };

  /**
   * On `new JObject { … }` in a fragment: name its shape as a `@typedef` in the header (made if
   * there isn't one), with the cursor on the name.
   */
  const extractTypedef = async (document: vscode.TextDocument, range: vscode.Range): Promise<vscode.CodeAction[]> => {
    const doc = cache.get(document);
    const root = doc.root;
    if (root?.name !== 'fragment') return [];
    const offset = document.offsetAt(range.start);
    const expr = expressionAt(doc, offset);
    const code = expr?.map.toGenerated(offset);
    if (!expr || code === undefined) return [];
    // Named for the variable it's the value of, when it is one.
    const element = [...nodeAt(doc, offset).path].reverse().find((e) => e.name === 'set-variable');
    const variable = element?.attributes.find((a) => a.name === 'name' && !a.expression)?.value?.trim() ?? 'shape';
    const header = summaryOf(document).header;
    const generated = await shapes.typedefsForCreated(doc, expr, code, variable, new Set(header?.typedefDocs.keys() ?? []));
    if (!generated) return [];
    const action = new vscode.CodeAction('Extract this JObject shape to a @typedef', vscode.CodeActionKind.RefactorExtract);
    action.edit = new vscode.WorkspaceEdit();
    const edit = header && (await rewriteHeader(document, header, (model, stop) => void named(model, stop, generated)));
    if (edit) action.edit.set(document.uri, [edit]);
    else if (!header) {
      const stops = tabStops();
      const model: HeaderModel = { summary: [], entries: [] };
      named(model, stops.stop, generated);
      const at = document.positionAt(root.range.start);
      action.edit.set(document.uri, [new vscode.SnippetTextEdit(new vscode.Range(at, at), new vscode.SnippetString(`${stops.snippet(renderHeader(model, '', indentUnit(document)))}\n`))]);
    } else return [];
    return [action];
  };

  /** On an include: set every input the fragment takes that nothing earlier sets, required and optional. */
  const setEveryInput = async (document: vscode.TextDocument, summary: PolicySummary, range: vscode.Range): Promise<vscode.CodeAction[]> => {
    const site = summary.includeSites.find((s) => toRange(document, s.range).intersection(range));
    const element = site && nodeAt(cache.get(document), site.range.start).element;
    if (!site || element?.name !== 'include-fragment') return [];
    const header = (await index.fragment(site.id, document.uri))?.summary.header;
    if (!header?.inputs.length) return [];
    const outer = await index.outerVariables(document);
    const before = new Set([...summary.variables.filter((v) => v.range.start < site.range.start).map((v) => v.name), ...outer.filter((o) => o.at < site.range.start).map((o) => o.name), ...(summary.header?.inputs.map((v) => v.name) ?? [])]);
    const unset = header.inputs.filter((v) => !before.has(v.name));
    if (!unset.length) return [];
    const line = document.lineAt(document.positionAt(element.range.start).line);
    const indent = line.text.slice(0, line.firstNonWhitespaceCharacterIndex);
    const text = (await Promise.all(unset.map((v) => inputLine(document, header, v, indent)))).join('');
    const action = new vscode.CodeAction(`Set every input of '${site.id}' (${unset.length})`, vscode.CodeActionKind.QuickFix);
    action.edit = new vscode.WorkspaceEdit();
    action.edit.insert(document.uri, new vscode.Position(line.lineNumber, 0), text);
    return [action];
  };

  /** Rewrites each flagged read to GetValueOrDefault, escaped for the document's format. */
  const useGetValueOrDefault = async (document: vscode.TextDocument, summary: PolicySummary, diagnostics: vscode.Diagnostic[]) => {
    const doc = cache.get(document);
    const sets = await setsFor(summary, document.uri);
    const reads = unguardedReads(doc, summary.header, (id) => sets.get(id));
    const escaped = isEscapedFormat(doc);
    const out: vscode.CodeAction[] = [];
    for (const d of diagnostics) {
      const r = reads.find((x) => x.range.start === document.offsetAt(d.range.start));
      if (!r?.fix) continue;
      const inCData = doc.source.lastIndexOf('<![CDATA[', r.fix.expression.range.start) > doc.source.lastIndexOf(']]>', r.fix.expression.range.start);
      const action = new vscode.CodeAction(`Use GetValueOrDefault for '${r.name}'`, vscode.CodeActionKind.QuickFix);
      action.edit = new vscode.WorkspaceEdit();
      action.edit.replace(document.uri, toRange(document, r.fix.range), escapeForDocument(r.fix.code, escaped, inCData));
      action.diagnostics = [d];
      action.isPreferred = true;
      out.push(action);
    }
    return out;
  };

  /** What files that include this fragment read: the variables that should be its @outs. */
  const publicNames = async (document: vscode.TextDocument): Promise<Set<string>> => {
    const scope = document.uri.scheme === 'file' ? undefined : scopeFromInstancePath(document.uri.path);
    const ids = scope?.kind === 'fragment' ? [scope.fragment] : fragmentIdsFor(document.uri.path);
    const callers = await index.callers(ids);
    return new Set(callers.flatMap((c) => c.summary.reads.map((r) => r.name)));
  };

  // ---- expansions -----------------------------------------------------------------------------

  /** `<!--` where the header goes expands to a drafted header; `@in`/`@out` inside it to a tag line. */
  const expansions: vscode.CompletionItemProvider = {
    async provideCompletionItems(document, position) {
      const doc = cache.get(document);
      const offset = document.offsetAt(position);
      // An empty set-variable value for a variable whose type is declared: offer one filled in.
      const target = emptySetVariable(document, offset);
      const declared = target && (await declaredFor(document, target.name));
      if (target && declared) {
        const { value, known } = await valueFor(document, declared.header, declared.v, target.indent);
        if (!known || !value) return undefined;
        const item = new vscode.CompletionItem(declared.v.type ? `${declared.v.type} value` : 'Default value', vscode.CompletionItemKind.Snippet);
        item.insertText = value;
        item.range = target.range;
        item.detail = `${declared.v.optional ? 'optional ' : ''}@${declared.uri.toString() === document.uri.toString() ? 'out/@internal' : 'in'} ${declared.v.name}${declared.v.description ? `: ${declared.v.description}` : ''}`;
        item.filterText = document.getText(target.range);
        item.sortText = '0';
        item.preselect = true;
        return [item];
      }
      if (doc.root?.name !== 'fragment') return undefined;
      // Shapes cost an engine pass, so only where an expansion can be offered.
      const wanted = headerExpansions(doc, offset, '').length > 0;
      const shapeText = wanted ? await shapes.typeTexts(doc) : undefined;
      const items = headerExpansions(doc, offset, indentUnit(document), shapeText, wanted ? await publicNames(document) : undefined, wanted ? await shapes.draftTypedefs(doc) : undefined);
      if (!items.length) return undefined;
      return items.map((x) => {
        const item = new vscode.CompletionItem(x.label, vscode.CompletionItemKind.Snippet);
        item.insertText = new vscode.SnippetString(x.snippet);
        item.range = toRange(document, x.replace);
        item.detail = x.detail;
        item.sortText = x.sortText;
        // VS Code filters by what's typed in the range: `<!--` for the header, `@i` for a tag.
        const typed = document.getText(new vscode.Range(item.range.start, position));
        if (!x.label.startsWith(typed)) item.filterText = `${typed} ${x.label}`;
        return item;
      }).filter((item) => (item.range as vscode.Range).isSingleLine);
    },
  };

  vscode.workspace.textDocuments.forEach((d) => schedule(d, 0));
  return vscode.Disposable.from(
    collection,
    vscode.languages.registerCompletionItemProvider(LANGUAGE_ID, expansions, '@', '-', '"', '('),
    vscode.languages.registerDefinitionProvider(LANGUAGE_ID, {
      // From a set-variable's name to where its variable is declared: the @in of the fragment it's
      // for, or this fragment's own @out / @internal line.
      async provideDefinition(document, position) {
        const typedef = typedefUseAt(document, position);
        if (typedef) return [typedef];
        const hit = nodeAt(cache.get(document), document.offsetAt(position));
        if (hit.element?.name !== 'set-variable' || hit.attribute?.name !== 'name' || !hit.onAttributeValue || !hit.attribute.valueRange) return undefined;
        const name = hit.attribute.value?.trim();
        const declared = name && (await declaredFor(document, name));
        if (!declared) return undefined;
        const target = await vscode.workspace.openTextDocument(declared.uri);
        return [{ originSelectionRange: toRange(document, hit.attribute.valueRange), targetUri: declared.uri, targetRange: toRange(target, declared.v.range) } satisfies vscode.LocationLink];
      },
    }),
    hintsChanged,
    vscode.languages.registerInlayHintsProvider(LANGUAGE_ID, inlayHints),
    vscode.languages.registerHoverProvider(LANGUAGE_ID, hover),
    vscode.languages.registerCodeActionsProvider(LANGUAGE_ID, actions, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix, vscode.CodeActionKind.RefactorRewrite, vscode.CodeActionKind.RefactorExtract] }),
    vscode.workspace.onDidOpenTextDocument((d) => schedule(d, 0)),
    vscode.workspace.onDidChangeTextDocument((e) => schedule(e.document)),
    vscode.workspace.onDidCloseTextDocument((d) => collection.delete(d.uri)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('apimPolicy.lint')) {
        refreshAll();
        hintsChanged.fire();
      }
    }),
    // A fragment's header changing changes every include of it.
    index.onDidChange(() => {
      hintsChanged.fire();
      refreshAll();
    }),
    { dispose: () => timers.forEach(clearTimeout) },
  );
}

/** One side of an include's hint: `in: a, b?` with each name hoverable and clickable. */
function side(label: 'in' | 'out', vars: readonly FragmentVariable[], uri: vscode.Uri, separated = false): vscode.InlayHintLabelPart[] {
  if (!vars.length) return [];
  const parts: vscode.InlayHintLabelPart[] = [new vscode.InlayHintLabelPart(`${separated ? ' · ' : ''}${label}: `)];
  vars.slice(0, HINT_NAMES).forEach((v, i) => {
    const part = new vscode.InlayHintLabelPart(`${i ? ', ' : ''}${v.name}${v.optional ? '?' : ''}`);
    part.tooltip = variableMarkdown(label, v);
    part.location = new vscode.Location(uri, new vscode.Position(0, 0));
    parts.push(part);
  });
  if (vars.length > HINT_NAMES) parts.push(new vscode.InlayHintLabelPart(`, +${vars.length - HINT_NAMES}`));
  return parts;
}

function variableMarkdown(kind: 'in' | 'out', v: FragmentVariable): vscode.MarkdownString {
  // Header text comes from workspace files, so it goes in as text, never as Markdown.
  const md = new vscode.MarkdownString().appendCodeblock(`@${kind} ${v.type ? `{${v.type}} ` : ''}${v.optional ? `[${v.name}${v.default !== undefined ? `=${v.default}` : ''}]` : v.name}`, 'text');
  if (v.description) md.appendText(v.description);
  return md;
}

function typedefMarkdown(name: string, example: { shape: string; json: string; csharp: string }, doc?: TypedefDoc): vscode.MarkdownString {
  // Shapes, descriptions and examples come from workspace files: code blocks and text, never Markdown.
  const md = new vscode.MarkdownString().appendMarkdown('**@typedef** ').appendText(name);
  if (doc?.description) md.appendMarkdown('\n\n').appendText(doc.description);
  md.appendCodeblock(example.shape, 'typescript');
  const described = doc?.properties.filter((p) => p.description) ?? [];
  for (const p of described) md.appendMarkdown('- `').appendText(p.name).appendMarkdown('`: ').appendText(p.description).appendMarkdown('\n');
  md.appendMarkdown('Every key filled in:');
  md.appendCodeblock(example.json, 'json');
  md.appendMarkdown('Built in a policy expression:');
  md.appendCodeblock(example.csharp, 'csharp');
  return md;
}

function headerMarkdown(id: string, header: FragmentDoc): vscode.MarkdownString {
  const md = new vscode.MarkdownString().appendMarkdown('**Fragment** ').appendText(id);
  if (header.summary) md.appendMarkdown('\n\n').appendText(header.summary);
  const list = (title: string, vars: readonly FragmentVariable[]) => {
    if (!vars.length) return;
    md.appendMarkdown(`\n\n**${title}**\n`);
    for (const v of vars) {
      md.appendMarkdown('\n- `').appendText(v.name).appendMarkdown('`');
      if (v.type) md.appendMarkdown(' *').appendText(v.type).appendMarkdown('*');
      // A default goes in a code span: as text, a URL would be linked along with what follows it.
      if (v.optional) md.appendMarkdown(v.default !== undefined ? ` (optional, default \`${v.default.replace(/`/g, "'")}\`)` : ' (optional)');
      else if (title.startsWith('Takes')) md.appendMarkdown(' (required)');
      if (v.description) md.appendText(` — ${v.description}`);
    }
  };
  list('Takes (@in)', header.inputs);
  list('Sets (@out)', header.outputs);
  return md;
}

/** Where a new `@in` line goes: after the last input, else before the first tag, else before `-->`. */
function tagInsertion(document: vscode.TextDocument, header: FragmentDoc, kind: 'in' | 'out' | 'internal' = 'in'): { position: vscode.Position; indent: string } {
  const lineOf = (offset: number) => document.lineAt(document.positionAt(offset).line);
  /** The line after `v`'s, past any continuation lines of its description. */
  const after = (v: FragmentVariable) => {
    let n = lineOf(v.range.start).lineNumber;
    while (n + 1 < document.lineCount && /^\s+[^\s@-]/.test(document.lineAt(n + 1).text) && document.offsetAt(new vscode.Position(n + 1, 0)) < header.range.end - 3) n++;
    return new vscode.Position(n + 1, 0);
  };
  const indentOf = (v: FragmentVariable) => {
    const line = lineOf(v.range.start);
    return line.text.slice(0, line.firstNonWhitespaceCharacterIndex);
  };
  // Its own group if there is one; else after the groups that come before it, else before the ones after.
  const groups = { in: header.inputs, out: header.outputs, internal: header.internals };
  const order: ('in' | 'out' | 'internal')[] = ['in', 'out', 'internal'];
  const own = groups[kind].at(-1);
  if (own) return { position: after(own), indent: indentOf(own) };
  const before = order.slice(0, order.indexOf(kind)).map((k) => groups[k].at(-1)).filter((v): v is FragmentVariable => !!v).at(-1);
  if (before) return { position: after(before), indent: indentOf(before) };
  const next = order.slice(order.indexOf(kind) + 1).map((k) => groups[k][0]).find((v): v is FragmentVariable => !!v);
  if (next) return { position: new vscode.Position(lineOf(next.range.start).lineNumber, 0), indent: indentOf(next) };
  return { position: new vscode.Position(lineOf(header.range.end).lineNumber, 0), indent: '    ' };
}

/** Whether a header type is an inline JSON shape (`{ … }`, `{ … }[]`) rather than a name. */
function inlineShape(type: string): boolean {
  return /^\{|\}(\[\])?$/.test(type.trim());
}

/**
 * Adds generated typedefs to `model` with the root's name as a tab stop, and gives the type for a
 * tag (`Kept[]`, with the same stop).
 */
function named(model: HeaderModel, stop: (text: string, key?: string) => string, generated: GeneratedTypedefs): string {
  const sentinel = stop(generated.name, `typedef:${generated.name}`);
  const entries = generated.entries.map((e) => (e.kind === 'typedef' && e.name === generated.name ? { ...e, name: sentinel } : e));
  insertTypedefs(model, entries);
  return generated.type === generated.name ? sentinel : `${sentinel}[]`;
}

/** Generated typedef entries, the root keeping the description it had. */
/**
 * A typedef for an inline object type (`{ rules: UserRule[] }`, or an array of one), from the text as
 * written so the typedefs it names stay references. Undefined for text this can't split.
 */
function typedefFromText(typeText: string, variable: string, taken: Set<string>): GeneratedTypedefs | undefined {
  const m = /^(\{[\s\S]*\})(\[\])?$/.exec(typeText.trim()) ?? /^JArray<(\{[\s\S]*\})>()$/.exec(typeText.trim());
  const array = !!m && (m[2] === '[]' || typeText.trim().startsWith('JArray<'));
  const props = m && propertiesOfTypeText(m[1]);
  if (!props?.length) return undefined;
  const base = typeNameFor(variable, array);
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base}${i}`;
  taken.add(name);
  const entries: HeaderEntry[] = [
    { kind: 'typedef', name, optional: false, description: [] },
    ...props.map((p): HeaderEntry => ({ kind: 'property', name: p.name, type: p.type, optional: p.optional, description: [] })),
  ];
  return { type: array ? `${name}[]` : name, name, entries };
}

function withDescription(entries: HeaderEntry[], description: string[]): HeaderEntry[] {
  return entries.map((e, i) => (i === 0 ? { ...e, description } : e));
}

/** A new tag line as a snippet, with the cursor left where its description goes. */
function tagSnippet(at: { position: vscode.Position; indent: string }, kind: 'in' | 'out' | 'internal', name: string, type: string | undefined): vscode.SnippetTextEdit {
  const lit = (t: string) => t.replace(/[$}\\]/g, '\\$&');
  const tag = `@${kind}`.padEnd(4);
  return new vscode.SnippetTextEdit(new vscode.Range(at.position, at.position), new vscode.SnippetString(`${at.indent}${tag} ${type ? `{${lit(type)}} ` : ''}${lit(name)}  \${1:description}\n`));
}

/** One level of indentation in `document`'s editor, or four spaces. */
function indentUnit(document: vscode.TextDocument): string {
  const editor = vscode.window.visibleTextEditors.find((e) => e.document === document);
  const tabSize = typeof editor?.options.tabSize === 'number' ? editor.options.tabSize : 4;
  return editor?.options.insertSpaces === false ? '\t' : ' '.repeat(tabSize);
}
