import { isInterlockError } from '@interlock/shared';
import { classifyTextualConflicts, MAX_FINDINGS_PER_RUN } from '../merge/conflict-classifier.js';
import { CLEAN, infraFailure } from './analyzer.js';
import type { Analyzer, AnalyzerContext, AnalyzerOutcome } from './analyzer.js';

/**
 * Textual conflict analyzer.
 *
 * Reads the conflicts git already produced during the speculative merge and
 * hands them to the classifier. Costs nothing beyond the merge and a few blob
 * reads per conflicted path, so it runs on every pair.
 */
export const textualAnalyzer: Analyzer = {
  kind: 'textual',
  name: 'textual',

  appliesTo: (context: AnalyzerContext) => !context.merged.clean,

  analyze: async (context: AnalyzerContext): Promise<AnalyzerOutcome> => {
    const log = context.logger.child('textual', { runId: context.runId });
    let classified;
    try {
      classified = await classifyTextualConflicts(
        {
          runId: context.runId,
          branchA: context.branchA,
          branchB: context.branchB,
          merge: context.mergeRequest,
          merged: context.merged,
          now: new Date().toISOString(),
        },
        { runner: context.runner },
      );
    } catch (error) {
      // A blob that cannot be read is a shadow that cannot be trusted, not a
      // pair with nothing wrong. The code and message carry no paths; details,
      // which do, stay out.
      if (!isInterlockError(error)) throw error;
      log.warn('textual classification could not read the merge', { code: error.code });
      return infraFailure(`${error.code}: ${error.message}`);
    }

    const { findings, unclassified, dropped } = classified;
    if (unclassified.length > 0) {
      log.info('conflicts of a type no class covers raised nothing', { types: unclassified });
    }
    if (dropped > 0) {
      log.warn('conflicted paths past the per-run bound were not examined', {
        dropped,
        bound: MAX_FINDINGS_PER_RUN,
      });
    }
    return findings.length === 0 ? CLEAN : { verdict: 'findings', findings };
  },
};
