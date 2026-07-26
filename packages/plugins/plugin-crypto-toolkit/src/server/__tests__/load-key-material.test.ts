import { Readable } from 'stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateRawKeyPair } from '../services/crypto-core';
import { loadKeyMaterial, loadRawMaterial } from '../services/load-key-material';

const LOAD_OPTIONS = { attachmentOwnerId: 1 };

type AppMock = {
  environment: { getVariable: (name: string) => unknown };
  pm: { get: (name: string) => unknown };
  db: { getRepository: (name: string) => unknown };
};

function buildAppMock(opts: {
  envVars?: Record<string, string | undefined>;
  attachment?: { id: number | string; buffer: Buffer };
}): AppMock {
  const envVars = opts.envVars ?? {};
  const attachment = opts.attachment;
  return {
    environment: {
      getVariable: (name: string) => (name in envVars ? envVars[name] : undefined),
    },
    pm: {
      get: (name: string) => {
        if (name !== 'file-manager') return undefined;
        return {
          storagesCache: new Map([['default', {}]]),
          getFileStream: async () => ({
            stream: Readable.from([attachment?.buffer ?? Buffer.alloc(0)]) as unknown as AsyncIterable<
              Buffer | Uint8Array
            >,
          }),
          createFileRecord: async () => ({}),
        };
      },
    },
    db: {
      getRepository: (name: string) => {
        if (name !== 'attachments') return undefined;
        return {
          findOne: async ({ filter }: { filter: { id: number | string; createdById: number } }) =>
            attachment && filter.id === attachment.id && filter.createdById === 1
              ? { storageId: null, createdById: 1, ...attachment }
              : null,
        };
      },
    },
  };
}

describe('loadKeyMaterial — text input', () => {
  it('loads PEM text and detects a public key', async () => {
    const pem = generateRawKeyPair('ed25519').publicPem;
    const app = buildAppMock({}) as never;
    const loaded = await loadKeyMaterial(app, { mode: 'text', text: pem }, LOAD_OPTIONS);
    expect(loaded.source).toBe('text');
    expect(loaded.buffer.equals(Buffer.from(pem, 'utf8'))).toBe(true);
    expect(loaded.detected.format).toBe('pem');
    expect(loaded.detected.kind).toBe('public-key');
    expect(loaded.detected.algorithm).toBe('ed25519');
  });

  it('rejects empty text input', async () => {
    const app = buildAppMock({}) as never;
    await expect(loadKeyMaterial(app, { mode: 'text', text: '' }, LOAD_OPTIONS)).rejects.toThrow(/Exactly one/);
  });

  it('propagates detection errors for garbage text', async () => {
    const app = buildAppMock({}) as never;
    await expect(loadKeyMaterial(app, { mode: 'text', text: 'not a key' }, LOAD_OPTIONS)).rejects.toThrow(
      /Unrecognized key material/,
    );
  });
});

describe('loadKeyMaterial — attachment input', () => {
  it('reads an attachment buffer and runs detection', async () => {
    const pem = generateRawKeyPair('rsa-4096').publicPem;
    const app = buildAppMock({
      attachment: { id: 42, buffer: Buffer.from(pem, 'utf8') },
    }) as never;
    const loaded = await loadKeyMaterial(app, { mode: 'attachment', attachmentId: 42 }, LOAD_OPTIONS);
    expect(loaded.source).toBe('attachment');
    expect(loaded.buffer.equals(Buffer.from(pem, 'utf8'))).toBe(true);
    expect(loaded.detected.kind).toBe('public-key');
  });

  it('rejects missing attachmentId', async () => {
    const app = buildAppMock({}) as never;
    await expect(loadKeyMaterial(app, { mode: 'attachment', attachmentId: '' } as never, LOAD_OPTIONS)).rejects.toThrow(
      /Exactly one/,
    );
  });

  it('errors when plugin-file-manager is not loaded', async () => {
    const app: AppMock = {
      environment: { getVariable: () => undefined },
      pm: { get: () => undefined },
      db: { getRepository: () => undefined },
    };
    await expect(loadKeyMaterial(app as never, { mode: 'attachment', attachmentId: 1 }, LOAD_OPTIONS)).rejects.toThrow(
      /plugin-file-manager/,
    );
  });
});

describe('loadKeyMaterial — env input', () => {
  it('resolves an env variable and runs detection', async () => {
    const pem = generateRawKeyPair('ed25519').publicPem;
    const app = buildAppMock({ envVars: { CRYPTO_TEST_KEY: pem } }) as never;
    const loaded = await loadKeyMaterial(app, { mode: 'env', envVar: 'CRYPTO_TEST_KEY' }, LOAD_OPTIONS);
    expect(loaded.source).toBe('env');
    expect(loaded.buffer.equals(Buffer.from(pem, 'utf8'))).toBe(true);
    expect(loaded.detected.format).toBe('pem');
  });

  it('rejects an unknown env variable name', async () => {
    const app = buildAppMock({ envVars: {} }) as never;
    await expect(loadKeyMaterial(app, { mode: 'env', envVar: 'NOPE' }, LOAD_OPTIONS)).rejects.toThrow(/not set/);
  });
});

describe('loadKeyMaterial — input shape validation', () => {
  it('rejects payloads with no source set', async () => {
    const app = buildAppMock({}) as never;
    await expect(loadKeyMaterial(app, {} as never, LOAD_OPTIONS)).rejects.toThrow(/Exactly one/);
  });

  it('rejects payloads with multiple sources set', async () => {
    const app = buildAppMock({}) as never;
    await expect(
      loadKeyMaterial(
        app,
        {
          mode: 'text',
          text: 'foo',
          attachmentId: 1,
        } as never,
        LOAD_OPTIONS,
      ),
    ).rejects.toThrow(/Exactly one/);
  });
});

describe('loadKeyMaterial — back-compat aliases', () => {
  // The text mode is mode-tagged so callers can pass either {mode,text} or plain {text}.
  // This is a guard rail for future refactors — keep the public surface small.
  it('falls into the env branch when mode is missing and envVar is undefined', async () => {
    const app = buildAppMock({ envVars: {} }) as never;
    await expect(loadKeyMaterial(app, { text: 'foo' } as never, LOAD_OPTIONS)).rejects.toThrow(/input mode/);
  });
});

describe('loadRawMaterial', () => {
  it('accepts arbitrary file content without attempting key-format detection', async () => {
    const app = buildAppMock({}) as never;
    const loaded = await loadRawMaterial(app, { mode: 'text', text: 'invoice,pdf,not,a,key' }, LOAD_OPTIONS);
    expect(loaded.buffer.toString('utf8')).toBe('invoice,pdf,not,a,key');
    expect(loaded.source).toBe('text');
  });

  it('rejects an attachment that does not belong to the requesting user', async () => {
    const app = buildAppMock({ attachment: { id: 42, buffer: Buffer.from('owned content') } }) as never;
    await expect(
      loadRawMaterial(app, { mode: 'attachment', attachmentId: 42 }, { attachmentOwnerId: 2 }),
    ).rejects.toThrow(/not found or is not owned/);
  });

  it('stops reading an attachment when it exceeds the configured maximum size', async () => {
    const app = buildAppMock({ attachment: { id: 42, buffer: Buffer.alloc(8) } }) as never;
    await expect(
      loadRawMaterial(app, { mode: 'attachment', attachmentId: 42 }, { attachmentOwnerId: 1, maxBytes: 4 }),
    ).rejects.toThrow(/exceeds the maximum allowed size/);
  });
});
