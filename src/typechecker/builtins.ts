/**
 * Fixed v1 builtin infix operator table (implementation notes §4.2).
 * Implicitly available — no import required.
 *
 * Each operator desugars to: fanout { l: left, r: right } >>> morphismName
 * All builtin operators are pure.
 */

import { type Type, TInt, TFloat, TBool, record, field, named } from "../types/type.ts";

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
  "+", "-", "*", "/", "==", "!=", "<", ">", "<=", ">=", "&&", "||",
];

// ---------------------------------------------------------------------------
// Operator table
// ---------------------------------------------------------------------------

const INFIX_TABLE: Record<string, BuiltinOpEntry> = {
  "+":  numericOp("add"),
  "-":  numericOp("sub"),
  "*":  numericOp("mul"),
  "/":  numericOp("div"),
  "<":  comparisonOp("lt"),
  ">":  comparisonOp("gt"),
  "<=": comparisonOp("leq"),
  ">=": comparisonOp("geq"),
  "==": equalityOp("eq"),
  "!=": equalityOp("neq"),
  "&&": boolOp("and"),
  "||": boolOp("or"),
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

/** Boolean operators: Bool operands, Bool result. */
function boolOp(morphismName: string): BuiltinOpEntry {
  return {
    morphismName,
    signature: (_operandTy) => ({
      inputTy:  record([field("l", TBool), field("r", TBool)]),
      outputTy: TBool,
    }),
  };
}

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
