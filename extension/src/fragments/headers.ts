import * as vscode from 'vscode';
import { LANGUAGE_ID, toRange, type DocumentCache } from '../documents';
import { expressionAt, isEscapedFormat, nodeAt } from '@apim-policy/document';
import {
  checkIncludes,
  draftModel,
  emptySetVariable,
  fragmentDiagnostics,
  type FragmentDoc,
  type FragmentVariable,
  guardedRead,
  headerExpansions,
  headerFor,
  type HintPart,
  includeHints,
  inferredTypes,
  inlineShape,
  inputUse,
  insertTag,
  type Level,
  namedTypedefs,
  outputsFirst,
  type PolicySummary,
  renderHeader,
  rewriteHeader,
  summarize,
  tagInsertion,
  type TagKind,
  tagLine,
  typedefAsProperties,
  typedefFromText,
  typedefNameAt,
  type TypedefDoc,
  typedefReferenceAt,
  unguardedReads,
  variableFamily,
} from '@apim-policy/analysis';
import { declarationOf, includedFragments, inputLine, type Layout, type PolicyIndex, type ShapeService, typeForTag, valueFor } from '@apim-policy/workspace';

/**
 * Fragment headers (`@in` / `@out`, see fragmentDoc.ts in @apim-policy/analysis) in the editor:
 * an inlay hint after each include-fragment listing what the fragment takes and sets, hover on its
 * fragment-id, diagnostics for a header that disagrees with its fragment and for an include that
 * leaves a required input unset, and code actions that write the header. What each one says and
 * edits is worked out in @apim-policy/analysis and @apim-policy/workspace; this turns it into
 * VS Code's objects.
 */
