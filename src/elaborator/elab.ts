/**
 * Elaborator: TypedModule → ElaboratedModule (Graph IR).
 *
 * Invariants maintained:
 *   - No unification or type inference here.
 *   - All port types are fully concrete on output.
 *   - All sharing is explicit via DupNode.
 *   - build and fanout produce categorically distinct graph structures.
 *   - CataNode algebra branches use Pi[A/μF]-substituted payload types.
 *   - Every node carries provenance.
 *   - IR validation runs eagerly after each Graph is built.
 */

import type { Type, ConcreteEffect } from "../types/type.ts";
import { effectJoin, typeEq } from "../types/check.ts";
import { substAdt, applySubst } from "../types/subst.ts";
import { isConcrete } from "../types/check.ts";

import type {
  TypedModule, TypedDef, TypedExpr, TypedStep, TypedNode,
  TypedBranch, TypedHandler, MorphTy, OmegaEntry,
  TypedTypeDecl, LiveVar,
} from "../typechecker/typed-ast.ts";
import type { CtorInfo } from "../typechecker/env.ts";
import type { Subst } from "../types/subst.ts";
import type { SourceNodeId } from "../surface/id.ts";
import type { SurfaceLiteral } from "../surface/ast.ts";

import type {
  Graph, Node, Port, PortId, NodeId,
  DupNode, DropNode, ProjNode, TupleNode,
  CaseNode, CataNode, ConstNode, CtorNode, EffectNode, RefNode,
  LiteralValue, Provenance, ElaboratedModule,
} from "../ir/ir.ts";
import { validateGraph } from "../ir/validate.ts";
import {
  GraphBuilder, freshNodeId, freshPortId, mkPort, prov,
} from "./graph-builder.ts";

import { ok, fail, type TypeResult, type TypeError } from "../typechecker/errors.ts";

// ---------------------------------------------------------------------------
// Elaboration context
// ---------------------------------------------------------------------------

type ElabContext = {
  /** All typed defs, for RefNode target lookup and SchemaInst body elaboration. */
  typedDefs:  Map<string, TypedDef>;
  /** Constructor info for CtorNode construction. */
  ctors:      Map<string, CtorInfo>;
  /** Effect operations environment. */
  omega:      Map<string, OmegaEntry>;
  /**
   * Local bindings: name → queue of PortIds (one per use).
   * Each LocalRef pops the front element; DupNode ensures one output per use.
   */
  locals:     Map<string, PortId[]>;
  /** The current morphism's input port. */
  inputPort:  PortId;
  /** Fully concrete type at inputPort. Required for over/let passthrough expansion. */
  inputType:  Type;
  /** The graph under construction. Nodes and wires are added here. */
  builder:    GraphBuilder;
  /** Source ID for provenance on synthetic nodes introduced here. */
  sourceId:   SourceNodeId;
};

function withLocals(
  ctx: ElabContext,
  locals: Map<string, PortId[]>,
  inputPort: PortId,
  inputType: Type,
): ElabContext {
  return { ...ctx, locals, inputPort, inputType };
}

// ---------------------------------------------------------------------------
// Module entry point
// ---------------------------------------------------------------------------

export function elaborateModule(mod: TypedModule): TypeResult<ElaboratedModule> {
  const errors: TypeError[] = [];
  const defs = new Map<string, Graph>();

  const prefix = mod.path.join(".");
  // Build a typedDefs context with both bare and qualified keys so that
  // SchemaInst.defName (now always qualified) can be resolved.
  const typedDefsCtx = new Map<string, TypedDef>(mod.typedDefs);
  if (prefix) {
    for (const [bareName, def] of mod.typedDefs) {
      typedDefsCtx.set(`${prefix}.${bareName}`, def);
    }
  }

  for (const [bareName, def] of mod.typedDefs) {
    if (isPolymorphic(def)) continue;  // elaborated only at SchemaInst sites
    const r = elaborateDef(def, typedDefsCtx, mod.omega);
    if (!r.ok) { errors.push(...r.errors); continue; }
    defs.set(bareName, r.value);
    if (prefix) defs.set(`${prefix}.${bareName}`, r.value);
  }

  if (errors.length > 0) return fail(errors);
  return ok({ defs, typeDecls: mod.typeDecls, omega: mod.omega });
}

/**
 * Elaborate all modules in a multi-module program into a single ElaboratedModule.
 *
 * Each non-polymorphic def is stored under both its qualified name (e.g.
 * "Shapes.origin") and its bare name (e.g. "origin") so that:
 *   - Cross-module RefNodes (defId = "Shapes.origin") resolve correctly.
 *   - Intra-module RefNodes (defId = "origin") also resolve correctly.
 *   - The CLI can look up the entry def by bare name.
 *
 * The cross-module typedDefs map is also passed to elaborateDef so that
 * SchemaInst across modules finds the higher-order def body.
 */
export function elaborateAll(modules: Map<string, TypedModule>): TypeResult<ElaboratedModule> {
  // Build cross-module maps indexed by qualified names only.
  // RefNode.defId and SchemaInst.defName are always qualified (set by typechecker),
  // so bare-name keys are not needed here and would cause collisions across modules.
  const allTypedDefs  = new Map<string, TypedDef>();
  const allOmega      = new Map<string, OmegaEntry>();
  const allTypeDecls  = new Map<string, TypedTypeDecl>();

  for (const [, typedMod] of modules) {
    const prefix = typedMod.path.join(".");
    for (const [bareName, def] of typedMod.typedDefs) {
      const qualName = prefix ? `${prefix}.${bareName}` : bareName;
      allTypedDefs.set(qualName, def);
    }
    for (const [k, v] of typedMod.omega)      allOmega.set(k, v);
    for (const [k, v] of typedMod.typeDecls)  allTypeDecls.set(k, v);
  }

  // Elaborate every non-polymorphic def using the full cross-module context.
  const errors: TypeError[] = [];
  const defs = new Map<string, Graph>();

  for (const [, typedMod] of modules) {
    const prefix = typedMod.path.join(".");
    for (const [bareName, def] of typedMod.typedDefs) {
      if (isPolymorphic(def)) continue;
      const r = elaborateDef(def, allTypedDefs, allOmega);
      if (!r.ok) { errors.push(...r.errors); continue; }
      const qualName = prefix ? `${prefix}.${bareName}` : bareName;
      defs.set(qualName, r.value);
    }
  }

  if (errors.length > 0) return fail(errors);
  return ok({ defs, typeDecls: allTypeDecls, omega: allOmega });
}

function isPolymorphic(def: TypedDef): boolean {
  return def.params.length > 0 || hasTypeVar(def.morphTy.input) || hasTypeVar(def.morphTy.output);
}

function hasTypeVar(ty: Type): boolean {
  switch (ty.tag) {
    case "TyVar": return true;
    case "Record": return ty.fields.some((f) => hasTypeVar(f.ty));
    case "Named":  return ty.args.some(hasTypeVar);
    case "Arrow":  return hasTypeVar(ty.from) || hasTypeVar(ty.to);
    default:       return false;
  }
}

// ---------------------------------------------------------------------------
// Def elaboration
// ---------------------------------------------------------------------------

