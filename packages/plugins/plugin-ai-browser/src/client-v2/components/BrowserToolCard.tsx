import { GlobalOutlined } from '@ant-design/icons';
import { useApp, type ToolsUIProperties } from '@nocobase/client-v2';
import { useRequest } from 'ahooks';
import { App, Button, Card, Drawer, Space, Tag, Typography } from 'antd';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { openAndApproveBrowser, prepareBrowserSession, type PrepareSessionValues } from '../approval';
import { useT } from '../locale';
import { extractBrowserSession, getToolResultContent, type BrowserSession } from '../session';
import { AIBrowserBlock } from './AIBrowserBlock';

const openedSessions = new Set<string>();
const OPEN_EVENT = 'ai-browser:open-live-view';
function stringValue(value: unknown) {
  return typeof value === 'string' ? value : undefined;
}

export default function BrowserToolCard({ toolCall, decisions, messageId }: ToolsUIProperties) {
  const api = useApp().apiClient;
  const t = useT();
  const { message } = App.useApp();
  const controller = useRef(new AbortController());
  const viewerId = useRef(`browser-viewer-${Math.random().toString(36).slice(2)}`);
  const autoAttempted = useRef<string>();
  const approved = useRef(false);
  const approveInFlight = useRef<Promise<void>>();
  const [prepared, setPrepared] = useState<BrowserSession>();
  const [open, setOpen] = useState(false);
  const args = toolCall.args && typeof toolCall.args === 'object' ? (toolCall.args as Record<string, unknown>) : {};
  const conversationId =
    stringValue(toolCall.sessionId) || stringValue(args.conversationId) || stringValue(args.sessionId);
  const url = stringValue(args.url);
  const result = extractBrowserSession(getToolResultContent({ content: toolCall.content, result: toolCall.result }));
  const sessionId = result.id || prepared?.id;
  const liveUrl = result.liveUrl || prepared?.liveUrl;
  const currentUrl = result.currentUrl || prepared?.currentUrl || url;
  const needsApproval = ['init', 'interrupted', 'waiting'].includes(toolCall.invokeStatus);
  const title = url ? t('Navigating to {{url}}', { url }) : t('Browser Session');
  const statusLabel = needsApproval
    ? 'Pending'
    : toolCall.status === 'error'
      ? 'Failed'
      : ['done', 'confirmed'].includes(toolCall.invokeStatus)
        ? 'Completed'
        : 'Running';
  const values: PrepareSessionValues = {
    conversationId,
    messageId: stringValue(toolCall.messageId) || messageId,
    toolCallId: toolCall.id,
    url,
    profileId: typeof args.profileId === 'string' || typeof args.profileId === 'number' ? args.profileId : undefined,
    title,
  };

  const openLiveView = useCallback((session: Partial<BrowserSession>) => {
    if (!session.id) return;
    openedSessions.add(session.id);
    window.dispatchEvent(
      new CustomEvent(OPEN_EVENT, { detail: { viewerId: viewerId.current, sessionId: session.id } }),
    );
    window.dispatchEvent(
      new CustomEvent('ai-browser:set-live-url', {
        detail: { sessionId: session.id, liveUrl: session.liveUrl, currentUrl: session.currentUrl },
      }),
    );
    setOpen(true);
  }, []);
  const approveOnce = useCallback(async () => {
    if (controller.current.signal.aborted || approved.current) return;
    if (approveInFlight.current) return approveInFlight.current;
    const current = controller.current;
    const promise = decisions
      .approve()
      .then(() => {
        if (controller.current === current && !current.signal.aborted) approved.current = true;
      })
      .finally(() => {
        if (approveInFlight.current === promise) approveInFlight.current = undefined;
      });
    approveInFlight.current = promise;
    return promise;
  }, [decisions]);
  useEffect(() => {
    const current = new AbortController();
    controller.current = current;
    approved.current = false;
    approveInFlight.current = undefined;
    autoAttempted.current = undefined;
    return () => current.abort();
  }, [toolCall.id]);
  const opening = useRequest(
    async () => {
      const approved = await openAndApproveBrowser({
        api,
        values,
        signal: controller.current.signal,
        approve: approveOnce,
        onPrepared: (session) => {
          setPrepared(session);
          openLiveView(session);
        },
      });
      if (!approved && !controller.current.signal.aborted) message.error(t('Browser live view is not ready yet'));
    },
    {
      manual: true,
      onError: () => {
        if (!controller.current.signal.aborted) message.error(t('Failed to open browser session'));
      },
    },
  );
  const reject = useRequest(
    async () => {
      controller.current.abort();
      await decisions.reject(t('User declined opening a browser session.'));
    },
    {
      manual: true,
      onError: () => {
        controller.current = new AbortController();
        message.error(t('Operation failed'));
      },
    },
  );

  const { run: checkExisting, cancel: cancelExisting } = useRequest(
    async () => prepareBrowserSession(api, values, controller.current.signal),
    {
      manual: true,
      onSuccess: (session) => {
        if (
          !needsApproval ||
          controller.current.signal.aborted ||
          session.status !== 'running' ||
          !session.liveViewOpened
        )
          return;
        setPrepared(session);
        approveOnce().catch(() => message.error(t('Operation failed')));
      },
    },
  );
  useEffect(() => {
    if (!needsApproval || !conversationId || autoAttempted.current === toolCall.id) return;
    autoAttempted.current = toolCall.id;
    checkExisting();
    return cancelExisting;
  }, [needsApproval, conversationId, toolCall.id, checkExisting, cancelExisting]);

  useEffect(() => {
    const closeOtherView = (event: Event) => {
      if ((event as CustomEvent<{ viewerId?: string }>).detail?.viewerId !== viewerId.current) setOpen(false);
    };
    window.addEventListener(OPEN_EVENT, closeOtherView);
    return () => {
      window.removeEventListener(OPEN_EVENT, closeOtherView);
    };
  }, []);

  const { run: checkCompleted, cancel: cancelCompleted } = useRequest(
    async (id: string) => {
      const response = await api.request<{ data: BrowserSession }>({
        url: 'aiBrowserSessions:get',
        method: 'get',
        params: { filterByTk: id },
        signal: controller.current.signal,
        skipNotify: true,
      });
      return response.data.data;
    },
    {
      manual: true,
      onSuccess: (session) => {
        if (session.status !== 'running' || openedSessions.has(session.id) || controller.current.signal.aborted) return;
        setPrepared(session);
        openLiveView(session);
      },
    },
  );
  useEffect(() => {
    if (needsApproval || !sessionId || openedSessions.has(sessionId)) return;
    checkCompleted(sessionId);
    return cancelCompleted;
  }, [needsApproval, sessionId, checkCompleted, cancelCompleted]);

  return (
    <>
      <Card
        size="small"
        title={
          <Space>
            <GlobalOutlined />
            {title}
            <Tag>{t(statusLabel)}</Tag>
          </Space>
        }
        extra={
          sessionId && (
            <Button size="small" onClick={() => openLiveView({ id: sessionId, liveUrl, currentUrl })}>
              {t('Live View')}
            </Button>
          )
        }
      >
        {currentUrl && <Typography.Paragraph ellipsis={{ rows: 1 }}>{currentUrl}</Typography.Paragraph>}
        {needsApproval && (
          <Space wrap>
            <Typography.Text type="secondary">
              {t('Browser access is required before this task can continue.')}
            </Typography.Text>
            <Button type="primary" loading={opening.loading} disabled={reject.loading} onClick={() => opening.run()}>
              {t('Open browser')}
            </Button>
            <Button loading={reject.loading} onClick={() => reject.run()}>
              {t('Cancel')}
            </Button>
          </Space>
        )}
      </Card>
      <Drawer
        open={open}
        width="90%"
        title={title}
        destroyOnClose
        styles={{ body: { padding: 0 } }}
        onClose={() => setOpen(false)}
      >
        {open && (
          <AIBrowserBlock
            sessionId={sessionId || prepared?.id}
            liveUrl={liveUrl || prepared?.liveUrl}
            currentUrl={currentUrl}
            height="calc(100vh - 56px)"
          />
        )}
      </Drawer>
    </>
  );
}
