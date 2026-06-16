/**
 * Promote-to-KB AI Tool
 *
 * Allows agents to promote ephemeral session context entries (Tier 1)
 * to permanent Knowledge Base documents (Tier 2).
 *
 * The promoted entry is saved as a text document in the target KB
 * and queued for vectorization, making it searchable via RAG in future sessions.
 *
 * Registered by plugin-knowledge-base as a dynamic tool via toolsManager.
 */

import { z } from 'zod';
import type { SessionContextService, ContextScope } from '../services/session-context';
import { canManageKnowledgeBase, resolveAccessContext } from '../utils/access';
import { enqueueKnowledgeBaseDocument } from '../queue/document-vectorization';
import { resolveScope, resolveUserId } from '../utils/scope-resolver';

export function createPromoteToKbToolProvider(sessionContext: SessionContextService, db: any, pluginRef: any) {
  return async (register: { registerTools: (tools: any) => void }) => {
    register.registerTools({
      scope: 'CUSTOM' as const,
      execution: 'backend' as const,
      defaultPermission: 'ALLOW' as const,

      introduction: {
        title: 'Promote to Knowledge Base',
        about:
          'Save important session context to a permanent Knowledge Base for long-term retrieval. ' +
          'Use this when you find data valuable enough to remember across future conversations.',
      },

      definition: {
        name: 'promote_to_kb',
        description: `Promote a session context entry to a permanent Knowledge Base document.

Use this when you have important findings that should be remembered across future conversations:
- Analysis results, extracted data, summaries
- Decisions, rules, or patterns discovered during the workflow

The promoted entry will be vectorized and become searchable via RAG.

Args:
- key: The session context key to promote (use shared_context.list to see available keys)
- knowledgeBaseId: Target Knowledge Base ID to save into
- filename: (optional) Name for the document in the KB
- text: (optional) If provided, promote this text directly instead of a session context key`,
        schema: z.object({
          key: z
            .string()
            .optional()
            .describe('Session context key to promote. Use shared_context.list to discover keys.'),
          knowledgeBaseId: z.string().describe('Target Knowledge Base ID. Ask the user or check available KBs.'),
          filename: z.string().optional().describe('Document name in the KB. Defaults to "session-context-<key>".'),
          text: z.string().optional().describe('Direct text to save. If provided, "key" is ignored.'),
        }),
      },

      invoke: async (ctx: any, args: { key?: string; knowledgeBaseId: string; filename?: string; text?: string }) => {
        try {
          // Validate KB exists
          const kbRepo = db.getRepository('aiKnowledgeBases');
          if (!kbRepo) {
            return { status: 'error' as const, content: 'Knowledge Base repository not available.' };
          }
          const kb = await kbRepo.findOne({ filter: { id: args.knowledgeBaseId } });
          if (!kb) {
            return {
              status: 'error' as const,
              content: `Knowledge Base "${args.knowledgeBaseId}" not found. Please check the ID.`,
            };
          }
          const kbData = kb.toJSON ? kb.toJSON() : kb;
          const permissionError = await checkUploadPermission(ctx, db, kbData);
          if (permissionError) {
            return { status: 'error' as const, content: permissionError };
          }

          let textContent: string;
          let docFilename: string;

          if (args.text) {
            // Direct text promotion
            textContent = args.text;
            docFilename = args.filename || 'agent-promoted-text';
          } else if (args.key) {
            // Promote from session context
            const scope = resolveScope(ctx);
            if (!scope.rootRunId && !scope.sessionId) {
              return {
                status: 'error' as const,
                content: 'Cannot determine context scope. Use "text" parameter for direct promotion.',
              };
            }

            const value = await sessionContext.get(scope, args.key);
            if (value === null) {
              return {
                status: 'error' as const,
                content: `Session context key "${args.key}" not found. Use shared_context.list to see available keys.`,
              };
            }

            textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
            docFilename = args.filename || `session-context-${args.key}`;
          } else {
            return {
              status: 'error' as const,
              content: 'Either "key" (session context key) or "text" (direct content) is required.',
            };
          }

          // Create document in KB
          const docRepo = db.getRepository('aiKnowledgeBaseDocuments');
          if (!docRepo) {
            return { status: 'error' as const, content: 'KB Documents repository not available.' };
          }

          const doc = await docRepo.create({
            values: {
              knowledgeBaseId: args.knowledgeBaseId,
              textContent,
              filename: docFilename,
              status: 'pending',
              uploadedById: resolveUserId(ctx),
            },
          });

          const docId = (doc as any)?.get?.('id') ?? (doc as any)?.id;
          await docRepo.update({
            filterByTk: docId,
            values: { knowledgeBaseId: args.knowledgeBaseId },
          });

          await enqueueKnowledgeBaseDocument(pluginRef, {
            documentId: String(docId),
            reason: 'promote-to-kb',
            requestedById: resolveUserId(ctx),
          });

          return {
            status: 'success' as const,
            content:
              `Promoted to Knowledge Base "${kb.get?.('name') || args.knowledgeBaseId}". ` +
              `Document "${docFilename}" (ID: ${docId}) created and queued for vectorization. ` +
              'It will be searchable via RAG once processing completes.',
          };
        } catch (e: any) {
          return { status: 'error' as const, content: `Promotion failed: ${e.message}` };
        }
      },
    });
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function checkUploadPermission(ctx: any, db: any, kbData: any): Promise<string | null> {
  if (kbData.type === 'EXTERNAL_RAG') {
    return 'Cannot promote documents to an external RAG knowledge base.';
  }

  const access = await resolveAccessContext(ctx, db);
  if (canManageKnowledgeBase(access, kbData)) {
    return null;
  }

  return 'You do not have permission to promote documents to this KB.';
}
