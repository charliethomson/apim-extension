/**
 * What the policy runner (runner/, .NET) is sent and sends back, one JSON object per line. These
 * mirror `runner/PolicyRunner/Model.cs`; the names are its properties in camelCase.
 */

/** An element of a policy, or a run of text in one (when `name` is absent). */
export interface RunNode {
  name?: string;
  attrs?: RunAttr[];
  children?: RunNode[];
  /** A text node's text, entity-decoded. */
  text?: string;
  /** Set when the text node is a policy expression. */
  expr?: RunExpr;
  /** Where it starts in its file, from 1. */
  line: number;
  col: number;
}

export interface RunAttr {
  name: string;
  /** Entity-decoded. */
  value: string;
  expr?: RunExpr;
}

/** The C# inside `@(…)` or `@{…}`, and where it starts in its file (from 1), for errors. */
export interface RunExpr {
  code: string;
  multi: boolean;
  line: number;
  col: number;
}

export interface ScopePolicy {
  kind: string;
  label: string;
  file?: string;
  /** The parsed `<policies>`; absent when the scope has none. */
  root?: RunNode;
}

export interface RunRequest {
  method?: string;
  url?: string;
  backendUrl?: string;
  headers?: Record<string, string[]>;
  body?: string;
  ipAddress?: string;
  matchedParameters?: Record<string, string>;
}

export interface RunResponse {
  status: number;
  reason?: string;
  headers?: Record<string, string[]>;
  body?: string;
}

export interface RunContext {
  api?: { id?: string; name?: string; path?: string; serviceUrl?: string; revision?: string; version?: string };
  operation?: { id?: string; name?: string; method?: string; urlTemplate?: string };
  product?: { id: string; name: string };
  subscription?: { id?: string; name?: string; key?: string };
  user?: { id?: string; email?: string; firstName?: string; lastName?: string; groups?: { id: string; name: string }[] };
  requestId?: string;
  timestamp?: string;
  region?: string;
  serviceName?: string;
}

/** One run: a request through a policy and its broader scopes (innermost first). */
export interface RunInput {
  scopes: ScopePolicy[];
  fragments: Record<string, { file?: string; root: RunNode }>;
  namedValues: Record<string, string>;
  /** Set before the run: strings, numbers and bools as themselves, objects as JObject, lists as JArray. */
  variables: Record<string, unknown>;
  request: RunRequest;
  backend?: RunResponse;
  context?: RunContext;
}

export interface RunResult {
  response?: { status: number; reason?: string; headers: Record<string, string[]>; body?: string };
  variables: Record<string, { type: string; value: unknown }>;
  calls: { kind: string; method: string; url: string; headers: Record<string, string[]>; body?: string }[];
  trace: { source: string; severity: string; message: string; metadata: Record<string, string> }[];
  steps: { policy: string; scope: string; section: string; file?: string; line: number; detail?: string }[];
  error?: { source: string; reason: string; message: string; scope: string; section: string; path: string; file?: string; line: number };
  failure?: {
    kind: 'compile' | 'unsupported' | 'test' | 'runner';
    message: string;
    file?: string;
    line: number;
    col: number;
    diagnostics: { code: string; message: string; file?: string; line: number; col: number }[];
  };
}
