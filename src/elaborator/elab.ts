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
import { effectJoin } from "../types/check.ts";
import { substAdt } from "../types/subst.ts";
import { applySubst } from "../typechecker/unify.ts";
import { isConcrete } from "../types/check.ts";

import type {
  TypedModule, TypedDef, TypedExpr, TypedStep, TypedNode,
  TypedBranch, TypedHandler, MorphTy, OmegaEntry,
  TypedTypeDecl,
} from "../typechecker/typed-ast.ts";
import type { CtorInfo } from "../typechecker/env.ts";
import type { Subst } from "../typechecker/unify.ts";
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
  /**
   * Schema parameter ports: param name → queue of PortIds (one per use).
   * When elaborating a SchemaInst body, Ref nodes targeting param names
   * pop the front element; a DupNode ensures one output per use.
   */
  paramPorts: Map<string, PortId[]>;
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

  for (const [name, def] of mod.typedDefs) {
    if (isPolymorphic(def)) continue;  // elaborated only at SchemaInst sites
    const r = elaborateDef(def, mod.typedDefs, mod.omega);
    if (!r.ok) { errors.push(...r.errors); continue; }
    defs.set(name, r.value);
  }

  if (errors.length > 0) return fail(errors);
  return ok({ defs, typeDecls: mod.typeDecls, omega: mod.omega });
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
    paramPorts: new Map(),
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
      // Schema param substitution: if defId is in paramPorts, pop next port from queue.
      const paramQueue = ctx.paramPorts.get(defId);
      if (paramQueue !== undefined && paramQueue.length > 0) {
        return paramQueue.shift()!;
      }
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
      // norm_I Case B: if inputPortId is non-unit context, insert DropNode first.
      // The Literal's morphTy.input is Unit by construction.
      const droppedPort = liftUnit(inputPortId, step.morphTy.input, builder, srcId);
      const outPort = mkPort(step.morphTy.output);
      const node: ConstNode = {
        kind: "const", value: surfaceLitToLiteral(step.node.value),
        id: freshNodeId(), effect: "pure",
        output: outPort,
        provenance: [prov(srcId)],
      };
      builder.addNode(node);
      // ConstNode has no input port in the IR (it is unit-sourced).
      // The droppedPort is the dangling terminal; wire it to signal consumption.
      // In a strict IR the drop node's output is wired to nothing;
      // it represents I -> 1 and the const is 1 -> T, composing to I -> T.
      // We don't need an explicit wire from drop-output to const because
      // ConstNode is implicitly unit-sourced. The drop node is the evidence.
      void droppedPort; // used for side effect (DropNode added to builder)
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
    // SchemaInst — definition-level substitution
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
    const fieldOutPort   = mkPort(field.expr.morphTy.output);

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

  // Create DupNode with n outputs
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

  // Elaborate each branch with norm_I applied
  const tupleInputs: { label: string; port: { id: string; ty: Type } }[] = [];

  for (let i = 0; i < n; i++) {
    const field    = fanoutNode.fields[i]!;
    const dupOut   = dupOutputs[i]!;
    const branchExpr = field.expr;

    const branchOutPortId = elabNormI(branchExpr, dupOut.id, step.morphTy.input, ctx, srcId);
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
    tag:   b.ctor,
    graph: elabBranchHandler(b, step.morphTy.output, ctx, srcId),
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
    // Input type is Unit; fresh Γ_local
    const inPort  = mkPort({ tag: "Unit" });
    const branchCtx: ElabContext = {
      ...ctx,
      builder:    branchBuilder,
      inputPort:  inPort.id,
      inputType:  { tag: "Unit" },
      locals:     new Map(),
      paramPorts: new Map(),
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
      locals.set(binder.name, allocateLocalPort(projOut, useCounts.get(binder.name) ?? 1, branchBuilder, srcId));
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
    paramPorts: new Map(),
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

  // Dup the input n times.
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

  // Branch 0: project .field, apply transform
  const transformFieldTy = inputType.fields.find((f) => f.name === field)!.ty;
  const projInPort0  = mkPort(inputType);
  builder.wire(dupOuts[0]!.id, projInPort0.id);
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
    builder.wire(dupOuts[i + 1]!.id, projInPort.id);
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
  const n = 1 + liveSet.length; // f_x + passthrough for each live var

  // Create DupNode with n outputs.
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

  // Branch 0: elaborate f_x = norm_I(I, rhs)
  const rhsOutPortId = elabNormI(rhs, dupOuts[0]!.id, step.morphTy.input, ctx, srcId);
  const rhsTy = rhs.morphTy.output;

  // Passthrough branches: project each live var.
  const tupleInputs: { label: string; port: { id: string; ty: Type } }[] = [
    { label: name, port: { id: rhsOutPortId, ty: rhsTy } },
  ];

  for (let i = 0; i < liveSet.length; i++) {
    const lv = liveSet[i]!;
    const projInPort  = mkPort(step.morphTy.input);
    builder.wire(dupOuts[i + 1]!.id, projInPort.id);
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
  const rPrimeTotalUses = tupleInputs.length + 1; // projections + body input
  let rPrimeSources: PortId[];
  if (rPrimeTotalUses <= 1) {
    rPrimeSources = [rPrimePort.id, rPrimePort.id]; // degenerate (shouldn't happen)
  } else {
    const rDupOuts = Array.from({ length: rPrimeTotalUses }, () => mkPort(rPrimeTy));
    const rDupNode: DupNode = {
      kind: "dup",
      id: freshNodeId(), effect: "pure",
      input: rPrimePort, outputs: rDupOuts,
      provenance: [prov(srcId, "dup-for-let-body-projs")],
    };
    builder.addNode(rDupNode);
    rPrimeSources = rDupOuts.map((p) => p.id);
  }
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
    newLocals.set(fi.label, allocateLocalPort(projOutPort, uses, builder, srcId));
  }

  // Elaborate body under new locals, with its dedicated rPrime copy as input.
  const bodyCtx = withLocals(ctx, newLocals, bodyInputPortId, rPrimeTy);
  return elabExpr(body, bodyInputPortId, bodyCtx);
}

// ---------------------------------------------------------------------------
// Schema instantiation
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

  // Apply tySubst/effSubst to the def's TypedExpr body.
  const substBody = substTypedExpr(def.body, tySubst, effSubst);

  // Elaborate each argument and allocate one output port per use in the body.
  const newParamPorts = new Map<string, PortId[]>(ctx.paramPorts);
  for (const [paramName, argExpr] of argSubst) {
    const argOutPortId = elabExpr(argExpr, inputPortId, ctx);
    const uses = countParamRefUses(substBody, [paramName]).get(paramName) ?? 1;
    const argOutPort = { id: argOutPortId, ty: argExpr.morphTy.output };
    newParamPorts.set(paramName, allocateLocalPort(argOutPort, uses, ctx.builder, srcId));
  }

  // Elaborate the substituted body with param ports.
  const instCtx: ElabContext = {
    ...ctx,
    paramPorts: newParamPorts,
    inputPort:  inputPortId,
    inputType:  step.morphTy.input,
    sourceId:   srcId,
  };

  return elabExpr(substBody, inputPortId, instCtx);
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
  return elabExpr(expr, inputPortId, ctx);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Insert a DropNode (terminal morphism ! : I -> 1).
 * Returns the DropNode's output port ID (type Unit).
 * Used when norm_I Case B: a unit-sourced expr appears in a non-unit context.
 */
function liftUnit(
  inputPortId: PortId,
  inputTy: Type,
  builder: GraphBuilder,
  srcId: SourceNodeId,
): PortId {
  if (inputTy.tag === "Unit") return inputPortId; // already unit; no-op
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
  if (uses <= 1) return [port.id];
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
      case "Case":    node.branches.forEach((b) => visitHandler(b.handler)); break;
      case "Fold":    node.branches.forEach((b) => visitHandler(b.handler)); break;
      case "Over":    visitStep(node.transform); break;
      case "Let":     visitExpr(node.rhs); visitExpr(node.body); break;
      case "SchemaInst": [...node.argSubst.values()].forEach(visitExpr); break;
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

/** Count how many times each param name appears as a Ref node in a TypedExpr. */
function countParamRefUses(expr: TypedExpr, paramNames: string[]): Map<string, number> {
  const counts = new Map<string, number>(paramNames.map((n) => [n, 0]));
  const visitStep = (s: TypedStep) => {
    if (s.node.tag === "Ref" && counts.has(s.node.defId)) {
      counts.set(s.node.defId, (counts.get(s.node.defId) ?? 0) + 1);
    }
    visitNode(s.node);
  };
  const visitExpr = (e: TypedExpr) => e.steps.forEach(visitStep);
  const visitNode = (node: TypedNode) => {
    switch (node.tag) {
      case "Build":      node.fields.forEach((f) => visitExpr(f.expr)); break;
      case "Fanout":     node.fields.forEach((f) => visitExpr(f.expr)); break;
      case "Case":       node.branches.forEach((b) => visitHandler(b.handler)); break;
      case "Fold":       node.branches.forEach((b) => visitHandler(b.handler)); break;
      case "Over":       visitStep(node.transform); break;
      case "Let":        visitExpr(node.rhs); visitExpr(node.body); break;
      case "SchemaInst": [...node.argSubst.values()].forEach(visitExpr); break;
      default: break;
    }
  };
  const visitHandler = (h: TypedHandler) => visitExpr(h.body);
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
    case "Fold":
      return {
        tag: "Fold",
        adtTy:     subT(node.adtTy),
        carrierTy: subT(node.carrierTy),
        branches:  node.branches.map((b) => substBranch(b, tySubst, effSubst)),
      };
    case "Over":
      return { tag: "Over", field: node.field, transform: subS(node.transform) };
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
