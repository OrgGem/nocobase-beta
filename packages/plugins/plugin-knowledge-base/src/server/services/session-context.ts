/**
 * Session Context Service
 *
 * Provides a key-value scratchpad for cross-agent collaboration within a single
 * workflow execution. Entries are ephemeral (default 24h TTL) and scoped by
 * rootRunId, sessionId, or pipelineJobId.
 *
 * This is the Tier 1 context layer. For persistent knowledge, use the
 * `promoteToKnowledgeBase()` method to vectorize and store in Tier 2 (KB).
 *
 * Thread-safety: All operations are atomic at the DB level (upsert by filter).
 * Multiple agents writing to the same scope concurrently is safe as long as they
 * use different keys. Same-key concurrent writes use last-write-wins semantics.
 */

import { Database } from '@nocobase/database';

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * Scope keys used to partition context entries.
 * At least one scope key should be provided.
 */
export interface ContextScope {
  rootRunId?: string;
  sessionId?: string;
  pipelineJobId?: number | string;
}

export interface SetOptions {
  source?: string;
  contentType?: 'text' | 'json' | 'file_ref' | 'summary';
  ttlSeconds?: number;
}

export interface KeyInfo {
  key: string;
  source: string;
  contentType: string;
  updatedAt: string;
}

// ── Constants ───────────────────────────────────────────────────────────────

const REPO_NAME = 'agentSessionContext';

/** Max value size to prevent unbounded storage (500 KB serialized). */
const MAX_VALUE_SIZE = 512_000;

/** Default TTL for session context entries (24 hours). */
const DEFAULT_TTL_SECONDS = 86_400;

// ── Service ─────────────────────────────────────────────────────────────────

export class SessionContextService {
  constructor(private readonly db: Database) {}

  // ─── Scope Validation (context isolation guard) ───

  /**
   * Ensure at least one scope key is provided to prevent cross-workflow data leaks.
   * Without this, an empty scope {} would match ALL entries in the table.
   */
  private validateScope(scope: ContextScope, operation: string): void {
    if (!scope.rootRunId && !scope.sessionId && !scope.pipelineJobId) {
      throw new Error(
        `[SessionContext] ${operation} requires at least one scope key (rootRunId, sessionId, or pipelineJobId). ` +
        'Empty scope would access ALL context entries — this is a context isolation violation.',
      );
    }
  }

  // ─── Write Operations ───

  /**
   * Set a context value. Upserts if key already exists in scope.
   */
  async set(scope: ContextScope, key: string, value: any, options?: SetOptions): Promise<void> {
    this.validateScope(scope, 'set');
    const repo = this.db.getRepository(REPO_NAME);
    if (!repo) return;

    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    if (serialized.length > MAX_VALUE_SIZE) {
      throw new Error(
        `Context value for key "${key}" exceeds ${MAX_VALUE_SIZE} bytes (got ${serialized.length}). ` +
          'Consider splitting into smaller entries or using promote_to_kb for large data.',
      );
    }

    const filter = this.buildFilter(scope, key);
    const existing = await repo.findOne({ filter });

    const values = {
      ...this.scopeFields(scope),
      key,
      value: serialized,
      contentType: options?.contentType || (typeof value === 'string' ? 'text' : 'json'),
      source: options?.source || 'system',
      ttlSeconds: options?.ttlSeconds ?? DEFAULT_TTL_SECONDS,
      updatedAt: new Date(),
    };

    if (existing) {
      await repo.update({ filterByTk: (existing as any).id, values });
    } else {
      await repo.create({ values: { ...values, createdAt: new Date() } });
    }
  }

  /**
   * Append an item to an array-valued context key.
   * Creates the key as `[item]` if it doesn't exist yet.
   */
  async append(scope: ContextScope, key: string, item: any, options?: SetOptions): Promise<void> {
    const existing = await this.get(scope, key);
    const arr = Array.isArray(existing) ? existing : existing != null ? [existing] : [];
    arr.push(item);
    await this.set(scope, key, arr, options);
  }

  // ─── Read Operations ───

  /**
   * Get a single context value by key. Returns `null` if not found or expired.
   */
  async get(scope: ContextScope, key: string): Promise<any> {
    this.validateScope(scope, 'get');
    const repo = this.db.getRepository(REPO_NAME);
    if (!repo) return null;

    const record = await repo.findOne({ filter: this.buildFilter(scope, key) });
    if (!record) return null;

    if (this.isExpired(record)) {
      await repo.destroy({ filterByTk: (record as any).id }).catch(() => {});
      return null;
    }

    return this.deserialize(record);
  }

  /**
   * Get all context entries for a scope. Returns a key→value map.
   * Expired entries are silently excluded and lazily cleaned up.
   */
  async getAll(scope: ContextScope): Promise<Record<string, any>> {
    this.validateScope(scope, 'getAll');
    const repo = this.db.getRepository(REPO_NAME);
    if (!repo) return {};

    const records = await repo.find({ filter: this.scopeFields(scope) });
    const result: Record<string, any> = {};
    const expiredIds: (string | number)[] = [];

    for (const r of records as any[]) {
      if (this.isExpired(r)) {
        expiredIds.push(r.id);
        continue;
      }
      result[r.key] = this.deserialize(r);
    }

    // Lazy cleanup of expired entries
    if (expiredIds.length > 0) {
      repo.destroy({ filter: { id: { $in: expiredIds } } }).catch(() => {});
    }

    return result;
  }

