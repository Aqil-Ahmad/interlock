import { fileURLToPath } from 'node:url';

/**
 * The directory this package's modules are loaded from — `src` run as it
 * stands, or `dist` once built.
 *
 * For a digest of the code a cached verdict depends on: redaction, severities
 * and the models a Finding is made of live here, so a change to any of them
 * has to change the verdict's key as surely as a change to the classifier.
 */
export const SHARED_MODULE_DIR: string = fileURLToPath(new URL('.', import.meta.url));
