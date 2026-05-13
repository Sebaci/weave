/**
 * Regression tests for fold over ADTs with recursive positions inside
 * container types (e.g. `type Rose = Rose { children: List Rose }`).
 *
 * Prior to the fix, foldPayload did not recurse through Named type arguments,
 * so `children: List Rose` was handed raw (unfolded) to the algebra branch
 * even though the branch input type declared `children: List A` (the carrier).
 * This caused wrong results or crashes.
 */

import { test, expect } from "vitest";
import { parseModule } from "../../src/parser/index.ts";
import { checkModule } from "../../src/typechecker/check.ts";
import { elaborateModule, resetElabCounters } from "../../src/elaborator/index.ts";
import { interpret } from "../../src/interpreter/eval.ts";
import { vInt, vVariant, vRecord, VUnit, type Value } from "../../src/interpreter/value.ts";

function run(src: string, defName: string, input: Value): Value {
  resetElabCounters();
  const pr = parseModule(src);
  if (!pr.ok) throw new Error(`Parse: ${pr.errors.map((e) => e.message).join("; ")}`);
  const tr = checkModule(pr.value);
  if (!tr.ok) throw new Error(`Typecheck: ${tr.errors.map((e) => e.message).join("; ")}`);
  const er = elaborateModule(tr.value);
  if (!er.ok) throw new Error(`Elaborate: ${er.errors.map((e) => e.message).join("; ")}`);
  return interpret(er.value, defName, input);
}

// ---------------------------------------------------------------------------
// Helpers to build List values
// ---------------------------------------------------------------------------

const nil = vVariant("Nil", VUnit);
function cons(head: Value, tail: Value): Value {
  return vVariant("Cons", vRecord({ head, tail }));
}

// ---------------------------------------------------------------------------
// Rose tree: type Rose = Rose { children: List Rose }
// Recursive position appears inside List, not directly in the payload.
// ---------------------------------------------------------------------------

const roseSrc = `
module Rose

type List a = Nil | Cons { head: a, tail: List a }

type Rose = Rose { children: List Rose }

-- Count the total number of Rose nodes in the tree.
-- After substitution the Rose branch receives { children: List Int }.
-- We fold children (a List Int) to sum the child counts, then add 1 for self.
def countNodes : Rose -> Int =
  fold {
    Rose: { children } >>>
      let n = children >>> fold {
        Nil: 0,
        Cons: { head, tail } >>> head + tail
      } in
      n + 1
  }
`;

// A single Rose node with no children: Rose { children: Nil }
// Expected count: 1
const leaf = vVariant("Rose", vRecord({ children: nil }));

// Rose { children: Cons(leaf, Cons(leaf, Nil)) }
// Expected count: 3  (self + 2 children)
const twoChildren = vVariant("Rose", vRecord({
  children: cons(leaf, cons(leaf, nil)),
}));

// Rose { children: Cons(twoChildren, Nil) }
// Expected count: 4  (self + twoChildren(3))
const nested = vVariant("Rose", vRecord({
  children: cons(twoChildren, nil),
}));

test("fold Rose container: single node counts 1", () => {
  const result = run(roseSrc, "Rose.countNodes", leaf);
  expect(result).toEqual(vInt(1));
});

test("fold Rose container: node with two leaf children counts 3", () => {
  const result = run(roseSrc, "Rose.countNodes", twoChildren);
  expect(result).toEqual(vInt(3));
});

test("fold Rose container: three-level tree counts 4", () => {
  const result = run(roseSrc, "Rose.countNodes", nested);
  expect(result).toEqual(vInt(4));
});

// ---------------------------------------------------------------------------
// Single-constructor variant container: type Box a = Box { val: a }
// The recursive position is inside a Named variant container (not a direct
// record alias). This exercises the Named/Variant path in foldPayload.
// If foldPayload fails to recurse into Box, the branch receives Box Nat
// (raw) instead of Box Int, and the value comparison fails.
// ---------------------------------------------------------------------------

const boxSrc = `
module Box

type Box a = Box { val: a }

type Nat = Zero | Succ { pred: Box Nat }

-- Fold Nat -> Int: carrier is Int, so Succ branch receives pred: Box Int.
-- Access val via pred >>> case { Box: { val } >>> val + 1 }.
-- If foldPayload fails to recurse into Box, pred is Box Nat (raw) and
-- val + 1 crashes or produces wrong results (Nat variant ≠ Int).
def natToInt : Nat -> Int =
  fold {
    Zero: 0,
    Succ: { pred } >>>
      pred >>>
      case {
        Box: { val } >>> val + 1
      }
  }
`;

const natZero = vVariant("Zero", VUnit);
// Succ { pred: Box { val: Zero } } — fold = 1
const natSuccZero = vVariant("Succ", vRecord({ pred: vVariant("Box", vRecord({ val: natZero })) }));
// Succ { pred: Box { val: Succ { pred: Box { val: Zero } } } } — fold = 2
const natSuccSucc = vVariant("Succ", vRecord({ pred: vVariant("Box", vRecord({ val: natSuccZero })) }));

test("fold Box variant container: Zero = 0", () => {
  const result = run(boxSrc, "Box.natToInt", natZero);
  expect(result).toEqual(vInt(0));
});

test("fold Box variant container: Succ(Box(Zero)) = 1", () => {
  const result = run(boxSrc, "Box.natToInt", natSuccZero);
  expect(result).toEqual(vInt(1));
});

test("fold Box variant container: Succ(Box(Succ(Box(Zero)))) = 2", () => {
  const result = run(boxSrc, "Box.natToInt", natSuccSucc);
  expect(result).toEqual(vInt(2));
});
