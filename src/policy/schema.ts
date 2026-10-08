/** Types for `data/policies.json`. Keep in sync with the file's shape. */

export type Section = 'inbound' | 'backend' | 'outbound' | 'on-error';

export const SECTIONS: readonly Section[] = ['inbound', 'backend', 'outbound', 'on-error'];

export interface AttributeDef {
  name: string;
  required?: boolean;
  /** Whether a policy expression is accepted as the value. */
  expressions?: boolean;
  /** Closed set of literal values. */
  enum?: string[];
  /** Value type, used to check literals and to type the shadow C# method. */
  type?: 'bool' | 'int' | 'string';
  description: string;
}

export type Content =
  | { kind: 'empty' }
  | { kind: 'text'; expressions?: boolean }
  | { kind: 'children'; children: ChildDef[]; text?: boolean }
  | { kind: 'policies'; only?: string[]; exclude?: string[] }
  | { kind: 'any' };

export interface ElementDef {
  name: string;
  description: string;
  attributes?: AttributeDef[];
  /** Groups of attributes where exactly one must be present. */
  oneOf?: string[][];
  content: Content;
}

export interface ChildDef extends ElementDef {
  min?: number;
  max?: number;
}

export interface PolicyDef extends ElementDef {
  /** Sections the policy may appear in. Empty means not section-scoped (GraphQL resolvers). */
  sections: Section[];
  docs: string;
  category: string;
}

export interface PolicyFile {
  $comment?: string;
  policies: PolicyDef[];
}

export class Catalog {
  private readonly byName = new Map<string, PolicyDef>();

  constructor(file: PolicyFile) {
    for (const p of file.policies) this.byName.set(p.name, p);
  }

  get(name: string): PolicyDef | undefined {
    return this.byName.get(name);
  }

  get names(): string[] {
    return [...this.byName.keys()];
  }
}
