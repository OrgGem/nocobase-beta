import React, { useState, useEffect } from 'react';
import {
  Card,
  Space,
  Alert,
  Radio,
  Select,
  Input,
  Button,
  Popconfirm,
  message,
  Form,
  Tag,
  Typography,
  Row,
  Col,
} from 'antd';
import {
  ReloadOutlined,
  DeleteOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  SendOutlined,
} from '@ant-design/icons';
import { useApp } from '@nocobase/client-v2';
import { useT } from './utils';

const { TextArea } = Input;
const { Title, Text } = Typography;

export function NginxCacheManager() {
  const t = useT();
  const api = useApp().apiClient;
  const [loading, setLoading] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [status, setStatus] = useState<any>(null);

  const [method, setMethod] = useState<'directory' | 'purgeRequest'>('directory');
  const [selectedPath, setSelectedPath] = useState<string>('custom');
  const [customPath, setCustomPath] = useState<string>('');
  const [purgeUrl, setPurgeUrl] = useState<string>('');
  const [httpMethod, setHttpMethod] = useState<string>('PURGE');
  const [headersStr, setHeadersStr] = useState<string>('{\n  "X-Purge": "1"\n}');
  const [logs, setLogs] = useState<string>('');

  const fetchNginxStatus = React.useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.request({ url: 'clusterManagerCacheMgr:nginxCacheStatus' });
      setStatus(res?.data?.data);
    } catch {
      message.error(t('Failed to load Nginx status'));
    } finally {
      setLoading(false);
    }
  }, [api, t]);

  useEffect(() => {
    fetchNginxStatus();
  }, [fetchNginxStatus]);

  useEffect(() => {
    if (status?.detectedPaths?.length > 0) {
      setSelectedPath(status.detectedPaths[0]);
    } else {
      setSelectedPath('custom');
    }
  }, [status]);

  const handleClearCache = async () => {
    setClearing(true);
    setLogs('');
    try {
      const values: any = { method };

      if (method === 'directory') {
        const targetDir = selectedPath === 'custom' ? customPath : selectedPath;
        if (!targetDir) {
          message.error(t('Nginx cache path is required'));
          setClearing(false);
          return;
        }
        values.directory = targetDir;
        setLogs(`[INFO] Clearing physical cache files in: ${targetDir}\n`);
      } else {
        if (!purgeUrl) {
          message.error(t('Please enter a valid Purge URL'));
          setClearing(false);
          return;
        }
        values.url = purgeUrl;
        values.httpMethod = httpMethod;

        let headers = {};
        try {
          if (headersStr.trim()) {
            headers = JSON.parse(headersStr);
          }
        } catch {
          message.error(t('Invalid headers JSON structure'));
          setClearing(false);
          return;
        }
        values.headers = headers;
        setLogs(
          `[INFO] Sending HTTP Purge request:\n[INFO] Method: ${httpMethod}\n[INFO] URL: ${purgeUrl}\n[INFO] Headers: ${JSON.stringify(
            headers,
            null,
            2,
          )}\n`,
        );
      }

      const res = await api.request({
        url: 'clusterManagerCacheMgr:clearNginxCache',
        method: 'post',
        data: { values },
      });

      const data = res?.data?.data;
      if (method === 'directory') {
        const msg = t('Cache cleared successfully. Cleared {count} items.').replace(
          '{count}',
          String(data?.clearedCount || 0),
        );
        message.success(msg);
        setLogs((prev) => prev + `[SUCCESS] ${msg}\n`);
      } else {
        const msg = t('HTTP Purge request completed. Status: {status}').replace(
          '{status}',
          String(data?.status || 200),
        );
        message.success(msg);
        setLogs(
          (prev) =>
            prev +
            `[SUCCESS] ${msg}\n[RESPONSE BODY]\n${
              typeof data?.data === 'object' ? JSON.stringify(data.data, null, 2) : String(data?.data || '')
            }\n`,
        );
      }
    } catch (err: any) {
      const errMsg = err?.response?.data?.message || err?.message || String(err);
      message.error(errMsg);
      setLogs((prev) => prev + `[ERROR] Failed: ${errMsg}\n`);
    } finally {
      setClearing(false);
    }
  };

  const detectedPaths = status?.detectedPaths || [];
  const nginxInstalled = status?.nginxInstalled || false;

  return (
    <Card bordered={false} loading={loading}>
      <Space direction="vertical" style={{ width: '100%' }} size="large">
        {/* Nginx Detection Status */}
        <Alert
          type={nginxInstalled ? 'success' : 'warning'}
          showIcon
          icon={nginxInstalled ? <CheckCircleOutlined /> : <CloseCircleOutlined />}
          message={<span style={{ fontWeight: 600 }}>{t('Nginx Cache Status')}</span>}
          description={
            <div style={{ marginTop: 8 }}>
              <div>
                <span style={{ fontWeight: 500 }}>{t('Status')}:</span>{' '}
                {nginxInstalled ? (
                  <Tag color="success">{t('Nginx is installed')}</Tag>
                ) : (
                  <Tag color="warning">{t('Nginx is NOT installed')}</Tag>
                )}
              </div>
              {status?.mainConfigPath && (
                <div style={{ marginTop: 4 }}>
                  <span style={{ fontWeight: 500 }}>{t('Nginx configuration file found at')}:</span>{' '}
                  <code style={{ fontSize: 12 }}>{status.mainConfigPath}</code>
                </div>
              )}
              {detectedPaths.length > 0 && (
                <div style={{ marginTop: 4 }}>
                  <span style={{ fontWeight: 500 }}>{t('Nginx cache paths detected')}:</span>
                  <div style={{ marginTop: 4, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {detectedPaths.map((p: string) => (
                      <Tag key={p} color="blue" style={{ fontSize: 11 }}>
                        {p}
                      </Tag>
                    ))}
                  </div>
                </div>
              )}
              {!nginxInstalled && (
                <div style={{ marginTop: 4, fontStyle: 'italic', opacity: 0.8 }}>
                  {t('Nginx is not detected on this node. You can still input a custom cache directory.')}
                </div>
              )}
            </div>
          }
          action={
            <Button size="small" icon={<ReloadOutlined />} onClick={fetchNginxStatus}>
              {t('Refresh')}
            </Button>
          }
        />

        {/* Method selection */}
        <div>
          <Title level={5} style={{ fontSize: 14 }}>
            {t('Nginx cache clearing method')}
          </Title>
          <Radio.Group
            value={method}
            onChange={(e) => setMethod(e.target.value)}
            style={{ width: '100%', marginTop: 8 }}
          >
            <Row gutter={16}>
              <Col span={12}>
                <Radio.Button
                  value="directory"
                  style={{
                    width: '100%',
                    height: 'auto',
                    padding: '16px 24px',
                    display: 'flex',
                    flexDirection: 'column',
                    borderRadius: 8,
                    textAlign: 'left',
                    boxShadow: 'none',
                    lineHeight: 'normal',
                    border: method === 'directory' ? '2px solid #1677ff' : '1px solid #d9d9d9',
                  }}
                >
                  <Space align="start" size="middle">
                    <DeleteOutlined
                      style={{ fontSize: 24, color: method === 'directory' ? '#1677ff' : 'inherit', marginTop: 4 }}
                    />
                    <div>
                      <div
                        style={{ fontWeight: 600, fontSize: 15, color: method === 'directory' ? '#1677ff' : 'inherit' }}
                      >
                        {t('Physical Files')}
                      </div>
                      <div style={{ fontSize: 12, opacity: 0.65, marginTop: 4 }}>
                        {t('Directly deletes all cache files inside the nginx cache directory on this server node.')}
                      </div>
                    </div>
                  </Space>
                </Radio.Button>
              </Col>
              <Col span={12}>
                <Radio.Button
                  value="purgeRequest"
                  style={{
                    width: '100%',
                    height: 'auto',
                    padding: '16px 24px',
                    display: 'flex',
                    flexDirection: 'column',
                    borderRadius: 8,
                    textAlign: 'left',
                    boxShadow: 'none',
                    lineHeight: 'normal',
                    border: method === 'purgeRequest' ? '2px solid #1677ff' : '1px solid #d9d9d9',
                  }}
                >
                  <Space align="start" size="middle">
                    <SendOutlined
                      style={{ fontSize: 24, color: method === 'purgeRequest' ? '#1677ff' : 'inherit', marginTop: 4 }}
                    />
                    <div>
                      <div
                        style={{
                          fontWeight: 600,
                          fontSize: 15,
                          color: method === 'purgeRequest' ? '#1677ff' : 'inherit',
                        }}
                      >
                        {t('HTTP Purge Request')}
                      </div>
                      <div style={{ fontSize: 12, opacity: 0.65, marginTop: 4 }}>
                        {t(
                          'Sends a custom HTTP request (like PURGE or bypass headers) to let Nginx clear specific URLs.',
                        )}
                      </div>
                    </div>
                  </Space>
                </Radio.Button>
              </Col>
            </Row>
          </Radio.Group>
        </div>

        {/* Input fields based on method */}
        <Card bordered size="small" style={{ backgroundColor: '#fafafa' }}>
          {method === 'directory' ? (
            <Form layout="vertical">
              <Form.Item label={<span style={{ fontWeight: 500 }}>{t('Select Cache Path')}</span>} required>
                <Select
                  value={selectedPath}
                  onChange={(val) => setSelectedPath(val)}
                  style={{ width: '100%' }}
                  options={[
                    ...detectedPaths.map((p: string) => ({ label: p, value: p })),
                    { label: t('Custom Path'), value: 'custom' },
                  ]}
                />
              </Form.Item>

              {selectedPath === 'custom' && (
                <Form.Item label={<span style={{ fontWeight: 500 }}>{t('Custom Cache Path')}</span>} required>
                  <Input
                    placeholder="/var/cache/nginx"
                    value={customPath}
                    onChange={(e) => setCustomPath(e.target.value)}
                  />
                  <Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 4 }}>
                    {t(
                      'Provide the full absolute path of the directory. Restricted system paths will be rejected for safety.',
                    )}
                  </Text>
                </Form.Item>
              )}
            </Form>
          ) : (
            <Form layout="vertical">
              <Row gutter={16}>
                <Col span={18}>
                  <Form.Item label={<span style={{ fontWeight: 500 }}>{t('Purge URL')}</span>} required>
                    <Input
                      placeholder="http://127.0.0.1/purge/*"
                      value={purgeUrl}
                      onChange={(e) => setPurgeUrl(e.target.value)}
                    />
                  </Form.Item>
                </Col>
                <Col span={6}>
                  <Form.Item label={<span style={{ fontWeight: 500 }}>{t('HTTP Method')}</span>} required>
                    <Select
                      value={httpMethod}
                      onChange={(val) => setHttpMethod(val)}
                      options={[
                        { label: 'PURGE', value: 'PURGE' },
                        { label: 'GET', value: 'GET' },
                        { label: 'POST', value: 'POST' },
                        { label: 'DELETE', value: 'DELETE' },
                      ]}
                    />
                  </Form.Item>
                </Col>
              </Row>
              <Form.Item label={<span style={{ fontWeight: 500 }}>{t('Headers (JSON)')}</span>}>
                <TextArea
                  rows={4}
                  value={headersStr}
                  onChange={(e) => setHeadersStr(e.target.value)}
                  placeholder={'{\n  "X-Purge": "1"\n}'}
                  style={{ fontFamily: 'monospace', fontSize: 12 }}
                />
              </Form.Item>
            </Form>
          )}
        </Card>

        {/* Big Action Button */}
        <div>
          <Popconfirm
            title={t('Clear Nginx Cache?')}
            description={
              method === 'directory'
                ? t(
                    'Are you sure you want to clear Nginx cache? This will permanently delete all files in this directory.',
                  )
                : t('Are you sure you want to trigger this HTTP Purge request?')
            }
            onConfirm={handleClearCache}
            okButtonProps={{ loading: clearing }}
          >
            <Button
              type="primary"
              danger={method === 'directory'}
              size="large"
              icon={method === 'directory' ? <DeleteOutlined /> : <SendOutlined />}
              loading={clearing}
            >
              {method === 'directory' ? t('Clear Nginx Cache') : t('Send Purge Request')}
            </Button>
          </Popconfirm>
        </div>

        {/* Execution Logs */}
        {logs && (
          <div>
            <Title level={5} style={{ fontSize: 13, marginBottom: 8 }}>
              {t('Execution Logs')}
            </Title>
            <pre
              style={{
                backgroundColor: '#1e1e1e',
                color: '#d4d4d4',
                padding: '12px 16px',
                borderRadius: 6,
                fontFamily: 'monospace',
                fontSize: 12,
                overflowX: 'auto',
                whiteSpace: 'pre-wrap',
                maxHeight: '300px',
              }}
            >
              {logs}
            </pre>
          </div>
        )}
      </Space>
    </Card>
  );
}
