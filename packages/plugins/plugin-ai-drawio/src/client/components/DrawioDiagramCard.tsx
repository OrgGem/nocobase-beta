import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Space, Typography, Card, Tag, message as antMessage } from 'antd';
import { ApartmentOutlined, FullscreenOutlined, CheckCircleOutlined } from '@ant-design/icons';
import type { ToolsUIProperties } from '@nocobase/client-v2';
import { getDiagram, restoreCurrentDiagram, setDrawerOpen, subscribeDiagramState } from '../diagramStore';
import { useDrawioHost, DrawioHostPortal } from '../drawioHost';
import { useT } from '../locale';

const { Text } = Typography;

type DiagramToolArgs = {
  title?: string;
  diagramId?: string;
};

function getDiagramToolArgs(value: unknown): DiagramToolArgs {
  if (typeof value !== 'object' || value === null) {
    return {};
  }
  const v = value as Record<string, unknown>;
  const title = typeof v.title === 'string' ? v.title : undefined;
  const diagramId = typeof v.diagramId === 'string' ? v.diagramId : undefined;
  return { title, diagramId };
}

/**
 * Tool card rendered inside the AI chat bubble when a drawio diagram tool
 * (display_diagram / display_model_diagram) was invoked.
 *
 * Single global diagram - no session scoping. The first tool call shows
 * "Open Diagram" button; once opened, subsequent calls update the same canvas.
 * If user closes the canvas, the button appears again.
 */
export const DrawioDiagramCard: React.FC<ToolsUIProperties> = ({ toolCall, decisions }) => {
  const t = useT();
  const args = getDiagramToolArgs(toolCall.args);
  const [opening, setOpening] = useState(false);
  const [tick, setTick] = useState(0);
  const isLeader = useDrawioHost();

  // Re-render on store changes so the card reflects the latest diagram state.
  useEffect(() => {
    return subscribeDiagramState(() => {
      setTick((x) => x + 1);
    });
  }, []);
  void tick;

  const done = toolCall.invokeStatus === 'done' || toolCall.invokeStatus === 'confirmed';
  const needsApproval = !done && (toolCall.invokeStatus === 'init' || toolCall.invokeStatus === 'interrupted');

  const current = getDiagram();
  const diagramTitle = args.title || current?.title || t('Drawio Diagram');

  // After a page reload, recover the persisted diagram.
  useEffect(() => {
    if (done) {
      const sessionCurrent = current ?? restoreCurrentDiagram();
      if (sessionCurrent) {
        setTick((x) => x + 1);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done]);

  const waitForDiagram = useCallback((timeoutMs = 20000): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve) => {
      const tickFn = () => {
        if (getDiagram()?.xml) {
          resolve(true);
          return;
        }
        if (Date.now() >= deadline) {
          resolve(false);
          return;
        }
        window.setTimeout(tickFn, 200);
      };
      tickFn();
    });
  }, []);

  const openDrawer = useCallback(async () => {
    if (opening) {
      return;
    }
    setOpening(true);
    try {
      if (needsApproval && decisions?.approve) {
        await decisions.approve();
        const ready = await waitForDiagram();
        if (ready) {
          setDrawerOpen(true);
        } else {
          antMessage.warning(t('Diagram is still being created. Please try again in a moment.'));
        }
        return;
      }

      if (getDiagram()?.xml) {
        setDrawerOpen(true);
      } else {
        antMessage.warning(t('Diagram is still being created. Please try again in a moment.'));
      }
    } catch (err: unknown) {
      const isNotInterrupted = err instanceof Error && err.message?.toLowerCase().includes('not interrupted');
      if (isNotInterrupted) {
        const ready = await waitForDiagram();
        if (ready) {
          setDrawerOpen(true);
        } else {
          antMessage.warning(t('Diagram is still being created. Please try again in a moment.'));
        }
      } else {
        antMessage.error(err instanceof Error ? err.message : t('Save failed'));
      }
    } finally {
      setOpening(false);
    }
  }, [opening, needsApproval, decisions, t, waitForDiagram]);

  return (
    <>
      {isLeader && <DrawioHostPortal />}
      <Card
        size="small"
        style={{
          marginTop: 8,
          borderRadius: 8,
          border: '1px solid #d9d9d9',
          background: current?.xml
            ? 'linear-gradient(135deg, #f0f9eb 0%, #e8f5e9 100%)'
            : 'linear-gradient(135deg, #f5f7fa 0%, #e8ecf1 100%)',
        }}
        styles={{ body: { padding: '12px 16px' } }}
      >
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Space>
            <ApartmentOutlined style={{ color: '#1890ff', fontSize: 16 }} />
            <Text strong style={{ fontSize: 14 }}>
              {diagramTitle}
            </Text>
            <Tag color={done ? 'blue' : 'processing'} icon={done ? <CheckCircleOutlined /> : undefined}>
              {done ? t('Ready') : t('Pending approval')}
            </Tag>
          </Space>
          <Button
            type="primary"
            icon={<FullscreenOutlined />}
            onClick={openDrawer}
            loading={opening}
            block
            style={{ borderRadius: 6, height: 36, fontWeight: 500 }}
          >
            {done ? t('Open Diagram') : t('Approve & Open Diagram')}
          </Button>
        </Space>
      </Card>
    </>
  );
};
