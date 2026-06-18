import React, { useState, useEffect, useRef } from 'react';
import { AIBrowserSessionCard } from '../AIBrowserSessionCard';
import { AIBrowserBlock } from '../AIBrowserBlock';
import { useT } from '../locale';
import { ToolsOptions, ToolsUIProperties } from '@nocobase/client';
import { useApp } from '@nocobase/client-v2';
import { Button, Drawer, Space, Typography } from 'antd';

const { Text } = Typography;

console.log('[AIBrowser] Client tools module loaded! Version: 1.0.17');

const LIVE_VIEW_OPEN_EVENT = 'ai-browser:open-live-view';

function getToolResultContent(toolCall: any) {
  const result = toolCall?.result;
  const content = toolCall?.content ?? result?.content ?? result;
  if (typeof content === 'string') {
    return content;
  }
  if (content == null) {
    return '';
  }
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function extractBrowserSession(content: string) {
  const liveUrlMatch = content.match(/Live Viewer:\s*(\S+)/);
  const sessionIdMatch = content.match(/Session ID:\s*([a-zA-Z0-9_-]+)/);
  const currentUrlMatch = content.match(/Current URL:\s*(\S+)/);

  let parsed: any = null;
  try {
    parsed = content.trim().startsWith('{') ? JSON.parse(content) : null;
  } catch {
    parsed = null;
  }

  return {
    liveUrl: liveUrlMatch ? liveUrlMatch[1] : parsed?.liveUrl,
    sessionId: sessionIdMatch ? sessionIdMatch[1] : parsed?.id,
    currentUrl: currentUrlMatch ? currentUrlMatch[1] : parsed?.currentUrl,
  };
}

const autoOpenedSessions = new Set<string>();

function getSessionData(response: any) {
  return response?.data?.data || response?.data || response;
}

async function waitForLiveViewOpened(api: any, sessionId: string, timeoutMs = 10000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const res = await api.resource('aiBrowserSessions').get({ filterByTk: sessionId });
      const session = getSessionData(res);
      if (session?.liveViewOpened || session?.status !== 'running') {
        return true;
      }
    } catch {
      return false;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 250));
  }
  return false;
}

