/**
 * Port-counting regression tests for the elaborator.
 *
 * These tests target patterns where countUsesInTypedExpr was historically
 * wrong: it recursed into Case/Fold/CaseField branch bodies and overcounted
 * variable uses there, allocating extra unconsumed DupNode outputs (IR-1).
 *
 * Patterns covered:
 *   1. Variable in multiple CaseField branches inside a fold handler
 *   2. Variable in multiple CaseField branches in a plain case handler
 *   3. Nested let chains where the inner let's body is a CaseField
 *   4. Schema instantiation — filter(pred: isPositive) end-to-end
 *
 * Each test verifies that elaboration succeeds (no IR-1 violation) and that
 * the interpreter produces the expected result.
 */

import { test, expect } from "vitest";
import { parseModule } from "../../src/parser/index.ts";
import { checkModule } from "../../src/typechecker/check.ts";
import { elaborateModule, resetElabCounters } from "../../src/elaborator/index.ts";
import { interpret } from "../../src/interpreter/eval.ts";
import { showValue, vInt, vVariant, vRecord, VUnit, type Value } from "../../src/interpreter/value.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function elabAndInterpret(src: string, defName: string, input: Value): Value {
  resetElabCounters();
  const pr = parseModule(src);
  if (!pr.ok) throw new Error(`Parse: ${pr.errors.map((e) => e.message).join("; ")}`);
  const tr = checkModule(pr.value);
  if (!tr.ok) throw new Error(`Typecheck: ${tr.errors.map((e) => e.message).join("; ")}`);
  const er = elaborateModule(tr.value);
  if (!er.ok) throw new Error(`Elaborate (IR violation): ${er.errors.map((e) => e.message).join("; ")}`);
  return interpret(er.value, defName, input);
}

const nil = vVariant("Nil", VUnit);
function cons(head: Value, tail: Value): Value {
  return vVariant("Cons", vRecord({ head, tail }));
}

// ---------------------------------------------------------------------------
// Test 1: Variable in multiple CaseField branches inside a fold handler
//
// Cons handler: let isPos = head > 0 in case .isPos { True: head+tail, False: tail }
//
// The let-bound `isPos` (Bool) is the dispatch field.
// `tail` appears in BOTH True and False branches.
//
// OLD countUsesInTypedExpr("tail" in handler body):
//   rhs=head>0 → 0 uses of tail from rhs
//   body=CaseField: True(head+tail) → tail+=1; False(tail) → tail+=1 → tail=2
// NEW countUsesInTypedExpr:
//   liveSet=[head,tail] → tail=1; rhs=head>0 → tail still 1
//   Total tail=1
//
// OLD: allocates 2 DupNode outputs for tail; CaseField only consumes 1 → IR-1 violation.
// NEW: allocates 1, consumed correctly → passes.
// ---------------------------------------------------------------------------

const src1 = `
module Test.PortCount1

type List a =
  | Nil
  | Cons { head: Int, tail: List a }

def sumPositives : List Int -> Int ! pure =
  fold {
    Nil: 0,
    Cons: { head, tail } >>>
      let isPos = head > 0 in
      case .isPos {
        True:  head + tail,
        False: tail,
      },
  }
`;

test("port-counting 1a: variable in multiple CaseField branches in fold — [3,-1,2] = 5", () => {
  // [3,-1,2]: 3(positive)+2(positive) = 5
  const input = cons(vInt(3), cons(vInt(-1), cons(vInt(2), nil)));
  const result = elabAndInterpret(src1, "sumPositives", input);
  expect(showValue(result)).toBe(showValue(vInt(5)));
});

test("port-counting 1b: variable in multiple CaseField branches in fold — all negative = 0", () => {
  const input = cons(vInt(-1), cons(vInt(-5), nil));
  const result = elabAndInterpret(src1, "sumPositives", input);
  expect(showValue(result)).toBe(showValue(vInt(0)));
});

