/**
 * Type-directed JSON → Value decoder for `weave run --input`.
 *
 * Encoding rules:
 *   Unit         → null
 *   Int          → JSON number (must be integer)
 *   Float        → JSON number
 *   Bool         → JSON boolean
 *   Text         → JSON string
 *   Record       → JSON object with matching named fields
 *   Named (ADT)  → { "tag": "<Ctor>", ...payload-fields }
 *                   "tag" is reserved as the discriminator. Constructor payload
 *                   fields named "tag" are unencodable and produce a decode error.
 *
 * For ADTs, constructor payloads are always named records in Weave, so all
 * payload fields appear flat in the JSON object alongside "tag". Nullary
 * constructors have no payload fields. Lists are encoded as nested Cons/Nil:
 *   { "tag": "Cons", "head": 1, "tail": { "tag": "Nil" } }
 */

import { applySubst, showType } from "../typechecker/index.ts";
import type { Type } from "../types/type.ts";
import type { TypedTypeDecl } from "../typechecker/typed-ast.ts";
import {
  VUnit, vInt, vFloat, vBool, vText, vRecord, vVariant, type Value,
} from "../interpreter/value.ts";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export class InputDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputDecodeError";
  }
}

/**
 * Decode a JSON-parsed value into a Weave runtime Value, guided by `ty`.
 *
 * `typeDecls` must come from the ElaboratedModule so that Named types
 * can be resolved to their constructor lists.
 *
 * Throws InputDecodeError on any mismatch.
 */
export function decodeInput(
  raw: unknown,
  ty: Type,
  typeDecls: ReadonlyMap<string, TypedTypeDecl>,
): Value {
  return decode(raw, ty, typeDecls, "input");
}

// ---------------------------------------------------------------------------
// Recursive decoder
// ---------------------------------------------------------------------------

function decode(
  raw: unknown,
  ty: Type,
  typeDecls: ReadonlyMap<string, TypedTypeDecl>,
  path: string,
): Value {
  switch (ty.tag) {
    case "Unit":
      if (raw !== null) {
        throw new InputDecodeError(
          `${path}: expected null for Unit, got ${JSON.stringify(raw)}`,
        );
      }
      return VUnit;

    case "Int":
      if (typeof raw !== "number" || !Number.isInteger(raw)) {
        throw new InputDecodeError(
          `${path}: expected Int (integer number), got ${JSON.stringify(raw)}`,
        );
      }
      return vInt(raw);

    case "Float":
      if (typeof raw !== "number") {
        throw new InputDecodeError(
          `${path}: expected Float (number), got ${JSON.stringify(raw)}`,
        );
      }
      return vFloat(raw);

    case "Bool":
      if (typeof raw !== "boolean") {
        throw new InputDecodeError(
          `${path}: expected Bool (true or false), got ${JSON.stringify(raw)}`,
        );
      }
      return vBool(raw);

    case "Text":
      if (typeof raw !== "string") {
        throw new InputDecodeError(
          `${path}: expected Text (string), got ${JSON.stringify(raw)}`,
        );
      }
      return vText(raw);

    case "Record":
      return decodeRecord(raw, ty.fields, typeDecls, path);

    case "Named":
      return decodeNamed(raw, ty.name, ty.args, typeDecls, path);

    case "TyVar":
      throw new InputDecodeError(
        `${path}: unresolved type variable '${ty.name}'; the def must be monomorphic to use --input`,
      );

    case "Arrow":
      throw new InputDecodeError(
        `${path}: cannot supply a function value via --input (type: ${showType(ty)})`,
      );
  }
}

// ---------------------------------------------------------------------------
// Record decoding
// ---------------------------------------------------------------------------

function decodeRecord(
  raw: unknown,
  fields: { name: string; ty: Type }[],
  typeDecls: ReadonlyMap<string, TypedTypeDecl>,
  path: string,
): Value {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new InputDecodeError(
      `${path}: expected a JSON object, got ${JSON.stringify(raw)}`,
    );
  }
  const obj = raw as Record<string, unknown>;
  const result: Record<string, Value> = {};

  for (const f of fields) {
    if (!(f.name in obj)) {
      throw new InputDecodeError(`${path}: missing field "${f.name}"`);
    }
    result[f.name] = decode(obj[f.name], f.ty, typeDecls, `${path}.${f.name}`);
  }

  const known = new Set(fields.map((f) => f.name));
  const extra = Object.keys(obj).filter((k) => !known.has(k));
  if (extra.length > 0) {
    throw new InputDecodeError(
      `${path}: unexpected field(s) ${extra.map((k) => `"${k}"`).join(", ")}`,
    );
  }

  return vRecord(result);
}

