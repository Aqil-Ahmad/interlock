/**
 * Speculative merge engine: combine two in-flight branches in the shadow's
 * object database and classify what breaks.
 *
 * Nothing here touches a user repository — every function takes a `ShadowRepo`.
 */
export * from './speculative-merge.js';
export * from './conflict-classifier.js';
