/** An in-memory editor for the workspace layer: files on "disk", open documents, an instance. */

import type { Backend, NamedValue } from '@apim-policy/azure';
import { instancePath, type Scope } from '@apim-policy/core';
import { type Document, looksLikePolicy, parse } from '@apim-policy/document';
import { outerVariables as placeOuter, summarize } from '@apim-policy/analysis';
import type { InstanceSource, RemoteFragment, WorkspaceHost } from '../src/host';

/** URIs are plain strings: `file:///ws/a.xml`, `apim-edit://inst/inst/fragments/f.fragment.xml`. */
export type Uri = string;

export class MemoryHost implements WorkspaceHost<Uri> {
  /** File text by URI; a value of `null` is a file that can't be read. */
  readonly files = new Map<Uri, string | null>();
  readonly open = new Map<Uri, Document>();
  reads = 0;

  constructor(files: Record<Uri, string | null> = {}) {
    for (const [k, v] of Object.entries(files)) this.files.set(k, v);
  }

  key = (uri: Uri) => uri;
  parse = (key: string) => key;
  scheme = (uri: Uri) => uri.slice(0, uri.indexOf(':'));
  path = (uri: Uri) => new URL(uri).pathname;
  file = (path: string) => `file://${path}`;
  label = (uri: Uri) => this.path(uri).replace(/^\/ws\//, '');
  findPolicyFiles = () => Promise.resolve([...this.files.keys()].filter((u) => u.endsWith('.xml')));
  findNamedValueFiles = () => Promise.resolve([...this.files.keys()].filter((u) => u.endsWith('/namedValueInformation.json')));
  readPolicy = (uri: Uri) => {
    this.reads++;
    const text = this.files.get(uri);
    if (text === null) return Promise.reject(new Error('unreadable'));
    return Promise.resolve(text !== undefined && looksLikePolicy(text) ? text : undefined);
  };
  openPolicies = () => [...this.open].map(([uri, doc]) => ({ uri, doc }));
  isOpen = (uri: Uri) => this.open.has(uri);

  /** Opens `uri` with `text` as its live content, returning the parse to hand the index. */
  edit(uri: Uri, text: string): Document {
    const doc = parse(text);
    this.open.set(uri, doc);
    return doc;
  }
}

/** A connected instance holding `fragments` (by id) and the policies of `scopes` (by scope key). */
export class MemoryInstance implements InstanceSource<Uri> {
  private readonly listeners = new Set<() => void>();
  products: string[] = [];

  constructor(
    readonly fragmentXml: Record<string, string> = {},
    readonly named: NamedValue[] = [],
    readonly backendList: Backend[] = [],
    /** Policy XML by scope, for the broader scopes around a policy. */
    readonly policies: { scope: Scope; xml: string }[] = [],
    /** The scope each workspace URI's policy applies at. */
    readonly scopeOf: (uri: Uri) => Scope | undefined = () => undefined,
  ) {}

  fragments(): Promise<RemoteFragment<Uri>[]> {
    return Promise.resolve(
      Object.entries(this.fragmentXml).map(([id, xml]) => {
        const doc = parse(xml);
        return { id, uri: this.policyUri({ kind: 'fragment', fragment: id }), summary: summarize(doc), doc };
      }),
    );
  }

  namedValues = () => Promise.resolve(this.named);
  backends = () => Promise.resolve(this.backendList);

  outerVariables(uri: Uri, doc: Document, includeSets: (id: string) => readonly string[] | undefined) {
    const scope = this.scopeOf(uri);
    if (!scope) return Promise.resolve([]);
    const chain = this.policies.map((p) => ({ scope: p.scope, doc: parse(p.xml) }));
    return Promise.resolve(placeOuter(doc, [chain], includeSets));
  }

  policyUri(scope: Scope): Uri {
    return `apim-instance://inst${instancePath(scope, 'inst')}`;
  }

  onDidChange(listener: () => void) {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  changed(): void {
    this.listeners.forEach((l) => l());
  }
}

/** A fragment that sets `outs` (with an `@out` header for each) and reads `ins` (`@in`). */
export function fragmentXml(outs: string[], ins: string[] = [], body = ''): string {
  const header = [...ins.map((n) => `  @in  ${n}`), ...outs.map((n) => `  @out ${n}`)].join('\n');
  const sets = outs.map((n) => `<set-variable name="${n}" value="x" />`).join('');
  return `<!--\n  A fragment.\n\n${header}\n-->\n<fragment>${sets}${body}</fragment>\n`;
}

export function policyXml(inbound: string): string {
  return `<policies><inbound><base />${inbound}</inbound><backend><base /></backend><outbound><base /></outbound><on-error><base /></on-error></policies>\n`;
}
