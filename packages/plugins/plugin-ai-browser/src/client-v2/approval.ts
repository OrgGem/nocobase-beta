import type { APIClient } from '@nocobase/client-v2';
import { readSession, type BrowserSession } from './session';

type BrowserApi = Pick<APIClient, 'request'>;
export type PrepareSessionValues = {
  conversationId?: string;
  messageId?: string;
  toolCallId?: string;
  url?: string;
  profileId?: string | number;
  title?: string;
};

export async function prepareBrowserSession(
  api: BrowserApi,
  values: PrepareSessionValues,
  signal?: AbortSignal,
): Promise<BrowserSession> {
  const response = await api.request<{ data: unknown }>({
    url: 'aiBrowser:prepareSession',
    method: 'post',
    data: values,
    signal,
    skipNotify: true,
  });
  const session = readSession(response.data.data);
  if (!session) throw new Error('Invalid browser session response');
  return session;
}

export async function waitForLiveViewOpened(
  api: BrowserApi,
  sessionId: string,
  {
    signal,
    timeoutMs = 10000,
    intervalMs = 250,
  }: { signal?: AbortSignal; timeoutMs?: number; intervalMs?: number } = {},
): Promise<boolean> {
  const started = Date.now();
  while (!signal?.aborted && Date.now() - started < timeoutMs) {
    try {
      const response = await api.request<{ data: unknown }>({
        url: 'aiBrowserSessions:get',
        method: 'get',
        params: { filterByTk: sessionId },
        signal,
        skipNotify: true,
      });
      const session = readSession(response.data.data);
      if (!session || session.status !== 'running') return false;
      if (session.liveViewOpened) return !signal?.aborted;
    } catch {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

export async function openAndApproveBrowser(args: {
  api: BrowserApi;
  values: PrepareSessionValues;
  onPrepared: (session: BrowserSession) => void;
  approve: () => Promise<void>;
  signal?: AbortSignal;
  timeoutMs?: number;
}) {
  const session = await prepareBrowserSession(args.api, args.values, args.signal);
  if (args.signal?.aborted) return false;
  args.onPrepared(session);
  const opened = await waitForLiveViewOpened(args.api, session.id, { signal: args.signal, timeoutMs: args.timeoutMs });
  if (!opened || args.signal?.aborted) return false;
  await args.approve();
  return true;
}