// ---------------------------------------------------------------------------
// ADT / Named type decoding
// ---------------------------------------------------------------------------

function decodeNamed(
  raw: unknown,
  name: string,
  args: Type[],
  typeDecls: ReadonlyMap<string, TypedTypeDecl>,
  path: string,
): Value {
  const decl = typeDecls.get(name);
  if (!decl) {
    throw new InputDecodeError(
      `${path}: unknown type '${name}'`,
    );
  }

  if (args.length !== decl.params.length) {
    throw new InputDecodeError(
      `${path}: type '${name}' expects ${decl.params.length} type argument(s) but got ${args.length}; the def input type must be fully concrete`,
    );
  }

  // Record-alias type: decode as a plain record with substituted field types
  if (decl.body.tag === "Record") {
    const subst = buildSubst(decl.params, args);
    const fields = decl.body.fields.map((f) => ({
      name: f.name,
      ty:   applySubst(f.ty, subst),
    }));
    return decodeRecord(raw, fields, typeDecls, path);
  }

  // Variant type: expect { "tag": "CtorName", ...payload-fields }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new InputDecodeError(
      `${path}: expected an object with "tag" for type '${name}', got ${JSON.stringify(raw)}`,
    );
  }
  const obj = raw as Record<string, unknown>;

  if (typeof obj["tag"] !== "string") {
    throw new InputDecodeError(
      `${path}: expected a "tag" string field for type '${name}'`,
    );
  }
  const ctorName = obj["tag"];

  const ctor = decl.body.ctors.find((c) => c.name === ctorName);
  if (!ctor) {
    const available = decl.body.ctors.map((c) => c.name).join(", ");
    throw new InputDecodeError(
      `${path}: unknown constructor "${ctorName}" for type '${name}'; available: ${available}`,
    );
  }

  const subst = buildSubst(decl.params, args);

  if (ctor.payloadTy === null) {
    // Nullary constructor: no payload fields beyond "tag"
    const extra = Object.keys(obj).filter((k) => k !== "tag");
    if (extra.length > 0) {
      throw new InputDecodeError(
        `${path}: constructor "${ctorName}" is nullary but found extra field(s): ${extra.map((k) => `"${k}"`).join(", ")}`,
      );
    }
    return vVariant(ctorName);
  }

  // Record-payload constructor: fields appear flat alongside "tag"
  const concretePayload = applySubst(ctor.payloadTy, subst);
  if (concretePayload.tag !== "Record") {
    throw new InputDecodeError(
      `${path}: internal: constructor "${ctorName}" payload resolved to non-record type ${showType(concretePayload)}`,
    );
  }

  // Enforce "tag" reservation: a payload field named "tag" is unencodable in
  // the flat tagged-object encoding because it collides with the discriminator.
  const tagClash = concretePayload.fields.find((f) => f.name === "tag");
  if (tagClash) {
    throw new InputDecodeError(
      `${path}: constructor "${ctorName}" has a payload field named "tag", which is reserved in the JSON encoding; this constructor cannot be used with --input`,
    );
  }

  const result: Record<string, Value> = {};
  for (const f of concretePayload.fields) {
    if (!(f.name in obj)) {
      throw new InputDecodeError(
        `${path}: missing field "${f.name}" for constructor "${ctorName}"`,
      );
    }
    result[f.name] = decode(obj[f.name], f.ty, typeDecls, `${path}.${f.name}`);
  }

  const known = new Set(concretePayload.fields.map((f) => f.name));
  known.add("tag");
  const extra = Object.keys(obj).filter((k) => !known.has(k));
  if (extra.length > 0) {
    throw new InputDecodeError(
      `${path}: unexpected field(s) ${extra.map((k) => `"${k}"`).join(", ")} for constructor "${ctorName}"`,
    );
  }

  return vVariant(ctorName, vRecord(result));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildSubst(params: string[], args: Type[]): Map<string, Type> {
  const subst = new Map<string, Type>();
  for (let i = 0; i < params.length; i++) {
    if (args[i] !== undefined) subst.set(params[i]!, args[i]!);
  }
  return subst;
}
