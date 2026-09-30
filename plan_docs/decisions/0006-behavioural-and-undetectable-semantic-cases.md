# ADR-0006: The behavioural case goes to the targeted tests; the duplicate is out of scope

- **Status:** accepted
- **Date:** 2026-09-30

## Context

The evaluation protocol lists seven semantic cases for the golden fixtures.
Three are stale references the compiler reports once the branches merge. The
other two compile, so the compiler cannot see them, and the golden set first
labelled both for an `ast-semantic` analyzer:

- **Same-symbol dual edit.** Both branches change one function in lines that
  merge cleanly.
- **Duplicate implementation.** Both branches add the same helper under
  different names.

No milestone plans that analyzer. M4 was rewritten so the AST layer is a
pre-filter and never a detector, because a hand-built matcher re-deriving what
a type checker knows is a worse copy of the type checker, and a matcher that
flags "both branches touched one function" is wrong far more often than right.
The first fixture for the dual edit showed it: its two edits, one rejecting a
discount over 100% and one rounding the result, were correct together, and the
only thing that could have flagged them was exactly such a matcher. Meanwhile
`plan_docs/evaluation.md` set an AST-layer precision target of 0.9 for a layer
that detects nothing.

M4's exit criterion already gives behavioural conflicts, two changes that
compile together and do the wrong thing, to the targeted-test analyzer.

## Decision

The dual edit is a behavioural conflict, labelled for the targeted-test
analyzer (`test`) under the rule `merge-breaks-test`. Its fixture carries a
test on each branch that passes there and fails only on the merge. The
duplicate implementation stays in the set, labelled as not detected by design:
it expects nothing, anything found on it is a false positive, and the report
lists it with the reason. The AST layer is measured as a pre-filter: it must
never filter out a labelled semantic conflict, and its escalation rate is
reported.

## Consequences

The targeted-test analyzer has a fixture to be scored on from its first day,
and one hard negative beside it: two edits to the same function whose tests
all pass merged. A test analyzer names its rule `merge-breaks-test` and spans
each branch's copy of the function the test exercises, or it scores recall 0
against the set.

A behavioural conflict is found only where a test covers it. A repository
without tests gets no such Finding, and the product says nothing rather than
guessing; the recall this costs is visible in the report.

The fixture format gains `notDetected`, which is also how any later case the
design deliberately does not catch is kept visible instead of dropped.

Reversing it means an AST detector: a new ADR, with the precision evidence the
pre-filter design rejected it for.

## Alternatives considered

- **An AST detector for both cases.** Contradicts the pre-filter design, and
  "both touched one function" is not evidence of a conflict: the first fixture
  was two correct edits.
- **Dropping both cases from the set.** Hides a case the protocol names, and
  loses the behavioural fixture the test analyzer needs.
- **Keeping the `ast-semantic` labels at recall 0.** Scores an analyzer that
  will never exist, and leaves the test analyzer with nothing to be scored on.