function elaborateDef(
  def: TypedDef,
  typedDefs: Map<string, TypedDef>,
  omega: Map<string, OmegaEntry>,
): TypeResult<Graph> {
  const builder = new GraphBuilder();
  const inPort  = mkPort(def.morphTy.input);

  const ctx: ElabContext = {
    typedDefs,
    ctors:      new Map(), // populated below
    omega,
    locals:     new Map(),
    inputPort:  inPort.id,
    inputType:  def.morphTy.input,
    builder,
    sourceId:   def.sourceId,
  };
  // Populate ctors from typedDefs (constructors are accessed via CtorNode)
  const ctxWithCtors = { ...ctx, ctors: collectCtors(typedDefs) };

  const outPortId = elabExpr(def.body, inPort.id, ctxWithCtors);
  const outPort   = mkPort(def.morphTy.output);

  // Wire the body's output to the graph's outPort
  builder.wire(outPortId, outPort.id);

  const graph = builder.build(inPort, outPort, [prov(def.sourceId)]);
  const vr = validateGraph(graph);
  if (!vr.ok) {
    return fail(vr.errors.map((e) => ({
      code:    "E_ELABORATION" as const,
      message: `IR validation (${e.rule}): ${e.message}`,
      sourceId: def.sourceId,
    })));
  }
  return ok(graph);
}

/** Collect all constructor info from typed defs' type decls (passed through module). */
function collectCtors(typedDefs: Map<string, TypedDef>): Map<string, CtorInfo> {
  // Constructor info is not directly on TypedDef; we reconstruct from the
  // GlobalEnv that was available during typechecking. For v1 the elaborator
  // re-derives ctor info from what's present in the typed AST (CtorNode carries
  // enough info: ctorName and adtTy are in the morphTy output).
  // We use an empty map here and resolve CtorNode info from the TypedStep morphTy directly.
  return new Map();
}

// ---------------------------------------------------------------------------
// Expression elaboration
// ---------------------------------------------------------------------------

/**
 * Elaborate a TypedExpr within the current context.
 * Returns the PortId of the final output.
 * Wires are added to ctx.builder.
 */
function elabExpr(expr: TypedExpr, inputPortId: PortId, ctx: ElabContext): PortId {
  let current = inputPortId;
  for (const step of expr.steps) {
    current = elabStep(step, current, ctx);
  }
  return current;
}

// ---------------------------------------------------------------------------
// Step elaboration
// ---------------------------------------------------------------------------

function elabStep(step: TypedStep, inputPortId: PortId, ctx: ElabContext): PortId {
  const srcId = step.sourceId;
  const { builder } = ctx;

  switch (step.node.tag) {

    // -----------------------------------------------------------------------
    // Ref — global morphism reference
    // -----------------------------------------------------------------------
    case "Ref": {
      const { defId } = step.node;
      const outPort = mkPort(step.morphTy.output);
      const inPort  = mkPort(step.morphTy.input);
      builder.wire(inputPortId, inPort.id);
      const node: RefNode = {
        kind: "ref", defId,
        id: freshNodeId(), effect: step.morphTy.eff,
        input: inPort, output: outPort,
        provenance: [prov(srcId)],
      };
      builder.addNode(node);
      return outPort.id;
    }

    // -----------------------------------------------------------------------
    // LocalRef — wire to an existing port in locals (pop from queue)
    // -----------------------------------------------------------------------
    case "LocalRef": {
      const queue = ctx.locals.get(step.node.name);
      if (!queue || queue.length === 0) {
        throw new Error(`Elaborator internal: LocalRef '${step.node.name}' not in locals`);
      }
      // LocalRef returns a pre-projected local value and ignores the current
      // flowing input. Drop the input unless it is already consumed elsewhere
      // (e.g. the handler inPort used directly as a binder node's input port).
      if (!builder.isPortConsumedAsSource(inputPortId)) {
        liftUnit(inputPortId, step.morphTy.input, builder, srcId);
      }
      return queue.shift()!;
    }

    // -----------------------------------------------------------------------
    // Ctor — constructor morphism
    // -----------------------------------------------------------------------
    case "Ctor": {
      const inPort  = mkPort(step.morphTy.input);
      const outPort = mkPort(step.morphTy.output);
      builder.wire(inputPortId, inPort.id);
      const node: CtorNode = {
        kind: "ctor", ctorName: step.node.name,
        id: freshNodeId(), effect: "pure",
        input: inPort, output: outPort,
        adtTy: step.morphTy.output,
        provenance: [prov(srcId)],
      };
      builder.addNode(node);
      return outPort.id;
    }

    // -----------------------------------------------------------------------
    // Projection
    // -----------------------------------------------------------------------
    case "Projection": {
      const inPort  = mkPort(step.morphTy.input);
      const outPort = mkPort(step.morphTy.output);
      builder.wire(inputPortId, inPort.id);
      const node: ProjNode = {
        kind: "proj", field: step.node.field,
        id: freshNodeId(), effect: "pure",
        input: inPort, output: outPort,
        provenance: [prov(srcId, "field-proj")],
      };
      builder.addNode(node);
      return outPort.id;
    }

    // -----------------------------------------------------------------------
    // Literal — ConstNode
    // -----------------------------------------------------------------------
    case "Literal": {
      // ConstNode is unit-sourced: it ignores its input.
      // Drop the input unless it is already consumed elsewhere (e.g. the handler
      // inPort used directly as a binder ProjNode's input via port sharing).
      if (!builder.isPortConsumedAsSource(inputPortId)) {
        liftUnit(inputPortId, step.morphTy.input, builder, srcId);
      }
      const outPort = mkPort(step.morphTy.output);
      const node: ConstNode = {
        kind: "const", value: surfaceLitToLiteral(step.node.value),
        id: freshNodeId(), effect: "pure",
        output: outPort,
        provenance: [prov(srcId)],
      };
      builder.addNode(node);
      return outPort.id;
    }

    // -----------------------------------------------------------------------
    // Build — TupleNode with ConstNode-sourced fields
    // -----------------------------------------------------------------------
    case "Build": {
      return elabBuild(step as TypedStep & { node: { tag: "Build" } }, inputPortId, ctx, srcId);
    }

    // -----------------------------------------------------------------------
    // Fanout — DupNode + TupleNode
    // -----------------------------------------------------------------------
    case "Fanout": {
      return elabFanout(step as TypedStep & { node: { tag: "Fanout" } }, inputPortId, ctx, srcId);
    }

    // -----------------------------------------------------------------------
    // Case — CaseNode
    // -----------------------------------------------------------------------
    case "Case": {
      return elabCase(step as TypedStep & { node: { tag: "Case" } }, inputPortId, ctx, srcId);
    }

    // -----------------------------------------------------------------------
    // CaseField — field-focused CaseNode
    // -----------------------------------------------------------------------
    case "CaseField": {
      return elabCaseField(step as TypedStep & { node: { tag: "CaseField" } }, inputPortId, ctx, srcId);
    }

    // -----------------------------------------------------------------------
    // Fold — CataNode
    // -----------------------------------------------------------------------
    case "Fold": {
      return elabFold(step as TypedStep & { node: { tag: "Fold" } }, inputPortId, ctx, srcId);
    }

    // -----------------------------------------------------------------------
    // Over — ProjNode + transform + TupleNode
    // -----------------------------------------------------------------------
    case "Over": {
      return elabOver(step as TypedStep & { node: { tag: "Over" } }, inputPortId, ctx, srcId);
    }

    // -----------------------------------------------------------------------
    // Let — DupNode + TupleNode + body
    // -----------------------------------------------------------------------
    case "Let": {
      return elabLet(step as TypedStep & { node: { tag: "Let" } }, inputPortId, ctx, srcId);
    }

    // -----------------------------------------------------------------------
    // Perform — EffectNode
    // -----------------------------------------------------------------------
    case "Perform": {
      const inPort  = mkPort(step.morphTy.input);
      const outPort = mkPort(step.morphTy.output);
      builder.wire(inputPortId, inPort.id);
      const eff = step.morphTy.eff;
      if (eff !== "parallel-safe" && eff !== "sequential") {
        throw new Error(`Elaborator internal: Perform must have non-pure effect`);
      }
      const node: EffectNode = {
        kind: "effect", op: step.node.op,
        id: freshNodeId(), effect: eff,
        input: inPort, output: outPort,
        provenance: [prov(srcId)],
      };
      builder.addNode(node);
      return outPort.id;
    }

    // -----------------------------------------------------------------------
    // GroupedExpr — inline arg wrapper (created by expandParamRefs only)
    // -----------------------------------------------------------------------
    case "GroupedExpr": {
      return elabExpr(step.node.body, inputPortId, ctx);
    }

    // -----------------------------------------------------------------------
    // SchemaInst — definition-level substitution via inline expansion
    // -----------------------------------------------------------------------
    case "SchemaInst": {
      return elabSchemaInst(step as TypedStep & { node: { tag: "SchemaInst" } }, inputPortId, ctx, srcId);
    }
  }
}

