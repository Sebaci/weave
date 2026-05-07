/**
 * Weave v1 Recursive Descent Parser.
 *
 * Entry point: parseModule(source) → ParseResult<Module>
 *
 * Follows the grammar in weave-surface-syntax-v1.md §13 exactly.
 * Infix operators use precedence climbing; all other rules are LL(k).
 *
 * Key disambiguation rules:
 *   - `{` at start of a branch handler → RecordHandler (never an expression)
 *   - `name(p: e)` → SchemaInst if content has `name:`, else syntax error
 *   - `True`/`False` → boolean Literal (not Ctor)
 *   - `over .f step` → transform is a single step (parseBaseStep), not a pipeline
 *   - `let x = e in body` → `in` is a keyword that terminates `e`
 *   - `parallel-safe` → parsed as three tokens (parallel MINUS safe) in effect positions
 */

import { freshId, spanMerge, type NodeMeta, type SourceSpan } from "../surface/id.ts";
import type {
  Module, TopDecl, TypeDecl, TypeDeclBody, CtorDecl,
  DefDecl, DefParam, EffectDecl, Import,
  SurfaceType, SurfaceField, SurfaceLiteral, SurfaceEffect,
  Expr, Step, Branch, Handler, FieldBinder, FanoutField, BuildField, SchemaArg,
} from "../surface/ast.ts";
import { lex, type Token, type TK, LexError } from "./lexer.ts";

// ---------------------------------------------------------------------------
// Public result type
// ---------------------------------------------------------------------------

export type ParseError = { message: string; span: SourceSpan };
export type ParseResult<T> = { ok: true; value: T } | { ok: false; errors: ParseError[] };

// ---------------------------------------------------------------------------
// Internal parse error (thrown, caught at top level)
// ---------------------------------------------------------------------------

