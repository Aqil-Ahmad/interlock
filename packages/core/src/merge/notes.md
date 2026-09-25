# Textual conflict classification

How a conflicted `merge-tree` result becomes Findings. The code in
`conflict-classifier.ts` carries the rules; this is why they are shaped as they
are.

## One Finding per conflicted path

A file with three conflict regions is one problem for whoever resolves it, and
one Finding keeps the count per run proportional to files rather than to hunks.
Each region contributes a span per side, up to `MAX_SPANS_PER_SIDE`.

## The class is read from structure

git's prose is reworded between releases; the `-z` type token and the stage set
are not. Every mapping needs both, so a shape git has never produced stays
unclassified instead of landing in the nearest class:

| Token                      | Stages                 | Class                                                |
| -------------------------- | ---------------------- | ---------------------------------------------------- |
| `CONFLICT (rename/delete)` | base and one side      | `rename-vs-modify`                                   |
| `CONFLICT (modify/delete)` | base and one side      | `delete-vs-modify`                                   |
| `CONFLICT (contents)`      | both sides, no base    | `add-add`                                            |
| `CONFLICT (contents)`      | base and both sides    | by region: `overlapping-edit` or `adjacent-addition` |
| `CONFLICT (binary)` too    | as either of the above | the same, with no span                               |

A rename against an edit is not a type of its own. git follows the rename and
merges the edit; it conflicts only when the edit collides, and then reports
`contents`, with every stage under the new name.

## Overlapping or adjacent

git writes "both added an import here" and "both rewrote this line" as the same
content conflict. The shadow merges with `diff3`, so every region carries its
base text, and each side is aligned against it: a base line with no counterpart
is one that side replaced or deleted, a side line with none was inserted.

- Both sides replaced a base line in common: overlapping.
- One side inserted strictly inside a run the other replaced: overlapping.
- Anything else — two insertions at one gap, changes to neighbouring lines, an
  insertion at the edge of the other's run — is adjacent.

Without a base, or with a side too far from it to align, the region cannot be
told apart and counts as adjacent. The weaker claim is the safe one: in the
noisy direction every pair of branches adding an import raises a high-severity
finding.

## Spans are in each branch's own file

Merged-file line numbers point at lines that exist on no branch: the merged
file holds both sides' clean changes as well as the regions. So each side is
placed separately. The merged file with every region resolved to that side is
the side's own file plus the other side's clean changes; aligning those two
places the region's lines exactly. A region is placed only when all its lines
align contiguously, and an empty side only when the lines around it are
neighbours in the file. Anything else gets no span: none is better than a wrong
one.

git records every stage under one path, which after a rename exists on one side
only, so each side's own path is found by looking for its blob in its own
commit — at the recorded path first, then anywhere. More than one match is a
copied file and gets no path.

Alignment is Myers' O(ND) diff after setting aside the shared start and end, and
gives up past `MAX_ALIGN_EDITS` rather than spend quadratic time on a hostile
file.

## Identity

`textualFindingKey`: the pair unordered, the class, and git's recorded path.
Not the span, which moves whenever either branch edits above the conflict, and
not the commits, which move on every snapshot; either would make a new Finding
per poll with the old one going stale beside it. A class change is a different
Finding because it asks something different of whoever resolves it.

## Bounds

Paths are examined most severe first — by what their class can turn out to be,
with an already-certain class ahead of a text conflict that may yet read as
adjacent — and at most `MAX_FINDINGS_PER_RUN` of them. Each costs a few
`cat-file` calls, and the repository decides how many paths conflict.