// ---------------------------------------------------------------------------
// Build elaboration
// ---------------------------------------------------------------------------

function elabBuild(
  step: TypedStep & { node: { tag: "Build" } },
  inputPortId: PortId,
  ctx: ElabContext,
  srcId: SourceNodeId,
): PortId {
  const { builder } = ctx;
  const buildNode = step.node;

  if (buildNode.fields.length === 0) {
    // build {} → ConstNode { tag: "unit" }
    // Drop the input (terminal morphism).
    liftUnit(inputPortId, step.morphTy.input, builder, srcId);
    const outPort = mkPort({ tag: "Unit" });
    const node: ConstNode = {
      kind: "const", value: { tag: "unit" },
      id: freshNodeId(), effect: "pure",
      output: outPort,
      provenance: [prov(srcId)],
    };
    builder.addNode(node);
    return outPort.id;
  }

  // Each field expression is unit-sourced (checked by typechecker).
  // Build a fresh sub-context with unit input for each field.
  const tupleInputs: { label: string; port: { id: string; ty: Type } }[] = [];

  for (const field of buildNode.fields) {
    const fieldBuilder = new GraphBuilder();
    // A real ConstNode is needed as the unit source so that Ref nodes (and any
    // other node that wires to its input) have a valid producer port.
    const unitOutPort = mkPort({ tag: "Unit" });
    const unitSourceNode: ConstNode = {
      kind: "const", value: { tag: "unit" },
      id: freshNodeId(), effect: "pure",
      output: unitOutPort,
      provenance: [prov(srcId, "build-unit-source")],
    };
    fieldBuilder.addNode(unitSourceNode);
    const fieldCtx: ElabContext = {
      ...ctx,
      builder:    fieldBuilder,
      inputPort:  unitOutPort.id,
      inputType:  { tag: "Unit" },
      locals:     new Map(), // build fields must be closed
      sourceId:   srcId,
    };
    const fieldOutPortId = elabExpr(field.expr, unitOutPort.id, fieldCtx);

    // Splice the field sub-builder's nodes/wires into the main builder.
    for (const n of (fieldBuilder as unknown as { _nodes: import("../ir/ir.ts").Node[] })._nodes) {
      builder.addNode(n);
    }
    for (const w of (fieldBuilder as unknown as { _wires: import("../ir/ir.ts").Wire[] })._wires) {
      builder.wire(w.from, w.to);
    }

    tupleInputs.push({ label: field.name, port: { id: fieldOutPortId, ty: field.expr.morphTy.output } });
  }

  // Input to the build construct is dropped (terminal morphism).
  liftUnit(inputPortId, step.morphTy.input, builder, srcId);

  const outPort = mkPort(step.morphTy.output);
  const tupleNode: TupleNode = {
    kind: "tuple",
    id: freshNodeId(), effect: "pure",
    inputs: tupleInputs.map((f) => ({ label: f.label, port: { id: f.port.id, ty: f.port.ty } })),
    output: outPort,
    provenance: [prov(srcId, "build-tuple")],
  };
  builder.addNode(tupleNode);
  return outPort.id;
}

// ---------------------------------------------------------------------------
// Fanout elaboration
// ---------------------------------------------------------------------------

function elabFanout(
  step: TypedStep & { node: { tag: "Fanout" } },
  inputPortId: PortId,
  ctx: ElabContext,
  srcId: SourceNodeId,
): PortId {
  const { builder } = ctx;
  const fanoutNode = step.node;
  const n = fanoutNode.fields.length;

  if (n === 0) {
    // fanout {} = terminal morphism ! : I -> 1
    return liftUnit(inputPortId, step.morphTy.input, builder, srcId);
  }

  // For n >= 2 create a DupNode; for n === 1 wire inputPortId directly (dup_1 = id).
  let dupOutputIds: PortId[];
  if (n === 1) {
    dupOutputIds = [inputPortId];
  } else {
    const inPort = mkPort(step.morphTy.input);
    builder.wire(inputPortId, inPort.id);
    const dupOutputs = Array.from({ length: n }, () => mkPort(step.morphTy.input));
    const dupNode: DupNode = {
      kind: "dup",
      id: freshNodeId(), effect: "pure",
      input: inPort, outputs: dupOutputs,
      provenance: [prov(srcId, "dup-for-fanout")],
    };
    builder.addNode(dupNode);
    dupOutputIds = dupOutputs.map((p) => p.id);
  }

  // Elaborate each branch with norm_I applied
  const tupleInputs: { label: string; port: { id: string; ty: Type } }[] = [];

  for (let i = 0; i < n; i++) {
    const field    = fanoutNode.fields[i]!;
    const branchExpr = field.expr;

    const branchOutPortId = elabNormI(branchExpr, dupOutputIds[i]!, step.morphTy.input, ctx, srcId);
    tupleInputs.push({ label: field.name, port: { id: branchOutPortId, ty: branchExpr.morphTy.output } });
  }

  const outPort = mkPort(step.morphTy.output);
  const tupleNode: TupleNode = {
    kind: "tuple",
    id: freshNodeId(), effect: "pure",
    inputs: tupleInputs.map((f) => ({ label: f.label, port: { id: f.port.id, ty: f.port.ty } })),
    output: outPort,
    provenance: [prov(srcId, "fanout-tuple")],
  };
  builder.addNode(tupleNode);
  return outPort.id;
}

// ---------------------------------------------------------------------------
// Case elaboration
// ---------------------------------------------------------------------------

function elabCase(
  step: TypedStep & { node: { tag: "Case" } },
  inputPortId: PortId,
  ctx: ElabContext,
  srcId: SourceNodeId,
): PortId {
  const { builder } = ctx;
  const inPort  = mkPort(step.morphTy.input);
  const outPort = mkPort(step.morphTy.output);
  builder.wire(inputPortId, inPort.id);

  const branches = step.node.branches.map((b) => ({
    tag:          b.ctor,
    rawPayloadTy: b.rawPayloadTy,
    graph:        elabBranchHandler(b, step.morphTy.output, ctx, srcId),
  }));

  let eff: ConcreteEffect = "pure";
  for (const b of branches) eff = effectJoin(eff, b.graph.effect);

  const node: CaseNode = {
    kind: "case",
    id: freshNodeId(), effect: eff,
    input: inPort, output: outPort,
    variantTy: step.morphTy.input,
    outTy:     step.morphTy.output,
    branches,
    provenance: [prov(srcId)],
  };
  builder.addNode(node);
  return outPort.id;
}

