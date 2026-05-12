/**
 * Runtime values for the Weave v1 interpreter.
 *
 * Every value is a morphism 1 -> T; the distinction is encoded as a
 * structural tag. No closures or function values exist at runtime —
 * higher-order defs are handled at the schema-instantiation level before
 * interpretation.
 *
 * Immutability invariant: Values must never be mutated after construction.
 * DupNode shares the same Value reference across all its output ports; any
 * in-place mutation would corrupt aliased consumers. Constructors below
 * allocate fresh Maps/objects — callers must not mutate them afterwards.
 */

export type Value =
  | { tag: "unit" }
  | { tag: "int";     value: number  }
  | { tag: "float";   value: number  }
  | { tag: "bool";    value: boolean }
  | { tag: "text";    value: string  }
  | { tag: "record";  fields: Map<string, Value> }
  | { tag: "variant"; ctor: string; payload: Value };

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

export const VUnit: Value = { tag: "unit" };
export const vInt   = (n: number):  Value => ({ tag: "int",   value: n });
export const vFloat = (n: number):  Value => ({ tag: "float", value: n });
export const vBool  = (b: boolean): Value => ({ tag: "bool",  value: b });
export const vText  = (s: string):  Value => ({ tag: "text",  value: s });

export function vRecord(fields: Record<string, Value>): Value {
  return { tag: "record", fields: new Map(Object.entries(fields)) };
}

export function vVariant(ctor: string, payload: Value = VUnit): Value {
  return { tag: "variant", ctor, payload };
}

// ---------------------------------------------------------------------------
// Display (for tests / debugging)
// ---------------------------------------------------------------------------

export function showValue(v: Value): string {
  switch (v.tag) {
    case "unit":    return "()";
    case "int":     return String(v.value);
    case "float":   return String(v.value);
    case "bool":    return String(v.value);
    case "text":    return JSON.stringify(v.value);
    case "record": {
      const fields = [...v.fields.entries()].map(([k, fv]) => `${k}: ${showValue(fv)}`).join(", ");
      return `{ ${fields} }`;
    }
    case "variant":
      return v.payload.tag === "unit"
        ? v.ctor
        : `${v.ctor}(${showValue(v.payload)})`;
  }
}
