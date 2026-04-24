export type {
  GraphId, NodeId, PortId, DefId, OpRef,
  Provenance, Port, Wire, Graph,
  LiteralValue,
  NodeBase, Node,
  DupNode, DropNode, ProjNode, TupleNode,
  CaseNode, CataNode, ConstNode, CtorNode, EffectNode, RefNode,
  ElaboratedModule,
} from "./ir.ts";

export { validateGraph } from "./validate.ts";
export type { ValidationError, ValidationResult } from "./validate.ts";
