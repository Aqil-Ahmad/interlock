/**
 * The containment boundary, re-exported where the MCP server has always found
 * it. One implementation lives in `shared`, because the CLI prints repository
 * content an agent reads too.
 */
export { CONTENT_CLOSE, CONTENT_OPEN, wrapUntrusted } from '@interlock/shared';
export type { SanitizeOptions } from '@interlock/shared';
