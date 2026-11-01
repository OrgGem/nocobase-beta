import { openAndApproveBrowser, prepareBrowserSession, waitForLiveViewOpened } from '../approval';

describe('V2 browser tool approval', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens the prepared viewer and waits for a running, opened session before approving', async () => {
    const calls: string[] = [];
    const request = vi
      .fn()
      .mockResolvedValueOnce({ data: { data: { id: 'session-1', status: 'running' } } })
      .mockImplementationOnce(async () => {
        calls.push('status');
        return { data: { data: { id: 'session-1', status: 'running', liveViewOpened: true } } };
      });
    const approve = vi.fn(async () => {
      calls.push('approve');
    });
    const values = { conversationId: 'conversation-1', toolCallId: 'tool-1', url: 'https://example.test' };
    expect(
      await openAndApproveBrowser({
        api: { request },
        values,
        onPrepared: () => {
          calls.push('open');
        },
        approve,
      }),
    ).toBe(true);
    expect(calls).toEqual(['open', 'status', 'approve']);
    expect(request.mock.calls[0][0]).toMatchObject({ url: 'aiBrowser:prepareSession', method: 'post', data: values });
    expect(approve).toHaveBeenCalledTimes(1);
  });

  it('does not approve ended sessions, invalid responses or failed status reads', async () => {
    const approve = vi.fn();
    const request = vi
      .fn()
      .mockResolvedValueOnce({ data: { data: { id: 'session-1' } } })
      .mockResolvedValueOnce({ data: { data: { id: 'session-1', status: 'stopped', liveViewOpened: true } } });
    expect(await openAndApproveBrowser({ api: { request }, values: {}, onPrepared: () => {}, approve })).toBe(false);
    expect(approve).not.toHaveBeenCalled();
    await expect(
      prepareBrowserSession({ request: vi.fn().mockResolvedValue({ data: { data: {} } }) }, {}),
    ).rejects.toThrow('Invalid browser session response');
    expect(await waitForLiveViewOpened({ request: vi.fn().mockRejectedValue(new Error('offline')) }, 'session-1')).toBe(
      false,
    );
  });

  it('does not approve after cancellation while a viewer is opening', async () => {
    const controller = new AbortController(),
      approve = vi.fn();
    const request = vi
      .fn()
      .mockResolvedValue({ data: { data: { id: 'session-1', status: 'running', liveViewOpened: true } } });
    expect(
      await openAndApproveBrowser({
        api: { request },
        values: {},
        onPrepared: () => controller.abort(),
        approve,
        signal: controller.signal,
      }),
    ).toBe(false);
    expect(approve).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('times out if the live view never opens', async () => {
    vi.useFakeTimers();
    const request = vi
      .fn()
      .mockResolvedValue({ data: { data: { id: 'session-1', status: 'running', liveViewOpened: false } } });
    const waiting = waitForLiveViewOpened({ request }, 'session-1', { timeoutMs: 1000, intervalMs: 250 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await waiting).toBe(false);
    expect(request).toHaveBeenCalledTimes(4);
  });
});
