/** The CLI's client for the daemon's localhost API. */
export { connectDaemon, parseAnalysis, parseCollection } from './daemon-client.js';
export type {
  AnalysisFailure,
  AnalysisState,
  BudgetReport,
  BudgetRule,
  BudgetWindow,
  CheckReport,
  CheckRequest,
  CollectionFailure,
  CollectionPhase,
  CollectionState,
  DaemonClient,
  DismissRequest,
  FinishedCollection,
  ShadowStoreSize,
} from './daemon-client.js';
