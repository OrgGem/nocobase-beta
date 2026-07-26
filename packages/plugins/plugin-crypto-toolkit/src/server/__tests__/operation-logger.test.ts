import { describe, expect, it, vi } from 'vitest';
import { logOperation } from '../services/operation-logger';

describe('operation-logger', () => {
  it('writes the success row, never throws, and tolerates missing fields', async () => {
    const created: unknown[] = [];
    const app = {
      db: {
        getRepository: (_name: string) => ({
          create: async ({ values }: { values: Record<string, unknown> }) => {
            created.push(values);
            return { id: 1, ...values };
          },
        }),
      },
    };
    await logOperation(app as never, {
      action: 'decrypt',
      algorithm: 'pgp',
      keyId: 7,
      inputBytes: 1024,
      outputBytes: 800,
      userId: 23,
    });
    expect(created).toHaveLength(1);
    const row = created[0] as Record<string, unknown>;
    expect(row.action).toBe('decrypt');
    expect(row.status).toBe('success');
    expect(row.keyId).toBe('7');
    expect(row.inputBytes).toBe('1024');
    expect(row.outputBytes).toBe('800');
    expect(row.userId).toBe('23');
  });

  it('logs the error row with status=error and errorMessage when requested', async () => {
    const created: unknown[] = [];
    const app = {
      db: {
        getRepository: (_name: string) => ({
          create: async ({ values }: { values: Record<string, unknown> }) => {
            created.push(values);
            return { id: 1, ...values };
          },
        }),
      },
    };
    await logOperation(app as never, {
      action: 'sign',
      status: 'error',
      algorithm: 'ed25519',
      durationMs: 23,
      errorMessage: 'flaky disk',
    });
    expect(created).toHaveLength(1);
    const row = created[0] as Record<string, unknown>;
    expect(row.status).toBe('error');
    expect(row.errorMessage).toBe('flaky disk');
    expect(row.durationMs).toBe(23);
  });

  it('swallows repository errors so the caller is unaffected', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failingApp = {
      db: {
        getRepository: (_name: string) => ({
          create: async () => {
            throw new Error('db is down');
          },
        }),
      },
    };
    await expect(logOperation(failingApp as never, { action: 'checksum' })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('also accepts a repository directly (no app wrapper)', async () => {
    const created: unknown[] = [];
    const repo = {
      collection: { name: 'cryptoOperations' },
      create: async ({ values }: { values: Record<string, unknown> }) => {
        created.push(values);
        return { id: 1, ...values };
      },
    };
    await logOperation(repo as never, { action: 'inspect' });
    expect(created).toHaveLength(1);
    expect((created[0] as Record<string, unknown>).action).toBe('inspect');
  });
});
