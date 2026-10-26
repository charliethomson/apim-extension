/**
 * Structural validation of a parsed policy document against the policy catalog.
 */

import type { Attribute, Document, Element, Node } from '@charliethomson/apim-document';
import type { OffsetRange } from '@charliethomson/apim-core';
import { SECTIONS, type Catalog, type ChildDef, type Content, type ElementDef, type Section } from './schema';

export type Severity = 'error' | 'warning' | 'info';

export type PolicyErrorCode =
  | 'invalid-root'
  | 'unexpected-element'
  | 'duplicate-section'
  | 'misplaced-section'
  | 'unknown-policy'
  | 'wrong-section'
  | 'policy-not-allowed-here'
  | 'fragment-section'
  | 'fragment-base'
  | 'nested-fragment'
  | 'unknown-attribute'
  | 'missing-attribute'
  | 'one-of-attributes'
  | 'invalid-value'
  | 'expression-not-allowed'
  | 'unexpected-content'
  | 'missing-element'
  | 'too-many-elements'
  | 'backend-multiple';

export interface PolicyDiagnostic {
  range: OffsetRange;
  message: string;
  code: PolicyErrorCode;
  severity: Severity;
}

/** Attributes any element may carry. */
const UNIVERSAL_ATTRIBUTES = new Set(['id']);

export function validate(doc: Document, catalog: Catalog): PolicyDiagnostic[] {
  return new Validator(doc, catalog).run();
}

class Validator {
  private readonly out: PolicyDiagnostic[] = [];

  constructor(
    private readonly doc: Document,
    private readonly catalog: Catalog,
  ) {}

  run(): PolicyDiagnostic[] {
    const root = this.doc.root;
    if (!root) {
      this.report({ start: 0, end: 0 }, 'Expected a <policies> or <fragment> root element.', 'invalid-root');
      return this.out;
    }
    if (root.name === 'policies') this.policiesRoot(root);
    else if (root.name === 'fragment') this.policyList(root, undefined, { kind: 'policies' }, true);
    else this.report(root.nameRange, `Expected <policies> or <fragment>, found <${root.name}>.`, 'invalid-root');
    return this.out;
  }

  private report(range: OffsetRange, message: string, code: PolicyErrorCode, severity: Severity = 'error'): void {
    this.out.push({ range, message, code, severity });
  }

  private policiesRoot(root: Element): void {
    this.attributes(root, []);
    const seen = new Set<string>();
    this.nonElementContent(root, false);
    for (const el of childElements(root)) {
      if (!isSection(el.name)) {
        const hint = this.catalog.get(el.name) ? ' Policies go inside a section.' : '';
        this.report(el.nameRange, `Unexpected <${el.name}> in <policies>; expected <inbound>, <backend>, <outbound> or <on-error>.${hint}`, 'unexpected-element');
        continue;
      }
      if (seen.has(el.name)) this.report(el.nameRange, `Duplicate <${el.name}> section.`, 'duplicate-section');
      seen.add(el.name);
      this.attributes(el, []);
      this.policyList(el, el.name, { kind: 'policies' }, false);
      if (el.name === 'backend') {
        const policies = childElements(el);
        if (policies.length > 1) {
          this.report(policies[1].nameRange, 'The <backend> section should contain a single policy.', 'backend-multiple', 'warning');
        }
      }
    }
  }

  /** Validates the policy elements nested in `parent`. `section` is undefined inside fragments. */
  private policyList(
    parent: Element,
    section: Section | undefined,
    content: Extract<Content, { kind: 'policies' }>,
    inFragment: boolean,
  ): void {
    this.nonElementContent(parent, false);
    for (const el of childElements(parent)) {
      if (isSection(el.name)) {
        if (inFragment) this.report(el.nameRange, `A fragment can't contain section elements like <${el.name}>.`, 'fragment-section');
        else this.report(el.nameRange, `<${el.name}> can only appear directly inside <policies>.`, 'misplaced-section');
        continue;
      }
      if (inFragment && el.name === 'base') {
        this.report(el.nameRange, 'A fragment can\'t contain <base />.', 'fragment-base');
        continue;
      }
      if (inFragment && el.name === 'include-fragment') {
        this.report(el.nameRange, 'Fragments can\'t include other fragments.', 'nested-fragment');
      }
      const def = this.catalog.get(el.name);
      if (!def) {
        this.report(el.nameRange, `Unknown policy <${el.name}>.`, 'unknown-policy');
        continue;
      }
      if (content.only && !content.only.includes(el.name)) {
        this.report(el.nameRange, `<${el.name}> isn't allowed here; only ${content.only.map((n) => `<${n}>`).join(', ')}.`, 'policy-not-allowed-here');
      } else if (content.exclude?.includes(el.name)) {
        this.report(el.nameRange, `<${el.name}> isn't allowed here.`, 'policy-not-allowed-here');
      }
      if (section && def.sections.length > 0 && !def.sections.includes(section)) {
        this.report(
          el.nameRange,
          `<${el.name}> can't be used in <${section}>; it's allowed in ${def.sections.map((s) => `<${s}>`).join(', ')}.`,
          'wrong-section',
        );
      }
      this.element(el, def, section, inFragment);
    }
  }

