/**
 * Reads assets/ApimContext.cs into type definitions for the engine. It understands the shapes the
 * stubs use: a namespace with usings, interfaces, sealed and static classes, and enums, whose
 * members are properties (`{ get; }` or `=> throw null`), indexers, methods, constructors and enum
 * values, each with an optional `///` summary.
 */

import { lexAll, PREDEFINED_TYPES, type Token } from './lexer';
import { readType } from './parser';
import type { TypeNode } from './syntax';
import type { Location, MemberDef, ParamDef, RawModel, TypeDef, TypeKind, TypeRef } from './model';

/** Parses the stub source. `raw` is the BCL model, used to resolve type names through the usings. */
export function readStubs(source: string, raw: RawModel): TypeDef[] {
  // Preprocessor lines aren't C# tokens; blank them so offsets stay put.
  const text = source.replace(/^[ \t]*#.*$/gm, (m) => ' '.repeat(m.length));
  const { tokens, trivia } = lexAll(text);
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
  const locate = (offset: number): Location => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo, character: offset - lineStarts[lo] };
  };
  const docBefore = (offset: number): string | undefined => {
    const lines: string[] = [];
    let at = offset;
    for (let k = trivia.length - 1; k >= 0; k--) {
      const c = trivia[k];
      if (c.end > at) continue;
      if (c.kind !== 'docComment' || text.slice(c.end, at).trim() !== '') break;
      lines.unshift(text.slice(c.start + 3, c.end).trim());
      at = c.start;
    }
    return summary(lines);
  };

  const defs: TypeDef[] = [];
  const usings: string[] = [];
  let namespace = '';
  let i = 0;
  const t = (k = i) => tokens[k];
  const isText = (s: string, k = i) => tokens[k].text === s && tokens[k].kind !== 'string';

  /** Skips a balanced `{ ... }` (or to the next `;` at depth 0) starting at `i`. */
  const skipMember = () => {
    let depth = 0;
    while (t().kind !== 'eof') {
      const x = t().text;
      if (x === '{') depth++;
      else if (x === '}') {
        if (depth === 0) return;
        depth--;
        if (depth === 0) {
          i++;
          return;
        }
      } else if (x === ';' && depth === 0) {
        i++;
        return;
      }
      i++;
    }
  };

  const pending: { def: TypeDef; typeNode: { base: TypeNode[] }; scope: string[] }[] = [];

  while (t().kind !== 'eof') {
    if (isText('namespace')) {
      i++;
      const parts: string[] = [];
      while (t().kind === 'ident') {
        parts.push(t().text);
        i++;
        if (isText('.')) i++;
        else break;
      }
      namespace = parts.join('.');
      if (isText('{')) i++;
      continue;
    }
    if (isText('using')) {
      i++;
      const parts: string[] = [];
      while (t().kind === 'ident') {
        parts.push(t().text);
        i++;
        if (isText('.')) i++;
        else break;
      }
      usings.push(parts.join('.'));
      if (isText(';')) i++;
      continue;
    }
    // A type declaration: modifiers, then interface/class/struct/enum.
    const declStart = t().start;
    const modifiers = new Set<string>();
    while (['public', 'internal', 'sealed', 'static', 'abstract', 'partial'].includes(t().text)) modifiers.add(tokens[i++].text);
    const kindTok = t();
    if (!['interface', 'class', 'struct', 'enum'].includes(kindTok.text)) {
      i++;
      continue;
    }
    i++;
    const nameTok = t();
    i++;
    const typeParams: string[] = [];
    if (isText('<')) {
      i++;
      while (t().kind === 'ident') {
        typeParams.push(tokens[i++].text);
        if (isText(',')) i++;
      }
      if (isText('>')) i++;
    }
    const bases: TypeNode[] = [];
    if (isText(':')) {
      i++;
      for (;;) {
        const r = readType(text, tokens, i);
        bases.push(r.type);
        i = r.pos;
        if (isText(',')) i++;
        else break;
      }
    }
    const def: TypeDef = {
      key: `${namespace}.${nameTok.text}${typeParams.length ? `\`${typeParams.length}` : ''}`,
      name: nameTok.text,
      namespace,
      kind: kindTok.text as TypeKind,
      typeParams,
      variance: [],
      isStatic: modifiers.has('static'),
      isAbstract: modifiers.has('abstract'),
      interfaces: [],
      members: [],
      doc: docBefore(declStart),
      origin: 'stub',
      location: locate(nameTok.start),
    };
    defs.push(def);
    pending.push({ def, typeNode: { base: bases }, scope: typeParams });
    if (!isText('{')) continue;
    i++;
    // Members.
    while (t().kind !== 'eof' && !isText('}')) {
      const memberStart = t().start;
      if (def.kind === 'enum') {
        if (t().kind === 'ident') {
          const n = t();
          def.members.push(member(def, { name: n.text, kind: 'enumMember', isStatic: true, type: { kind: 'named', key: def.key, args: [] }, doc: docBefore(memberStart), location: locate(n.start) }));
        }
        while (t().kind !== 'eof' && !isText(',') && !isText('}')) i++;
        if (isText(',')) i++;
        continue;
      }
      const mods = new Set<string>();
      while (['public', 'private', 'internal', 'protected', 'static', 'readonly', 'abstract', 'virtual', 'override', 'sealed', 'const'].includes(t().text)) mods.add(tokens[i++].text);
      if (mods.has('private') || mods.has('internal') || mods.has('protected')) {
        skipMember();
        continue;
      }
      const isStatic = mods.has('static') || mods.has('const');
      // Constructor: Name(
      if (t().kind === 'ident' && t().text === def.name && isText('(', i + 1)) {
        const n = t();
        i += 2;
        const params = readParams([...typeParams]);
        def.members.push(member(def, { name: '.ctor', kind: 'ctor', isStatic: false, type: { kind: 'named', key: def.key, args: [] }, params, doc: docBefore(memberStart), location: locate(n.start) }));
        skipMember();
        continue;
      }
      const typeRead = readType(text, tokens, i);
      if (!typeRead.ok) {
        skipMember();
        continue;
      }
      i = typeRead.pos;
      const n = t();
      if (n.kind === 'keyword' && n.text === 'this' && isText('[', i + 1)) {
        // T this[string name] { get; }
        i += 2;
        const params = readParams([...typeParams], ']');
        def.members.push(member(def, { name: 'this[]', kind: 'indexer', isStatic: false, type: toRef(typeRead.type, typeParams), params, doc: docBefore(memberStart), location: locate(n.start) }));
        skipMember();
        continue;
      }
      if (n.kind !== 'ident') {
        skipMember();
        continue;
      }
      i++;
      const methodTypeParams: string[] = [];
      if (isText('<')) {
        i++;
        while (t().kind === 'ident') {
          methodTypeParams.push(tokens[i++].text);
          if (isText(',')) i++;
        }
        if (isText('>')) i++;
      }
      const scope = [...typeParams, ...methodTypeParams];
      const doc = docBefore(memberStart);
      if (isText('(')) {
        i++;
        const params = readParams(scope);
        const isExtension = params[0]?.modifier === 'this';
        def.members.push(member(def, { name: n.text, kind: 'method', isStatic, isExtension, typeParams: methodTypeParams, type: toRef(typeRead.type, scope), params, doc, location: locate(n.start) }));
      } else {
        const writable = isText('{') && /\bset\s*;/.test(text.slice(t().start, text.indexOf('}', t().start)));
        def.members.push(member(def, { name: n.text, kind: mods.has('const') ? 'const' : 'property', isStatic, type: toRef(typeRead.type, scope), doc, writable, location: locate(n.start) }));
      }
      skipMember();
    }
    if (isText('}')) i++;
  }

  // Bases resolve once every stub type is known.
  for (const p of pending) {
    for (const b of p.typeNode.base) {
      const ref = toRef(b, p.scope);
      if (ref.kind !== 'named') continue;
      const isInterface = (raw.types[ref.key]?.k ?? defs.find((d) => d.key === ref.key)?.kind) === 'interface';
      if (isInterface || p.def.kind === 'interface') p.def.interfaces.push(ref);
      else p.def.base = ref;
    }
  }
  return defs;

  function readParams(scope: string[], close = ')'): ParamDef[] {
    const params: ParamDef[] = [];
    while (t().kind !== 'eof' && !isText(close)) {
      let modifier: ParamDef['modifier'];
      if (['this', 'out', 'ref', 'in', 'params'].includes(t().text)) modifier = tokens[i++].text as ParamDef['modifier'];
      const r = readType(text, tokens, i);
      i = r.pos;
      const name = t().kind === 'ident' ? tokens[i++].text : '';
      let defaultText: string | undefined;
      if (isText('=')) {
        i++;
        const start = t().start;
        while (t().kind !== 'eof' && !isText(',') && !isText(close)) i++;
        defaultText = text.slice(start, t().start).trim();
      }
      params.push({ name, type: toRef(r.type, scope), modifier, defaultText });
      if (isText(',')) i++;
      else break;
    }
    if (isText(close)) i++;
    return params;
  }

  function toRef(node: TypeNode, scope: string[]): TypeRef {
    switch (node.kind) {
      case 'predefined':
        return { kind: 'named', key: PREDEFINED_TYPES[node.keyword], args: [] };
      case 'array':
        return node.ranks.reduceRight<TypeRef>((el, rank) => ({ kind: 'array', element: el, rank }), toRef(node.element, scope));
      case 'nullable':
        return { kind: 'named', key: 'System.Nullable`1', args: [toRef(node.element, scope)] };
      case 'named': {
        const last = node.parts[node.parts.length - 1];
        const args = (last.typeArgs ?? []).map((a) => toRef(a, scope));
        if (node.parts.length === 1 && !args.length && scope.includes(last.name)) return { kind: 'param', name: last.name };
        const written = node.parts.map((p) => p.name).join('.');
        const arity = args.length ? `\`${args.length}` : '';
        const candidates = node.parts.length > 1 ? [`${written}${arity}`] : [namespace, ...usings].map((ns) => `${ns}.${written}${arity}`);
        const key = candidates.find((c) => raw.types[c] || defs.some((d) => d.key === c) || pendingKey(c)) ?? candidates[0];
        return { kind: 'named', key, args };
      }
      default:
        return { kind: 'named', key: 'System.Object', args: [] };
    }
  }

  /** Stub types declared later in the file than their first use. */
  function pendingKey(key: string): boolean {
    const name = key.slice(namespace.length + 1);
    return key.startsWith(`${namespace}.`) && new RegExp(`\\b(?:interface|class|struct|enum)\\s+${name.replace(/`\d+$/, '')}\\b`).test(text);
  }
}

function member(declaring: TypeDef, m: Partial<MemberDef> & Pick<MemberDef, 'name' | 'kind' | 'type'>): MemberDef {
  return { isStatic: false, isExtension: false, typeParams: [], params: [], declaring, ...m };
}

/** The text of `<summary>` doc comment lines, with the inline tags flattened to Markdown. */
export function summary(lines: string[]): string | undefined {
  if (lines.length === 0) return undefined;
  const text = lines
    .join(' ')
    .replace(/<\/?summary>/g, '')
    .replace(/<see cref="(?:[A-Z]:)?([^"]+)"\s*\/>/g, '`$1`')
    .replace(/<(?:paramref|typeparamref) name="([^"]+)"\s*\/>/g, '`$1`')
    .replace(/<c>(.*?)<\/c>/g, '`$1`')
    .replace(/\s+/g, ' ')
    .trim();
  return text || undefined;
}

export type { Token };