// ---------------------------------------------------------------------------
// CaseField elaboration
// ---------------------------------------------------------------------------

function elabCaseField(
  step: TypedStep & { node: { tag: "CaseField" } },
  inputPortId: PortId,
  ctx: ElabContext,
  srcId: SourceNodeId,
): PortId {
  const { builder } = ctx;
  const { field, contextTy } = step.node;
  const inPort  = mkPort(step.morphTy.input);
  const outPort = mkPort(step.morphTy.output);
  builder.wire(inputPortId, inPort.id);

  // variantTy is the type of the discriminant field (Σ)
  const inputRec = step.morphTy.input;
  const variantTy = inputRec.tag === "Record"
    ? (inputRec.fields.find((f) => f.name === field)?.ty ?? step.morphTy.input)
    : step.morphTy.input;

  const branches = step.node.branches.map((b) => ({
    tag:          b.ctor,
    rawPayloadTy: b.rawPayloadTy,
    graph:        elabCaseFieldBranchHandler(b, contextTy, step.morphTy.output, ctx, srcId),
  }));

  let eff: ConcreteEffect = "pure";
  for (const b of branches) eff = effectJoin(eff, b.graph.effect);

  const node: CaseNode = {
    kind: "case",
    id: freshNodeId(), effect: eff,
    input: inPort, output: outPort,
    variantTy,
    outTy:     step.morphTy.output,
    branches,
    field,
    contextTy,
    provenance: [prov(srcId)],
  };
  builder.addNode(node);
  return outPort.id;
}

/**
 * Elaborate a branch handler for `case .field`.
 * Branch input type (branch.payloadTy) is ρ (nullary) or merge(Pi, ρ) (record-payload).
 * All ρ fields are projected into locals automatically; Pi binder fields are also projected.
 */
function elabCaseFieldBranchHandler(
  branch: TypedBranch,
  contextTy: Type,
  outputTy: Type,
  ctx: ElabContext,
  srcId: SourceNodeId,
): Graph {
  const handler      = branch.handler;
  const branchBuilder = new GraphBuilder();
  const inPort = mkPort(branch.payloadTy);

  // Collect all fields to project into locals:
  // NullaryHandler: all ρ fields (payloadTy = ρ = contextTy)
  // RecordHandler:  explicit Pi binders + all ρ fields
  type FieldBind = { name: string; ty: Type };
  let allBinders: FieldBind[];

  const rhoFields: FieldBind[] = contextTy.tag === "Record"
    ? contextTy.fields.map((f) => ({ name: f.name, ty: f.ty }))
    : [];

  if (handler.tag === "Nullary") {
    allBinders = rhoFields;
  } else {
    const piBinders: FieldBind[] = handler.binders.map((b) => ({ name: b.name, ty: b.fieldTy }));
    allBinders = [...piBinders, ...rhoFields];
  }

  const useCounts = countUsesInTypedExpr(handler.body, allBinders.map((b) => b.name));
  const locals    = new Map<string, PortId[]>();

  if (allBinders.length > 1) {
    const dupOuts = Array.from({ length: allBinders.length }, () => mkPort(branch.payloadTy));
    const dupNode: DupNode = {
      kind: "dup",
      id: freshNodeId(), effect: "pure",
      input: inPort, outputs: dupOuts,
      provenance: [prov(srcId, "dup-for-handler-binders")],
    };
    branchBuilder.addNode(dupNode);

    for (let i = 0; i < allBinders.length; i++) {
      const binder  = allBinders[i]!;
      const projIn  = mkPort(branch.payloadTy);
      branchBuilder.wire(dupOuts[i]!.id, projIn.id);
      const projOut = mkPort(binder.ty);
      const projNode: ProjNode = {
        kind: "proj", field: binder.name,
        id: freshNodeId(), effect: "pure",
        input: projIn, output: projOut,
        provenance: [prov(srcId, "handler-proj")],
      };
      branchBuilder.addNode(projNode);
      const ports = allocateLocalPort(projOut, useCounts.get(binder.name) ?? 1, branchBuilder, srcId);
      if (ports.length > 0) locals.set(binder.name, ports);
    }
  } else if (allBinders.length === 1) {
    const binder  = allBinders[0]!;
    const projOut = mkPort(binder.ty);
    const projNode: ProjNode = {
      kind: "proj", field: binder.name,
      id: freshNodeId(), effect: "pure",
      input: inPort, output: projOut,
      provenance: [prov(srcId, "handler-proj")],
    };
    branchBuilder.addNode(projNode);
    locals.set(binder.name, allocateLocalPort(projOut, useCounts.get(binder.name) ?? 1, branchBuilder, srcId));
  }
  // allBinders.length === 0: empty context row; body uses no locals from ρ

  const branchCtx: ElabContext = {
    ...ctx,
    builder:    branchBuilder,
    inputPort:  inPort.id,
    inputType:  branch.payloadTy,
    locals,
    sourceId:   srcId,
  };

  const outPortId = elabExpr(handler.body, inPort.id, branchCtx);
  const outPort   = mkPort(outputTy);
  branchBuilder.wire(outPortId, outPort.id);
  const g = branchBuilder.build(inPort, outPort, [prov(srcId, "branch-handler")]);
  validateOrThrow(g, srcId);
  return g;
}

// ---------------------------------------------------------------------------
// Fold elaboration
// ---------------------------------------------------------------------------

function elabFold(
  step: TypedStep & { node: { tag: "Fold" } },
  inputPortId: PortId,
  ctx: ElabContext,
  srcId: SourceNodeId,
): PortId {
  const { builder } = ctx;
  const foldNode  = step.node;
  const inPort    = mkPort(step.morphTy.input);
  const outPort   = mkPort(step.morphTy.output);
  builder.wire(inputPortId, inPort.id);

  const algebra = foldNode.branches.map((b) => ({
    tag:          b.ctor,
    rawPayloadTy: b.rawPayloadTy,
    graph:        elabBranchHandler(b, foldNode.carrierTy, ctx, srcId),
  }));

  let eff: ConcreteEffect = "pure";
  for (const b of algebra) eff = effectJoin(eff, b.graph.effect);

  const node: CataNode = {
    kind: "cata",
    id: freshNodeId(), effect: eff,
    input: inPort, output: outPort,
    adtTy:     foldNode.adtTy,
    carrierTy: foldNode.carrierTy,
    algebra,
    provenance: [prov(srcId)],
  };
  builder.addNode(node);
  return outPort.id;
}

// ---------------------------------------------------------------------------
// Branch handler elaboration
// ---------------------------------------------------------------------------

