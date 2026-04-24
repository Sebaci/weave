/**
 * Weave v1 Lexer.
 *
 * Converts a source string into a flat token stream.
 * All whitespace and line comments (--) are discarded.
 * Positions are 1-based (line 1, column 1).
 */

import type { Position, SourceSpan } from "../surface/id.ts";

// ---------------------------------------------------------------------------
// Token kinds
// ---------------------------------------------------------------------------

export type TK =
  | "INT" | "FLOAT" | "TEXT"
  | "IDENT"     // lowercase identifier (names, keywords)
  | "UPPER"     // uppercase identifier (type names, constructors, True/False)
  | "COMPOSE"   // >>>
  | "ARROW"     // ->
  | "BANG"      // !
  | "LBRACE" | "RBRACE"
  | "LPAREN" | "RPAREN"
  | "COMMA" | "COLON" | "EQ" | "DOT" | "PIPE" | "UNDER"
  | "PLUS" | "MINUS" | "STAR" | "SLASH"
  | "EQEQ" | "NEQ" | "LT" | "GT" | "LEQ" | "GEQ"
  | "AMPAMP" | "PIPEPIPE"
  | "EOF";

export type Token = {
  kind: TK;
  text: string;     // raw source text
  span: SourceSpan;
};

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

export class LexError extends Error {
  constructor(
    public override message: string,
    public pos: Position,
  ) {
    super(`Lex error at ${pos.line}:${pos.column}: ${message}`);
  }
}

export function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let col  = 1;

  const cur  = ()          => i < source.length ? source[i]!  : "";
  const look = (n = 1)     => i + n < source.length ? source[i + n]! : "";
  const pos  = (): Position => ({ line, column: col });

  function advance(): string {
    const ch = source[i++]!;
    if (ch === "\n") { line++; col = 1; } else { col++; }
    return ch;
  }

  function token(kind: TK, text: string, start: Position): Token {
    return { kind, text, span: { start, end: pos() } };
  }

  function skipWS(): void {
    for (;;) {
      const ch = cur();
      if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
        advance();
      } else if (ch === "-" && look() === "-") {
        while (i < source.length && cur() !== "\n") advance();
      } else {
        break;
      }
    }
  }

  while (i < source.length) {
    skipWS();
    if (i >= source.length) break;

    const start = pos();
    const ch = cur();

    // ---- String literals ------------------------------------------------
    if (ch === '"') {
      advance();
      let text = "";
      while (i < source.length && cur() !== '"') {
        if (cur() === "\\") {
          advance();
          const e = advance();
          switch (e) {
            case "n":  text += "\n"; break;
            case "t":  text += "\t"; break;
            case '"':  text += '"';  break;
            case "\\": text += "\\"; break;
            default:   text += e;
          }
        } else {
          text += advance();
        }
      }
      if (cur() !== '"') throw new LexError("Unterminated string literal", start);
      advance();
      tokens.push(token("TEXT", text, start));
      continue;
    }

    // ---- Numeric literals -----------------------------------------------
    if (ch >= "0" && ch <= "9") {
      let text = "";
      while (cur() >= "0" && cur() <= "9") text += advance();
      if (cur() === "." && look() >= "0" && look() <= "9") {
        text += advance();
        while (cur() >= "0" && cur() <= "9") text += advance();
        tokens.push(token("FLOAT", text, start));
      } else {
        tokens.push(token("INT", text, start));
      }
      continue;
    }

    // ---- Lowercase identifiers (and bare underscore) --------------------
    if ((ch >= "a" && ch <= "z") || ch === "_") {
      let text = "";
      while (
        (cur() >= "a" && cur() <= "z") || (cur() >= "A" && cur() <= "Z") ||
        (cur() >= "0" && cur() <= "9") || cur() === "_" || cur() === "'"
      ) {
        text += advance();
      }
      tokens.push(token(text === "_" ? "UNDER" : "IDENT", text, start));
      continue;
    }

    // ---- Uppercase identifiers -----------------------------------------
    if (ch >= "A" && ch <= "Z") {
      let text = "";
      while (
        (cur() >= "a" && cur() <= "z") || (cur() >= "A" && cur() <= "Z") ||
        (cur() >= "0" && cur() <= "9") || cur() === "_" || cur() === "'"
      ) {
        text += advance();
      }
      tokens.push(token("UPPER", text, start));
      continue;
    }

    // ---- Operators and punctuation -------------------------------------
    advance(); // consume the leading character

    switch (ch) {
      case ">":
        if (cur() === ">" && look() === ">") {
          advance(); advance();
          tokens.push(token("COMPOSE", ">>>", start));
        } else if (cur() === "=") {
          advance(); tokens.push(token("GEQ", ">=", start));
        } else {
          tokens.push(token("GT", ">", start));
        }
        break;
      case "<":
        if (cur() === "=") { advance(); tokens.push(token("LEQ", "<=", start)); }
        else tokens.push(token("LT", "<", start));
        break;
      case "=":
        if (cur() === "=") { advance(); tokens.push(token("EQEQ", "==", start)); }
        else tokens.push(token("EQ", "=", start));
        break;
      case "!":
        if (cur() === "=") { advance(); tokens.push(token("NEQ", "!=", start)); }
        else tokens.push(token("BANG", "!", start));
        break;
      case "&":
        if (cur() === "&") { advance(); tokens.push(token("AMPAMP", "&&", start)); }
        else throw new LexError("Unexpected '&'; did you mean '&&'?", start);
        break;
      case "|":
        if (cur() === "|") { advance(); tokens.push(token("PIPEPIPE", "||", start)); }
        else tokens.push(token("PIPE", "|", start));
        break;
      case "-":
        if (cur() === ">") { advance(); tokens.push(token("ARROW", "->", start)); }
        else tokens.push(token("MINUS", "-", start));
        break;
      case "+": tokens.push(token("PLUS",   "+", start)); break;
      case "*": tokens.push(token("STAR",   "*", start)); break;
      case "/": tokens.push(token("SLASH",  "/", start)); break;
      case "{": tokens.push(token("LBRACE", "{", start)); break;
      case "}": tokens.push(token("RBRACE", "}", start)); break;
      case "(": tokens.push(token("LPAREN", "(", start)); break;
      case ")": tokens.push(token("RPAREN", ")", start)); break;
      case ",": tokens.push(token("COMMA",  ",", start)); break;
      case ":": tokens.push(token("COLON",  ":", start)); break;
      case ".": tokens.push(token("DOT",    ".", start)); break;
      default:
        throw new LexError(`Unexpected character '${ch}'`, start);
    }
  }

  tokens.push({ kind: "EOF", text: "", span: { start: pos(), end: pos() } });
  return tokens;
}
