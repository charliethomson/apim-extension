/**
 * Syntax tree for C# 7.3 expressions and statements, the language policy expressions use. Offsets are in the code being parsed,
 * end-exclusive. Incomplete input still produces a tree: a missing identifier is a `name` (or a
 * member access) with an empty `name`, and a missing operand is a `missing` node.
 */

export interface Span {
  start: number;
  end: number;
}

// ---- types ----------------------------------------------------------------------------------

export interface NamePart extends Span {
  name: string;
  typeArgs?: TypeNode[];
}

export type TypeNode =
  | (Span & { kind: 'predefined'; keyword: string })
  | (Span & { kind: 'named'; parts: NamePart[]; global?: boolean })
  | (Span & { kind: 'array'; element: TypeNode; ranks: number[] })
  | (Span & { kind: 'nullable'; element: TypeNode })
  | (Span & { kind: 'tuple'; elements: { type: TypeNode; name?: string }[] })
  | (Span & { kind: 'var' });

// ---- expressions ----------------------------------------------------------------------------

export type LiteralKind = 'string' | 'char' | 'int' | 'uint' | 'long' | 'ulong' | 'float' | 'double' | 'decimal' | 'bool' | 'null';

export interface Argument extends Span {
  name?: string;
  modifier?: 'out' | 'ref' | 'in';
  value: Expr;
}

export interface ArgumentList extends Span {
  /** Offset of `(` or `[`. */
  open: number;
  /** Offset of the closer, or undefined when it's missing. */
  close?: number;
  args: Argument[];
  /** Offsets of the separating commas. */
  commas: number[];
}

export interface LambdaParam extends Span {
  name: string;
  type?: TypeNode;
  modifier?: 'out' | 'ref' | 'in';
}

export interface Initializer extends Span {
  kind: 'object' | 'collection';
  /** Object initializers: `Name = value`. Collection initializers: values, or `{ k, v }` as a `tuple`-less list. */
  members: { name?: string; nameSpan?: Span; value: Expr; index?: ArgumentList }[];
}

export interface Designation extends Span {
  name: string;
}

export type Expr =
  | (Span & { kind: 'missing' })
  | (Span & { kind: 'literal'; literal: LiteralKind; text: string })
  | (Span & { kind: 'interp'; holes: Expr[] })
  | (Span & { kind: 'namedValue'; name: string })
  | (Span & { kind: 'name'; name: string; typeArgs?: TypeNode[] })
  | (Span & { kind: 'predefined'; keyword: string })
  | (Span & { kind: 'member'; target: Expr; name: string; nameSpan: Span; typeArgs?: TypeNode[]; conditional: boolean; global?: boolean })
  | (Span & { kind: 'call'; target: Expr; args: ArgumentList })
  | (Span & { kind: 'index'; target: Expr; args: ArgumentList; conditional: boolean })
  | (Span & { kind: 'new'; type?: TypeNode; args?: ArgumentList; init?: Initializer; arrayRanks?: number[]; arraySizes?: Expr[]; arrayInit?: Expr[]; anonymous?: { name: string; nameSpan: Span; value: Expr }[] })
  | (Span & { kind: 'lambda'; params: LambdaParam[]; body: Expr | Block; arrow: number })
  | (Span & { kind: 'unary'; op: string; operand: Expr; postfix: boolean })
  | (Span & { kind: 'binary'; op: string; left: Expr; right: Expr })
  | (Span & { kind: 'assign'; op: string; left: Expr; right: Expr })
  | (Span & { kind: 'conditional'; condition: Expr; whenTrue: Expr; whenFalse: Expr })
  | (Span & { kind: 'is'; operand: Expr; type?: TypeNode; designation?: Designation; pattern?: Expr })
  | (Span & { kind: 'as'; operand: Expr; type: TypeNode })
  | (Span & { kind: 'cast'; type: TypeNode; operand: Expr })
  | (Span & { kind: 'paren'; inner: Expr })
  | (Span & { kind: 'tuple'; items: { name?: string; value: Expr }[] })
  | (Span & { kind: 'typeof'; type: TypeNode })
  | (Span & { kind: 'default'; type?: TypeNode })
  | (Span & { kind: 'nameof'; inner: Expr })
  | (Span & { kind: 'checked'; inner: Expr })
  | (Span & { kind: 'throw'; operand: Expr })
  | (Span & { kind: 'declaration'; type: TypeNode; designation: Designation })
  | (Span & { kind: 'arrayInit'; items: Expr[] })
  | (Span & { kind: 'query'; from: FromClause; body: QueryBody });

