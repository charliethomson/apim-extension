/**
 * What the workspace layer needs from the editor, so it runs (and tests) without one. `U` is the
 * editor's URI type: the index hands back the URIs the host gave it.
 */

import type { Backend, NamedValue } from '@apim-policy/azure';
import type { Scope } from '@apim-policy/core';
import type { Document } from '@apim-policy/document';
import type { IncludeSets, OuterSet, PolicySummary } from '@apim-policy/analysis';

/** Editable copies of instance documents; an open one stands in for the instance's version. */
export const EDIT_SCHEME = 'apim-edit';

/** Read-only documents for what lives on the instance. */
export const INSTANCE_SCHEME = 'apim-instance';

/** Something to stop: a listener, a watcher. */
export interface Disposable {
  dispose(): void;
}

export interface WorkspaceHost<U> {
  /** A stable string for `uri`, unique per document. */
  key(uri: U): string;
  /** The URI `key` came from. */
  parse(key: string): U;
  scheme(uri: U): string;
  path(uri: U): string;
  /** The local file at `path`. */
  file(path: string): U;
  /** How to name `uri` to the user: its path relative to the workspace. */
  label(uri: U): string;
  /** Every `.xml` file in the workspace that could be a policy. */
  findPolicyFiles(): Promise<U[]>;
  /** APIOps named values: `namedValues/<name>/namedValueInformation.json` files. */
  findNamedValueFiles(): Promise<U[]>;
  /** A file's text when it's a policy; undefined when it isn't one. Throws when it can't be read. */
  readPolicy(uri: U): Promise<string | undefined>;
  /** Policies open in the editor, from their live text. */
  openPolicies(): { uri: U; doc: Document }[];
  /** Whether `uri` is open in the editor, which then owns its text. */
  isOpen(uri: U): boolean;
}

/** A fragment on the connected instance. */
export interface RemoteFragment<U> {
  id: string;
  uri: U;
  summary: PolicySummary;
  doc: Document;
  description?: string;
}

/** The connected instance, as far as the workspace layer reads it. */
export interface InstanceSource<U> {
  fragments(): Promise<RemoteFragment<U>[]>;
  namedValues(): Promise<NamedValue[]>;
  backends(): Promise<Backend[]>;
  /** What the broader scopes set before each point of `doc`, the policy at `uri`. */
  outerVariables(uri: U, doc: Document, includeSets: IncludeSets): Promise<OuterSet[]>;
  /** The read-only document for a scope's policy on the instance. */
  policyUri(scope: Scope): U;
  onDidChange(listener: () => void): Disposable;
}
