/**
 * Shared Context AI Tool
 *
 * Registered by plugin-knowledge-base as a dynamic tool via toolsManager.
 * Exposes the SessionContextService to all AI Employees, enabling cross-agent
 * collaboration through a shared key-value scratchpad.
 *
 * Scope resolution:
 *  1. rootRunId — from orchestrator trace context (inside a delegation chain)
 *  2. sessionId — from the active AI chat conversation
 *
 * This tool is intentionally in the knowledge-base plugin (not orchestrator)
 * because KB owns all storage and context infrastructure.
 */

import { z } from 'zod';
import type { SessionContextService, ContextScope } from '../services/session-context';
import { resolveScope, resolveSource } from '../utils/scope-resolver';

export function createSharedContextToolProvider(sessionContext: SessionContextService) {
  /**
   * Dynamic tools provider — called by toolsManager when listing available tools.
   * Registers a single `shared_context` tool for all AI Employees.
   */
  return async (register: { registerTools: (tools: any) => void }) => {
    register.registerTools({
      scope: 'CUSTOM' as const,
      execution: 'backend' as const,
      defaultPermission: 'ALLOW' as const,

      introduction: {
          title: 'Shared Context',
          about:
            'Read and write shared context for cross-agent collaboration. ' +
            'Enables agents to share findings, data, and state within a delegation chain or chat session.',
        },

        definition: {
          name: 'shared_context',
          description: `Read/write shared context for cross-agent collaboration within a delegation chain or chat session.

HOW TO USE:
- "list": See all available context keys. Use this FIRST to discover what other agents have shared.
- "get": Read a context value by key. Args: { key: "<key_name>" }
- "set": Write/update a context value. Args: { key: "<key_name>", value: <any_json_value> }
- "append": Append an item to an array-valued key. Args: { key: "<key_name>", item: <any_value> }
- "delete": Remove a context key. Args: { key: "<key_name>" }

BEST PRACTICES:
- Always call "list" first to see what's already available before re-computing.
- Write your key findings with "set" before finishing, so downstream agents benefit.
- Use descriptive key names: "ocr_results", "legal_risks", "analysis_summary".
- Keep values concise; the store has a 500KB per-entry limit.
- Context entries expire after 24 hours by default.`,
          schema: z.object({
            action: z
              .enum(['list', 'get', 'set', 'append', 'delete'])
              .describe('The operation to perform.'),
            key: z
              .string()
              .optional()
              .describe('Context key name. Required for get/set/append/delete.'),
            value: z
              .any()
              .optional()
              .describe('Value to write (for "set" action). Any JSON-serializable value.'),
            item: z
              .any()
              .optional()
              .describe('Item to append (for "append" action).'),
          }),
        },

        invoke: async (ctx: any, args: { action: string; key?: string; value?: any; item?: any }) => {
          const scope = resolveScope(ctx);

          if (!scope.rootRunId && !scope.sessionId) {
            return {
              status: 'error' as const,
              content:
                'Cannot determine context scope. This tool requires an active delegation chain (rootRunId) or chat session (sessionId).',
            };
          }

          try {
            switch (args.action) {
              case 'list': {
                const keys = await sessionContext.listKeys(scope);
                if (keys.length === 0) {
                  return {
                    status: 'success' as const,
                    content:
                      'No shared context entries found. You are the first agent — use "set" to write context for downstream agents.',
                  };
                }
                return {
                  status: 'success' as const,
                  content: JSON.stringify({ keys, total: keys.length }),
                };
              }

              case 'get': {
                if (!args.key) {
                  return { status: 'error' as const, content: 'Missing "key" parameter for "get" action.' };
                }
                const value = await sessionContext.get(scope, args.key);
                if (value === null) {
                  return { status: 'success' as const, content: `Key "${args.key}" not found in shared context.` };
                }
                return {
                  status: 'success' as const,
                  content: typeof value === 'string' ? value : JSON.stringify(value),
                };
              }

              case 'set': {
                if (!args.key) {
                  return { status: 'error' as const, content: 'Missing "key" parameter for "set" action.' };
                }
                if (args.value === undefined) {
                  return { status: 'error' as const, content: 'Missing "value" parameter for "set" action.' };
                }
                const source = resolveSource(ctx);
                await sessionContext.set(scope, args.key, args.value, {
                  source,
                  contentType: typeof args.value === 'string' ? 'text' : 'json',
                });
                return {
                  status: 'success' as const,
                  content: `Context key "${args.key}" saved. Other agents can now read it.`,
                };
              }

              case 'append': {
                if (!args.key) {
                  return { status: 'error' as const, content: 'Missing "key" parameter for "append" action.' };
                }
                if (args.item === undefined) {
                  return { status: 'error' as const, content: 'Missing "item" parameter for "append" action.' };
                }
                const appendSource = resolveSource(ctx);
                await sessionContext.append(scope, args.key, args.item, { source: appendSource });
                return { status: 'success' as const, content: `Item appended to "${args.key}".` };
              }

              case 'delete': {
                if (!args.key) {
                  return { status: 'error' as const, content: 'Missing "key" parameter for "delete" action.' };
                }
                await sessionContext.delete(scope, args.key);
                return { status: 'success' as const, content: `Context key "${args.key}" deleted.` };
              }

              default:
                return {
                  status: 'error' as const,
                  content: `Unknown action "${args.action}". Use "list", "get", "set", "append", or "delete".`,
                };
            }
          } catch (e: any) {
            return { status: 'error' as const, content: `Shared context error: ${e.message}` };
          }
        },
    });
  };
}
