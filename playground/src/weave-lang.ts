import { StreamLanguage } from "@codemirror/language";

const KEYWORDS = new Set([
  "def", "type", "case", "fold", "import", "module",
  "let", "fanout", "build", "perform", "effect",
]);

const BUILTIN_TYPES = new Set(["Int", "Bool", "Text", "Unit"]);

export const weaveLang = StreamLanguage.define({
  token(stream) {
    if (stream.eatSpace()) return null;

    // Line comment
    if (stream.match("//")) {
      stream.skipToEnd();
      return "comment";
    }

    // String literal
    if (stream.match(/^"([^"\\]|\\.)*"/)) return "string";

    // Identifiers, keywords, types, constructors
    if (stream.match(/^[a-zA-Z_][a-zA-Z0-9_]*/)) {
      const word = stream.current();
      if (KEYWORDS.has(word))      return "keyword";
      if (BUILTIN_TYPES.has(word)) return "type";
      if (word === "true" || word === "false") return "atom";
      if (/^[A-Z]/.test(word))    return "variable-2"; // constructors / module names
      return null;
    }

    // Integer literals
    if (stream.match(/^\d+/)) return "number";

    // Multi-character operators (longest first)
    if (stream.match(">>>")) return "operator";
    if (stream.match("<>"))  return "operator";
    if (stream.match("->"))  return "operator";
    if (stream.match("&&"))  return "operator";
    if (stream.match("||"))  return "operator";

    // Single-character operators and punctuation
    const ch = stream.next();
    if (ch && "=|!:,{}.><+-*/%()[]".includes(ch)) return "operator";

    return null;
  },
});