function elabBranchHandler(
  branch: TypedBranch,
  outputTy: Type,
  ctx: ElabContext,
  srcId: SourceNodeId,
): Graph {
  const handler  = branch.handler;
  const branchBuilder = new GraphBuilder();

  if (handler.tag === "Nullary") {
    // Branch input type is the constructor payload (Unit for nullary constructors,
    // the record type for record-payload constructors without { fields } >>>).
    const inPort  = mkPort(branch.payloadTy);
    const branchCtx: ElabContext = {
      ...ctx,
      builder:    branchBuilder,
      inputPort:  inPort.id,
      inputType:  branch.payloadTy,
      locals:     new Map(),
      sourceId:   srcId,
    };
    const outPortId = elabExpr(handler.body, inPort.id, branchCtx);
    const outPort   = mkPort(outputTy);
    branchBuilder.wire(outPortId, outPort.id);
    const g = branchBuilder.build(inPort, outPort, [prov(srcId, "branch-handler")]);
    validateOrThrow(g, srcId);
    return g;
  }

  // Record handler: { binders } >>> body
  // Input type is branch.payloadTy
  const inPort = mkPort(branch.payloadTy);

  // Create ProjNodes for each binder, plus DupNodes if a name is used multiple times.
  const useCounts = countUsesInTypedExpr(handler.body, handler.binders.map((b) => b.name));
  const locals    = new Map<string, PortId[]>();

  // We need to DupNode the input for all binders (each needs a separate ProjNode input)
  const nonWildBinders = handler.binders;
  if (nonWildBinders.length > 1) {
    // Dup the handler input n times (once per binder)
    const dupOuts = Array.from({ length: nonWildBinders.length }, () => mkPort(branch.payloadTy));
    const dupNode: DupNode = {
      kind: "dup",
      id: freshNodeId(), effect: "pure",
      input: inPort, outputs: dupOuts,
      provenance: [prov(srcId, "dup-for-handler-binders")],
    };
    branchBuilder.addNode(dupNode);

    for (let i = 0; i < nonWildBinders.length; i++) {
      const binder = nonWildBinders[i]!;
      const projIn  = mkPort(branch.payloadTy);
      branchBuilder.wire(dupOuts[i]!.id, projIn.id);
      const projOut = mkPort(binder.fieldTy);
      const projNode: ProjNode = {
        kind: "proj", field: binder.name,
        id: freshNodeId(), effect: "pure",
        input: projIn, output: projOut,
        provenance: [prov(srcId, "handler-proj")],
      };
      branchBuilder.addNode(projNode);
      const ports = allocateLocalPort(projOut, useCounts.get(binder.name) ?? 1, branchBuilder, srcId);
      if (ports.length > 0) locals.set(binder.name, ports);
    }
  } else if (nonWildBinders.length === 1) {
    const binder  = nonWildBinders[0]!;
    const projIn  = inPort; // use the handler inPort directly
    const projOut = mkPort(binder.fieldTy);
    const projNode: ProjNode = {
      kind: "proj", field: binder.name,
      id: freshNodeId(), effect: "pure",
      input: projIn, output: projOut,
      provenance: [prov(srcId, "handler-proj")],
    };
    branchBuilder.addNode(projNode);
    locals.set(binder.name, allocateLocalPort(projOut, useCounts.get(binder.name) ?? 1, branchBuilder, srcId));
  }

  const branchCtx: ElabContext = {
    ...ctx,
    builder:    branchBuilder,
    inputPort:  inPort.id,
    inputType:  branch.payloadTy,
    locals,
    sourceId:   srcId,
  };

  const outPortId = elabExpr(handler.body, inPort.id, branchCtx);
  const outPort   = mkPort(outputTy);
  branchBuilder.wire(outPortId, outPort.id);
  const g = branchBuilder.build(inPort, outPort, [prov(srcId, "branch-handler")]);
  validateOrThrow(g, srcId);
  return g;
}

// ---------------------------------------------------------------------------
// Over elaboration
// ---------------------------------------------------------------------------

function elabOver(
  step: TypedStep & { node: { tag: "Over" } },
  inputPortId: PortId,
  ctx: ElabContext,
  srcId: SourceNodeId,
): PortId {
  const { builder } = ctx;
  const { field, transform } = step.node;
  const inputType = step.morphTy.input;

  if (inputType.tag !== "Record") {
    throw new Error(`Elaborator internal: over expects record input, got ${inputType.tag}`);
  }

  // All fields except `field` are passthroughs.
  const passthroughFields = inputType.fields.filter((f) => f.name !== field);
  const n = 1 + passthroughFields.length; // 1 for the transform branch + k passthroughs

  // When n=1 (no passthroughs), skip DupNode — wire directly.
  let dupOutputIds: PortId[];
  if (n === 1) {
    dupOutputIds = [inputPortId];
  } else {
    const inPort = mkPort(inputType);
    builder.wire(inputPortId, inPort.id);
    const dupOuts = Array.from({ length: n }, () => mkPort(inputType));
    const dupNode: DupNode = {
      kind: "dup",
      id: freshNodeId(), effect: "pure",
      input: inPort, outputs: dupOuts,
      provenance: [prov(srcId, "dup-for-over")],
    };
    builder.addNode(dupNode);
    dupOutputIds = dupOuts.map((p) => p.id);
  }

  // Branch 0: project .field, apply transform
  const transformFieldTy = inputType.fields.find((f) => f.name === field)!.ty;
  const projInPort0  = mkPort(inputType);
  builder.wire(dupOutputIds[0]!, projInPort0.id);
  const projOutPort0 = mkPort(transformFieldTy);
  const projNode0: ProjNode = {
    kind: "proj", field,
    id: freshNodeId(), effect: "pure",
    input: projInPort0, output: projOutPort0,
    provenance: [prov(srcId, "over-field-proj")],
  };
  builder.addNode(projNode0);

  // Elaborate the transform step in a fresh handler context.
  const handlerCtx: ElabContext = {
    ...ctx,
    inputPort: projOutPort0.id,
    inputType: transformFieldTy,
    locals:    new Map(),
  };
  const transformOutPortId = elabStep(transform, projOutPort0.id, handlerCtx);
  const newFieldTy = transform.morphTy.output;

  // Passthrough branches: project each non-`field` field.
  const tupleInputs: { label: string; port: { id: string; ty: Type } }[] = [
    { label: field, port: { id: transformOutPortId, ty: newFieldTy } },
  ];

  for (let i = 0; i < passthroughFields.length; i++) {
    const pf = passthroughFields[i]!;
    const projInPort  = mkPort(inputType);
    builder.wire(dupOutputIds[i + 1]!, projInPort.id);
    const projOutPort = mkPort(pf.ty);
    const projNode: ProjNode = {
      kind: "proj", field: pf.name,
      id: freshNodeId(), effect: "pure",
      input: projInPort, output: projOutPort,
      provenance: [prov(srcId, "over-passthrough-proj")],
    };
    builder.addNode(projNode);
    tupleInputs.push({ label: pf.name, port: { id: projOutPort.id, ty: pf.ty } });
  }

  const outPort = mkPort(step.morphTy.output);
  const tupleNode: TupleNode = {
    kind: "tuple",
    id: freshNodeId(), effect: "pure",
    inputs: tupleInputs.map((f) => ({ label: f.label, port: { id: f.port.id, ty: f.port.ty } })),
    output: outPort,
    provenance: [prov(srcId, "over-tuple")],
  };
  builder.addNode(tupleNode);
  return outPort.id;
}

// ---------------------------------------------------------------------------
// Let elaboration
// ---------------------------------------------------------------------------

