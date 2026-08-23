import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'stream';
import { SftpAdapter } from '../adapters/sftp-adapter';

function createAdapter(overrides = {}) {
  const calls = [];
  const manager = {
    listFiles: vi.fn(),
    stat: vi.fn().mockResolvedValue({ size: overrides.statSize ?? 1000, isFile: true, isDirectory: false, modifyTime: 0 }),
    exists: vi.fn(),
    getFileStream: vi.fn().mockImplementation((_configId, _path, range) => {
      calls.push({ path: _path, range });
      return Promise.resolve(Readable.from(['x', 'y']));
    }),
    putFileStream: vi.fn(),
    mkdir: vi.fn(),
    deleteFile: vi.fn(),
    deleteDir: vi.fn(),
    rename: vi.fn(),
  };
  const adapter = new SftpAdapter(manager, 'config-id', '/base');
  return { adapter, manager, calls };
}

describe('SftpAdapter.getStream range handling', () => {
  it('serves a closed range with correct size and contentRange', async () => {
    const { adapter, calls } = createAdapter();
    const result = await adapter.getStream('/file.mp4', { start: 100, end: 199 });
    expect(result.size).toBe(100);
    expect(result.contentRange).toBe('bytes 100-199/1000');
    expect(calls[0].range).toEqual({ start: 100, end: 199 });
  });

  it('clamps an open-ended range to the total size', async () => {
    const { adapter, calls } = createAdapter();
    const result = await adapter.getStream('/file.mp4', { start: 900 });
    expect(result.contentRange).toBe('bytes 900-999/1000');
    expect(result.size).toBe(100);
    expect(calls[0].range).toEqual({ start: 900, end: 999 });
  });

  it('throws 416 for unsatisfiable ranges', async () => {
    const { adapter } = createAdapter({ statSize: 0 });
    await expect(adapter.getStream('/empty', { start: 0, end: 10 })).rejects.toMatchObject({ status: 416, code: 'RANGE_NOT_SATISFIABLE' });
  });

  it('throws 416 when start is negative or end < start', async () => {
    const { adapter } = createAdapter();
    await expect(adapter.getStream('/file.mp4', { start: -1 })).rejects.toMatchObject({ status: 416 });
    await expect(adapter.getStream('/file.mp4', { start: 10, end: 5 })).rejects.toMatchObject({ status: 416 });
  });
});
