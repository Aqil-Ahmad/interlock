import { notImplemented } from '@interlock/shared';
import type { Analyzer, AnalyzerContext, AnalyzerOutcome } from './analyzer.js';

/**
 * Textual conflict analyzer.
 *
 * Reads the conflict blocks git already produced during the speculative merge
 * and hands them to the classifier. Costs nothing beyond the merge, so it runs
 * on every pair.
 */
export const textualAnalyzer: Analyzer = {
  kind: 'textual',
  name: 'textual',

  appliesTo: (context: AnalyzerContext) => !context.merged.clean,

  analyze: (_context: AnalyzerContext): Promise<AnalyzerOutcome> =>
    notImplemented('textualAnalyzer.analyze'),
};
