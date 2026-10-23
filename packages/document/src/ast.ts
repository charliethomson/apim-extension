import type { OffsetRange, SourceMap } from '@apim-policy/core';

/** All ranges are document offsets, end-exclusive. */

export interface NamedValue {
  name: string;
  /** Range of the whole `{{name}}` token in the document. */
  range: OffsetRange;
}

export interface Expression {
  kind: 'expr' | 'block';
  /** From the `@` to the closing bracket, inclusive. */
  range: OffsetRange;
  /** Between the brackets. */
  codeRange: OffsetRange;
  /** The C# code with XML entities decoded (unchanged inside CDATA). */
  code: string;
  /** Maps offsets in `code` to document offsets. */
  map: SourceMap;
  namedValues: NamedValue[];
}

export interface Attribute {
  name: string;
  nameRange: OffsetRange;
  /** Whole attribute, `name="value"`. */
  range: OffsetRange;
  /** Raw source text between the quotes, undefined when the attribute has no value. */
  value?: string;
  valueRange?: OffsetRange;
  expression?: Expression;
  namedValues: NamedValue[];
}

export interface Element {
  type: 'element';
  name: string;
  nameRange: OffsetRange;
  /** From `<` to the end of the end tag (or the start tag if self-closing or unclosed). */
  range: OffsetRange;
  startTag: OffsetRange;
  endTag?: OffsetRange;
  selfClosing: boolean;
  attributes: Attribute[];
  children: Node[];
}

export interface Text {
  type: 'text';
  range: OffsetRange;
  /** Raw source text. */
  value: string;
  expression?: Expression;
  namedValues: NamedValue[];
}

export interface CData {
  type: 'cdata';
  range: OffsetRange;
  contentRange: OffsetRange;
  expression?: Expression;
  namedValues: NamedValue[];
}

export interface Comment {
  type: 'comment';
  range: OffsetRange;
}

/** `<?...?>` and `<!DOCTYPE ...>`. */
export interface Declaration {
  type: 'declaration';
  range: OffsetRange;
}

export type Node = Element | Text | CData | Comment | Declaration;

export interface ParseDiagnostic {
  range: OffsetRange;
  message: string;
  code: ParseErrorCode;
}

export type ParseErrorCode =
  | 'unterminated-comment'
  | 'unterminated-cdata'
  | 'unterminated-declaration'
  | 'unterminated-tag'
  | 'unterminated-attribute'
  | 'unterminated-expression'
  | 'expected-quote-after-expression'
  | 'text-after-expression'
  | 'attribute-without-value'
  | 'unquoted-attribute'
  | 'duplicate-attribute'
  | 'unexpected-character'
  | 'unexpected-end-tag'
  | 'missing-end-tag'
  | 'unescaped-lt'
  | 'multiple-roots';

export interface Document {
  source: string;
  children: Node[];
  /** First element at the top level. */
  root?: Element;
  diagnostics: ParseDiagnostic[];
  /** Every expression in document order. */
  expressions: Expression[];
}
