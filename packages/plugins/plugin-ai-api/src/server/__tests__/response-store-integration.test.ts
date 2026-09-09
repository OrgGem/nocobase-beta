/**
 * Database integration tests for the aiApiResponseRecords collection and response store.
 *
 * Uses createMockDatabase (SQLite in-memory) to validate:
 * - Collection schema creation with correct field types
 * - CRUD operations on response records
 * - Owner-scoped retrieval and deletion
 * - Expiry enforcement
 * - Batch cleanup of expired records
 * - Chain loading with previous_response_id
 */

import type { Context } from '@nocobase/actions';
import { createMockDatabase, type Database } from '@nocobase/database';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import responseRecordsCollection from '../collections/ai-api-response-records';
import SeedSampleResponseRecords from '../migrations/20260903000000-seed-sample-response-records';
import {
  cleanupExpiredResponseRecords,
  deleteResponseRecord,
  getResponseRecord,
  loadConversationChain,
  RESPONSE_RETENTION_MS,
  storeResponseRecord,
} from '../utils/response-store';

describe('aiApiResponseRecords database integration', () => {
  let db: Database;

  beforeEach(async () => {
    db = await createMockDatabase();
    // Register the actual collection definition so schema drift between the plugin and this
    // test fails here instead of silently passing against a hand-duplicated schema.
    db.collection(responseRecordsCollection);
    await db.sync({ force: true });
  });

  afterEach(async () => {
    // Truncate to avoid unique constraint collisions across tests (shared SQLite file).
    try {
      await db.getRepository('aiApiResponseRecords').destroy({ filter: {} });
    } catch {
      // Table may not exist in some edge cases.
    }
    await db.close();
  });

  function makeCtx(): Pick<Context, 'db'> {
    return { db } as Pick<Context, 'db'>;
  }

  function makeResponse(id: string, model = 'test-service/gpt-4o') {
    return {
      id,
      object: 'response' as const,
      created_at: Math.floor(Date.now() / 1000),
      completed_at: Math.floor(Date.now() / 1000),
      status: 'completed' as const,
      error: null,
      incomplete_details: null,
      instructions: null,
      model,
      output: [],
      output_text: `Response ${id}`,
      parallel_tool_calls: true,
      service_tier: 'default' as const,
      temperature: null,
      tool_choice: 'auto',
      tools: [],
      top_p: null,
      truncation: 'disabled' as const,
      usage: {
        input_tokens: 10,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 5,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 15,
      },
      metadata: null,
    };
  }

  it('stores and retrieves a response record by responseId + userId', async () => {
    const ctx = makeCtx();
    const response = makeResponse('resp_store_1');

    await storeResponseRecord(ctx, response, { input: 'Hello', store: true }, 42);

    const record = await getResponseRecord(ctx, 'resp_store_1', 42);
    expect(record).toMatchObject({
      responseId: 'resp_store_1',
      userId: 42,
      model: 'test-service/gpt-4o',
    });
    expect((record?.output as Record<string, unknown> | undefined)?.id).toBe('resp_store_1');
  });

  it('does not store when store=false', async () => {
    const ctx = makeCtx();
    const response = makeResponse('resp_no_store');

    await storeResponseRecord(ctx, response, { input: 'Hello', store: false }, 42);

    const record = await getResponseRecord(ctx, 'resp_no_store', 42);
    expect(record).toBeNull();
  });

  it('scopes retrieval by userId — cross-user access returns null', async () => {
    const ctx = makeCtx();
    const response = makeResponse('resp_private');

    await storeResponseRecord(ctx, response, { input: 'Secret', store: true }, 42);

    // Same user can retrieve
    expect(await getResponseRecord(ctx, 'resp_private', 42)).not.toBeNull();
    // Different user cannot
    expect(await getResponseRecord(ctx, 'resp_private', 99)).toBeNull();
  });

  it('treats expired records as missing', async () => {
    const ctx = makeCtx();
    const response = makeResponse('resp_expired');

    // Manually insert with past expiry
    await db.getRepository('aiApiResponseRecords').create({
      values: {
        responseId: 'resp_expired',
        userId: 42,
        model: 'test-service/gpt-4o',
        input: 'Old',
        output: response,
        expiresAt: new Date(Date.now() - 1000),
      },
    });

    const record = await getResponseRecord(ctx, 'resp_expired', 42);
    expect(record).toBeNull();
  });

  it('deletes only an owner-scoped record', async () => {
    const ctx = makeCtx();
    const response = makeResponse('resp_delete');

    await storeResponseRecord(ctx, response, { input: 'Delete me', store: true }, 42);

    // Wrong user cannot delete
    const deletedWrong = await deleteResponseRecord(ctx, 'resp_delete', 99);
    expect(deletedWrong).toBe(false);

    // Correct user can delete
    const deletedRight = await deleteResponseRecord(ctx, 'resp_delete', 42);
    expect(deletedRight).toBe(true);

    // After deletion, retrieval returns null
    expect(await getResponseRecord(ctx, 'resp_delete', 42)).toBeNull();
  });

  it('cleans up expired records in batches', async () => {
    const ctx = makeCtx();

    // Insert 3 expired and 2 unexpired records
    for (let i = 0; i < 3; i++) {
      await db.getRepository('aiApiResponseRecords').create({
        values: {
          responseId: `resp_cleanup_${i}`,
          userId: 42,
          model: 'test-service/gpt-4o',
          input: 'Expired',
          output: makeResponse(`resp_cleanup_${i}`),
          expiresAt: new Date(Date.now() - 1000),
        },
      });
    }
    for (let i = 0; i < 2; i++) {
      await db.getRepository('aiApiResponseRecords').create({
        values: {
          responseId: `resp_keep_${i}`,
          userId: 42,
          model: 'test-service/gpt-4o',
          input: 'Keep',
          output: makeResponse(`resp_keep_${i}`),
          expiresAt: new Date(Date.now() + RESPONSE_RETENTION_MS),
        },
      });
    }

    const deleted = await cleanupExpiredResponseRecords(ctx);
    expect(deleted).toBeGreaterThanOrEqual(3);

    // Unexpired records remain
    expect(await getResponseRecord(ctx, 'resp_keep_0', 42)).not.toBeNull();
    expect(await getResponseRecord(ctx, 'resp_keep_1', 42)).not.toBeNull();
  });

  it('loads a conversation chain via previousResponseId', async () => {
    const ctx = makeCtx();

    // Create a chain: resp_chain_1 → resp_chain_2 → resp_chain_3
    const r1 = makeResponse('resp_chain_1');
    const r2 = { ...makeResponse('resp_chain_2'), previous_response_id: 'resp_chain_1' };
    const r3 = { ...makeResponse('resp_chain_3'), previous_response_id: 'resp_chain_2' };

    await storeResponseRecord(ctx, r1, { input: 'First question', store: true }, 42);
    await storeResponseRecord(ctx, r2, { input: 'Follow up', store: true, previous_response_id: 'resp_chain_1' }, 42);
    await storeResponseRecord(ctx, r3, { input: 'And then?', store: true, previous_response_id: 'resp_chain_2' }, 42);

    const messages = await loadConversationChain(ctx, 'resp_chain_2', 42);
    expect(messages).not.toBeNull();
    // Should contain: first question input + first response output + follow up input + follow up output
    // String input produces 1 user message per record; chain of 2 records = 2 messages minimum
    expect(messages?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('returns null for a broken chain (missing link)', async () => {
    const ctx = makeCtx();

    // Only store the second response pointing to a non-existent first
    const r2 = { ...makeResponse('resp_broken'), previous_response_id: 'resp_missing' };
    await storeResponseRecord(ctx, r2, { input: 'Orphan', store: true, previous_response_id: 'resp_missing' }, 42);

    const messages = await loadConversationChain(ctx, 'resp_broken', 42);
    expect(messages).toBeNull();
  });

  it('returns null for a cyclic chain', async () => {
    const ctx = makeCtx();

    // Create a cycle: A → B → A
    const rA = { ...makeResponse('resp_cycle_a'), previous_response_id: 'resp_cycle_b' };
    const rB = { ...makeResponse('resp_cycle_b'), previous_response_id: 'resp_cycle_a' };

    await storeResponseRecord(ctx, rA, { input: 'A', store: true, previous_response_id: 'resp_cycle_b' }, 42);
    await storeResponseRecord(ctx, rB, { input: 'B', store: true, previous_response_id: 'resp_cycle_a' }, 42);

    const messages = await loadConversationChain(ctx, 'resp_cycle_a', 42);
    expect(messages).toBeNull();
  });

  it('handles BIGINT userId correctly', async () => {
    const ctx = makeCtx();
    const bigUserId = BigInt('9007199254740991'); // Within safe integer range for SQLite compatibility
    const response = makeResponse('resp_bigint');

    await storeResponseRecord(ctx, response, { input: 'BigInt test', store: true }, bigUserId);

    const record = await getResponseRecord(ctx, 'resp_bigint', bigUserId);
    expect(record?.userId.toString()).toBe(bigUserId.toString());
  });

  it('preserves metadata through store and retrieve', async () => {
    const ctx = makeCtx();
    const response = { ...makeResponse('resp_meta'), metadata: { env: 'test', version: '1.0' } };

    await storeResponseRecord(
      ctx,
      response,
      { input: 'Meta test', store: true, metadata: { env: 'test', version: '1.0' } },
      42,
    );

    const record = await getResponseRecord(ctx, 'resp_meta', 42);
    expect(record).not.toBeNull();
    expect(record?.metadata).toEqual({ env: 'test', version: '1.0' });
  });

  it('uses the runtime data category so records are excluded from backups', () => {
    const collection = db.getCollection('aiApiResponseRecords');
    expect(collection.options.dataCategory).toBe('runtime');
  });

  describe('seed sample response records migration', () => {
    function makeMigration() {
      const rootUser = { get: (key: string) => (key === 'id' ? 42 : undefined) };
      const usersRepo = { findOne: async () => rootUser };
      const app = { logger: { info: vi.fn(), warn: vi.fn() } };
      db.getRepository = ((original) =>
        vi.fn((name: string) => (name === 'users' ? usersRepo : original.call(db, name))))(
        db.getRepository.bind(db),
      ) as Database['getRepository'];
      const MigrationClass = SeedSampleResponseRecords as unknown as new (context: { db: Database; app: unknown }) => {
        up: () => Promise<void>;
        down: () => Promise<void>;
      };
      return { migration: new MigrationClass({ db, app }), app };
    }

    it('seeds both samples, is idempotent, and recovers partial execution', async () => {
      const { migration } = makeMigration();

      await migration.up();
      const repo = db.getRepository('aiApiResponseRecords');
      const countWelcome = await repo.count({ filter: { responseId: 'resp_sample_welcome' } });
      const countFollowup = await repo.count({ filter: { responseId: 'resp_sample_followup' } });
      if (countWelcome !== 1 || countFollowup !== 1) {
        throw new Error(`after up: welcome=${countWelcome} followup=${countFollowup}`);
      }

      // Rerun: no duplicates.
      await migration.up();
      expect(await repo.count({ filter: { responseId: 'resp_sample_welcome' } })).toBe(1);
      expect(await repo.count({ filter: { responseId: 'resp_sample_followup' } })).toBe(1);

      // Partial execution: first sample exists, second was lost — rerun must create the missing one.
      await repo.destroy({ filter: { responseId: 'resp_sample_followup' } });
      await migration.up();
      expect(await repo.count({ filter: { responseId: 'resp_sample_followup' } })).toBe(1);
    });

    it('down() removes exactly the two sample records', async () => {
      const { migration } = makeMigration();

      await migration.up();
      await storeResponseRecord(makeCtx(), makeResponse('resp_user_owned'), { input: 'Keep me', store: true }, 42);

      await migration.down();

      const repo = db.getRepository('aiApiResponseRecords');
      expect(await repo.count({ filter: { responseId: 'resp_sample_welcome' } })).toBe(0);
      expect(await repo.count({ filter: { responseId: 'resp_sample_followup' } })).toBe(0);
      // Unrelated records are untouched.
      expect(await repo.count({ filter: { responseId: 'resp_user_owned' } })).toBe(1);
    });

    it('skips seeding when no root user exists', async () => {
      const originalGetRepository = db.getRepository.bind(db);
      db.getRepository = vi.fn((name: string) => {
        if (name === 'users') return { findOne: async () => null };
        return originalGetRepository(name);
      }) as Database['getRepository'];
      const app = { logger: { info: vi.fn(), warn: vi.fn() } };
      const MigrationClass = SeedSampleResponseRecords as unknown as new (context: { db: Database; app: unknown }) => {
        up: () => Promise<void>;
      };
      const migration = new MigrationClass({ db, app });

      await migration.up();

      expect(await originalGetRepository('aiApiResponseRecords').count()).toBe(0);
    });
  });
});