function elabLet(
  step: TypedStep & { node: { tag: "Let" } },
  inputPortId: PortId,
  ctx: ElabContext,
  srcId: SourceNodeId,
): PortId {
  const { builder } = ctx;
  const letNode = step.node;
  const { name, rhs, body, liveSet } = letNode;

  // Partition liveSet into vars already in ctx.locals (pre-projected by a binder or prior let)
  // vs. vars that must be projected from the current input.
  const liveFromLocals: Array<{ lv: LiveVar; portId: PortId }> = [];
  const liveFromInput: LiveVar[] = [];
  for (const lv of liveSet) {
    const queue = ctx.locals.get(lv.name);
    if (queue && queue.length > 0) {
      liveFromLocals.push({ lv, portId: queue.shift()! });
    } else {
      liveFromInput.push(lv);
    }
  }

  // n covers only liveFromInput (vars not already extracted); +1 for the RHS branch.
  const n = 1 + liveFromInput.length;

  // When n=1 (all live vars already in locals, or no live vars), skip DupNode.
  let letDupOutputIds: PortId[];
  if (n === 1) {
    letDupOutputIds = [inputPortId];
  } else {
    const inPort = mkPort(step.morphTy.input);
    builder.wire(inputPortId, inPort.id);
    const dupOuts = Array.from({ length: n }, () => mkPort(step.morphTy.input));
    const dupNode: DupNode = {
      kind: "dup",
      id: freshNodeId(), effect: "pure",
      input: inPort, outputs: dupOuts,
      provenance: [prov(srcId, "dup-for-let")],
    };
    builder.addNode(dupNode);
    letDupOutputIds = dupOuts.map((p) => p.id);
  }

  // Branch 0: elaborate f_x = norm_I(I, rhs)
  const rhsOutPortId = elabNormI(rhs, letDupOutputIds[0]!, step.morphTy.input, ctx, srcId);
  const rhsTy = rhs.morphTy.output;

  // Build tupleInputs: new binding + live vars (in original liveSet order).
  const tupleInputs: { label: string; port: { id: PortId; ty: Type } }[] = [
    { label: name, port: { id: rhsOutPortId, ty: rhsTy } },
  ];

  let inputIdx = 1; // index into letDupOutputIds for liveFromInput vars
  for (const lv of liveSet) {
    const fromLocals = liveFromLocals.find((e) => e.lv.name === lv.name);
    if (fromLocals) {
      // Already pre-projected — use the existing port directly.
      tupleInputs.push({ label: lv.name, port: { id: fromLocals.portId, ty: lv.ty } });
    } else {
      // Project from the let's DupNode output.
      const projInPort  = mkPort(step.morphTy.input);
      builder.wire(letDupOutputIds[inputIdx]!, projInPort.id);
      inputIdx++;
      const projOutPort = mkPort(lv.ty);
      const projNode: ProjNode = {
        kind: "proj", field: lv.name,
        id: freshNodeId(), effect: "pure",
        input: projInPort, output: projOutPort,
        provenance: [prov(srcId, "let-passthrough-proj")],
      };
      builder.addNode(projNode);
      tupleInputs.push({ label: lv.name, port: { id: projOutPort.id, ty: lv.ty } });
    }
  }

  // Build the intermediate record R' = { name: rhsTy, v1: ..., ... }
  const rPrimeTy: Type = {
    tag: "Record",
    fields: tupleInputs.map((f) => ({ name: f.label, ty: f.port.ty })),
    rest: null,
  };
  const rPrimePort = mkPort(rPrimeTy);
  const tupleNode: TupleNode = {
    kind: "tuple",
    id: freshNodeId(), effect: "pure",
    inputs: tupleInputs.map((f) => ({ label: f.label, port: { id: f.port.id, ty: f.port.ty } })),
    output: rPrimePort,
    provenance: [prov(srcId, "let-tuple")],
  };
  builder.addNode(tupleNode);

  // Create ProjNodes from R' for each binding in the new scope.
  const useCounts = countUsesInTypedExpr(body, [name, ...liveSet.map((v) => v.name)]);
  const newLocals = new Map<string, PortId[]>();

  // DupNode rPrimePort for all uses: one per projection + one for body piped input.
  // rPrimeTotalUses >= 2 always (tupleInputs.length >= 1 because let always has at least the bound name).
  const rPrimeTotalUses = tupleInputs.length + 1; // projections + body input
  if (rPrimeTotalUses < 2) {
    throw new Error("Elaborator internal: let rPrimeTotalUses < 2 — invariant violated");
  }
  const rDupOuts = Array.from({ length: rPrimeTotalUses }, () => mkPort(rPrimeTy));
  const rDupNode: DupNode = {
    kind: "dup",
    id: freshNodeId(), effect: "pure",
    input: rPrimePort, outputs: rDupOuts,
    provenance: [prov(srcId, "dup-for-let-body-projs")],
  };
  builder.addNode(rDupNode);
  const rPrimeSources = rDupOuts.map((p) => p.id);
  // Last slot reserved for body input; projections use [0..N-1]
  const bodyInputPortId = rPrimeSources[tupleInputs.length]!;

  for (let i = 0; i < tupleInputs.length; i++) {
    const fi = tupleInputs[i]!;
    const projInPort  = mkPort(rPrimeTy);
    builder.wire(rPrimeSources[i]!, projInPort.id);
    const projOutPort = mkPort(fi.port.ty);
    const projNode: ProjNode = {
      kind: "proj", field: fi.label,
      id: freshNodeId(), effect: "pure",
      input: projInPort, output: projOutPort,
      provenance: [prov(srcId, "let-body-proj")],
    };
    builder.addNode(projNode);
    const uses = useCounts.get(fi.label) ?? 1;
    const letBodyPorts = allocateLocalPort(projOutPort, uses, builder, srcId);
    if (letBodyPorts.length > 0) newLocals.set(fi.label, letBodyPorts);
  }

  // Elaborate body under new locals, with its dedicated rPrime copy as input.
  const bodyCtx = withLocals(ctx, newLocals, bodyInputPortId, rPrimeTy);
  return elabExpr(body, bodyInputPortId, bodyCtx);
}

// ---------------------------------------------------------------------------
// Schema instantiation — inline expansion
// ---------------------------------------------------------------------------

function elabSchemaInst(
  step: TypedStep & { node: { tag: "SchemaInst" } },
  inputPortId: PortId,
  ctx: ElabContext,
  srcId: SourceNodeId,
): PortId {
  const { defName, tySubst, effSubst, argSubst } = step.node;
  const def = ctx.typedDefs.get(defName);
  if (!def) {
    throw new Error(`Elaborator internal: SchemaInst def '${defName}' not found`);
  }

  // 1. Apply tySubst/effSubst to the def body — all type variables become concrete.
  const substBody = substTypedExpr(def.body, tySubst, effSubst);

  // 2. Apply tySubst/effSubst to each arg expression so its morphTy is also concrete.
  const expandedArgSubst = new Map<string, TypedExpr>();
  for (const [paramName, argExpr] of argSubst) {
    expandedArgSubst.set(paramName, substTypedExpr(argExpr, tySubst, effSubst));
  }

  // 3. Inline-expand: replace every Ref to a param name with the arg's steps.
  //    Each use site gets its own copy — semantically equivalent to writing the
  //    body with the argument inlined at every occurrence (spec §definition-level
  //    substitution). No paramPorts, no pre-elaboration, no shared ports.
  const expandedBody = expandParamRefs(substBody, expandedArgSubst);

  // 4. Elaborate the expanded body normally from the call-site input port.
  return elabExpr(expandedBody, inputPortId, ctx);
}

