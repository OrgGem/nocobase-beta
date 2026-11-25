// SPDX-License-Identifier: Apache-2.0

import { CheckCircleOutlined, CloseCircleOutlined, CloudUploadOutlined, SyncOutlined } from '@ant-design/icons';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Empty,
  Form,
  Input,
  message,
  Modal,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import React, { useCallback, useEffect, useState } from 'react';
import type { BatchSyncItemResult } from '../../shared/types';
import { useHaproxyApi } from '../api';
import { useHaproxySession } from '../hooks/useHaproxySession';
import { useT } from '../locale';
import { getErrorMessage } from '../utils/format';
import { NodeToolbar } from './NodeToolbar';

export const HaproxyRawConfigView: React.FC<{ fixedConnectionId?: number }> = ({ fixedConnectionId }) => {
  const t = useT();
  const api = useHaproxyApi();
  const { permissions, connections, selectedConnectionId, setSelectedConnectionId, bootstrapping } =
    useHaproxySession(fixedConnectionId);

  const canPush = Boolean(permissions?.canRawConfig);
  const [loading, setLoading] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [content, setContent] = useState('');
  const [version, setVersion] = useState<number | null>(null);
  const [checksum, setChecksum] = useState<string | null>(null);
  const [forceReload, setForceReload] = useState(false);
  const [skipVersion, setSkipVersion] = useState(false);

  const [batchModalOpen, setBatchModalOpen] = useState(false);
  const [batchPushing, setBatchPushing] = useState(false);
  const [batchResults, setBatchResults] = useState<BatchSyncItemResult[] | null>(null);
  const [batchForm] = Form.useForm<{ targetConnectionIds: number[]; forceReload: boolean; skipVersion: boolean }>();

  const loadRaw = useCallback(async () => {
    if (!selectedConnectionId) return;
    setLoading(true);
    try {
      const res = await api.getRawConfig(selectedConnectionId);
      setContent(res.content);
      setVersion(res.version);
      setChecksum(res.checksum);
    } catch (err) {
      message.error(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [api, selectedConnectionId]);

  useEffect(() => {
    loadRaw();
  }, [loadRaw]);

  const handlePushCurrent = useCallback(async () => {
    if (!selectedConnectionId) return;
    setPushing(true);
    try {
      await api.pushRawConfig(selectedConnectionId, content, {
        version: skipVersion ? undefined : version ?? undefined,
        forceReload,
        skipVersion,
      });
      message.success(t('Raw configuration applied'));
      await loadRaw();
    } catch (err) {
      message.error(getErrorMessage(err));
    } finally {
      setPushing(false);
    }
  }, [api, content, forceReload, loadRaw, selectedConnectionId, skipVersion, t, version]);

  const handlePushBatch = useCallback(async () => {
    try {
      const values = await batchForm.validateFields();
      setBatchPushing(true);
      const res = await api.pushRawConfigBatch(values.targetConnectionIds, content, {
        forceReload: values.forceReload,
        skipVersion: values.skipVersion,
      });
      setBatchResults(res.results);
      setBatchModalOpen(false);
      await loadRaw();
    } catch (err) {
      if (err && typeof err === 'object' && 'errorFields' in err) return;
      message.error(getErrorMessage(err));
    } finally {
      setBatchPushing(false);
    }
  }, [api, batchForm, content, loadRaw]);

  if (!bootstrapping && connections.length === 0) {
    return (
      <Card>
        <Empty description={t('No enabled HAProxy Data Plane connections')} />
      </Card>
    );
  }

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <NodeToolbar
        connections={connections}
        selectedConnectionId={selectedConnectionId}
        onSelectConnection={setSelectedConnectionId}
        fixedConnectionId={fixedConnectionId}
        loading={loading}
        onRefresh={loadRaw}
        extraRight={
          <Space>
            {version != null && <Tag color="geekblue">v{version}</Tag>}
            {checksum && <Typography.Text code>{checksum.slice(0, 12)}</Typography.Text>}
          </Space>
        }
      />

      {batchResults && (
        <Card
          size="small"
          title={t('Multi-Server Sync Results')}
          extra={
            <Button htmlType="button" size="small" onClick={() => setBatchResults(null)}>
              {t('Cancel')}
            </Button>
          }
        >
          <Table<BatchSyncItemResult>
            rowKey="connectionId"
            size="small"
            dataSource={batchResults}
            pagination={false}
            columns={[
              { title: t('Node'), dataIndex: 'connectionName', key: 'connectionName' },
              {
                title: t('Status'),
                key: 'ok',
                render: (_v: unknown, r: BatchSyncItemResult) =>
                  r.ok ? (
                    <Tag icon={<CheckCircleOutlined aria-hidden="true" />} color="success">
                      OK {r.version != null ? `(v${r.version})` : ''}
                    </Tag>
                  ) : (
                    <Tag icon={<CloseCircleOutlined aria-hidden="true" />} color="error">
                      {r.error}
                    </Tag>
                  ),
              },
              {
                title: t('Reload ID'),
                dataIndex: 'reloadId',
                key: 'reloadId',
                render: (id?: string | null) => (id ? <Typography.Text code>{id}</Typography.Text> : '—'),
              },
            ]}
          />
        </Card>
      )}

      <Card
        size="small"
        title={t('Raw haproxy.cfg Editor')}
        extra={
          canPush ? (
            <Space wrap>
              <Checkbox checked={skipVersion} onChange={(e) => setSkipVersion(e.target.checked)}>
                {t('Skip optimistic version check (overwrite target version)')}
              </Checkbox>
              <Switch
                checked={forceReload}
                onChange={setForceReload}
                aria-label={t('Force immediate reload (skip reload-delay)')}
              />
              <Typography.Text>{t('Force immediate reload (skip reload-delay)')}</Typography.Text>
              <Button
                htmlType="button"
                type="primary"
                icon={<CloudUploadOutlined aria-hidden="true" />}
                loading={pushing}
                onClick={handlePushCurrent}
              >
                {t('Push to Current Node')}
              </Button>
              {connections.length > 1 && (
                <Button
                  htmlType="button"
                  icon={<SyncOutlined aria-hidden="true" />}
                  onClick={() => {
                    batchForm.resetFields();
                    batchForm.setFieldsValue({
                      targetConnectionIds: connections.map((c) => c.id),
                      forceReload: true,
                      skipVersion: true,
                    });
                    setBatchModalOpen(true);
                  }}
                >
                  {t('Push / Sync to Multiple Nodes')}
                </Button>
              )}
            </Space>
          ) : null
        }
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message={t('Data Plane API validates syntax before writing haproxy.cfg and reloading HAProxy.')}
        />
        <Input.TextArea
          rows={22}
          readOnly={!canPush}
          aria-label={t('Raw haproxy.cfg Editor')}
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 13 }}
          value={content}
          onChange={(e) => setContent(e.target.value)}
        />
      </Card>

      <Modal
        open={batchModalOpen}
        title={t('Push / Sync to Multiple Nodes')}
        okText={t('Apply')}
        cancelText={t('Cancel')}
        confirmLoading={batchPushing}
        onOk={handlePushBatch}
        onCancel={() => setBatchModalOpen(false)}
        destroyOnClose
      >
        <Form form={batchForm} layout="vertical">
          <Form.Item name="targetConnectionIds" label={t('Target HAProxy Nodes')} rules={[{ required: true }]}>
            <Select
              mode="multiple"
              options={connections.map((c) => ({
                value: c.id,
                label: c.title ? `${c.title} (${c.name})` : c.name,
              }))}
            />
          </Form.Item>
          <Form.Item
            name="skipVersion"
            label={t('Skip optimistic version check (overwrite target version)')}
            valuePropName="checked"
          >
            <Switch />
          </Form.Item>
          <Form.Item name="forceReload" label={t('Force immediate reload (skip reload-delay)')} valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
};

export default HaproxyRawConfigView;
