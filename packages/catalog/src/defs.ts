import type { Element } from '@charliethomson/apim-document';
import { SECTIONS, type Catalog, type ElementDef, type Section } from './schema';

/**
 * The definition of the last element in `path` (root first), walking child definitions down
 * from the nearest policy so `<when>` resolves through `<choose>`.
 */
export function resolveDef(path: readonly { name: string }[], catalog: Catalog): ElementDef | undefined {
  let def: ElementDef | undefined;
  for (const el of path) {
    const child = def?.content.kind === 'children' ? def.content.children.find((c) => c.name === el.name) : undefined;
    def = child ?? catalog.get(el.name);
  }
  return def;
}

/** The section an element sits in, or undefined in a fragment or outside any section. */
export function sectionOf(path: readonly Element[]): Section | undefined {
  for (const el of path) if ((SECTIONS as readonly string[]).includes(el.name)) return el.name as Section;
  return undefined;
}