// ---------------------------------------------------------------------------
// Param-ref inline expansion
// ---------------------------------------------------------------------------

/**
 * Walk a TypedExpr and replace every Ref step whose defId is a key in
 * argSubst with the inline steps of the corresponding arg TypedExpr.
 * This is definition-level substitution: each use site receives its own copy.
 */
function expandParamRefs(expr: TypedExpr, argSubst: Map<string, TypedExpr>): TypedExpr {
  if (argSubst.size === 0) return expr;
  return {
    steps:    expr.steps.flatMap((s) => expandStep(s, argSubst)),
    morphTy:  expr.morphTy,
    sourceId: expr.sourceId,
  };
}

function expandStep(step: TypedStep, argSubst: Map<string, TypedExpr>): TypedStep[] {
  if (step.node.tag === "Ref") {
    const argExpr = argSubst.get(step.node.defId);
    if (argExpr !== undefined) {
      // Inline the arg's steps in place of this Ref.
      return argExpr.steps;
    }
  }
  return [{ ...step, node: expandNode(step.node, argSubst) }];
}

function expandNode(node: TypedNode, argSubst: Map<string, TypedExpr>): TypedNode {
  const exp  = (e: TypedExpr) => expandParamRefs(e, argSubst);
  const expB = (b: TypedBranch) => expandBranch(b, argSubst);

  switch (node.tag) {
    case "Ref":
    case "LocalRef":
    case "Ctor":
    case "Projection":
    case "Literal":
    case "Perform":
      return node;
    case "Build":
      return { tag: "Build", fields: node.fields.map((f) => ({ name: f.name, expr: exp(f.expr) })) };
    case "Fanout":
      return { tag: "Fanout", fields: node.fields.map((f) => ({ name: f.name, expr: exp(f.expr) })) };
    case "Case":
      return { tag: "Case", branches: node.branches.map(expB) };
    case "CaseField":
      return { ...node, branches: node.branches.map(expB) };
    case "Fold":
      return { ...node, branches: node.branches.map(expB) };
    case "Over": {
      const expanded = expandStep(node.transform, argSubst);
      if (expanded.length === 1) {
        return { tag: "Over", field: node.field, transform: expanded[0]! };
      }
      // Multi-step expansion: wrap in GroupedExpr so Over.transform stays a single TypedStep.
      const groupedBody: TypedExpr = { steps: expanded, morphTy: node.transform.morphTy, sourceId: node.transform.sourceId };
      const groupedStep: TypedStep = { node: { tag: "GroupedExpr", body: groupedBody }, morphTy: node.transform.morphTy, sourceId: node.transform.sourceId };
      return { tag: "Over", field: node.field, transform: groupedStep };
    }
    case "GroupedExpr":
      return { tag: "GroupedExpr", body: exp(node.body) };
    case "Let":
      return { tag: "Let", name: node.name, rhs: exp(node.rhs), body: exp(node.body), liveSet: node.liveSet };
    case "SchemaInst": {
      const newArgSubst = new Map<string, TypedExpr>();
      for (const [k, v] of node.argSubst) newArgSubst.set(k, exp(v));
      return { ...node, argSubst: newArgSubst };
    }
  }
}

function expandBranch(branch: TypedBranch, argSubst: Map<string, TypedExpr>): TypedBranch {
  const exp = (e: TypedExpr) => expandParamRefs(e, argSubst);
  const handler: TypedHandler =
    branch.handler.tag === "Nullary"
      ? { tag: "Nullary", body: exp(branch.handler.body) }
      : { tag: "Record", binders: branch.handler.binders, body: exp(branch.handler.body) };
  return { ...branch, handler };
}

// ---------------------------------------------------------------------------
// norm_I elaboration
// ---------------------------------------------------------------------------

/**
 * Elaborate `expr` with norm_I semantics:
 * - Case A: expr domain = inputTy → elaborate normally
 * - Case B: expr domain = Unit    → insert DropNode (I -> 1) first
 */