// ---- LINQ query expressions -------------------------------------------------------------------

/** `from T x in source`, which also starts a query. */
export interface FromClause extends Span {
  kind: 'from';
  type?: TypeNode;
  designation: Designation;
  source: Expr;
}

export type QueryClause =
  | FromClause
  | (Span & { kind: 'let'; designation: Designation; value: Expr })
  | (Span & { kind: 'where'; condition: Expr })
  | (Span & { kind: 'join'; type?: TypeNode; designation: Designation; source: Expr; outerKey: Expr; innerKey: Expr; into?: Designation })
  | (Span & { kind: 'orderby'; keys: Expr[] });

export interface QueryBody extends Span {
  clauses: QueryClause[];
  /** `select x`, or `group x by k`. Missing when the query is still being typed. */
  final?: (Span & { kind: 'select'; value: Expr }) | (Span & { kind: 'group'; value: Expr; key: Expr });
  /** `into y ...`: the query continues with `y` as its range variable. */
  continuation?: { designation: Designation; body: QueryBody };
}

// ---- statements -----------------------------------------------------------------------------

export interface Declarator extends Span {
  name: string;
  nameSpan: Span;
  init?: Expr;
}

export interface Block extends Span {
  kind: 'block';
  statements: Stmt[];
}

export interface SwitchSection extends Span {
  labels: ({ kind: 'default' } | { kind: 'case'; value?: Expr; type?: TypeNode; designation?: Designation; when?: Expr })[];
  statements: Stmt[];
}

export interface CatchClause extends Span {
  type?: TypeNode;
  designation?: Designation;
  filter?: Expr;
  block: Block;
}

export type Stmt =
  | Block
  | (Span & { kind: 'empty' })
  | (Span & { kind: 'local'; type: TypeNode; declarators: Declarator[]; isConst: boolean })
  | (Span & { kind: 'expr'; expr: Expr })
  | (Span & { kind: 'if'; condition: Expr; then: Stmt; else?: Stmt })
  | (Span & { kind: 'return'; value?: Expr })
  | (Span & { kind: 'throw'; value?: Expr })
  | (Span & { kind: 'foreach'; type: TypeNode; designation: Designation; collection: Expr; body: Stmt })
  | (Span & { kind: 'for'; init: Stmt[]; condition?: Expr; iterators: Expr[]; body: Stmt })
  | (Span & { kind: 'while'; condition: Expr; body: Stmt })
  | (Span & { kind: 'do'; body: Stmt; condition: Expr })
  | (Span & { kind: 'switch'; value: Expr; sections: SwitchSection[] })
  | (Span & { kind: 'try'; block: Block; catches: CatchClause[]; finally?: Block })
  | (Span & { kind: 'using'; resource: Stmt; body: Stmt })
  | (Span & { kind: 'lock'; value: Expr; body: Stmt })
  | (Span & { kind: 'break' })
  | (Span & { kind: 'continue' })
  | LocalFunction;

/** `T Name(T a, T b) { ... }` or `=> expr;` inside a block (C# 7.0). */
export interface LocalFunction extends Span {
  kind: 'localFunction';
  name: string;
  nameSpan: Span;
  typeParams: Designation[];
  returnType: TypeNode;
  params: (LambdaParam & { defaultValue?: Expr; isParams?: boolean })[];
  body: Expr | Block;
}

export interface SyntaxError extends Span {
  message: string;
  /** `language-version` for valid C# that's newer than the 7.3 policy expressions accept. */
  code?: 'language-version';
}