class PErr extends Error {
  constructor(
    public override message: string,
    public span: SourceSpan,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Operator precedence table for infix expressions
// ---------------------------------------------------------------------------

type InfixEntry = { op: string; prec: number };

const INFIX: Record<string, InfixEntry> = {
  "||": { op: "||", prec: 1 },
  "&&": { op: "&&", prec: 2 },
  "==": { op: "==", prec: 3 },
  "!=": { op: "!=", prec: 3 },
  "<":  { op: "<",  prec: 4 },
  ">":  { op: ">",  prec: 4 },
  "<=": { op: "<=", prec: 4 },
  ">=": { op: ">=", prec: 4 },
  "+":  { op: "+",  prec: 5 },
  "-":  { op: "-",  prec: 5 },
  "*":  { op: "*",  prec: 6 },
  "/":  { op: "/",  prec: 6 },
};

function infixEntry(t: Token): InfixEntry | null {
  const map: Record<TK, string | undefined> = {
    PIPEPIPE: "||", AMPAMP: "&&",
    EQEQ: "==", NEQ: "!=",
    LT: "<", GT: ">", LEQ: "<=", GEQ: ">=",
    PLUS: "+", MINUS: "-", STAR: "*", SLASH: "/",
    // All other kinds — no infix
    INT: undefined, FLOAT: undefined, TEXT: undefined,
    IDENT: undefined, UPPER: undefined,
    COMPOSE: undefined, ARROW: undefined, BANG: undefined,
    LBRACE: undefined, RBRACE: undefined, LPAREN: undefined, RPAREN: undefined,
    COMMA: undefined, COLON: undefined, EQ: undefined, DOT: undefined,
    PIPE: undefined, UNDER: undefined, EOF: undefined,
  };
  const sym = map[t.kind];
  return sym !== undefined ? (INFIX[sym] ?? null) : null;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

class Parser {
  private readonly toks: Token[];
  private pos = 0;

  constructor(toks: Token[]) { this.toks = toks; }

  // ---- Token access -------------------------------------------------------

  cur():  Token { return this.toks[this.pos]!; }
  look(n = 1): Token {
    const idx = Math.min(this.pos + n, this.toks.length - 1);
    return this.toks[idx]!;
  }

  advance(): Token {
    const t = this.cur();
    if (t.kind !== "EOF") this.pos++;
    return t;
  }

  eat(kind: TK): Token | null {
    if (this.cur().kind === kind) return this.advance();
    return null;
  }

  expect(kind: TK, hint?: string): Token {
    const t = this.cur();
    if (t.kind !== kind) {
      const got = t.text ? `'${t.text}'` : t.kind;
      throw new PErr(hint ?? `Expected ${kind}, got ${got}`, t.span);
    }
    return this.advance();
  }

  expectIdent(name: string): Token {
    const t = this.cur();
    if (t.kind !== "IDENT" || t.text !== name)
      throw new PErr(`Expected '${name}', got '${t.text || t.kind}'`, t.span);
    return this.advance();
  }

  isIdent(name: string): boolean {
    return this.cur().kind === "IDENT" && this.cur().text === name;
  }

  isUpper(name?: string): boolean {
    return this.cur().kind === "UPPER" && (name === undefined || this.cur().text === name);
  }

  err(msg: string): never {
    throw new PErr(msg, this.cur().span);
  }

  // ---- NodeMeta helpers ---------------------------------------------------

  mk(span: SourceSpan): NodeMeta { return { id: freshId(), span }; }
  mkSpan(start: SourceSpan): NodeMeta { return this.mk(spanMerge(start, this.cur().span)); }

  // =========================================================================
  // Module
  // =========================================================================

  parseModule(): Module {
    const start = this.cur().span;

    // Optional module header
    let path: string[] = [];
    if (this.isIdent("module")) {
      this.advance();
      path = this.parseModulePath();
    }

    // Imports
    const imports: Import[] = [];
    while (this.isIdent("import")) {
      const iStart = this.cur().span;
      this.advance();
      imports.push({ path: this.parseModulePath(), meta: this.mkSpan(iStart) });
    }

    // Top-level declarations
    const decls: TopDecl[] = [];
    while (this.cur().kind !== "EOF") {
      decls.push(this.parseTopDecl());
    }

    return { path, imports, decls, meta: this.mkSpan(start) };
  }

  parseModulePath(): string[] {
    const parts: string[] = [];
    // First component may be upper or lower
    const t = this.cur();
    if (t.kind !== "UPPER" && t.kind !== "IDENT")
      this.err("Expected module path (identifier)");
    parts.push(this.advance().text);
    while (this.cur().kind === "DOT" && (this.look().kind === "UPPER" || this.look().kind === "IDENT")) {
      this.advance(); // consume DOT
      parts.push(this.advance().text);
    }
    return parts;
  }

  // =========================================================================
  // Top-level declarations
  // =========================================================================

  parseTopDecl(): TopDecl {
    if (this.isIdent("type"))   return { tag: "TypeDecl",   decl: this.parseTypeDecl()   };
    if (this.isIdent("def"))    return { tag: "DefDecl",    decl: this.parseDefDecl()    };
    if (this.isIdent("effect")) return { tag: "EffectDecl", decl: this.parseEffectDecl() };
    this.err(`Expected 'type', 'def', or 'effect', got '${this.cur().text || this.cur().kind}'`);
  }

  // =========================================================================
  // Type declarations
  // =========================================================================

  parseTypeDecl(): TypeDecl {
    const start = this.cur().span;
    this.expectIdent("type");
    const name = this.expect("UPPER", "Expected type name (uppercase)").text;
    const params: string[] = [];
    while (this.cur().kind === "IDENT") params.push(this.advance().text);
    this.expect("EQ", "Expected '=' in type declaration");

    // Record type: { field: Type, ... }
    if (this.cur().kind === "LBRACE") {
      const fields = this.parseRecordTypeBody();
      const body: TypeDeclBody = { tag: "Record", fields };
      return { name, params, body, meta: this.mkSpan(start) };
    }

    // Variant type: | Ctor ... | Ctor ...
    const ctors: CtorDecl[] = [];
    this.eat("PIPE"); // optional leading |
    ctors.push(this.parseCtorDecl());
    while (this.eat("PIPE")) ctors.push(this.parseCtorDecl());
    return { name, params, body: { tag: "Variant", ctors }, meta: this.mkSpan(start) };
  }

  parseCtorDecl(): CtorDecl {
    const start = this.cur().span;
    const name  = this.expect("UPPER", "Expected constructor name").text;
    let payload: SurfaceField[] | null = null;
    if (this.cur().kind === "LBRACE") {
      payload = this.parseRecordTypeBody();
    }
    return { name, payload, meta: this.mkSpan(start) };
  }

  /** Parse `{ field: Type, ... }` — used in type declarations and ctor payloads. */
  parseRecordTypeBody(): SurfaceField[] {
    this.expect("LBRACE");
    const fields: SurfaceField[] = [];
    if (this.cur().kind !== "RBRACE") {
      fields.push(this.parseSurfaceField());
      while (this.eat("COMMA") && this.cur().kind !== "RBRACE")
        fields.push(this.parseSurfaceField());
    }
    this.expect("RBRACE");
    return fields;
  }

  parseSurfaceField(): SurfaceField {
    const start = this.cur().span;
    const name  = this.expect("IDENT", "Expected field name").text;
    this.expect("COLON");
    const ty = this.parseTypeExpr();
    return { name, ty, meta: this.mkSpan(start) };
  }

  // =========================================================================
  // Def declarations
  // =========================================================================

  parseDefDecl(): DefDecl {
    const start = this.cur().span;
    this.expectIdent("def");
    const name = this.expect("IDENT", "Expected def name (lowercase)").text;

    // Optional higher-order params: (paramName : typeExpr)
    const params: DefParam[] = [];
    while (this.cur().kind === "LPAREN") {
      const pStart = this.cur().span;
      this.advance();
      const pName = this.expect("IDENT").text;
      this.expect("COLON");
      const pTy = this.parseTypeExpr();
      this.expect("RPAREN");
      params.push({ name: pName, ty: pTy, meta: this.mkSpan(pStart) });
    }

    // `: typeExpr` is optional. Omitting it produces an unannotated def
    // (ty = null) whose morphTy is inferred by the typechecker from the body.
    let ty: SurfaceType | null = null;
    let eff: SurfaceEffect | null = null;
    if (this.cur().kind === "COLON") {
      this.advance();
      ty = this.parseTypeExpr();

      // Optional outer `! effectLevel`
      if (this.cur().kind === "BANG") {
        this.advance();
        const e = this.parseEffectLevel();
        // If ty is Arrow, embed the effect inside the arrow; otherwise set outer eff
        if (ty.tag === "Arrow") {
          (ty as { eff: SurfaceEffect | null }).eff = e;
        } else {
          eff = e;
        }
      }
    }

    this.expect("EQ", "Expected '=' before def body");
    const body = this.parseExpr();
    return { name, params, ty, eff, body, meta: this.mkSpan(start) };
  }

  // =========================================================================
  // Effect declarations
  // =========================================================================

  parseEffectDecl(): EffectDecl {
    const start = this.cur().span;
    this.expectIdent("effect");
    const name = this.expect("IDENT", "Expected effect name (lowercase)").text;
    this.expect("COLON");
    const inputTy = this.parseTypeTerm();
    this.expect("ARROW", "Expected '->' in effect declaration");
    const outputTy = this.parseTypeExpr();
    this.expect("BANG", "Expected '!' in effect declaration");
    const effLevel = this.parseEffectLevel();
    return { name, inputTy, outputTy, eff: effLevel, meta: this.mkSpan(start) };
  }

  // =========================================================================
  // Type expressions
  // =========================================================================

  /**
   * arrowType ::= typeTerm ("->" typeExpr ("!" effectLevel)?)?
   * Right-associative: A -> B -> C parses as A -> (B -> C).
   */
  parseTypeExpr(): SurfaceType {
    const start = this.cur().span;
    const lhs = this.parseTypeTerm();
    if (this.cur().kind !== "ARROW") return lhs;
    this.advance(); // ->
    const rhs = this.parseTypeExpr();
    let eff: SurfaceEffect | null = null;
    if (this.cur().kind === "BANG") {
      this.advance();
      eff = this.parseEffectLevel();
    }
    return { tag: "Arrow", from: lhs, to: rhs, eff, meta: this.mkSpan(start) };
  }

  /**
   * typeTerm ::= typeAtom+   (type application: the head is an uppercase name)
   * A bare lowercase name is just a TyVar; it cannot be applied to arguments.
   */
  parseTypeTerm(): SurfaceType {
    const start = this.cur().span;
    const head = this.parseTypeAtom();

    // Type application: if head is a Named (uppercase), collect atom args
    if (head.tag === "Named") {
      const args: SurfaceType[] = [];
      while (this.isTypeAtomStart()) {
        args.push(this.parseTypeAtom());
      }
      if (args.length > 0) {
        return { tag: "Named", name: head.name, args, meta: this.mkSpan(start) };
      }
    }
    return head;
  }

  isTypeAtomStart(): boolean {
    const t = this.cur();
    return t.kind === "UPPER" || t.kind === "IDENT" || t.kind === "LBRACE" || t.kind === "LPAREN";
  }

  /**
   * typeAtom ::= TypeName | name | recordType | "(" typeExpr ")"
   */
  parseTypeAtom(): SurfaceType {
    const start = this.cur().span;
    const t = this.cur();

    if (t.kind === "UPPER") {
      this.advance();
      const base = resolveBaseType(t.text);
      if (base) return { tag: "BaseType", base, meta: this.mkSpan(start) };
      return { tag: "Named", name: t.text, args: [], meta: this.mkSpan(start) };
    }

    if (t.kind === "IDENT") {
      this.advance();
      return { tag: "TyVar", name: t.text, meta: this.mkSpan(start) };
    }

    if (t.kind === "LBRACE") {
      const fields = this.parseRecordTypeBody();
      // Check for row variable `| name` — only inside parenthesized type, not in a
      // record type body parsed here (already consumed RBRACE). Actually this is handled
      // in parseRecordTypeFull below. For record type atoms we just take the closed form.
      return { tag: "Record", fields, rest: null, meta: this.mkSpan(start) };
    }

    if (t.kind === "LPAREN") {
      this.advance();
      const inner = this.parseTypeExpr();
      this.expect("RPAREN");
      // Re-stamp meta with outer parens span
      return { ...inner, meta: this.mkSpan(start) };
    }

    this.err(`Expected type, got '${t.text || t.kind}'`);
  }

  parseEffectLevel(): SurfaceEffect {
    const t = this.cur();
    if (t.kind !== "IDENT") this.err("Expected effect level (pure | parallel-safe | sequential | effVar)");
    const name = t.text;
    this.advance();
    if (name === "pure")       return "pure";
    if (name === "sequential") return "sequential";
    if (name === "parallel") {
      // Expect `-safe`
      this.expect("MINUS", "Expected '-' after 'parallel' (parallel-safe)");
      this.expectIdent("safe");
      return "parallel-safe";
    }
    // Effect variable
    return { tag: "EffVar", name };
  }

  // =========================================================================
  // Expressions (pipelines)
  // =========================================================================

  /**
   * expr = pipeline
   * pipeline = infixSegment (">>>" infixSegment)*
   * Each infixSegment is a Step (possibly an Infix node).
   */
  parseExpr(): Expr {
    const start = this.cur().span;
    const steps: Step[] = [];
    steps.push(this.parseInfix(0));
    while (this.cur().kind === "COMPOSE") {
      this.advance();
      steps.push(this.parseInfix(0));
    }
    return { tag: "Pipeline", steps, meta: this.mkSpan(start) };
  }

  /**
   * Precedence-climbing infix parser.
   * Returns a Step (may be Infix).
   */
  parseInfix(minPrec: number): Step {
    let lhs = this.parseBaseStep();
    for (;;) {
      const entry = infixEntry(this.cur());
      if (!entry || entry.prec < minPrec) break;
      const opTok = this.advance();
      // Left-associative: right side uses prec + 1
      const rhs = this.parseInfix(entry.prec + 1);
      const meta = this.mk(spanMerge(lhs.meta.span, rhs.meta.span));
      lhs = { tag: "Infix", op: entry.op, left: lhs, right: rhs, meta };
    }
    return lhs;
  }

  /**
   * Base step: one non-infix, non-pipeline step.
   * Handles all keyword forms and atoms.
   */
  parseBaseStep(): Step {
    const start = this.cur().span;
    const t = this.cur();

    if (t.kind === "IDENT") {
      switch (t.text) {
        case "case":    return this.parseCaseOrFold("Case");
        case "fold":    return this.parseCaseOrFold("Fold");
        case "build":   return this.parseBuild();
        case "fanout":  return this.parseFanout();
        case "over":    return this.parseOver();
        case "let":     return this.parseLet();
        case "perform": return this.parsePerform();
      }
    }

    if (t.kind === "LPAREN") {
      this.advance();
      const inner = this.parseExpr();
      this.expect("RPAREN", "Expected ')' after grouped expression");
      if (inner.steps.length > 1) {
        this.err("Parenthesised multi-step pipelines are not supported; write steps without parentheses");
      }
      return inner.steps[0]!;
    }

    return this.parseAtom();
  }

  /**
   * Atom: name, ctor, projection, literal.
   * No keywords at this level.
   */
  parseAtom(): Step {
    const start = this.cur().span;
    const t = this.cur();

    // Boolean literals (uppercase but not constructors)
    if (t.kind === "UPPER" && (t.text === "True" || t.text === "False")) {
      this.advance();
      return { tag: "Literal", value: { tag: "bool", value: t.text === "True" }, meta: this.mkSpan(start) };
    }

    // Uppercase: qualified name (Foo.Bar.baz) or constructor
    // Qualified name pattern: UPPER (DOT UPPER)* DOT IDENT
    if (t.kind === "UPPER") {
      if (this.isQualifiedName()) {
        return this.parseQualifiedName(start);
      }
      this.advance();
      return { tag: "Ctor", name: t.text, meta: this.mkSpan(start) };
    }

    // Lowercase identifier: name or schema instantiation
    if (t.kind === "IDENT") {
      this.advance();
      // Schema instantiation: name(param: expr, ...)
      if (this.cur().kind === "LPAREN" && this.isSchemaInstStart()) {
        return this.parseSchemaInstTail(t.text, start);
      }
      return { tag: "Name", name: t.text, meta: this.mkSpan(start) };
    }

    // Projection: .fieldName
    if (t.kind === "DOT") {
      this.advance();
      const field = this.expect("IDENT", "Expected field name after '.'").text;
      return { tag: "Projection", field, meta: this.mkSpan(start) };
    }

    // Integer literal
    if (t.kind === "INT") {
      this.advance();
      return { tag: "Literal", value: { tag: "int", value: parseInt(t.text, 10) }, meta: this.mkSpan(start) };
    }

    // Float literal
    if (t.kind === "FLOAT") {
      this.advance();
      return { tag: "Literal", value: { tag: "float", value: parseFloat(t.text) }, meta: this.mkSpan(start) };
    }

    // Text literal
    if (t.kind === "TEXT") {
      this.advance();
      return { tag: "Literal", value: { tag: "text", value: t.text }, meta: this.mkSpan(start) };
    }

    this.err(`Unexpected token '${t.text || t.kind}' in expression`);
  }

  // =========================================================================
  // Qualified name helpers
  // =========================================================================

  /**
   * Lookahead: cur() is UPPER. Returns true if the upcoming tokens form
   * UPPER (DOT UPPER)* DOT IDENT — a qualified def reference like Foo.Bar.baz.
   */
  isQualifiedName(): boolean {
    let n = 1;
    for (;;) {
      if (this.look(n).kind !== "DOT") return false;
      n++;
      const next = this.look(n);
      if (next.kind === "IDENT") return true;
      if (next.kind === "UPPER") { n++; continue; }
      return false;
    }
  }

  /** Consume UPPER (DOT UPPER)* DOT IDENT and return a Name step. */
  parseQualifiedName(start: SourceSpan): Step {
    const parts: string[] = [this.advance().text]; // consume first UPPER
    for (;;) {
      if (this.cur().kind !== "DOT") break;
      const after = this.look(); // token after the DOT
      if (after.kind === "IDENT") {
        this.advance();                    // consume DOT
        parts.push(this.advance().text);   // consume IDENT
        break;
      } else if (after.kind === "UPPER") {
        this.advance();                    // consume DOT
        parts.push(this.advance().text);   // consume UPPER
      } else {
        break;
      }
    }
    return { tag: "Name", name: parts.join("."), meta: this.mkSpan(start) };
  }

  // =========================================================================
  // Schema instantiation
  // =========================================================================

  /**
   * Lookahead: LPAREN is current; peek inside to see if it looks like `name: ...`.
   */
  isSchemaInstStart(): boolean {
    // cur() == LPAREN, look(1) should be IDENT and look(2) should be COLON
    return this.look(1).kind === "IDENT" && this.look(2).kind === "COLON";
  }

  parseSchemaInstTail(name: string, start: SourceSpan): Step {
    this.expect("LPAREN");
    const args: SchemaArg[] = [];
    args.push(this.parseSchemaArg());
    while (this.eat("COMMA") && this.cur().kind !== "RPAREN")
      args.push(this.parseSchemaArg());
    this.eat("COMMA"); // trailing comma
    this.expect("RPAREN");
    return { tag: "SchemaInst", name, args, meta: this.mkSpan(start) };
  }

  parseSchemaArg(): SchemaArg {
    const start = this.cur().span;
    const name  = this.expect("IDENT", "Expected parameter name in schema argument").text;
    this.expect("COLON");
    const expr  = this.parseExpr();
    return { name, expr, meta: this.mkSpan(start) };
  }

  // =========================================================================
  // case / fold
  // =========================================================================

  parseCaseOrFold(tag: "Case" | "Fold"): Step {
    const start = this.cur().span;
    this.advance(); // consume 'case' or 'fold'

    // case .field { ... } — field-focused variant; only valid for 'case'
    let field: string | undefined;
    if (tag === "Case" && this.cur().kind === "DOT") {
      this.advance(); // consume '.'
      field = this.expect("IDENT", "Expected field name after 'case .'").text;
    }

    this.expect("LBRACE");
    const branches: Branch[] = [];
    this.eat("PIPE"); // optional leading |
    branches.push(this.parseBranch());
    while (this.eat("COMMA") && this.cur().kind !== "RBRACE")
      branches.push(this.parseBranch());
    this.eat("COMMA"); // trailing comma
    this.expect("RBRACE");
    return field !== undefined
      ? { tag: "Case", field, branches, meta: this.mkSpan(start) }
      : { tag, branches, meta: this.mkSpan(start) };
  }

  parseBranch(): Branch {
    const start = this.cur().span;
    const ctor  = this.expect("UPPER", "Expected constructor name in branch").text;
    this.expect("COLON");
    const handler = this.parseHandler();
    return { ctor, handler, meta: this.mkSpan(start) };
  }

  /**
   * handler ::= "{" fieldBinders "}" ">>>" expr    (RecordHandler)
   *           | expr                                 (NullaryHandler)
   *
   * Disambiguation: if next token is '{', it is always a RecordHandler.
   * No Weave expression starts with a bare '{'.
   */
  parseHandler(): Handler {
    const start = this.cur().span;

    if (this.cur().kind === "LBRACE") {
      this.advance(); // {
      const binders: FieldBinder[] = [];
      if (this.cur().kind !== "RBRACE") {
        binders.push(this.parseFieldBinder());
        while (this.eat("COMMA") && this.cur().kind !== "RBRACE")
          binders.push(this.parseFieldBinder());
      }
      this.eat("COMMA"); // trailing comma
      this.expect("RBRACE");
      this.expect("COMPOSE", "Expected '>>>' after record binders in handler");
      const body = this.parseExpr();
      return { tag: "RecordHandler", binders, body, meta: this.mkSpan(start) };
    }

    const body = this.parseExpr();
    return { tag: "NullaryHandler", body, meta: this.mkSpan(start) };
  }

  parseFieldBinder(): FieldBinder {
    const start = this.cur().span;
    const name  = this.expect("IDENT", "Expected field name in binder").text;
    if (this.cur().kind === "COLON") {
      this.advance();
      this.expect("UNDER", "Expected '_' after ':' in wildcard binder");
      return { tag: "Wildcard", name, meta: this.mkSpan(start) };
    }
    return { tag: "Bind", name, meta: this.mkSpan(start) };
  }

  // =========================================================================
  // build
  // =========================================================================

  parseBuild(): Step {
    const start = this.cur().span;
    this.advance(); // 'build'
    this.expect("LBRACE");
    const fields: BuildField[] = [];
    if (this.cur().kind !== "RBRACE") {
      fields.push(this.parseBuildField());
      while (this.eat("COMMA") && this.cur().kind !== "RBRACE")
        fields.push(this.parseBuildField());
    }
    this.eat("COMMA");
    this.expect("RBRACE");
    return { tag: "Build", fields, meta: this.mkSpan(start) };
  }

  parseBuildField(): BuildField {
    const start = this.cur().span;
    const name  = this.expect("IDENT", "Expected field name in build").text;
    this.expect("COLON");
    const expr  = this.parseExpr();
    return { name, expr, meta: this.mkSpan(start) };
  }

  // =========================================================================
  // fanout
  // =========================================================================

  parseFanout(): Step {
    const start = this.cur().span;
    this.advance(); // 'fanout'
    this.expect("LBRACE");
    const fields: FanoutField[] = [];
    if (this.cur().kind !== "RBRACE") {
      fields.push(this.parseFanoutField());
      while (this.eat("COMMA") && this.cur().kind !== "RBRACE")
        fields.push(this.parseFanoutField());
    }
    this.eat("COMMA");
    this.expect("RBRACE");
    return { tag: "Fanout", fields, meta: this.mkSpan(start) };
  }

  parseFanoutField(): FanoutField {
    const start = this.cur().span;
    const name  = this.expect("IDENT", "Expected field name in fanout").text;
    if (this.cur().kind === "COLON") {
      this.advance();
      const expr = this.parseExpr();
      return { tag: "Field", name, expr, meta: this.mkSpan(start) };
    }
    // Shorthand: just the name
    return { tag: "Shorthand", name, meta: this.mkSpan(start) };
  }

  // =========================================================================
  // over
  // =========================================================================

  parseOver(): Step {
    const start = this.cur().span;
    this.advance(); // 'over'
    this.expect("DOT", "Expected '.fieldName' after 'over'");
    const field = this.expect("IDENT", "Expected field name after '.'").text;
    // Transform is a single base step (not a full pipeline)
    const transform = this.parseBaseStep();
    return { tag: "Over", field, transform, meta: this.mkSpan(start) };
  }

  // =========================================================================
  // let
  // =========================================================================

  parseLet(): Step {
    const start = this.cur().span;
    this.advance(); // 'let'
    const name = this.expect("IDENT", "Expected binding name after 'let'").text;
    this.expect("EQ", "Expected '=' in let binding");
    const rhs = this.parseExpr();
    this.expectIdent("in");
    const body = this.parseExpr();
    return { tag: "Let", name, rhs, body, meta: this.mkSpan(start) };
  }

  // =========================================================================
  // perform
  // =========================================================================

  parsePerform(): Step {
    const start = this.cur().span;
    this.advance(); // 'perform'
    const op: string[] = [];
    // Allow mixed-case qualified name
    const first = this.cur();
    if (first.kind !== "UPPER" && first.kind !== "IDENT")
      this.err("Expected qualified name after 'perform'");
    op.push(this.advance().text);
    while (this.cur().kind === "DOT" && (this.look().kind === "UPPER" || this.look().kind === "IDENT")) {
      this.advance(); // DOT
      op.push(this.advance().text);
    }
    return { tag: "Perform", op, meta: this.mkSpan(start) };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveBaseType(name: string): "Int" | "Float" | "Bool" | "Text" | "Unit" | null {
  switch (name) {
    case "Int":   return "Int";
    case "Float": return "Float";
    case "Bool":  return "Bool";
    case "Text":  return "Text";
    case "Unit":  return "Unit";
    default:      return null;
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export type ParseModuleOpts = {
  /** Allow unannotated `def name = expr` forms (ty = null). REPL-only — not valid v1 surface syntax. */
  allowUnannotatedDefs?: boolean;
};

export function parseModule(source: string, opts?: ParseModuleOpts): ParseResult<Module> {
  let tokens: Token[];
  try {
    tokens = lex(source);
  } catch (e) {
    if (e instanceof LexError) {
      return { ok: false, errors: [{ message: e.message, span: { start: e.pos, end: e.pos } }] };
    }
    throw e;
  }

  const parser = new Parser(tokens);
  let mod: Module;
  try {
    mod = parser.parseModule();
  } catch (e) {
    if (e instanceof PErr) {
      return { ok: false, errors: [{ message: e.message, span: e.span }] };
    }
    throw e;
  }

  if (!opts?.allowUnannotatedDefs) {
    const errors: ParseError[] = [];
    for (const topDecl of mod.decls) {
      if (topDecl.tag === "DefDecl" && topDecl.decl.ty === null) {
        errors.push({
          message: `def '${topDecl.decl.name}' requires a type annotation (': type')`,
          span: topDecl.decl.meta.span,
        });
      }
    }
    if (errors.length > 0) return { ok: false, errors };
  }

  return { ok: true, value: mod };
}