function elabNormI(
  expr: TypedExpr,
  inputPortId: PortId,
  inputTy: Type,
  ctx: ElabContext,
  srcId: SourceNodeId,
): PortId {
  if (expr.morphTy.input.tag === "Unit" && inputTy.tag !== "Unit") {
    // Case B: lift unit-sourced expr by inserting DropNode (! : I -> 1).
    const droppedPort = liftUnit(inputPortId, inputTy, ctx.builder, srcId);
    return elabExpr(expr, droppedPort, { ...ctx, inputType: { tag: "Unit" } });
  }
  // Case C: domain mismatch — typechecker should have caught this.
  if (expr.morphTy.input.tag !== "Unit" && !typeEq(expr.morphTy.input, inputTy)) {
    throw new Error(
      `Elaborator internal: norm_I Case C — expr domain ${JSON.stringify(expr.morphTy.input)} ` +
      `does not match input type ${JSON.stringify(inputTy)}`,
    );
  }
  return elabExpr(expr, inputPortId, ctx);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Insert a DropNode (terminal morphism ! : I -> 1).
 * Returns the DropNode's output port ID (type Unit).
 *
 * Always adds a DropNode — even for Unit input — so that the inputPortId is
 * wired and the connectivity invariant holds. The DropNode's output is
 * intentionally dangling (§9.16) when not threaded forward.
 */
function liftUnit(
  inputPortId: PortId,
  inputTy: Type,
  builder: GraphBuilder,
  srcId: SourceNodeId,
): PortId {
  const inPort  = mkPort(inputTy);
  const outPort = mkPort({ tag: "Unit" });
  builder.wire(inputPortId, inPort.id);
  const node: DropNode = {
    kind: "drop",
    id: freshNodeId(), effect: "pure",
    input: inPort, output: outPort,
    provenance: [prov(srcId, "terminal-lift")],
  };
  builder.addNode(node);
  return outPort.id;
}

/**
 * Given a port that holds a value needed `n` times:
 * - n == 1: return the port directly.
 * - n >= 2: create a DupNode with n outputs, return the first output (others
 *           queued for later use — for v1 we return a single port and note
 *           that multi-use locals share the DupNode output directly via
 *           wiring from the same port, which the IR allows for DupNode outputs).
 *
 * For v1 simplicity: if n >= 2, create DupNode and return the first output.
 * Subsequent uses of the same local name will wire to later outputs.
 * We track this via a separate per-name output queue in the let/handler logic.
 *
 * Actually for simplicity in v1: return the port itself. We rely on the
 * fact that DupNode outputs may have multiple wires (IR-2 allows this).
 * The DupNode was already created if needed; we use its output ports.
 */
function allocateLocalPort(
  port: { id: PortId; ty: Type },
  uses: number,
  builder: GraphBuilder,
  srcId: SourceNodeId,
): PortId[] {
  if (uses === 0) {
    // Unused binder — drop immediately so no output port is orphaned.
    const outPort = mkPort({ tag: "Unit" });
    const dropNode: DropNode = {
      kind: "drop", id: freshNodeId(), effect: "pure",
      input: port, output: outPort,
      provenance: [prov(srcId, "drop-unused-binder")],
    };
    builder.addNode(dropNode);
    return [];
  }
  if (uses === 1) return [port.id];
  const dupOuts = Array.from({ length: uses }, () => mkPort(port.ty));
  const dupNode: DupNode = {
    kind: "dup",
    id: freshNodeId(), effect: "pure",
    input: port, outputs: dupOuts,
    provenance: [prov(srcId, "dup-for-local")],
  };
  builder.addNode(dupNode);
  return dupOuts.map((p) => p.id);
}

/** Count how many times each name (as LocalRef) appears in a TypedExpr. */
function countUsesInTypedExpr(expr: TypedExpr, names: string[]): Map<string, number> {
  const counts = new Map<string, number>(names.map((n) => [n, 0]));
  const visitStep = (s: TypedStep) => {
    if (s.node.tag === "LocalRef" && counts.has(s.node.name)) {
      counts.set(s.node.name, (counts.get(s.node.name) ?? 0) + 1);
    }
    visitNode(s.node);
  };
  const visitExpr = (e: TypedExpr) => e.steps.forEach(visitStep);
  const visitNode = (node: TypedNode) => {
    switch (node.tag) {
      case "Build":   node.fields.forEach((f) => visitExpr(f.expr)); break;
      case "Fanout":  node.fields.forEach((f) => visitExpr(f.expr)); break;
      case "Case":      node.branches.forEach((b) => visitHandler(b.handler)); break;
      case "CaseField": node.branches.forEach((b) => visitHandler(b.handler)); break;
      case "Fold":      node.branches.forEach((b) => visitHandler(b.handler)); break;
      case "Over":         visitStep(node.transform); break;
      case "GroupedExpr":  visitExpr(node.body); break;
      case "Let":          visitExpr(node.rhs); visitExpr(node.body); break;
      case "SchemaInst":   [...node.argSubst.values()].forEach(visitExpr); break;
      default: break;
    }
  };
  const visitHandler = (h: TypedHandler) => {
    if (h.tag === "Nullary") visitExpr(h.body);
    else visitExpr(h.body);
  };
  visitExpr(expr);
  return counts;
}

/** Convert a SurfaceLiteral to an IR LiteralValue. */
function surfaceLitToLiteral(lit: SurfaceLiteral): LiteralValue {
  switch (lit.tag) {
    case "int":   return { tag: "int",   value: lit.value };
    case "float": return { tag: "float", value: lit.value };
    case "text":  return { tag: "text",  value: lit.value };
    case "bool":  return { tag: "bool",  value: lit.value };
  }
}

// ---------------------------------------------------------------------------
// TypedExpr substitution (for schema instantiation)
// ---------------------------------------------------------------------------

/**
 * Apply tySubst and effSubst to all Type values embedded in a TypedExpr.
 * Produces a new TypedExpr with concrete types throughout.
 */
function substTypedExpr(
  expr: TypedExpr,
  tySubst: Map<string, import("../types/type.ts").Type>,
  effSubst: Map<string, import("../types/type.ts").ConcreteEffect>,
): TypedExpr {
  return {
    steps:    expr.steps.map((s) => substTypedStep(s, tySubst, effSubst)),
    morphTy:  substMorphTy(expr.morphTy, tySubst, effSubst),
    sourceId: expr.sourceId,
  };
}

function substTypedStep(
  step: TypedStep,
  tySubst: Map<string, import("../types/type.ts").Type>,
  effSubst: Map<string, import("../types/type.ts").ConcreteEffect>,
): TypedStep {
  return {
    node:     substTypedNode(step.node, tySubst, effSubst),
    morphTy:  substMorphTy(step.morphTy, tySubst, effSubst),
    sourceId: step.sourceId,
  };
}

function substMorphTy(
  mt: MorphTy,
  tySubst: Map<string, import("../types/type.ts").Type>,
  effSubst: Map<string, import("../types/type.ts").ConcreteEffect>,
): MorphTy {
  return {
    input:  applySubst(mt.input,  tySubst),
    output: applySubst(mt.output, tySubst),
    eff:    effSubst.get(typeof mt.eff === "string" ? mt.eff : mt.eff) ?? mt.eff,
  };
}

function substTypedNode(
  node: TypedNode,
  tySubst: Map<string, import("../types/type.ts").Type>,
  effSubst: Map<string, import("../types/type.ts").ConcreteEffect>,
): TypedNode {
  const sub  = (e: TypedExpr) => substTypedExpr(e, tySubst, effSubst);
  const subS = (s: TypedStep) => substTypedStep(s, tySubst, effSubst);
  const subT = (ty: import("../types/type.ts").Type) => applySubst(ty, tySubst);

  switch (node.tag) {
    case "Ref":
    case "LocalRef":
    case "Ctor":
    case "Projection":
    case "Literal":
    case "Perform":
      return node;
    case "Build":
      return { tag: "Build", fields: node.fields.map((f) => ({ name: f.name, expr: sub(f.expr) })) };
    case "Fanout":
      return { tag: "Fanout", fields: node.fields.map((f) => ({ name: f.name, expr: sub(f.expr) })) };
    case "Case":
      return { tag: "Case", branches: node.branches.map((b) => substBranch(b, tySubst, effSubst)) };
    case "CaseField":
      return {
        tag:       "CaseField",
        field:     node.field,
        contextTy: subT(node.contextTy),
        branches:  node.branches.map((b) => substBranch(b, tySubst, effSubst)),
      };
    case "Fold":
      return {
        tag: "Fold",
        adtTy:     subT(node.adtTy),
        carrierTy: subT(node.carrierTy),
        branches:  node.branches.map((b) => substBranch(b, tySubst, effSubst)),
      };
    case "Over":
      return { tag: "Over", field: node.field, transform: subS(node.transform) };
    case "GroupedExpr":
      return { tag: "GroupedExpr", body: sub(node.body) };
    case "Let":
      return {
        tag: "Let", name: node.name,
        rhs:     sub(node.rhs),
        body:    sub(node.body),
        liveSet: node.liveSet.map((lv) => ({ name: lv.name, ty: subT(lv.ty) })),
      };
    case "SchemaInst": {
      const newArgSubst = new Map<string, TypedExpr>();
      for (const [k, v] of node.argSubst) newArgSubst.set(k, sub(v));
      return {
        tag:      "SchemaInst",
        defName:  node.defName,
        tySubst:  node.tySubst,
        effSubst: node.effSubst,
        argSubst: newArgSubst,
      };
    }
  }
}

function substBranch(
  branch: TypedBranch,
  tySubst: Map<string, import("../types/type.ts").Type>,
  effSubst: Map<string, import("../types/type.ts").ConcreteEffect>,
): TypedBranch {
  const subT = (ty: import("../types/type.ts").Type) => applySubst(ty, tySubst);
  const subE = (e: TypedExpr) => substTypedExpr(e, tySubst, effSubst);

  const handler: TypedHandler =
    branch.handler.tag === "Nullary"
      ? { tag: "Nullary", body: subE(branch.handler.body) }
      : {
          tag: "Record",
          binders: branch.handler.binders.map((b) => ({ name: b.name, fieldTy: subT(b.fieldTy) })),
          body:    subE(branch.handler.body),
        };

  return { ctor: branch.ctor, rawPayloadTy: subT(branch.rawPayloadTy), payloadTy: subT(branch.payloadTy), handler };
}

// ---------------------------------------------------------------------------
// Validation helper
// ---------------------------------------------------------------------------

function validateOrThrow(graph: Graph, sourceId: SourceNodeId): void {
  const vr = validateGraph(graph);
  if (!vr.ok) {
    throw new Error(
      `IR validation failed (sourceId=${sourceId}):\n` +
      vr.errors.map((e) => `  [${e.rule}] ${e.message}`).join("\n"),
    );
  }
}
