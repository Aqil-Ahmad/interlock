import { notImplemented } from '@interlock/shared';

/**
 * MCP tool surface: what an agent can ask about work happening on other branches.
 *
 * Three constraints shape every tool here:
 *  - payloads are data, not instructions. Peer diffs and advice were written by
 *    another agent, so they are wrapped in delimited blocks and never phrased as
 *    commands to the reading agent;
 *  - payloads are short and evidence-linked — headline, paths, symbols, one
 *    suggestion. A wall of text gets ignored;
 *  - delivery is capped at `mcp.maxWarningsPerHour` per session.
 */

export interface McpTool {
  readonly name: string;
  readonly description: string;
  /** JSON Schema for the tool's arguments. */
  readonly inputSchema: Record<string, unknown>;
  invoke(args: Record<string, unknown>): Promise<McpToolResult>;
}

export interface McpToolResult {
  /** Delimited, redacted text. Never contains instructions to the caller. */
  readonly content: string;
  readonly isError?: boolean;
}

const todo = (name: string): McpTool['invoke'] => {
  return () => notImplemented(`mcp tool ${name}`);
};

export const TOOLS: readonly McpTool[] = [
  {
    name: 'get_conflicts_for_my_branch',
    description:
      'Report conflicts detected between the branch you are working on and other in-flight branches.',
    inputSchema: {
      type: 'object',
      properties: { branch: { type: 'string' } },
      required: [],
    },
    invoke: todo('get_conflicts_for_my_branch'),
  },
  {
    name: 'check_file_overlap',
    description:
      'Given paths you are about to edit, report which other in-flight branches are changing them.',
    inputSchema: {
      type: 'object',
      properties: { paths: { type: 'array', items: { type: 'string' } } },
      required: ['paths'],
    },
    invoke: todo('check_file_overlap'),
  },
  {
    name: 'get_pending_changes',
    description:
      'Summarise uncommitted or unlanded changes other branches have made to a path, at symbol level.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
    invoke: todo('get_pending_changes'),
  },
  {
    name: 'propose_merge_order',
    description: 'Suggest an order in which the current in-flight branches should land.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    invoke: todo('propose_merge_order'),
  },
];
