/**
 * ConversationExtractor — Reads and formats user chat history from aiConversations + aiMessages.
 *
 * This service queries conversations belonging to a specific user since a given timestamp,
 * extracts the human/AI message pairs, and formats them into a compact text representation
 * suitable for LLM summarization.
 */

import type { Database } from '@nocobase/database';

export interface ExtractedConversation {
  sessionId: string;
  aiEmployeeName: string;
  title: string;
  createdAt: Date;
  messages: ExtractedMessage[];
}

export interface ExtractedMessage {
  role: string;
  content: string;
}

export interface ExtractionResult {
  conversations: ExtractedConversation[];
  totalMessages: number;
  lastSessionId: string | null;
}

export class ConversationExtractor {
  constructor(private db: Database) {}

  /**
   * Extract conversations for a user since a given timestamp.
   * Returns formatted conversations with their messages.
   */
  async extract(
    userId: number,
    sinceDate?: Date,
    maxConversations: number = 50,
  ): Promise<ExtractionResult> {
    const filter: Record<string, any> = { userId };

    if (sinceDate) {
      // Include conversations that were CREATED or UPDATED since last sync
      // This ensures we don't miss ongoing conversations that received new messages
      filter.$or = [
        { createdAt: { $gt: sinceDate } },
        { updatedAt: { $gt: sinceDate } },
      ];
    }

    const conversations = await this.db.getRepository('aiConversations').find({
      filter,
      sort: ['createdAt'],
      limit: maxConversations,
      appends: ['aiEmployee'],
    });

    if (!conversations.length) {
      return { conversations: [], totalMessages: 0, lastSessionId: null };
    }

    const extracted: ExtractedConversation[] = [];
    let totalMessages = 0;
    let lastSessionId: string | null = null;

    for (const conv of conversations) {
      const messages = await this.db.getRepository('aiConversations.messages', conv.sessionId).find({
        sort: ['messageId'],
        limit: 100, // Cap messages per conversation to prevent memory issues
        filter: {
          role: { $in: ['user', 'assistant'] }, // Only human and AI messages, skip tool calls
        },
      });

      if (!messages.length) continue;

      const extractedMessages: ExtractedMessage[] = messages
        .map((msg: any) => {
          const content = this.extractTextContent(msg.content);
          // Phase 4: Skip empty messages
          if (!content) return null;

          // Phase 4: For assistant messages, check if they appear to be primarily
          // KB/RAG sourced (metadata flag set by plugin-knowledge-base or plugin-ai).
          // We still include them but cap their length to limit KB content leakage
          // into the synthesis input. The synthesizer prompt also has strong rules
          // to not store KB-derived facts.
          if (msg.role !== 'user' && content.length > 500) {
            // Truncate long AI responses — these often contain KB-sourced paragraphs.
            // Keeping only the first ~300 chars preserves conversational context
            // (the question was about X) without including the full KB-sourced answer.
            return {
              role: msg.role,
              content: content.slice(0, 300) + '...[truncated]',
            };
          }

          return { role: msg.role, content };
        })
        .filter((m): m is ExtractedMessage => m !== null && m.content.length > 0);


      if (!extractedMessages.length) continue;

      extracted.push({
        sessionId: conv.sessionId,
        aiEmployeeName: conv.aiEmployee?.nickname || conv.aiEmployeeUsername || 'AI',
        title: conv.title || 'Untitled',
        createdAt: conv.createdAt,
        messages: extractedMessages,
      });

      totalMessages += extractedMessages.length;
      lastSessionId = conv.sessionId;
    }

    return { conversations: extracted, totalMessages, lastSessionId };
  }

  /**
   * Format extracted conversations into a compact text for LLM summarization.
   * Limits total text to maxChars to stay within token budget.
   */
  formatForSummarization(result: ExtractionResult, maxChars: number = 30000): string {
    if (!result.conversations.length) return '';

    const parts: string[] = [];
    let currentLength = 0;

    for (const conv of result.conversations) {
      const header = `\n--- Conversation: "${conv.title}" (with ${conv.aiEmployeeName}, ${conv.createdAt.toISOString().split('T')[0]}) ---\n`;
      if (currentLength + header.length > maxChars) break;
      parts.push(header);
      currentLength += header.length;

      for (const msg of conv.messages) {
        const line = `${msg.role === 'user' ? 'User' : 'AI'}: ${msg.content}\n`;
        if (currentLength + line.length > maxChars) break;
        parts.push(line);
        currentLength += line.length;
      }
    }

    return parts.join('');
  }

  /**
   * Extract plain text from the jsonb content field.
   * aiMessages.content can be: string | { content: string } | { content: { content: string } }
   */
  private extractTextContent(content: any): string {
    if (!content) return '';
    if (typeof content === 'string') return content.trim();
    if (typeof content === 'object') {
      if (typeof content.content === 'string') return content.content.trim();
      if (content.content && typeof content.content === 'object') {
        if (typeof content.content.content === 'string') return content.content.content.trim();
      }
      if (typeof content.text === 'string') return content.text.trim();
    }
    return '';
  }
}
