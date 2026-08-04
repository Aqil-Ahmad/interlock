/**
 * The analyzer pipeline.
 *
 * Ordered cheapest-first so a run reports something in seconds and refines it
 * over minutes: textual and AST verdicts land almost immediately, sandboxed
 * typecheck/build/test verdicts follow and act as ground truth for the
 * heuristic layers.
 *
 * An analyzer joins by implementing `Analyzer` and being appended here.
 */
export * from './analyzer.js';
export * from './textual.js';

import type { Analyzer } from './analyzer.js';
import { textualAnalyzer } from './textual.js';

/** Pipeline order. Cheap, high-precision analyzers first. */
export const ANALYZER_PIPELINE: readonly Analyzer[] = [textualAnalyzer];