const BrowserSessionUICard: React.FC<ToolsUIProperties> = ({ toolCall, decisions, messageId }) => {
  const t = useT();
  const api = useApp().apiClient;
  const viewerIdRef = useRef(`browser-viewer-${Math.random().toString(36).slice(2, 10)}`);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [fallbackSession, setFallbackSession] = useState<any>(null);
  const [preparedSession, setPreparedSession] = useState<any>(null);
  const [approving, setApproving] = useState(false);
  const [autoApproving, setAutoApproving] = useState(false);
  const autoApproveAttemptedRef = useRef<string>();
  const args = toolCall.args as any;
  const content = getToolResultContent(toolCall);
  const parsedSession = extractBrowserSession(content);
  const conversationId = (toolCall as any).sessionId || args?.conversationId || args?.sessionId;
  const liveViewScope = conversationId ? `conversation:${conversationId}` : `message:${messageId || (toolCall as any).id}`;

  const liveUrl = parsedSession.liveUrl || preparedSession?.liveUrl || fallbackSession?.liveUrl;
  const sessionId = parsedSession.sessionId || preparedSession?.id || fallbackSession?.id || 'unknown';
  const currentUrl = parsedSession.currentUrl || preparedSession?.currentUrl || fallbackSession?.currentUrl || args?.url;
  const displayStatus = liveUrl
    ? 'running'
    : toolCall.invokeStatus === 'done' || toolCall.invokeStatus === 'confirmed'
      ? 'completed'
      : 'pending';

  const title = args?.url ? `Navigating to ${args.url}` : 'Browser Session';
  const needsApproval =
    toolCall.invokeStatus === 'init' || toolCall.invokeStatus === 'interrupted' || toolCall.invokeStatus === 'waiting';

  const openLiveView = () => {
    window.dispatchEvent(
      new CustomEvent(LIVE_VIEW_OPEN_EVENT, {
        detail: {
          viewerId: viewerIdRef.current,
          scope: liveViewScope,
          sessionId,
        },
      }),
    );
    setDrawerOpen(true);
  };

  const prepareAndApprove = async () => {
    if (approving) return;
    setApproving(true);
    try {
      const res = await api.resource('aiBrowser').prepareSession({
        values: {
          conversationId,
          messageId: (toolCall as any).messageId || messageId,
          toolCallId: (toolCall as any).id,
          url: args?.url,
          profileId: args?.profileId,
          title: args?.url ? `Browser Session - ${args.url}` : 'Browser Session',
        },
      });
      const session = getSessionData(res);
      if (session?.id) {
        setPreparedSession(session);
        autoOpenedSessions.add(session.id);
        window.dispatchEvent(
          new CustomEvent('ai-browser:set-live-url', {
            detail: {
              liveUrl: session.liveUrl,
              sessionId: session.id,
              currentUrl: session.currentUrl,
              title,
            },
          }),
        );
        openLiveView();
        await waitForLiveViewOpened(api, session.id);
      }
      await decisions.approve();
    } finally {
      setApproving(false);
    }
  };

  useEffect(() => {
    if (!needsApproval || !conversationId || approving || autoApproving) {
      return;
    }
    if (autoApproveAttemptedRef.current === (toolCall as any).id) {
      return;
    }

    autoApproveAttemptedRef.current = (toolCall as any).id;
    let cancelled = false;
    const approveIfSessionAlreadyOpened = async () => {
      setAutoApproving(true);
      try {
        const res = await api.resource('aiBrowser').prepareSession({
          values: {
            conversationId,
            messageId: (toolCall as any).messageId || messageId,
            toolCallId: (toolCall as any).id,
            url: args?.url,
            profileId: args?.profileId,
            title: args?.url ? `Browser Session - ${args.url}` : 'Browser Session',
          },
        });
        const session = getSessionData(res);
        if (cancelled || !session?.id || session.status !== 'running' || !session.liveViewOpened) {
          return;
        }

        setPreparedSession(session);
        autoOpenedSessions.add(session.id);
        window.dispatchEvent(
          new CustomEvent('ai-browser:set-live-url', {
            detail: {
              liveUrl: session.liveUrl,
              sessionId: session.id,
              currentUrl: session.currentUrl,
              title,
            },
          }),
        );
        await decisions.approve();
      } finally {
        if (!cancelled) {
          setAutoApproving(false);
        }
      }
    };

    approveIfSessionAlreadyOpened();
    return () => {
      cancelled = true;
    };
  }, [api, args?.profileId, args?.url, approving, autoApproving, conversationId, decisions, messageId, needsApproval, title, toolCall]);

  useEffect(() => {
    const handleOpen = (event: CustomEvent) => {
      const detail = event.detail || {};
      if (detail.viewerId === viewerIdRef.current) {
        return;
      }
      // Only one live browser Drawer should exist on screen at a time.
      // The server session itself remains active for subsequent browser tools.
      setDrawerOpen(false);
    };
    window.addEventListener(LIVE_VIEW_OPEN_EVENT, handleOpen as EventListener);
    return () => window.removeEventListener(LIVE_VIEW_OPEN_EVENT, handleOpen as EventListener);
  }, []);

  // --- Auto-open logic ---
  useEffect(() => {
    if (needsApproval && preparedSession?.id !== sessionId) return;
    if (!liveUrl || !sessionId || sessionId === 'unknown') return;
    if (autoOpenedSessions.has(sessionId)) return;

    const tryOpen = async () => {
      try {
        const res = await api.resource('aiBrowserSessions').get({ filterByTk: sessionId });
        const sessionStatus = res?.data?.data?.status;
        if (sessionStatus !== 'running') {
           // Historical or ended session, do not auto open
           autoOpenedSessions.add(sessionId);
           return;
        }
        
        // It is running! Auto-open it.
        autoOpenedSessions.add(sessionId);
        window.dispatchEvent(
          new CustomEvent('ai-browser:set-live-url', {
            detail: { liveUrl, sessionId, currentUrl, title },
          }),
        );
        openLiveView();
      } catch (e) {
         // ignore
      }
    };
    tryOpen();
  }, [liveUrl, sessionId, api, currentUrl, title, needsApproval, preparedSession?.id]);

  // --- Keep session status polling but DO NOT auto-close ---
  useEffect(() => {
    if (!drawerOpen || !sessionId || sessionId === 'unknown') return;

    let cancelled = false;
    const checkStatus = async () => {
      try {
        await api.resource('aiBrowserSessions').get({ filterByTk: sessionId });
        // We removed auto-close here because users still want to see the UI
        // even if the agent finished its task and stopped the session.
      } catch (e) {
        // ignore
      }
    };

    const interval = setInterval(checkStatus, 10000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [drawerOpen, sessionId, api]);

  useEffect(() => {
    if (needsApproval || liveUrl || !args?.url) {
      return;
    }

    let cancelled = false;
    const loadLatestSession = async () => {
      try {
        const res = await api.resource('aiBrowserSessions').list({ sort: ['-createdAt'], pageSize: 10 });
        const rows = res?.data?.data || [];
        const targetUrl = String(args?.url || '');
        // Only use fallback session if it strictly matches the target url and is actively running.
        // We avoid aggressively falling back to random old sessions.
        const session =
          rows.find((row: any) => targetUrl && (row.currentUrl === targetUrl || row.startUrl === targetUrl) && row.liveUrl && row.status === 'running');

        if (!cancelled && session) {
          setFallbackSession(session);
        }
      } catch {
        // The default tool card still shows the tool status if session lookup fails.
      }
    };

    loadLatestSession();
    const timers = [500, 1500, 3000, 5000].map((delay) => window.setTimeout(loadLatestSession, delay));

    return () => {
      cancelled = true;
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [api, args?.url, liveUrl, needsApproval]);

  return (
    <>
      <AIBrowserSessionCard
        sessionId={sessionId}
        title={title}
        status={needsApproval ? 'pending' : displayStatus}
        liveUrl={liveUrl}
        currentUrl={currentUrl}
        onViewLive={openLiveView}
      />
      {needsApproval && !autoApproving && (
        <Space style={{ marginTop: 8 }}>
          <Text type="secondary">{t('Browser access is required before this task can continue.')}</Text>
          <Button type="primary" size="small" loading={approving} onClick={prepareAndApprove}>
            {t('Open browser')}
          </Button>
          <Button size="small" disabled={approving} onClick={() => decisions.reject('User declined opening a browser session.')}>
            {t('Cancel')}
          </Button>
        </Space>
      )}
      <Drawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        width="90%"
        title={title}
        destroyOnClose
        styles={{ body: { padding: 0 } }}
      >
        {drawerOpen && (
          <AIBrowserBlock liveUrl={liveUrl} sessionId={sessionId} currentUrl={currentUrl} height="calc(100vh - 56px)" />
        )}
      </Drawer>
    </>
  );
};

export const browserOpenUrlClientTool: [string, ToolsOptions] = [
  'browser_open_url',
  {
    ui: {
      card: BrowserSessionUICard,
    },
  },
];

export const aiBrowserClientTools = [
  browserOpenUrlClientTool,
];