  /**
   * List context keys + metadata (without full values — lightweight).
   */
  async listKeys(scope: ContextScope): Promise<KeyInfo[]> {
    this.validateScope(scope, 'listKeys');
    const repo = this.db.getRepository(REPO_NAME);
    if (!repo) return [];

    const records = await repo.find({
      filter: this.scopeFields(scope),
      fields: ['key', 'source', 'contentType', 'updatedAt', 'ttlSeconds', 'createdAt'],
    });

    return (records as any[])
      .filter((r) => !this.isExpired(r))
      .map((r) => ({
        key: r.key,
        source: r.source || '',
        contentType: r.contentType || 'json',
        updatedAt: r.updatedAt?.toISOString?.() || '',
      }));
  }

  // ─── Delete Operations ───

  /**
   * Delete a specific key from a scope.
   */
  async delete(scope: ContextScope, key: string): Promise<void> {
    this.validateScope(scope, 'delete');
    const repo = this.db.getRepository(REPO_NAME);
    if (!repo) return;
    await repo.destroy({ filter: this.buildFilter(scope, key) });
  }

  /**
   * Delete all entries for a scope (e.g. when a run finishes).
   */
  async clearScope(scope: ContextScope): Promise<number> {
    this.validateScope(scope, 'clearScope');
    const repo = this.db.getRepository(REPO_NAME);
    if (!repo) return 0;
    return repo.destroy({ filter: this.scopeFields(scope) });
  }

  // ─── Summary (for injection into sub-agent system prompts) ───

  /**
   * Build a compact summary of all context entries suitable for
   * injection into a sub-agent's system prompt.
   *
   * @param maxChars Maximum total characters for the summary (default 8000).
   * @returns Markdown-formatted summary string, or empty string if no context.
   */
  async buildSummary(scope: ContextScope, maxChars = 8000): Promise<string> {
    this.validateScope(scope, 'buildSummary');
    const all = await this.getAll(scope);
    const entries = Object.entries(all);
    if (entries.length === 0) return '';

    const lines: string[] = [];
    let totalLen = 0;

    for (const [key, value] of entries) {
      const preview =
        typeof value === 'string'
          ? value.slice(0, 1000)
          : JSON.stringify(value).slice(0, 1000);
      const line = `- **${key}**: ${preview}`;

      if (totalLen + line.length > maxChars) {
        lines.push(`- ...(${entries.length - lines.length} more keys truncated)`);
        break;
      }

      lines.push(line);
      totalLen += line.length;
    }

    return lines.join('\n');
  }

  // ─── Promotion (Tier 1 → Tier 2) ───

  /**
   * Promote a session context entry to a permanent Knowledge Base document.
   * The value is saved as text content, then vectorized via the KB pipeline.
   *
   * @param scope          Context scope to read from
   * @param key            Key to promote
   * @param knowledgeBaseId Target KB ID
   * @param filename       Optional document name in KB
   * @returns documentId if successful, null otherwise
   */
  async promoteToKnowledgeBase(
    scope: ContextScope,
    key: string,
    knowledgeBaseId: string,
    filename?: string,
  ): Promise<string | null> {
    this.validateScope(scope, 'promoteToKnowledgeBase');
    const value = await this.get(scope, key);
    if (value == null) return null;

    const textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);

    const docRepo = this.db.getRepository('aiKnowledgeBaseDocuments');
    if (!docRepo) return null;

    const doc = await docRepo.create({
      values: {
        knowledgeBaseId,
        textContent,
        filename: filename || `session-context-${key}`,
        status: 'pending',
      },
    });

    return (doc as any)?.id || null;
  }

  // ─── Pruning (called by cron job) ───

  /**
   * Delete all expired entries across all scopes.
   * Called periodically by the plugin's cron job.
   */
  async pruneExpired(): Promise<number> {
    const repo = this.db.getRepository(REPO_NAME);
    if (!repo) return 0;

    // Find entries where updatedAt + ttlSeconds < now
    // SQL: WHERE "ttlSeconds" IS NOT NULL AND "updatedAt" + INTERVAL 'ttlSeconds seconds' < NOW()
    // Since NocoBase ORM doesn't support interval arithmetic directly, we paginate and check in JS.
    const PAGE_SIZE = 200;
    let totalDeleted = 0;
    let offset = 0;

    while (true) {
      const records = await repo.find({
        filter: {
          ttlSeconds: { $ne: null },
        },
        fields: ['id', 'updatedAt', 'createdAt', 'ttlSeconds'],
        limit: PAGE_SIZE,
        offset,
        sort: ['id'],
      });

      if ((records as any[]).length === 0) break;

      const idsToDelete: (string | number)[] = [];
      for (const r of records as any[]) {
        if (this.isExpired(r)) {
          idsToDelete.push(r.id);
        }
      }

      if (idsToDelete.length > 0) {
        await repo.destroy({ filter: { id: { $in: idsToDelete } } });
        totalDeleted += idsToDelete.length;
      }

      if ((records as any[]).length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }

    return totalDeleted;
  }

  // ─── Internals ───

  private scopeFields(scope: ContextScope): Record<string, any> {
    const fields: Record<string, any> = {};
    if (scope.rootRunId) fields.rootRunId = scope.rootRunId;
    if (scope.sessionId) fields.sessionId = scope.sessionId;
    if (scope.pipelineJobId) fields.pipelineJobId = scope.pipelineJobId;
    return fields;
  }

  private buildFilter(scope: ContextScope, key: string): Record<string, any> {
    return { ...this.scopeFields(scope), key };
  }

  private isExpired(record: any): boolean {
    if (!record.ttlSeconds) return false;
    const updatedAt = record.updatedAt
      ? new Date(record.updatedAt).getTime()
      : record.createdAt
        ? new Date(record.createdAt).getTime()
        : 0;
    if (!updatedAt) return false;
    return (Date.now() - updatedAt) / 1000 > record.ttlSeconds;
  }

  private deserialize(record: any): any {
    const raw = record.value;
    if (raw == null) return null;
    if (record.contentType === 'text') return raw;
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
}