// ---------------------------------------------------------------------------
// Test 2: Variable in multiple CaseField branches in a plain case handler
//
// Box handler { x, y }: let isLarger = x > y in case .isLarger { True: x-y, False: y-x }
//
// Both x and y appear in both branches of case .isLarger.
// They also both appear in the let RHS (x > y).
//
// countUsesInTypedExpr(handler.body, ["x","y"]):
//   NEW: liveSet=[x,y] → x=1, y=1; rhs=x>y → x+=1, y+=1 → x=2, y=2
//   OLD: rhs=x>y → x=1, y=1; body: True(x-y)→x+=1,y+=1; False(y-x)→y+=1,x+=1 → x=3, y=3
//
// OLD: allocates 3 DupNode outputs each; CaseField creates fresh projections (consuming 2
// from the liveSet + rhs, leaving 1 extra unconsumed) → IR-1.
// NEW: allocates 2 each → all consumed correctly.
// ---------------------------------------------------------------------------

const src2 = `
module Test.PortCount2

type Box = | Box { x: Int, y: Int }

def absDiff : Box -> Int ! pure =
  case {
    Box: { x, y } >>>
      let isLarger = x > y in
      case .isLarger {
        True:  x - y,
        False: y - x,
      }
  }
`;

test("port-counting 2a: variable in both CaseField branches, plain handler — Box{5,3} = 2", () => {
  const input = vVariant("Box", vRecord({ x: vInt(5), y: vInt(3) }));
  const result = elabAndInterpret(src2, "absDiff", input);
  expect(showValue(result)).toBe(showValue(vInt(2)));
});

test("port-counting 2b: variable in both CaseField branches, plain handler — Box{2,7} = 5", () => {
  const input = vVariant("Box", vRecord({ x: vInt(2), y: vInt(7) }));
  const result = elabAndInterpret(src2, "absDiff", input);
  expect(showValue(result)).toBe(showValue(vInt(5)));
});

// ---------------------------------------------------------------------------
// Test 3: Nested let chains where the inner let body is a CaseField
//
// Cons handler:
//   let s2 = head + head in           -- outer let; liveSet=[head,tail]
//   let isPos = s2 > 0 in             -- inner let; liveSet=[head,tail]
//   case .isPos { True: head+tail, False: tail }
//
// countUsesInTypedExpr(handler.body, ["head","tail"]):
//   handler.body = outer Let(s2, rhs=head+head, body=inner_let, liveSet=[head,tail])
//   NEW: outer liveSet=[head,tail] → head=1,tail=1; rhs=head+head → head+=2 → head=3,tail=1
//   OLD: rhs=head+head → head=2; recurse into inner_let:
//     inner Let(isPos, rhs=s2>0, body=case.isPos{...}) → rhs: nothing from counts;
//     body: True(head+tail)→head+=1,tail+=1; False(tail)→tail+=1 → head=1,tail=2
//   OLD total: head=3, tail=3
//
// NEW: head=3, tail=1. OLD: head=3, tail=3.
// tail is overcounted 3x in old code; only 1 actual consumption needed.
// ---------------------------------------------------------------------------

const src3 = `
module Test.PortCount3

type List a =
  | Nil
  | Cons { head: Int, tail: List a }

def chainedLetWithCase : List Int -> Int ! pure =
  fold {
    Nil: 0,
    Cons: { head, tail } >>>
      let s2 = head + head in
      let isPos = s2 > 0 in
      case .isPos {
        True:  head + tail,
        False: tail,
      },
  }
`;

