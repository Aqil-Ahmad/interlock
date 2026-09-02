import { MAX_IGNORE_PATTERN_LENGTH } from './config.js';

/**
 * Glob matching for the two things a repository is allowed to exclude: branch
 * names and paths.
 *
 * Matched by scanning rather than by translating to a regex. Patterns come from
 * a repository's own `.interlock.json`, written by the agents Interlock
 * watches, and the names come from the same repository — so both sides are
 * hostile. A regex translation backtracks exponentially on a pattern that
 * alternates literals with wildcards: `a*a*a…b` against a name of `a`s takes 20
 * seconds at 33 characters, on the event loop, for every name it is tried
 * against. These scans backtrack to the last wildcard only, which bounds them
 * at the product of the two lengths.
 */

/**
 * Match a name against a pattern, treating it as one flat string.
 *
 * `/` is an ordinary character here, so `*` spans it. That is what branch rules
 * want — `release/*` should exclude `release/1.0` and `release/1.0/hotfix`
 * alike — and it is why {@link matchesPath} exists rather than reusing this on
 * paths, where the same behaviour would surprise anyone who has read a
 * `.gitignore`.
 *
 * Both sides are compared by code point, so `?` consumes an astral character
 * whole rather than half a surrogate pair. `*` is tested before a literal match
 * so that it always expands: a name containing a literal `*` would otherwise
 * consume the wildcard meant to span it.
 */
export function matchesGlob(name: string, pattern: string): boolean {
  // Enforced again here, not only where the config is parsed: a matcher has to
  // be safe on input that never passed through that boundary.
  if (pattern.length > MAX_IGNORE_PATTERN_LENGTH) return false;

  const subject = [...name];
  const glob = [...pattern];
  let subjectIndex = 0;
  let globIndex = 0;
  // Where to resume if the run this `*` is currently claiming turns out to be
  // one character too short.
  let starIndex = -1;
  let resumeIndex = 0;

  while (subjectIndex < subject.length) {
    const globChar = glob[globIndex];
    if (globChar === '*') {
      starIndex = globIndex;
      globIndex++;
      resumeIndex = subjectIndex;
    } else if (globChar === '?' || (globChar !== undefined && globChar === subject[subjectIndex])) {
      globIndex++;
      subjectIndex++;
    } else if (starIndex !== -1) {
      globIndex = starIndex + 1;
      resumeIndex++;
      subjectIndex = resumeIndex;
    } else {
      return false;
    }
  }

  while (glob[globIndex] === '*') globIndex++;
  return globIndex === glob.length;
}

/**
 * Match a worktree-relative path against a path pattern.
 *
 * Follows `.gitignore` where it is cheap to, because that is the intuition
 * anyone writing `ignore` will bring:
 *
 *  - `*` and `?` stay inside one segment; `**` spans segments;
 *  - a pattern containing no `/` matches a segment at any depth, so
 *    `node_modules` excludes `packages/app/node_modules/x`;
 *  - a pattern containing `/` is anchored to the worktree root;
 *  - matching a directory excludes everything beneath it.
 *
 * Two deliberate departures. There is no `!` negation: excluding a subtree and
 * then rescuing part of it is a second pass over every path, and a watcher that
 * skips a file is cheaper to reason about than one that skips and unskips.
 * And a match on a name excludes that name as well as what is under it, where
 * git excludes only the contents — it keeps a file called `build` under
 * `build/`, and keeps `a` itself under `a/**`. Both distinctions need a stat on
 * a path that may already be gone by the time the event naming it is read, and
 * a directory node is not a change to watch either way.
 */
export function matchesPath(path: string, pattern: string): boolean {
  if (pattern.length > MAX_IGNORE_PATTERN_LENGTH) return false;

  const cleaned = trimSlashes(pattern);
  if (cleaned === '') return false;

  const segments = splitPath(path);
  if (segments.length === 0) return false;

  // A bare name matches a segment at any depth; anything else is rooted. This
  // is the rule that makes `node_modules` mean what everyone expects.
  if (!cleaned.includes('/')) {
    return segments.some((segment) => matchesGlob(segment, cleaned));
  }

  // A leading `/` is already gone; a pattern containing `/` anywhere is rooted
  // either way, so the two spellings mean the same thing.
  const patternSegments = cleaned.split('/');

  // Excluding a directory excludes what is under it, so a prefix of the path
  // matching is enough. Walking prefixes rather than testing the full path also
  // keeps `dist/**` from needing to match a path that is exactly `dist`.
  for (let depth = 1; depth <= segments.length; depth++) {
    if (matchesSegments(segments.slice(0, depth), patternSegments)) return true;
  }
  return false;
}

/** True when any pattern excludes the path. */
export function pathIgnored(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchesPath(path, pattern));
}

function trimSlashes(pattern: string): string {
  let start = 0;
  let end = pattern.length;
  while (start < end && pattern[start] === '/') start++;
  while (end > start && pattern[end - 1] === '/') end--;
  return pattern.slice(start, end);
}

/** Split on `/`, dropping empty and `.` segments so `./a//b` reads as `a/b`. */
function splitPath(path: string): string[] {
  return path.split('/').filter((segment) => segment !== '' && segment !== '.');
}

/**
 * Match a segment list against a pattern segment list, with `**` spanning any
 * number of segments.
 *
 * The same backtrack-to-the-last-wildcard scan as {@link matchesGlob}, one
 * level up: bounded at the product of the two lengths rather than exponential
 * in the number of `**`s.
 */
function matchesSegments(segments: readonly string[], pattern: readonly string[]): boolean {
  let segmentIndex = 0;
  let patternIndex = 0;
  let starIndex = -1;
  let resumeIndex = 0;

  while (segmentIndex < segments.length) {
    const part = pattern[patternIndex];
    if (part === '**') {
      starIndex = patternIndex;
      patternIndex++;
      resumeIndex = segmentIndex;
    } else if (part !== undefined && matchesGlob(segments[segmentIndex]!, part)) {
      patternIndex++;
      segmentIndex++;
    } else if (starIndex !== -1) {
      patternIndex = starIndex + 1;
      resumeIndex++;
      segmentIndex = resumeIndex;
    } else {
      return false;
    }
  }

  while (pattern[patternIndex] === '**') patternIndex++;
  return patternIndex === pattern.length;
}
