/**
 * The C# type an attribute's expression must produce, from the catalog. Bool attributes are
 * typed: APIM converts other results (numbers, strings) loosely, so typing them would report
 * errors the gateway doesn't. `set-variable`'s value is the exception, checked against the types
 * a variable may hold (`variable`).
 */

import type { Attribute, Document, Element, Expression, Node } from '@charliethomson/apim-document';
import type { ResultType } from '@charliethomson/apim-csharp-engine';
import type { Catalog, ChildDef, ElementDef } from '@charliethomson/apim-catalog';

/** Result types for attribute expressions whose attribute has a declared type. */
export function resultTypes(doc: Document, catalog: Catalog): Map<Expression, ResultType> {
  const out = new Map<Expression, ResultType>();
  const visit = (nodes: Node[], parentDef: ElementDef | undefined) => {
    for (const n of nodes) {
      if (n.type !== 'element') continue;
      const def = childDef(parentDef, n) ?? catalog.get(n.name);
      if (def) setTypes(n.attributes, def, out);
      if (n.name === 'set-variable') {
        const value = n.attributes.find((a) => a.name === 'value')?.expression;
        if (value) out.set(value, 'variable');
      }
      visit(n.children, def);
    }
  };
  visit(doc.children, undefined);
  return out;
}

function childDef(parent: ElementDef | undefined, el: Element): ChildDef | undefined {
  return parent?.content.kind === 'children' ? parent.content.children.find((c) => c.name === el.name) : undefined;
}

function setTypes(attributes: Attribute[], def: ElementDef, out: Map<Expression, ResultType>): void {
  for (const a of attributes) {
    const t = def.attributes?.find((d) => d.name === a.name)?.type;
    if (a.expression && t === 'bool') out.set(a.expression, 'bool');
  }
}
