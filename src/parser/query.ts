import type { Attribute, Document, Element, Expression, NamedValue, Node } from './ast';

export interface Hit {
  /** Innermost element containing the offset. */
  element?: Element;
  /** Chain from the root to `element`. */
  path: Element[];
  /** Set when the offset is on the element's name in its start or end tag. */
  onElementName?: boolean;
  attribute?: Attribute;
  onAttributeName?: boolean;
  onAttributeValue?: boolean;
  expression?: Expression;
  namedValue?: NamedValue;
}

const within = (r: { start: number; end: number }, o: number) => o >= r.start && o <= r.end;

/** What's at document offset `offset` (end-inclusive, so the cursor after a word counts). */
export function nodeAt(doc: Document, offset: number): Hit {
  const hit: Hit = { path: [] };
  const visit = (nodes: Node[]) => {
    for (const n of nodes) {
      if (n.type === 'element') {
        if (!within(n.range, offset)) continue;
        hit.element = n;
        hit.path.push(n);
        if (within(n.startTag, offset)) {
          hit.onElementName = within(n.nameRange, offset);
          for (const a of n.attributes) {
            if (!within(a.range, offset)) continue;
            hit.attribute = a;
            hit.onAttributeName = within(a.nameRange, offset);
            hit.onAttributeValue = !!a.valueRange && within(a.valueRange, offset);
            hit.expression = a.expression && within(a.expression.codeRange, offset) ? a.expression : undefined;
            hit.namedValue = a.namedValues.find((nv) => within(nv.range, offset));
          }
          return;
        }
        if (n.endTag && within(n.endTag, offset)) {
          const nameStart = n.endTag.start + 2;
          hit.onElementName = offset >= nameStart && offset <= nameStart + n.name.length;
          return;
        }
        visit(n.children);
        return;
      }
      if ((n.type === 'text' || n.type === 'cdata') && within(n.range, offset)) {
        if (n.expression && within(n.expression.codeRange, offset)) hit.expression = n.expression;
        hit.namedValue = n.namedValues.find((nv) => within(nv.range, offset));
      }
    }
  };
  visit(doc.children);
  return hit;
}

/** The expression whose code contains document offset `offset` (end-inclusive). */
export function expressionAt(doc: Document, offset: number): Expression | undefined {
  return doc.expressions.find((e) => offset >= e.codeRange.start && offset <= e.codeRange.end);
}
