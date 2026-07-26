import React, { useCallback, useEffect, useState } from 'react';
import { Button, Drawer, Space, Typography, Card, Tag, message as antMessage } from 'antd';
import { ApartmentOutlined, FullscreenOutlined, CheckCircleOutlined } from '@ant-design/icons';
import type { ToolsUIProperties } from '@nocobase/client-v2';
import { DrawioBlock } from '../DrawioBlock';
import { getDiagramResultByTitle, subscribeDiagramResult } from './diagramResultStore';
import { useT } from '../locale';

const { Text } = Typography;

type DiagramToolArgs = {
  title?: string;
};

function getDiagramToolArgs(value: unknown): DiagramToolArgs {
  if (typeof value !== 'object' || value === null || !('title' in value)) {
    return {};
  }
  const title = value.title;
  return typeof title === 'string' ? { title } : {};
}

/**
 * Shared UI card rendered inside the AI Employee chat bubble when a drawio
 * diagram tool (display_diagram / display_model_diagram) was invoked.
 *
 * It shows a "Open Diagram" button that opens a fullscreen Drawer
 * containing the DrawioBlock — identical to the "Open in fullscreen" action
 * in the Diagrams tab of DrawioManager.
 *
 * When the drawio block was already open on the page at invoke time, the
 * tool applies changes directly and the card is just informational.
 * When no block was open, the card is the primary way for the user to
 * open and view the newly created diagram.
 */
export const DrawioDiagramCard: React.FC<ToolsUIProperties> = ({ toolCall }) => {
  const t = useT();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [openDiagramId, setOpenDiagramId] = useState<string>();
  const [openDiagramTitle, setOpenDiagramTitle] = useState<string>();
  const args = getDiagramToolArgs(toolCall.args);
  const diagramTitle = args.title || t('Drawio Diagram');
  const [result, setResult] = useState(() => getDiagramResultByTitle(diagramTitle));

  const getDiagramId = useCallback((): string | undefined => {
    return result?.diagramId || getDiagramResultByTitle(diagramTitle)?.diagramId;
  }, [diagramTitle, result?.diagramId]);

  const isAppliedDirectly = useCallback((): boolean => {
    return result?.appliedDirectly ?? getDiagramResultByTitle(diagramTitle)?.appliedDirectly ?? false;
  }, [diagramTitle, result?.appliedDirectly]);

  const openDrawer = useCallback(() => {
    const diagramId = getDiagramId();
    if (!diagramId) {
      antMessage.warning(t('Diagram is still being created. Please try again in a moment.'));
      return;
    }
    const stored = result || getDiagramResultByTitle(diagramTitle);
    setOpenDiagramId(diagramId);
    setOpenDiagramTitle(stored?.title || diagramTitle);
    setDrawerOpen(true);
  }, [diagramTitle, getDiagramId, result, t]);

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
  }, []);

  useEffect(() => {
    return subscribeDiagramResult((result) => {
      if (result.title !== diagramTitle) {
        return;
      }
      setResult(result);
      if (drawerOpen) {
        setOpenDiagramId(result.diagramId);
        setOpenDiagramTitle(result.title || diagramTitle);
      }
    });
  }, [diagramTitle, drawerOpen]);

  // For "done" status tools that were applied directly, show minimal card
  if (toolCall.invokeStatus === 'done' && isAppliedDirectly()) {
    return (
      <Card
        size="small"
        style={{
          marginTop: 8,
          borderRadius: 8,
          border: '1px solid #d9d9d9',
          background: 'linear-gradient(135deg, #f0f9eb 0%, #e8f5e9 100%)',
        }}
        styles={{ body: { padding: '10px 16px' } }}
      >
        <Space>
          <ApartmentOutlined style={{ color: '#52c41a', fontSize: 16 }} />
          <Text style={{ fontSize: 13 }}>{diagramTitle}</Text>
          <Tag color="green" icon={<CheckCircleOutlined />}>
            {t('Applied')}
          </Tag>
        </Space>
      </Card>
    );
  }

  // No drawio block was open — show the "Open Diagram" button
  return (
    <>
      <Card
        size="small"
        style={{
          marginTop: 8,
          borderRadius: 8,
          border: '1px solid #d9d9d9',
          background: 'linear-gradient(135deg, #f5f7fa 0%, #e8ecf1 100%)',
        }}
        styles={{ body: { padding: '12px 16px' } }}
      >
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Space>
            <ApartmentOutlined style={{ color: '#1890ff', fontSize: 16 }} />
            <Text strong style={{ fontSize: 14 }}>
              {diagramTitle}
            </Text>
            <Tag color="blue" icon={<CheckCircleOutlined />} style={{ marginLeft: 4 }}>
              {t('Ready')}
            </Tag>
          </Space>
          <Button
            type="primary"
            icon={<FullscreenOutlined />}
            onClick={openDrawer}
            block
            style={{
              borderRadius: 6,
              height: 36,
              fontWeight: 500,
            }}
          >
            {t('Open Diagram')}
          </Button>
        </Space>
      </Card>

      <Drawer
        open={drawerOpen}
        onClose={closeDrawer}
        width="100%"
        title={openDiagramTitle || diagramTitle}
        destroyOnClose
        styles={{ body: { padding: 0 } }}
      >
        {drawerOpen && openDiagramId && <DrawioBlock diagramId={openDiagramId} height="calc(100vh - 56px)" />}
      </Drawer>
    </>
  );
};