export function registerFragmentDocs(cache: DocumentCache, index: PolicyIndex<vscode.Uri>, shapes: ShapeService<vscode.Uri>): vscode.Disposable {
  const summaryOf = (document: vscode.TextDocument) => summarize(cache.get(document));
  const layout = (document: vscode.TextDocument, indent: string): Layout => ({ indent, unit: indentUnit(document), escaped: isEscapedFormat(cache.get(document)) });
  const snippet = (document: vscode.TextDocument, range: { start: number; end: number }, text: string) => new vscode.SnippetTextEdit(toRange(document, range), new vscode.SnippetString(text));
  const level = (key: string, fallback: string): Level | 'off' => {
    const s = vscode.workspace.getConfiguration('apimPolicy').get<string>(key, fallback);
    return s === 'warning' ? 'warning' : s === 'information' ? 'information' : 'off';
  };
  const severity = (l: Level) => (l === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information);

  const hintsChanged = new vscode.EventEmitter<void>();
  const collection = vscode.languages.createDiagnosticCollection('apim-fragments');
  const timers = new Map<string, NodeJS.Timeout>();

  const refresh = async (document: vscode.TextDocument) => {
    if (document.languageId !== LANGUAGE_ID || document.isClosed) return;
    const version = document.version;
    const doc = cache.get(document);
    const summary = summarize(doc);
    const unguarded = level('lint.unguardedVariableAccess', 'off');
    const includes = await includedFragments(index, document.uri, summary);
    // What broader scopes on the connected instance set; only fetched when something uses it.
    const outer = summary.includeSites.length || unguarded !== 'off' ? await index.outerVariables(document.uri, doc) : [];
    if (document.isClosed || document.version !== version) return;
    const found = fragmentDiagnostics(doc, summary, includes, outer, { missingInput: level('lint.missingInput', 'warning'), unguarded: unguarded === 'off' ? undefined : unguarded });
    collection.set(
      document.uri,
      found.map((f) => {
        const d = new vscode.Diagnostic(toRange(document, f.range), f.message, severity(f.severity));
        d.source = 'apim';
        d.code = f.code;
        if (f.unnecessary) d.tags = [vscode.DiagnosticTag.Unnecessary];
        return d;
      }),
    );
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
      const doc = cache.get(document);
      const summary = summarize(doc);
      if (!summary.includeSites.length) return [];
      const includes = await includedFragments(index, document.uri, summary);
      const outer = await index.outerVariables(document.uri, doc);
      const hints: vscode.InlayHint[] = [];
      for (const h of includeHints(summary, (id) => includes.header(id), outer)) {
        const position = document.positionAt(h.at);
        if (!range.contains(position)) continue;
        const uri = includes.headers.get(h.id)!.uri;
        const hint = new vscode.InlayHint(position, h.parts.map((p) => hintPart(p, uri)));
        hint.paddingLeft = true;
        hints.push(hint);
      }
      return hints;
    },
  };

  // ---- hover --------------------------------------------------------------------------------------

  const hover: vscode.HoverProvider = {
    async provideHover(document, position) {
      // A @typedef name in the header (where it's defined, or used in a tag's type): its shape and an example.
      const own = summaryOf(document).header;
      const offset = document.offsetAt(position);
      if (own && offset > own.range.start && offset < own.range.end) {
        const word = typedefNameAt(document.getText(), own, offset);
        const example = word && (await shapes.example(own, word.name));
        return word && example ? new vscode.Hover(typedefMarkdown(word.name, example, own.typedefDocs.get(word.name)), toRange(document, word.range)) : undefined;
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

  const fix = (title: string, kind: vscode.CodeActionKind, edit: (e: vscode.WorkspaceEdit) => void, options: { diagnostics?: vscode.Diagnostic[]; preferred?: boolean } = {}) => {
    const a = new vscode.CodeAction(title, kind);
    a.edit = new vscode.WorkspaceEdit();
    edit(a.edit);
    if (options.diagnostics) a.diagnostics = options.diagnostics;
    if (options.preferred) a.isPreferred = true;
    return a;
  };

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
      if (maybeUnset.length) out.push(...setOutputsFirst(document, summary, maybeUnset));
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
          const at = tagInsertion(document.getText(), header);
          out.push(
            fix(`Document '${name}' as @in${use.optional ? ' (optional)' : ''}`, vscode.CodeActionKind.QuickFix, (e) => e.set(document.uri, [snippet(document, { start: at.offset, end: at.offset }, tagLine(at.indent, 'in', label, use.type))]), {
              diagnostics: context.diagnostics.filter((d) => d.code === 'fragment-in-undocumented' && document.getText(d.range) === name),
            }),
          );
        }
        out.push(...(await declareVariables(document, header, context.diagnostics.filter((d) => d.code === 'fragment-var-undeclared'))));
        return out;
      }
      // No header yet: offer one on the fragment element, drafted from what the fragment does.
      const doc = cache.get(document);
      const root = doc.root;
      if (root?.name !== 'fragment' || !toRange(document, root.startTag).intersection(range)) return out;
      const text = `${renderHeader(draftModel(doc, summary, undefined, await shapes.typeTexts(doc), await index.readByCallers(document.uri), await shapes.draftTypedefs(doc)), '', indentUnit(document))}\n`;
      out.push(fix('Add a header documenting @in and @out', vscode.CodeActionKind.RefactorRewrite, (e) => e.insert(document.uri, document.positionAt(root.range.start), text)));
      return out;
    },
  };

  /** The include element whose fragment-id starts at `offset`, with the indent of its line. */
  const includeAt = (document: vscode.TextDocument, offset: number) => {
    const element = nodeAt(cache.get(document), offset).element;
    if (element?.name !== 'include-fragment') return undefined;
    const line = document.lineAt(document.positionAt(element.range.start).line);
    return { line: line.lineNumber, indent: line.text.slice(0, line.firstNonWhitespaceCharacterIndex) };
  };

  /** For each include missing required inputs: set-variable lines for them, just above it. */
  const setInputs = async (document: vscode.TextDocument, summary: PolicySummary, diagnostics: vscode.Diagnostic[]) => {
    const includes = await includedFragments(index, document.uri, summary);
    const problems = checkIncludes(summary.includeSites, summary.variables, summary.header?.inputs.map((v) => v.name) ?? [], (id) => includes.header(id));
    const out: vscode.CodeAction[] = [];
    for (const d of diagnostics) {
      const offset = document.offsetAt(d.range.start);
      const absent = problems.find((p) => p.range.start === offset)?.missing ?? [];
      const site = summary.includeSites.find((s) => s.range.start === offset);
      const at = includeAt(document, offset);
      const header = site && includes.header(site.id);
      if (!absent.length || !site || !at || !header) continue;
      const text = (await Promise.all(absent.map((name) => inputLine(shapes, header, header.inputs.find((v) => v.name === name) ?? { name, optional: false, description: '', range: { start: 0, end: 0 } }, layout(document, at.indent))))).join('');
      const title = absent.length === 1 ? `Set '${absent[0]}' before this include` : `Set the ${absent.length} required inputs before this include`;
      out.push(fix(title, vscode.CodeActionKind.QuickFix, (e) => e.insert(document.uri, new vscode.Position(at.line, 0), text), { diagnostics: [d], preferred: true }));
    }
    return out;
  };

  /** On an include: set every input the fragment takes that nothing earlier sets, required and optional. */
  const setEveryInput = async (document: vscode.TextDocument, summary: PolicySummary, range: vscode.Range): Promise<vscode.CodeAction[]> => {
    const site = summary.includeSites.find((s) => toRange(document, s.range).intersection(range));
    const at = site && includeAt(document, site.range.start);
    if (!site || !at) return [];
    const header = (await index.fragment(site.id, document.uri))?.summary.header;
    if (!header?.inputs.length) return [];
    const outer = await index.outerVariables(document.uri, cache.get(document));
    const before = new Set([...summary.variables.filter((v) => v.range.start < site.range.start).map((v) => v.name), ...outer.filter((o) => o.at < site.range.start).map((o) => o.name), ...(summary.header?.inputs.map((v) => v.name) ?? [])]);
    const unset = header.inputs.filter((v) => !before.has(v.name));
    if (!unset.length) return [];
    const text = (await Promise.all(unset.map((v) => inputLine(shapes, header, v, layout(document, at.indent))))).join('');
    return [fix(`Set every input of '${site.id}' (${unset.length})`, vscode.CodeActionKind.QuickFix, (e) => e.insert(document.uri, new vscode.Position(at.line, 0), text))];
  };

  /** On a `set-variable` with an empty value for a variable whose type is declared: fill the value in. */
  const fillValue = async (document: vscode.TextDocument, range: vscode.Range): Promise<vscode.CodeAction[]> => {
    const target = emptySetVariable(cache.get(document), document.offsetAt(range.start));
    const declared = target && (await declarationOf(index, document.uri, summaryOf(document), target.name));
    if (!target || !declared) return [];
    const { value, known } = await valueFor(shapes, declared.header, declared.v, layout(document, target.indent));
    if (!known || !value) return [];
    return [fix(`Fill in '${target.name}'${declared.v.type ? ` (${declared.v.type})` : ''}`, vscode.CodeActionKind.QuickFix, (e) => e.replace(document.uri, toRange(document, target.range), value), { preferred: true })];
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
    const edit = header
      ? await rewriteHeader(document.getText(), header, indentUnit(document), (model, stop) => void namedTypedefs(model, stop, generated))
      : headerFor(generated, indentUnit(document));
    if (edit === undefined) return [];
    const where = header ? header.range : { start: root.range.start, end: root.range.start };
    return [fix('Extract this JObject shape to a @typedef', vscode.CodeActionKind.RefactorExtract, (e) => e.set(document.uri, [snippet(document, where, edit)]))];
  };

  /**
   * For variables a documented fragment sets but doesn't declare: document one as @out or
   * @internal (typed from the code), or opt a family out with an @internal pattern.
   */
  const declareVariables = async (document: vscode.TextDocument, header: FragmentDoc, diagnostics: vscode.Diagnostic[]): Promise<vscode.CodeAction[]> => {
    const names = [...new Set(diagnostics.map((d) => document.getText(d.range)))];
    if (!names.length) return [];
    const doc = cache.get(document);
    const source = document.getText();
    const shapeText = await shapes.typeTexts(doc);
    const inferred = inferredTypes(doc).sets;
    const typeOf = (name: string) => shapeText(name) ?? inferred.get(name);
    const all = vscode.languages.getDiagnostics(document.uri).filter((d) => d.code === 'fragment-var-undeclared');
    const out: vscode.CodeAction[] = [];
    const action = (title: string, edit: vscode.SnippetTextEdit | vscode.TextEdit, fixes: vscode.Diagnostic[], preferred = false) =>
      out.push(fix(title, vscode.CodeActionKind.QuickFix, (e) => e.set(document.uri, [edit]), { diagnostics: fixes, preferred }));
    const insertLine = (kind: TagKind, line: string) => {
      const at = tagInsertion(source, header, kind);
      return vscode.TextEdit.insert(document.positionAt(at.offset), `${at.indent}${line}\n`);
    };
    /** Tags for `vars` (typed, typedefs made where needed), each description a tab stop. */
    const declare = async (vars: readonly string[], kind: 'out' | 'internal') => {
      const taken = new Set(header.typedefDocs.keys());
      const edit = await rewriteHeader(source, header, indentUnit(document), async (model, stop) => {
        for (const name of vars) {
          const type = await typeForTag(shapes, doc, model, stop, name, typeOf(name), taken);
          insertTag(model, { kind, name, type, optional: false, description: [stop('description', `description:${name}`)] });
        }
      });
      if (edit !== undefined) return snippet(document, header.range, edit);
      // A header the model can't hold: insert the line as it is.
      const at = tagInsertion(source, header, kind);
      return snippet(document, { start: at.offset, end: at.offset }, tagLine(at.indent, kind, vars[0], typeOf(vars[0])));
    };
    for (const name of names) {
      const mine = diagnostics.filter((d) => document.getText(d.range) === name);
      action(`Document '${name}' as @internal`, await declare([name], 'internal'), mine, true);
      action(`Document '${name}' as @out`, await declare([name], 'out'), mine);
      const family = variableFamily(name);
      if (family) action(`Treat every '${family}*' variable as internal`, insertLine('internal', `@internal ${family}*`), all.filter((d) => document.getText(d.range).startsWith(family)));
    }
    // Every undeclared variable at once, one typed line each, Tab moving through their descriptions.
    const everyName = [...new Set(all.map((d) => document.getText(d.range)))];
    if (everyName.length > 1) action(`Document every undeclared variable as @internal (${everyName.length})`, await declare(everyName, 'internal'), all);
    action('Treat every undocumented variable as internal (@internal *)', insertLine('internal', '@internal *'), all);
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
    const source = document.getText();
    const line = range.start.line;
    const onLine = (r: { start: number }) => document.positionAt(r.start).line === line;
    const doc = cache.get(document);
    const out: vscode.CodeAction[] = [];
    const rewrite = (title: string, kind: vscode.CodeActionKind, edit: string, preferred = false) => out.push(fix(title, kind, (e) => e.set(document.uri, [snippet(document, header.range, edit)]), { preferred }));
    const legacy = [...header.typedefDocs.values()].find((t) => t.legacy && onLine(t.range));
    if (legacy) {
      let split = true;
      const edit = await rewriteHeader(source, header, indentUnit(document), (model) => void (split = typedefAsProperties(header, legacy, model)));
      if (split && edit !== undefined) rewrite(`Write ${legacy.name} as @property lines`, vscode.CodeActionKind.RefactorRewrite, edit);
    }
    const tags: [TagKind, FragmentVariable][] = [
      ...header.inputs.map((v): [TagKind, FragmentVariable] => ['in', v]),
      ...header.outputs.map((v): [TagKind, FragmentVariable] => ['out', v]),
      ...header.internals.map((v): [TagKind, FragmentVariable] => ['internal', v]),
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
      const edit = generated && (await rewriteHeader(source, header, indentUnit(document), (model, stop) => {
        const entry = model.entries.find((e) => e.kind === kind && e.name === v.name);
        if (entry) entry.type = namedTypedefs(model, stop, generated);
      }));
      if (edit) rewrite(`Generate a @typedef for '${v.name}'`, vscode.CodeActionKind.QuickFix, edit, true);
    }
    return out;
  };

  /** Sets each output to an empty value at the start of the fragment, so every path leaves one. */
  const setOutputsFirst = (document: vscode.TextDocument, summary: PolicySummary, diagnostics: vscode.Diagnostic[]): vscode.CodeAction[] => {
    const names = diagnostics.map((d) => document.getText(d.range));
    const edit = outputsFirst(cache.get(document), summary, names, indentUnit(document));
    if (!edit) return [];
    const title = edit.count === 1 ? `Set '${names[0]}' at the start of the fragment` : `Set the ${edit.count} outputs at the start of the fragment`;
    return [fix(title, vscode.CodeActionKind.QuickFix, (e) => e.insert(document.uri, document.positionAt(edit.offset), edit.text), { diagnostics, preferred: true })];
  };

  /** Rewrites each flagged read to GetValueOrDefault, escaped for the document's format. */
  const useGetValueOrDefault = async (document: vscode.TextDocument, summary: PolicySummary, diagnostics: vscode.Diagnostic[]) => {
    const doc = cache.get(document);
    const includes = await includedFragments(index, document.uri, summary);
    const reads = unguardedReads(doc, summary.header, (id) => includes.sets(id));
    const out: vscode.CodeAction[] = [];
    for (const d of diagnostics) {
      const r = reads.find((x) => x.range.start === document.offsetAt(d.range.start));
      const edit = r && guardedRead(doc, r);
      if (!r || !edit) continue;
      out.push(fix(`Use GetValueOrDefault for '${r.name}'`, vscode.CodeActionKind.QuickFix, (e) => e.replace(document.uri, toRange(document, edit.range), edit.text), { diagnostics: [d], preferred: true }));
    }
    return out;
  };

  // ---- expansions -----------------------------------------------------------------------------

  /** `<!--` where the header goes expands to a drafted header; `@in`/`@out` inside it to a tag line. */
  const expansions: vscode.CompletionItemProvider = {
    async provideCompletionItems(document, position) {
      const doc = cache.get(document);
      const offset = document.offsetAt(position);
      // An empty set-variable value for a variable whose type is declared: offer one filled in.
      const target = emptySetVariable(doc, offset);
      const declared = target && (await declarationOf(index, document.uri, summarize(doc), target.name));
      if (target && declared) {
        const { value, known } = await valueFor(shapes, declared.header, declared.v, layout(document, target.indent));
        if (!known || !value) return undefined;
        const item = new vscode.CompletionItem(declared.v.type ? `${declared.v.type} value` : 'Default value', vscode.CompletionItemKind.Snippet);
        item.insertText = value;
        item.range = toRange(document, target.range);
        item.detail = `${declared.v.optional ? 'optional ' : ''}@${declared.own ? 'out/@internal' : 'in'} ${declared.v.name}${declared.v.description ? `: ${declared.v.description}` : ''}`;
        item.filterText = document.getText(item.range);
        item.sortText = '0';
        item.preselect = true;
        return [item];
      }
      if (doc.root?.name !== 'fragment') return undefined;
      // Shapes cost an engine pass, so only where an expansion can be offered.
      const wanted = headerExpansions(doc, offset, '').length > 0;
      const shapeText = wanted ? await shapes.typeTexts(doc) : undefined;
      const items = headerExpansions(doc, offset, indentUnit(document), shapeText, wanted ? await index.readByCallers(document.uri) : undefined, wanted ? await shapes.draftTypedefs(doc) : undefined);
      if (!items.length) return undefined;
      return items
        .map((x) => {
          const item = new vscode.CompletionItem(x.label, vscode.CompletionItemKind.Snippet);
          item.insertText = new vscode.SnippetString(x.snippet);
          item.range = toRange(document, x.replace);
          item.detail = x.detail;
          item.sortText = x.sortText;
          // VS Code filters by what's typed in the range: `<!--` for the header, `@i` for a tag.
          const typed = document.getText(new vscode.Range(item.range.start, position));
          if (!x.label.startsWith(typed)) item.filterText = `${typed} ${x.label}`;
          return item;
        })
        .filter((item) => (item.range as vscode.Range).isSingleLine);
    },
  };

  vscode.workspace.textDocuments.forEach((d) => schedule(d, 0));
  return vscode.Disposable.from(
    collection,
    vscode.languages.registerCompletionItemProvider(LANGUAGE_ID, expansions, '@', '-', '"', '('),
    vscode.languages.registerDefinitionProvider(LANGUAGE_ID, {
      // From a typedef name in a tag's type to its @typedef; from a set-variable's name to where its
      // variable is declared: the @in of the fragment it's for, or this fragment's own @out / @internal line.
      async provideDefinition(document, position) {
        const offset = document.offsetAt(position);
        const own = summaryOf(document).header;
        const ref = own && typedefReferenceAt(document.getText(), own, offset);
        if (ref) return [{ originSelectionRange: toRange(document, ref.range), targetUri: document.uri, targetRange: toRange(document, ref.typedef.block), targetSelectionRange: toRange(document, ref.typedef.range) } satisfies vscode.LocationLink];
        const hit = nodeAt(cache.get(document), offset);
        if (hit.element?.name !== 'set-variable' || hit.attribute?.name !== 'name' || !hit.onAttributeValue || !hit.attribute.valueRange) return undefined;
        const name = hit.attribute.value?.trim();
        const declared = name && (await declarationOf(index, document.uri, summaryOf(document), name));
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

/** One piece of an include's hint; a variable's shows its tag on hover and leads to the fragment. */
function hintPart(p: HintPart, uri: vscode.Uri): vscode.InlayHintLabelPart {
  const part = new vscode.InlayHintLabelPart(p.text);
  if (p.variable) {
    part.tooltip = variableMarkdown(p.variable.kind, p.variable.v);
    part.location = new vscode.Location(uri, new vscode.Position(0, 0));
  }
  return part;
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

/** One level of indentation in `document`'s editor, or four spaces. */
function indentUnit(document: vscode.TextDocument): string {
  const editor = vscode.window.visibleTextEditors.find((e) => e.document === document);
  const tabSize = typeof editor?.options.tabSize === 'number' ? editor.options.tabSize : 4;
  return editor?.options.insertSpaces === false ? '\t' : ' '.repeat(tabSize);
}