  private element(el: Element, def: ElementDef, section: Section | undefined, inFragment: boolean): void {
    this.attributes(el, def.attributes ?? [], def.oneOf);
    const content = def.content;
    switch (content.kind) {
      case 'empty':
        for (const c of el.children) {
          if (c.type === 'element' || (c.type !== 'comment' && !isBlank(this.doc, c))) {
            this.report(rangeOf(c), `<${el.name}> should be empty.`, 'unexpected-content', 'warning');
            break;
          }
        }
        break;
      case 'text':
        for (const c of childElements(el)) {
          this.report(c.nameRange, `<${el.name}> takes text, not elements.`, 'unexpected-element');
        }
        if (!content.expressions) {
          for (const c of el.children) {
            if ((c.type === 'text' || c.type === 'cdata') && c.expression) {
              this.report(c.expression.range, `<${el.name}> doesn't accept policy expressions.`, 'expression-not-allowed', 'warning');
            }
          }
        }
        break;
      case 'children':
        this.children(el, content.children, section, inFragment);
        this.nonElementContent(el, content.text ?? false);
        break;
      case 'policies':
        this.policyList(el, section, content, inFragment);
        break;
      case 'any':
        break;
    }
  }

  private children(el: Element, defs: ChildDef[], section: Section | undefined, inFragment: boolean): void {
    const counts = new Map<string, number>();
    for (const c of childElements(el)) {
      const def = defs.find((d) => d.name === c.name);
      if (!def) {
        const expected = defs.map((d) => `<${d.name}>`).join(', ');
        this.report(c.nameRange, `Unexpected <${c.name}> in <${el.name}>${expected ? `; expected ${expected}` : ''}.`, 'unexpected-element');
        continue;
      }
      const n = (counts.get(c.name) ?? 0) + 1;
      counts.set(c.name, n);
      if (def.max !== undefined && n > def.max) {
        this.report(c.nameRange, `<${el.name}> allows at most ${def.max} <${c.name}>.`, 'too-many-elements');
      }
      this.element(c, def, section, inFragment);
    }
    for (const def of defs) {
      if ((def.min ?? 0) > (counts.get(def.name) ?? 0)) {
        this.report(el.nameRange, `<${el.name}> requires ${def.min === 1 ? 'a' : `at least ${def.min}`} <${def.name}> element.`, 'missing-element');
      }
    }
  }

  private attributes(el: Element, defs: NonNullable<ElementDef['attributes']>, oneOf?: string[][]): void {
    const present = new Set(el.attributes.map((a) => a.name));
    for (const attr of el.attributes) {
      if (UNIVERSAL_ATTRIBUTES.has(attr.name) || attr.name === 'xmlns' || attr.name.startsWith('xmlns:')) continue;
      const def = defs.find((d) => d.name === attr.name);
      if (!def) {
        this.report(attr.nameRange, `Unknown attribute '${attr.name}' on <${el.name}>.`, 'unknown-attribute', 'warning');
        continue;
      }
      this.attributeValue(el, attr, def);
    }
    for (const def of defs) {
      if (def.required && !present.has(def.name)) {
        this.report(el.nameRange, `<${el.name}> is missing required attribute '${def.name}'.`, 'missing-attribute');
      }
    }
    for (const group of oneOf ?? []) {
      const found = group.filter((n) => present.has(n));
      const list = group.map((n) => `'${n}'`).join(', ');
      if (found.length === 0) {
        this.report(el.nameRange, `<${el.name}> needs one of ${list}.`, 'one-of-attributes');
      } else if (found.length > 1) {
        const second = el.attributes.find((a) => a.name === found[1])!;
        this.report(second.nameRange, `<${el.name}> takes only one of ${list}.`, 'one-of-attributes');
      }
    }
  }

  private attributeValue(el: Element, attr: Attribute, def: NonNullable<ElementDef['attributes']>[number]): void {
    if (attr.expression) {
      if (!def.expressions) {
        this.report(attr.expression.range, `'${attr.name}' on <${el.name}> doesn't accept policy expressions.`, 'expression-not-allowed', 'warning');
      }
      return;
    }
    if (attr.value === undefined || attr.namedValues.length > 0) return;
    const value = attr.value.trim();
    const range = attr.valueRange ?? attr.nameRange;
    if (def.enum && !def.enum.includes(value)) {
      this.report(range, `Invalid value '${value}' for '${attr.name}'; expected ${def.enum.map((v) => `'${v}'`).join(', ')}.`, 'invalid-value');
    } else if (def.type === 'bool' && value !== 'true' && value !== 'false') {
      this.report(range, `'${attr.name}' must be true or false.`, 'invalid-value');
    } else if (def.type === 'int' && !/^-?\d+$/.test(value)) {
      this.report(range, `'${attr.name}' must be a whole number.`, 'invalid-value');
    }
  }

  /** Flags non-whitespace text where only elements belong. */
  private nonElementContent(el: Element, textAllowed: boolean): void {
    if (textAllowed) return;
    for (const c of el.children) {
      if ((c.type === 'text' || c.type === 'cdata') && !isBlank(this.doc, c)) {
        this.report(trimmed(this.doc, c.range), `Unexpected text in <${el.name}>.`, 'unexpected-content', 'warning');
      }
    }
  }
}

function childElements(el: Element): Element[] {
  return el.children.filter((c): c is Element => c.type === 'element');
}

function isSection(name: string): name is Section {
  return (SECTIONS as readonly string[]).includes(name);
}

function isBlank(doc: Document, n: Node): boolean {
  if (n.type === 'text') return n.value.trim() === '';
  if (n.type === 'cdata') return doc.source.slice(n.contentRange.start, n.contentRange.end).trim() === '';
  return false;
}

function rangeOf(n: Node): OffsetRange {
  return n.type === 'element' ? n.nameRange : n.range;
}

function trimmed(doc: Document, r: OffsetRange): OffsetRange {
  let { start, end } = r;
  while (start < end && /\s/.test(doc.source[start])) start++;
  while (end > start && /\s/.test(doc.source[end - 1])) end--;
  return { start, end };
}
