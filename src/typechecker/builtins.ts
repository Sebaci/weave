/**
 * Fixed v1 builtin infix operator table (implementation notes §4.2).
 * Implicitly available — no import required.
 *
 * Each operator desugars to: fanout { l: left, r: right } >>> morphismName
 * All builtin operators are pure.
 */

import { type Type, TInt, TFloat, TBool, TText, record, field, named, tyVar } from "../types/type.ts";

export type BuiltinOpEntry = {
  morphismName: string;
  // The input record type for the morphism: { l: A, r: A }
  // Returns a function from the operand type to the full signature.
  signature: (operandTy: Type) => { inputTy: Type; outputTy: Type } | null;
};

/**
 * Look up an infix operator.
 * Returns null if the operator is not in the v1 builtin table (→ type error).
 */
export function lookupInfixOp(op: string): BuiltinOpEntry | null {
  return INFIX_TABLE[op] ?? null;
}

/** All builtin operator names, for error messages. */
export const BUILTIN_OPS: readonly string[] = [
  "+", "-", "*", "/", "==", "!=", "<", ">", "<=", ">=", "&&", "||", "<>",
];

// ---------------------------------------------------------------------------
// Operator table
// ---------------------------------------------------------------------------

const INFIX_TABLE: Record<string, BuiltinOpEntry> = {
  "+":  numericOp("builtin.add"),
  "-":  numericOp("builtin.sub"),
  "*":  numericOp("builtin.mul"),
  "/":  numericOp("builtin.div"),
  "<":  comparisonOp("builtin.lt"),
  ">":  comparisonOp("builtin.gt"),
  "<=": comparisonOp("builtin.leq"),
  ">=": comparisonOp("builtin.geq"),
  "==": equalityOp("builtin.eq"),
  "!=": equalityOp("builtin.neq"),
  "&&": boolOp("builtin.and"),
  "||": boolOp("builtin.or"),
  "<>": concatOp("builtin.concat"),
};

// ---------------------------------------------------------------------------
// Operator constructors
// ---------------------------------------------------------------------------

/**
 * Numeric operators: accept Int or Float, return same type.
 * The `operandTy` parameter lets the typechecker pass the resolved operand type
 * after unification. If neither Int nor Float, returns null (type error).
 */
function numericOp(morphismName: string): BuiltinOpEntry {
  return {
    morphismName,
    signature: (operandTy) => {
      if (operandTy.tag !== "Int" && operandTy.tag !== "Float") return null;
      return {
        inputTy:  record([field("l", operandTy), field("r", operandTy)]),
        outputTy: operandTy,
      };
    },
  };
}

/** Comparison operators: Int or Float operands, Bool result. */
function comparisonOp(morphismName: string): BuiltinOpEntry {
  return {
    morphismName,
    signature: (operandTy) => {
      if (operandTy.tag !== "Int" && operandTy.tag !== "Float") return null;
      return {
        inputTy:  record([field("l", operandTy), field("r", operandTy)]),
        outputTy: TBool,
      };
    },
  };
}

/** Equality operators: any type `a`, Bool result. */
function equalityOp(morphismName: string): BuiltinOpEntry {
  return {
    morphismName,
    signature: (operandTy) => ({
      inputTy:  record([field("l", operandTy), field("r", operandTy)]),
      outputTy: TBool,
    }),
  };
}

/** Text concatenation operator: { l: Text, r: Text } → Text. Rejects non-Text operands. */
function concatOp(morphismName: string): BuiltinOpEntry {
  return {
    morphismName,
    signature: (operandTy) => {
      if (operandTy.tag !== "Text") return null;
      return {
        inputTy:  record([field("l", TText), field("r", TText)]),
        outputTy: TText,
      };
    },
  };
}

/** Boolean operators: Bool operands, Bool result. Rejects non-Bool operands. */
function boolOp(morphismName: string): BuiltinOpEntry {
  return {
    morphismName,
    signature: (operandTy) => {
      if (operandTy.tag !== "Bool") return null;
      return {
        inputTy:  record([field("l", TBool), field("r", TBool)]),
        outputTy: TBool,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Builtin morphism specs — seeded into every module's name environment
// ---------------------------------------------------------------------------

export type BuiltinMorphismSpec = {
  name:     string;  // surface name, e.g. "id"
  defId:    string;  // runtime key, e.g. "builtin.id"
  inputTy:  Type;
  outputTy: Type;
};

export const BUILTIN_MORPHISM_SPECS: readonly BuiltinMorphismSpec[] = [
  { name: "id",     defId: "builtin.id",
    inputTy: tyVar("a"), outputTy: tyVar("a") },
  { name: "not",    defId: "builtin.not",
    inputTy: TBool, outputTy: TBool },
  { name: "concat", defId: "builtin.concat",
    inputTy: record([field("l", TText), field("r", TText)]), outputTy: TText },
];

// ---------------------------------------------------------------------------
// Builtin type names
// ---------------------------------------------------------------------------

/** Resolve a builtin type name to a concrete Type. Used in pass 1 when
 *  resolving surface type expressions. Returns null for unknown names. */
export function resolveBuiltinType(name: string): Type | null {
  switch (name) {
    case "Int":   return TInt;
    case "Float": return TFloat;
    case "Bool":  return TBool;
    case "Text":  return { tag: "Text" };
    case "Unit":  return { tag: "Unit" };
    default:      return null;
  }
}
