/**
 * MCP request handlers for the capability registry.
 *
 * Deliberately SDK-free: listing and calling are pure functions here, so they
 * are testable without spinning a transport. Only `mcp-server.ts` touches the
 * transport-specific SDK.
 *
 * This is the concrete answer to "the same tool implementation runs in-process
 * and out-of-process": the registry has no idea which of the two it is serving.
 */

import type { CapabilityRegistry } from '../src/capability-registry.ts';
import type { JsonObject, ToolContext } from '../src/ports.ts';

export interface McpToolDescription {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
}

/**
 * Kept structurally identical to the MCP `CallToolResult` so the transport
 * adapter needs no conversion — mutable arrays and optional metadata are what
 * the protocol's schema expects.
 */
export interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError: boolean;
}

export function textResult(text: string): McpToolResult {
  return { content: [{ type: 'text', text }], isError: false };
}

export function errorResult(message: string): McpToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** tools/list — every registered capability, nothing filtered. */
export function listCapabilityTools(registry: CapabilityRegistry): McpToolDescription[] {
  return registry.listToolDefinitions().map((def) => ({
    name: def.name,
    description: def.description,
    inputSchema: def.inputSchema,
  }));
}

export interface CapabilityNameResolver {
  /** Maps an MCP tool name back to the capability id that owns it. */
  idForToolName(toolName: string): string | null;
}

/**
 * tools/call.
 *
 * Errors become `isError` results rather than thrown exceptions: a thrown error
 * here would tear down the MCP transport, whereas a flagged result lets the
 * agent see what happened and decide whether to retry with different arguments.
 */
export async function callCapabilityTool(
  registry: CapabilityRegistry,
  resolver: CapabilityNameResolver,
  ctx: ToolContext,
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const id = resolver.idForToolName(toolName);
  if (!id) return errorResult(`Unknown tool: ${toolName}`);
  try {
    const result = await registry.invokeAsTool(id, ctx, args as JsonObject);
    return result.isError ? errorResult(result.content) : textResult(result.content);
  } catch (err) {
    return errorResult(`Tool '${toolName}' failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
