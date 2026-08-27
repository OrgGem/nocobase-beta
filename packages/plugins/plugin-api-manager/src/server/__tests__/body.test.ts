import { PassThrough } from 'stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getRawBodyBuffer } from '../gateway/body';

/** Build a mock IncomingMessage-like stream with the Readable API (no _read). */
function makeReq(body: Buffer): any {
  const stream = new PassThrough();
  stream.push(body);
  stream.push(null);
  return stream;
}

/** Build a stream that stays open so we can emit an error manually. */
function makeOpenReq(initial: Buffer): any {
  const stream = new PassThrough();
  stream.push(initial);
  return stream;
}

describe('getRawBodyBuffer', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves with the full body when within the limit', async () => {
    const body = Buffer.from('hello-world');
    const req = makeReq(body);
    const result = await getRawBodyBuffer({ req }, 1024);
    expect(result).toEqual(body);
  });

  it('resolves with an empty Buffer for an empty body', async () => {
    const req = makeReq(Buffer.alloc(0));
    const result = await getRawBodyBuffer({ req }, 1024);
    expect(result).toEqual(Buffer.alloc(0));
  });

  it('rejects with statusCode 413 when the body exceeds the limit', async () => {
    const req = makeReq(Buffer.from('a'.repeat(2048)));
    await expect(getRawBodyBuffer({ req }, 1024)).rejects.toMatchObject({ statusCode: 413 });
  });

  it('rejects with statusCode 413 when an empty chunk exceeds the limit (0-byte cap)', async () => {
    const req = makeReq(Buffer.from('a'));
    await expect(getRawBodyBuffer({ req }, 0)).rejects.toMatchObject({ statusCode: 413 });
  });

  it('removes all listeners after a successful read', async () => {
    const req = makeReq(Buffer.from('x'));
    const spyOn = vi.spyOn(req, 'on');
    const spyRemove = vi.spyOn(req, 'removeListener');
    await getRawBodyBuffer({ req }, 1024);
    // Attached exactly 3 listeners.
    expect(spyOn).toHaveBeenCalledTimes(3);
    // Cleaned up exactly 3 listeners after settle.
    expect(spyRemove).toHaveBeenCalledTimes(3);
    expect(req.listenerCount('data')).toBe(0);
    expect(req.listenerCount('end')).toBe(0);
    expect(req.listenerCount('error')).toBe(0);
  });

  it('removes all listeners after an over-limit rejection', async () => {
    const req = makeReq(Buffer.from('a'.repeat(2048)));
    const spyRemove = vi.spyOn(req, 'removeListener');
    await expect(getRawBodyBuffer({ req }, 1024)).rejects.toMatchObject({ statusCode: 413 });
    expect(spyRemove).toHaveBeenCalledTimes(3);
    expect(req.listenerCount('data')).toBe(0);
    expect(req.listenerCount('end')).toBe(0);
    expect(req.listenerCount('error')).toBe(0);
  });

  it('rejects once when the stream emits an error', async () => {
    const req = makeOpenReq(Buffer.from('data'));
    const promise = getRawBodyBuffer({ req }, 1024);
    req.emit('error', new Error('boom'));
    await expect(promise).rejects.toThrow('boom');
    expect(req.listenerCount('data')).toBe(0);
    expect(req.listenerCount('end')).toBe(0);
    expect(req.listenerCount('error')).toBe(0);
  });

  it('does not double-settle when the stream errors after a successful end', async () => {
    const req = makeReq(Buffer.from('ok'));
    const result = await getRawBodyBuffer({ req }, 1024);
    expect(result).toEqual(Buffer.from('ok'));
    // The error listener was removed on settle, so emitting 'error' on a
    // stream with no 'error' listener would crash the process. We restore
    // a no-op listener first to prove the body reader itself is inert.
    req.on('error', () => {});
    expect(() => req.emit('error', new Error('late error'))).not.toThrow();
    expect(req.listenerCount('error')).toBe(1); // only the no-op we added
  });

  it('does not double-settle when the stream emits data after rejection', async () => {
    const req = makeReq(Buffer.from('a'.repeat(2048)));
    await expect(getRawBodyBuffer({ req }, 1024)).rejects.toMatchObject({ statusCode: 413 });
    // More data events after settle must be ignored.
    req.emit('data', Buffer.from('more'));
    req.emit('end');
    expect(req.listenerCount('data')).toBe(0);
  });
});
