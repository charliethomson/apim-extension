/**
 * Parsed policies (from the tolerant parser) as the trees the runner reads: entities decoded,
 * comments dropped, every element, text and expression placed by line and column in its file.
 */

import { Lines } from '@apim-policy/core';
import { decodeEntities, type Document, type Expression, type Node } from '@apim-policy/document';
import type { RunExpr, RunNode } from './protocol';

/** The document's root element as a run tree, or undefined when it has none. */
export function toRunTree(doc: Document): RunNode | undefined {
  if (!doc.root) return undefined;
  const lines = new Lines(doc.source);
  return convert(doc.root, doc.source, lines);
}

function convert(node: Node, source: string, lines: Lines): RunNode | undefined {
  const at = (offset: number) => {
    const line = lines.lineOf(offset);
    return { line: line + 1, col: offset - lines.start(line) + 1 };
  };
  const expr = (e: Expression | undefined): RunExpr | undefined => e && { code: e.code, multi: e.kind === 'block', ...at(e.codeRange.start) };
  switch (node.type) {
    case 'element':
      return {
        name: node.name,
        ...at(node.range.start),
        attrs: node.attributes.map((a) => ({ name: a.name, value: decodeEntities(a.value ?? '').text, ...(a.expression ? { expr: expr(a.expression) } : {}) })),
        children: node.children.map((c) => convert(c, source, lines)).filter((c): c is RunNode => c !== undefined),
      };
    case 'text':
      return { text: decodeEntities(node.value).text, ...at(node.range.start), ...(node.expression ? { expr: expr(node.expression) } : {}) };
    case 'cdata':
      return { text: source.slice(node.contentRange.start, node.contentRange.end), ...at(node.range.start), ...(node.expression ? { expr: expr(node.expression) } : {}) };
    default:
      return undefined;
  }
}
