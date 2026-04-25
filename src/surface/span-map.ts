import type {
  Module, TopDecl, TypeDecl, TypeDeclBody, CtorDecl, DefDecl, DefParam,
  EffectDecl, Import, SurfaceType, SurfaceField, Expr, Step, Handler,
  Branch, FieldBinder, FanoutField, BuildField, SchemaArg,
} from "./ast.ts";
import type { SourceNodeId, SourceSpan } from "./id.ts";

export type SpanMap = ReadonlyMap<SourceNodeId, SourceSpan>;

export function buildSpanMap(mod: Module): SpanMap {
  const map = new Map<SourceNodeId, SourceSpan>();

  function reg(id: SourceNodeId, span: SourceSpan): void {
    map.set(id, span);
  }

  function visitModule(m: Module): void {
    reg(m.meta.id, m.meta.span);
    m.imports.forEach(visitImport);
    m.decls.forEach(visitTopDecl);
  }

  function visitImport(i: Import): void {
    reg(i.meta.id, i.meta.span);
  }

  function visitTopDecl(td: TopDecl): void {
    switch (td.tag) {
      case "TypeDecl":   visitTypeDecl(td.decl);   break;
      case "DefDecl":    visitDefDecl(td.decl);    break;
      case "EffectDecl": visitEffectDecl(td.decl); break;
    }
  }

  function visitTypeDecl(d: TypeDecl): void {
    reg(d.meta.id, d.meta.span);
    visitTypeDeclBody(d.body);
  }

  function visitTypeDeclBody(b: TypeDeclBody): void {
    switch (b.tag) {
      case "Record":  b.fields.forEach(visitSurfaceField); break;
      case "Variant": b.ctors.forEach(visitCtorDecl);     break;
    }
  }

  function visitCtorDecl(c: CtorDecl): void {
    reg(c.meta.id, c.meta.span);
    c.payload?.forEach(visitSurfaceField);
  }

  function visitDefDecl(d: DefDecl): void {
    reg(d.meta.id, d.meta.span);
    d.params.forEach(visitDefParam);
    visitSurfaceType(d.ty);
    visitExpr(d.body);
  }

  function visitDefParam(p: DefParam): void {
    reg(p.meta.id, p.meta.span);
    visitSurfaceType(p.ty);
  }

  function visitEffectDecl(d: EffectDecl): void {
    reg(d.meta.id, d.meta.span);
    visitSurfaceType(d.inputTy);
    visitSurfaceType(d.outputTy);
  }

  function visitSurfaceType(t: SurfaceType): void {
    reg(t.meta.id, t.meta.span);
    switch (t.tag) {
      case "BaseType": break;
      case "TyVar":    break;
      case "Named":    t.args.forEach(visitSurfaceType); break;
      case "Record":   t.fields.forEach(visitSurfaceField); break;
      case "Arrow":    visitSurfaceType(t.from); visitSurfaceType(t.to); break;
    }
  }

  function visitSurfaceField(f: SurfaceField): void {
    reg(f.meta.id, f.meta.span);
    visitSurfaceType(f.ty);
  }

  function visitExpr(e: Expr): void {
    reg(e.meta.id, e.meta.span);
    e.steps.forEach(visitStep);
  }

  function visitStep(s: Step): void {
    reg(s.meta.id, s.meta.span);
    switch (s.tag) {
      case "Name":       break;
      case "Ctor":       break;
      case "Projection": break;
      case "Literal":    break;
      case "Perform":    break;
      case "SchemaInst": s.args.forEach(visitSchemaArg); break;
      case "Build":      s.fields.forEach(visitBuildField); break;
      case "Fanout":     s.fields.forEach(visitFanoutField); break;
      case "Case":       s.branches.forEach(visitBranch); break;
      case "Fold":       s.branches.forEach(visitBranch); break;
      case "Over":       visitStep(s.transform); break;
      case "Let":        visitExpr(s.rhs); visitExpr(s.body); break;
      case "Infix":      visitStep(s.left); visitStep(s.right); break;
    }
  }

  function visitSchemaArg(a: SchemaArg): void {
    reg(a.meta.id, a.meta.span);
    visitExpr(a.expr);
  }

  function visitBuildField(f: BuildField): void {
    reg(f.meta.id, f.meta.span);
    visitExpr(f.expr);
  }

  function visitFanoutField(f: FanoutField): void {
    reg(f.meta.id, f.meta.span);
    if (f.tag === "Field") visitExpr(f.expr);
  }

  function visitBranch(b: Branch): void {
    reg(b.meta.id, b.meta.span);
    visitHandler(b.handler);
  }

  function visitHandler(h: Handler): void {
    reg(h.meta.id, h.meta.span);
    switch (h.tag) {
      case "NullaryHandler": visitExpr(h.body); break;
      case "RecordHandler":
        h.binders.forEach(visitFieldBinder);
        visitExpr(h.body);
        break;
    }
  }

  function visitFieldBinder(b: FieldBinder): void {
    reg(b.meta.id, b.meta.span);
  }

  visitModule(mod);
  return map;
}
