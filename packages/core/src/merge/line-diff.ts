/**
 * Line alignment: which line of one text each line of another is.
 *
 * Myers' O(ND) difference algorithm, returning a longest common subsequence as
 * a match per line. Written here rather than taken from npm because `core`
 * takes no dependency without an ADR, and rather than asked of `git diff`
 * because what gets aligned is often a text no object holds — a merged file
 * with every region resolved to one side — and the runner has no stdin to
 * hash one with.
 */

/**
 * For each line of `a`, the index of the line of `b` it is matched to, or -1
 * where `a`'s line has no counterpart.
 *
 * Null when the texts differ by more than `maxEdits` lines once their common
 * start and end are set aside. The cost is quadratic in the edits, not in the
 * length, and a caller that cannot align something is better told so than made
 * to wait.
 */
export function alignLines(
  a: readonly string[],
  b: readonly string[],
  maxEdits: number,
): Int32Array | null {
  const matches = new Int32Array(a.length).fill(-1);

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    matches[start] = start;
    start++;
  }
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
    matches[endA] = endB;
  }

  const n = endA - start;
  const m = endB - start;
  if (n === 0 || m === 0) return matches;

  const max = Math.min(n + m, maxEdits);
  const offset = max + 1;
  // Furthest x reached on each diagonal k = x - y, indexed from `offset`.
  const v = new Int32Array(2 * max + 3);
  // The window of `v` each step started from: diagonals -d-1 … d+1, which is
  // all a step reads, so the trace is quadratic in the edits alone.
  const trace: Int32Array[] = [];

  for (let d = 0; d <= max; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!);
      let x = down ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[start + x] === b[start + y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        backtrack(trace, d, n, m, (i, j) => {
          matches[start + i] = start + j;
        });
        return matches;
      }
    }
  }
  return null;
}

/** Walk the trace back from the end, reporting every diagonal step as a match. */
function backtrack(
  trace: readonly Int32Array[],
  edits: number,
  n: number,
  m: number,
  match: (i: number, j: number) => void,
): void {
  let x = n;
  let y = m;
  for (let d = edits; d > 0; d--) {
    const window = trace[d]!;
    const at = (k: number): number => window[k + d + 1]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      match(x, y);
    }
    x = prevX;
    y = prevY;
  }
  // No diagonal opens the path: the shared start was set aside before aligning,
  // so the first lines differ and step zero's snake is empty.
}
