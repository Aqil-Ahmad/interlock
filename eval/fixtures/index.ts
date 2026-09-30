import type { Fixture } from './format.js';
import { SEMANTIC } from './semantic.js';
import { TEXTUAL } from './textual.js';

export type { BranchSpec, Expectation, Fixture, FixtureCase, Operation, Span } from './format.js';
export { FIXTURE_CASES } from './format.js';

/** The golden set, in the order reports list it: by id. */
export const FIXTURES: readonly Fixture[] = [...TEXTUAL, ...SEMANTIC].sort((a, b) =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
);
