/**
 * A tiny member model read from stubs/ApimContext.cs, used for `context.` completion and hover
 * when the C# extension isn't available. It understands the stubs' own simple shapes only:
 * interfaces, classes and enums with properties, methods and enum members.
 */

export interface StubMember {
  name: string;
  kind: 'property' | 'method' | 'enumMember';
  /** Declared type (return type for methods). */
  type: string;
  /** Parameter list as written, for methods. */
  params?: string;
  doc?: string;
}

export interface StubType {
  name: string;
  kind: 'interface' | 'class' | 'enum';
  doc?: string;
  members: StubMember[];
}

export type StubModel = Map<string, StubType>;

const TYPE_DECL = /^\s*(?:public\s+)?(?:sealed\s+|static\s+)*(interface|class|enum)\s+(\w+)/;
const PROPERTY = /^\s*(?:public\s+)?([\w.<>[\],? ]+?)\s+(\w+)\s*(?:\{\s*get;|=>)/;
const METHOD = /^\s*(?:public\s+)?(?:static\s+)?([\w.<>[\],?]+)\s+(\w+(?:<\w+>)?)\s*\(([^)]*)\)/;
const ENUM_MEMBER = /^\s*(\w+)\s*,?\s*$/;

export function parseStubs(text: string): StubModel {
  const model: StubModel = new Map();
  let current: StubType | undefined;
  let depth = 0;
  let typeDepth = -1;
  let doc: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('///')) {
      doc.push(trimmed.slice(3).trim());
      continue;
    }
    const docText = summary(doc);
    if (trimmed && !trimmed.startsWith('//') && !trimmed.startsWith('#')) {
      const t = TYPE_DECL.exec(line);
      if (t) {
        current = { name: t[2], kind: t[1] as StubType['kind'], doc: docText, members: [] };
        model.set(current.name, current);
        typeDepth = depth;
      } else if (current && depth === typeDepth + 1 && !/\bprivate\b/.test(line)) {
        if (current.kind === 'enum') {
          const e = ENUM_MEMBER.exec(line);
          if (e) current.members.push({ name: e[1], kind: 'enumMember', type: current.name, doc: docText });
        } else {
          const m = METHOD.exec(line);
          const p = m ? undefined : PROPERTY.exec(line);
          if (m) {
            current.members.push({ name: m[2].replace(/<\w+>$/, ''), kind: 'method', type: m[1], params: m[3], doc: docText });
          } else if (p) {
            current.members.push({ name: p[2], kind: 'property', type: p[1].trim(), doc: docText });
          }
        }
      }
    }
    if (trimmed) doc = [];
    for (const ch of line) {
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (current && depth === typeDepth) current = undefined;
      }
    }
  }
  return model;
}

function summary(lines: string[]): string | undefined {
  if (lines.length === 0) return undefined;
  const text = lines
    .join(' ')
    .replace(/<\/?summary>/g, '')
    .replace(/<see cref="([^"]+)"\s*\/>/g, '$1')
    .replace(/<(?:paramref|typeparamref) name="([^"]+)"\s*\/>/g, '$1')
    .replace(/<c>(.*?)<\/c>/g, '`$1`')
    .replace(/\s+/g, ' ')
    .trim();
  return text || undefined;
}

/**
 * Members available after `chain.` where the chain starts at `context`, e.g. the code before
 * the cursor is `context.Request.Url.`. Returns undefined when the chain leaves the stubs.
 */
export function membersAfter(model: StubModel, codeBefore: string): { type: StubType; typed: string } | undefined {
  const m = /(\bcontext(?:\s*\??\.\s*[A-Za-z_]\w*)*)\s*\??\.\s*([A-Za-z_]\w*)?$/.exec(codeBefore);
  if (!m) return undefined;
  const parts = m[1].split(/\s*\??\.\s*/).slice(1);
  let type = model.get('IProxyRequestContext');
  for (const p of parts) {
    const member = type?.members.find((x) => x.name === p && x.kind === 'property');
    if (!member) return undefined;
    type = model.get(member.type.replace(/\?$/, ''));
  }
  return type ? { type, typed: m[2] ?? '' } : undefined;
}
