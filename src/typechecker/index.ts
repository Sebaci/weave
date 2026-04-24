export { checkModule, checkDef, checkExpr, checkStep } from "./check.ts";
export type { TypeError, TypeResult } from "./errors.ts";
export { ok, fail, typeError, collectResults, mapResult } from "./errors.ts";
export type { CheckEnv, GlobalEnv, TypeDeclEnv, LocalEnv, DefInfo, CtorInfo, TypeDeclInfo, Omega } from "./env.ts";
export { emptyLocal, extendLocal, extendLocalMany, withLocals, withFreshLocals } from "./env.ts";
export { unify, unifyRows, unifyEffect, applySubst, applyEffSubst, showType, showEffect } from "./unify.ts";
export type { Subst, EffSubst, UnifyResult } from "./unify.ts";
export { lookupInfixOp, resolveBuiltinType, BUILTIN_OPS } from "./builtins.ts";
