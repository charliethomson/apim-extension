/**
 * Pure helpers for the semantic half of the allowlist lint: decoding semantic tokens from the
 * C# server and reading symbols out of its hover text.
 */

export interface DecodedToken {
  line: number;
  character: number;
  length: number;
  type: string;
}

/** Decodes the LSP relative token encoding (5 integers per token). */
export function decodeSemanticTokens(data: Uint32Array | number[], legend: readonly string[]): DecodedToken[] {
  const out: DecodedToken[] = [];
  let line = 0;
  let character = 0;
  for (let i = 0; i + 4 < data.length; i += 5) {
    const dLine = data[i];
    line += dLine;
    character = dLine === 0 ? character + data[i + 1] : data[i + 1];
    out.push({ line, character, length: data[i + 2], type: legend[data[i + 3]] ?? 'unknown' });
  }
  return out;
}

export const TYPE_TOKENS = new Set(['class', 'struct', 'interface', 'enum', 'delegate', 'record', 'recordStruct', 'type']);
export const MEMBER_TOKENS = new Set(['method', 'extensionMethod', 'property', 'field', 'enumMember', 'event', 'constant']);

export type HoverSymbol = { kind: 'type'; fullName: string } | { kind: 'member'; typeName: string; member: string } | undefined;

/**
 * Reads the symbol from the first code line of a C# hover, for example
 * `class System.IO.File`, `delegate TResult System.Func<in T, out TResult>(T arg)`,
 * `long DateTime.ToBinary()` or `DateTimeKind.Local = 2`.
 */
export function parseHoverSymbol(markdown: string): HoverSymbol {
  const code = /```csharp\n([^\n]*)/.exec(markdown)?.[1] ?? markdown.split('\n')[0];
  const line = code.replace(/^\((?:extension|field|constant|parameter|local variable|awaitable)\)\s*/, '').trim();
  const type = /^(?:readonly\s+|sealed\s+|static\s+|abstract\s+)*(?:class|struct|interface|enum|record(?:\s+struct)?)\s+([\w.]+)/.exec(line);
  if (type) return { kind: 'type', fullName: type[1] };
  const del = /^delegate\s+.+?\s([\w.]+?)(?:<[^(]*>)?\(/.exec(line);
  if (del) return { kind: 'type', fullName: del[1] };
  // "<return type> Type.Member(...)" or "Type.Member = value" (enum members) or "<type> Type.Prop { get; }"
  const member = /(?:^|\s)((?:[\w]+\.)*[A-Z]\w*)(?:<[^>]*>)?\.(\w+)(?:<[^>]*>)?\s*(?:\(|\{|=|$)/.exec(line);
  if (member) return { kind: 'member', typeName: member[1], member: member[2] };
  return undefined;
}
