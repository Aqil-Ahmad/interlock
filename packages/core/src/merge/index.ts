/**
 * Speculative merge engine: combine two in-flight branches in a shadow worktree
 * and classify what breaks.
 *
 * Nothing here touches a user repository — every function takes a `ShadowRepo`
 * or a `ShadowWorktree`.
 */
export * from './speculative-merge.js';
export * from './conflict-classifier.js';