test("port-counting 3a: nested let chains with CaseField body — [3,1,2] = 12", () => {
  // [3,1,2]:
  // Nil → 0
  // Cons(2,Nil): head=2,tail=0; s2=4; isPos=True; 2+0=2
  // Cons(1,[2]): head=1,tail=2; s2=2; isPos=True; 1+2=3
  // Cons(3,[1,2]): head=3,tail=3; s2=6; isPos=True; 3+3=6... hmm
  // Wait: tail is the result of folding the rest, not the element.
  // Nil → 0; Cons(2,Nil)→2+0=2; Cons(1,[2])→1+2=3; Cons(3,[1,2])→3+3=6? No.
  // fold is right-to-left / bottom-up:
  // Nil → 0
  // Cons(2,0): s2=4>0=True → 2+0=2
  // Cons(1,2): s2=2>0=True → 1+2=3
  // Cons(3,3): s2=6>0=True → 3+3=6
  // Wait that doesn't give 12. Let me recheck. [3,1,2] processed bottom-up:
  // Nil → 0
  // Cons(head=2, tail=fold(Nil)=0): s2=4>0, True → head+tail=2+0=2
  // Cons(head=1, tail=fold([2])=2): s2=2>0, True → head+tail=1+2=3
  // Cons(head=3, tail=fold([1,2])=3): s2=6>0, True → head+tail=3+3=6
  // Total = 6, not 12. Let me fix expected value.
  const input = cons(vInt(3), cons(vInt(1), cons(vInt(2), nil)));
  const result = elabAndInterpret(src3, "chainedLetWithCase", input);
  expect(showValue(result)).toBe(showValue(vInt(6)));
});

test("port-counting 3b: nested let chains with CaseField body — [-3,1] = 1", () => {
  // Nil → 0
  // Cons(1,0): s2=2>0=True → 1+0=1
  // Cons(-3,1): s2=-6>0=False → tail=1
  // Total = 1
  const input = cons(vInt(-3), cons(vInt(1), nil));
  const result = elabAndInterpret(src3, "chainedLetWithCase", input);
  expect(showValue(result)).toBe(showValue(vInt(1)));
});

// ---------------------------------------------------------------------------
// Test 4: Schema instantiation — filter(pred: isPositive)
//
// This is the exact pattern that triggered the original countUsesInTypedExpr bug.
// filter's Cons handler: let passed = head >>> pred in case .passed { True: .., False: .. }
// Both `head` and `tail` appear in the True branch; `tail` appears in the False branch.
//
// OLD countUsesInTypedExpr("tail" in Cons handler body):
//   rhs = head>>>pred → 0 tail uses
//   body = CaseField: True(fanout{head,tail}>>>Cons) → tail=1; False(tail) → tail=1 → total=2
// NEW:
//   liveSet=[head,tail] → tail=1; rhs=head>>>pred → nothing → tail=1
//
// OLD allocates 2 DupNode outputs for tail; CaseField only consumes 1 → IR-1 violation.
// NEW allocates 1 → correct.
// ---------------------------------------------------------------------------

const src4 = `
module Test.PortCount4

type List a =
  | Nil
  | Cons { head: a, tail: List a }

def filter (pred : a -> Bool ! pure) : List a -> List a ! pure =
  fold {
    Nil:  Nil,
    Cons: { head, tail } >>>
      let passed = head >>> pred in
      case .passed {
        True:  fanout { head, tail } >>> Cons,
        False: tail,
      },
  }

def isPositive : Int -> Bool ! pure = id > 0

def keepPositives : List Int -> List Int ! pure =
  filter(pred: isPositive)
`;

test("port-counting 4a: schema instantiation filter(pred:isPositive) — [3,-1,2] keeps [3,2]", () => {
  const input = cons(vInt(3), cons(vInt(-1), cons(vInt(2), nil)));
  const result = elabAndInterpret(src4, "keepPositives", input);
  const expected = cons(vInt(3), cons(vInt(2), nil));
  expect(showValue(result)).toBe(showValue(expected));
});

test("port-counting 4b: schema instantiation filter — all negative → Nil", () => {
  const input = cons(vInt(-1), cons(vInt(-5), nil));
  const result = elabAndInterpret(src4, "keepPositives", input);
  expect(showValue(result)).toBe(showValue(nil));
});

test("port-counting 4c: schema instantiation filter — all positive → unchanged", () => {
  const input = cons(vInt(1), cons(vInt(2), cons(vInt(3), nil)));
  const result = elabAndInterpret(src4, "keepPositives", input);
  const expected = cons(vInt(1), cons(vInt(2), cons(vInt(3), nil)));
  expect(showValue(result)).toBe(showValue(expected));
});
