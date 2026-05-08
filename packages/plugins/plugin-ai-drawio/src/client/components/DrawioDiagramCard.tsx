import React, { useCallback, useEffect, useState } from 'react';
import { Button, Drawer, Space, Typography, Card, Tag, message as antMessage } from 'antd';
import { ApartmentOutlined, FullscreenOutlined, CheckCircleOutlined } from '@ant-design/icons';
import type { ToolsUIProperties } from '@nocobase/client';
import { DrawioBlock } from '../DrawioBlock';
import { getDiagramResultByTitle } from './diagramResultStore';

const { Text } = Typography;

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
  const [drawerOpen, setDrawerOpen] = useState(false);

  const args = toolCall.args as any;
  const diagramTitle: string = args?.title || 'Drawio Diagram';

  // The invoke handler stores diagram result in module-level store keyed by title.
  // It also mutates the args object to include _diagramId and _appliedDirectly.
  // On initial render, _diagramId might not be set yet (invoke still running),
  // but by the time the user clicks "Open Diagram", it will be available.

  const getDiagramId = useCallback((): string | undefined => {
    // First check the mutated args (set by invoke handler)
    if (args?._diagramId) return args._diagramId;
    // Fallback: check the module-level store
    const stored = getDiagramResultByTitle(diagramTitle);
    return stored?.diagramId;
  }, [args, diagramTitle]);

  const isAppliedDirectly = useCallback((): boolean => {
    if (args?._appliedDirectly !== undefined) return args._appliedDirectly;
    const stored = getDiagramResultByTitle(diagramTitle);
    return stored?.appliedDirectly ?? false;
  }, [args, diagramTitle]);

  const openDrawer = useCallback(() => {
    const diagramId = getDiagramId();
    if (!diagramId) {
      antMessage.warning('Diagram is still being created. Please try again in a moment.');
      return;
    }
    setDrawerOpen(true);
  }, [getDiagramId]);

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
  }, []);

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
          <Text style={{ fontSize: 13 }}>
            {diagramTitle}
          </Text>
          <Tag color="green" icon={<CheckCircleOutlined />}>
            Applied
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
              Ready
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
            Open Diagram
          </Button>
        </Space>
      </Card>

      <Drawer
        open={drawerOpen}
        onClose={closeDrawer}
        width="100%"
        title={diagramTitle}
        destroyOnClose
        styles={{ body: { padding: 0 } }}
      >
        {drawerOpen && (
          <DrawioBlock diagramId={getDiagramId()!} height="calc(100vh - 56px)" />
        )}
      </Drawer>
    </>
  );
};
