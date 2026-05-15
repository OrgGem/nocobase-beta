/**
 * Shared Session Context for cross-agent collaboration.
 *
 * This collection stores ephemeral key-value entries scoped by orchestration run,
 * AI chat session, or document-understanding pipeline job. It acts as a scratchpad
 * that agents read/write during a single workflow execution.
 *
 * Tier 1 (ephemeral) — entries auto-expire after `ttlSeconds` (default 24 hours).
 * For persistent knowledge, agents can promote entries to a Knowledge Base (Tier 2)
 * via the `promote_to_kb` tool.
 *
 * Scope keys (at least one must be provided):
 * - rootRunId:    Orchestrator delegation chain ID (groups all agents in one run)
 * - sessionId:    AI chat conversation ID (user-facing session)
 * - pipelineJobId: Document Understanding pipeline job ID
 */

import { defineCollection } from '@nocobase/database';

export default defineCollection({
  name: 'agentSessionContext',
  title: 'Agent Session Context',
  fields: [
    {
      name: 'id',
      type: 'bigInt',
      autoIncrement: true,
      primaryKey: true,
    },
    // ── Scope keys ──────────────────────────────────────────────────────────
    {
      name: 'rootRunId',
      type: 'string',
      length: 100,
    },
    {
      name: 'sessionId',
      type: 'string',
      length: 100,
    },
    {
      name: 'pipelineJobId',
      type: 'bigInt',
    },
    // ── Content ─────────────────────────────────────────────────────────────
    {
      name: 'key',
      type: 'string',
      length: 200,
      allowNull: false,
    },
    {
      name: 'value',
      type: 'text',
      comment: 'JSON-serialized value',
    },
    {
      name: 'contentType',
      type: 'string',
      length: 50,
      defaultValue: 'json',
      comment: '"text" | "json" | "file_ref" | "summary"',
    },
    {
      name: 'source',
      type: 'string',
      length: 200,
      comment: 'Who wrote this entry (agent username, pipeline step name, etc.)',
    },
    {
      name: 'ttlSeconds',
      type: 'integer',
      defaultValue: 86400,
      comment: 'Auto-expire after N seconds. Default: 24 hours. null = never expire.',
    },
    // ── Timestamps ──────────────────────────────────────────────────────────
    {
      name: 'createdAt',
      type: 'date',
    },
    {
      name: 'updatedAt',
      type: 'date',
    },
  ],
  indexes: [
    { fields: ['rootRunId', 'key'] },
    { fields: ['sessionId', 'key'] },
    { fields: ['pipelineJobId'] },
    { fields: ['updatedAt'] },
  ],
});
