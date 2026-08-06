import type { Context } from '@nocobase/actions';
import { AiApiClientDisconnectedError, createRequestAbortController, isClientDisconnected } from '../utils/streaming';

class ListenerTarget {
  private listeners = new Map<string, Set<() => void>>();
  aborted = false;
  writableEnded = false;

  once(event: string, listener: () => void) {
    const wrapped = () => {
      this.off(event, wrapped);
      listener();
    };
    const group = this.listeners.get(event) ?? new Set();
    group.add(wrapped);
    this.listeners.set(event, group);
  }

  off(event: string, listener: () => void) {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: string) {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener();
  }
}

describe('AI API streaming cancellation classification', () => {
  it('uses a recognizable client-disconnect abort reason', () => {
    const req = new ListenerTarget();
    const res = new ListenerTarget();
    const ctx = { req, res } as unknown as Context;
    const controller = createRequestAbortController(ctx);

    req.aborted = true;
    req.emit('aborted');

    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toBeInstanceOf(AiApiClientDisconnectedError);
    expect(isClientDisconnected(ctx, controller.signal.reason)).toBe(true);
    controller.dispose();
  });

  it('does not treat an unrelated provider abort as client cancellation', () => {
    const req = new ListenerTarget();
    const res = new ListenerTarget();
    const ctx = { req, res } as unknown as Context;

    expect(isClientDisconnected(ctx, new DOMException('Provider timeout', 'AbortError'))).toBe(false);
  });
});
