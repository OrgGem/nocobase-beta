import React, { useState, useEffect, useCallback } from 'react';
import { Card, Form, Input, Button, Alert, Progress, Tag, Typography, Space, Divider, message, Select } from 'antd';
import { CloudServerOutlined, SafetyOutlined, ReloadOutlined, DatabaseOutlined, ClearOutlined, DeleteOutlined } from '@ant-design/icons';
import { useAPIClient } from '@nocobase/client';
import { useT } from '../locale';
import { parseJsonText, stringifyJsonText } from '../utils/jsonFields';

const { Text, Title } = Typography;

const PREDEFINED_PACKAGES = {
  apt: ['python3', 'python3-pip', 'python3-venv'],
  python: [
    'python-docx', 'openpyxl', 'pandas', 'matplotlib', 'Pillow',
    'reportlab', 'jinja2', 'pyyaml', 'tabulate', 'xlsxwriter',
  ],
  node: [
    'xlsx', 'docx', 'pdfkit', 'csv-parse', 'archiver',
    'sharp', 'lodash', 'dayjs',
  ],
};

const STATUS_MAP: Record<string, { color: string; text: string }> = {
  pending: { color: 'default', text: 'Not initialized' },
  running: { color: 'processing', text: 'Running...' },
  succeeded: { color: 'success', text: 'Succeeded' },
  failed: { color: 'error', text: 'Failed' },
};

export const WorkerSetup: React.FC = () => {
  const t = useT();
  const api = useAPIClient();
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [initRunning, setInitRunning] = useState(false);
  const [config, setConfig] = useState<any>(null);
  const [progress, setProgress] = useState<{ percent: number; log: string } | null>(null);

  const [clearing, setClearing] = useState(false);
  const [addingPkg, setAddingPkg] = useState(false);
  const [customPkgLang, setCustomPkgLang] = useState<'python' | 'node'>('python');
  const [customPkgName, setCustomPkgName] = useState('');

  const loadConfig = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.request({ url: 'skillWorkerConfigs:get' });
      const responseData = data?.data?.data || data?.data;
      const cfg = responseData;
      if (cfg) {
        cfg.packageWhitelist = parseJsonText(cfg.packageWhitelist, { python: [], node: [], apt: [] });
        cfg.customPackages = parseJsonText(cfg.customPackages, { python: [], node: [] });
      }
      setConfig(cfg);
      if (cfg) {
        form.setFieldsValue({
          npmRegistryUrl: cfg.npmRegistryUrl,
          npmAuthToken: cfg.npmAuthToken,
          pypiIndexUrl: cfg.pypiIndexUrl,
          pypiTrustedHost: cfg.pypiTrustedHost,
          aptMirrorUrl: cfg.aptMirrorUrl,
          aptGpgKeyUrl: cfg.aptGpgKeyUrl,
          retentionHours: cfg.retentionHours ?? 24,
        });
        if (cfg.initStatus === 'running') {
          setInitRunning(true);
          setProgress({ percent: cfg.initProgressPercent || 0, log: cfg.initProgressLog || t('Processing...') });
        } else {
          setInitRunning(false);
          setProgress(null);
        }
      }
    } catch {
      // Config may not exist yet
    } finally {
      setLoading(false);
    }
  }, [api, form]);

  useEffect(() => {
    loadConfig();

    let interval: any;
    if (initRunning) {
      interval = setInterval(() => {
        loadConfig();
      }, 5000);
    }

    return () => {
      if (interval) clearInterval(interval);
    };
  }, [loadConfig, initRunning]);

  const handleSaveConfig = async () => {
    setSaving(true);
    try {
      const values = form.getFieldsValue();
      if (config?.id) {
        await api.request({
          url: `skillWorkerConfigs:update`,
          method: 'post',
          params: { filterByTk: config.id },
          data: values,
        });
      } else {
        await api.request({
          url: 'skillWorkerConfigs:create',
          method: 'post',
          data: values,
        });
      }
      message.success(t('Config saved'));
      await loadConfig();
    } catch {
      message.error(t('Failed to save config'));
    } finally {
      setSaving(false);
    }
  };

  const handleClearData = async (type: 'expired' | 'all') => {
    setClearing(true);
    try {
      const { data } = await api.request({
        url: 'skillHub:clearStorage',
        method: 'POST',
        data: { type },
      });
      const responseData = data?.data?.data || data?.data;
      message.success(t(`Cleared ${responseData?.count || 0} executions`));
    } catch (err: any) {
      message.error(err?.response?.data?.errors?.[0]?.message || t('Failed to clear data'));
    } finally {
      setClearing(false);
    }
  };

  const handleInitEnv = async () => {
    setInitRunning(true);
    setProgress({ percent: 0, log: t('Dispatching to workers...') });
    try {
      await api.request({
        url: 'skillHub:initEnv',
        method: 'post',
      });
      message.info(t('Init environment task dispatched'));
      await loadConfig();
    } catch (err: any) {
      message.error(err?.message || t('Failed to init environment'));
      setInitRunning(false);
      setProgress(null);
    }
  };

  const handleAddPackage = async () => {
    if (!customPkgName.trim()) return;
    setAddingPkg(true);
    try {
      const currentConfig = config || {};
      const currentCustom = parseJsonText(currentConfig.customPackages, { python: [], node: [] });
      const currentLangList = currentCustom[customPkgLang] || [];
      
      if (!currentLangList.includes(customPkgName.trim())) {
        currentLangList.push(customPkgName.trim());
        const newCustom = { ...currentCustom, [customPkgLang]: currentLangList };
        
        if (config?.id) {
          await api.request({
            url: `skillWorkerConfigs:update`,
            method: 'post',
            params: { filterByTk: config.id },
            data: { customPackages: stringifyJsonText(newCustom, { python: [], node: [] }) },
          });
        } else {
          await api.request({
            url: 'skillWorkerConfigs:create',
            method: 'post',
            data: { customPackages: stringifyJsonText(newCustom, { python: [], node: [] }) },
          });
        }
      }
      
      message.success(t('Package added. Triggering installation across workers...'));
      setCustomPkgName('');
      
      await handleInitEnv();
    } catch {
      message.error(t('Failed to add custom package'));
    } finally {
      setAddingPkg(false);
    }
  };

  const statusInfo = STATUS_MAP[config?.initStatus] || STATUS_MAP.pending;
  const whitelist = config?.packageWhitelist;
  const hasWhitelist = whitelist?.python?.length > 0 || whitelist?.node?.length > 0;

  return (
    <div style={{ padding: 16, maxWidth: 800 }}>
      {/* Registry Configuration */}
      <Card
        title={
          <Space>
            <CloudServerOutlined />
            <span>{t('Registry Configuration')}</span>
          </Space>
        }
        size="small"
        style={{ marginBottom: 16 }}
      >
        <Form form={form} layout="vertical" size="small">
          <Form.Item name="npmRegistryUrl" label={t('npm Registry URL')}>
            <Input placeholder="https://registry.npmjs.org" />
          </Form.Item>
          <Form.Item name="npmAuthToken" label={t('npm Auth Token')}>
            <Input.Password placeholder={t('Optional, for private registry')} />
          </Form.Item>
          <Divider style={{ margin: '12px 0' }} />
          <Form.Item name="pypiIndexUrl" label={t('PyPI Index URL')}>
            <Input placeholder="https://pypi.org/simple" />
          </Form.Item>
          <Form.Item name="pypiTrustedHost" label={t('PyPI Trusted Host')}>
            <Input placeholder="pypi.org" />
          </Form.Item>
          <Divider style={{ margin: '12px 0' }} />
          <Form.Item name="aptMirrorUrl" label={t('APT Mirror URL')}>
            <Input placeholder="http://deb.debian.org/debian" />
          </Form.Item>
          <Form.Item name="aptGpgKeyUrl" label={t('APT GPG Key URL')}>
            <Input placeholder={t('Optional')} />
          </Form.Item>
          <Form.Item>
            <Button type="primary" onClick={handleSaveConfig} loading={saving}>
              {t('Save Config')}
            </Button>
          </Form.Item>
        </Form>
      </Card>

      {/* Storage Management */}
      <Card
        title={
          <Space>
            <DatabaseOutlined />
            <span>{t('Storage Management (Data Retention)')}</span>
          </Space>
        }
        size="small"
        style={{ marginBottom: 16 }}
      >
        <Form form={form} layout="vertical" size="small">
          <Form.Item 
            name="retentionHours" 
            label={t('Retention Hours (Auto Cleanup)')}
            tooltip={t('Executions older than this will be automatically deleted. 0 means keep forever.')}
          >
            <Input type="number" min={0} />
          </Form.Item>
          <Form.Item>
            <Button type="primary" onClick={handleSaveConfig} loading={saving}>
              {t('Save Config')}
            </Button>
          </Form.Item>
        </Form>
        <Divider style={{ margin: '12px 0' }} />
        <Space>
          <Button 
            icon={<ClearOutlined />} 
            onClick={() => handleClearData('expired')} 
            loading={clearing}
          >
            {t('Clear Expired Data Now')}
          </Button>
          <Button 
            danger 
            icon={<DeleteOutlined />} 
            onClick={() => handleClearData('all')} 
            loading={clearing}
          >
            {t('Clear All Execution Data')}
          </Button>
        </Space>
      </Card>

      {/* Environment Status */}
      <Card
        title={
          <Space>
            <CloudServerOutlined />
            <span>{t('Environment Status')}</span>
          </Space>
        }
        size="small"
        style={{ marginBottom: 16 }}
        extra={
          <Button icon={<ReloadOutlined />} size="small" onClick={loadConfig} loading={loading}>
            {t('Refresh')}
          </Button>
        }
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <div>
            <Text strong>{t('Status')}: </Text>
            <Tag color={statusInfo.color}>{t(statusInfo.text)}</Tag>
            {config?.lastInitAt && (
              <Text type="secondary" style={{ fontSize: 12 }}>
                ({new Date(config.lastInitAt).toLocaleString()})
              </Text>
            )}
          </div>

          <Divider style={{ margin: '8px 0' }} />

          <div>
            <Text strong>{t('Packages to install')}:</Text>
            <div style={{ marginTop: 4 }}>
              <Text type="secondary">APT: </Text>
              {PREDEFINED_PACKAGES.apt.map((p) => (
                <Tag key={p} style={{ marginBottom: 2 }}>{p}</Tag>
              ))}
            </div>
            <div style={{ marginTop: 4 }}>
              <Text type="secondary">Python: </Text>
              {PREDEFINED_PACKAGES.python.map((p) => (
                <Tag key={p} color="blue" style={{ marginBottom: 2 }}>{p}</Tag>
              ))}
            </div>
            <div style={{ marginTop: 4 }}>
              <Text type="secondary">Node: </Text>
              {PREDEFINED_PACKAGES.node.map((p) => (
                <Tag key={p} color="green" style={{ marginBottom: 2 }}>{p}</Tag>
              ))}
            </div>
          </div>

          <div style={{ marginTop: 12 }}>
            <Button
              type="primary"
              icon={initRunning ? <ReloadOutlined spin /> : <CloudServerOutlined />}
              onClick={handleInitEnv}
              size="large"
            >
              {initRunning ? t('Initializing... (Click to Force Run)') : t('Init Environment')}
            </Button>
          </div>

          {initRunning && progress && (
            <div style={{ marginTop: 8 }}>
              <Progress percent={progress.percent} status="active" />
              <Text type="secondary">{progress.log}</Text>
            </div>
          )}

          {config?.lastInitLog && config.initStatus !== 'running' && (
            <div style={{ marginTop: 8 }}>
              <Text strong>{t('Last Init Log')}:</Text>
              <pre style={{
                background: '#f5f5f5',
                padding: 8,
                borderRadius: 4,
                fontSize: 11,
                maxHeight: 200,
                overflow: 'auto',
                whiteSpace: 'pre-wrap',
                marginTop: 4,
              }}>
                {config.lastInitLog}
              </pre>
            </div>
          )}
        </Space>
      </Card>

      {/* Package Whitelist */}
      <Card
        title={
          <Space>
            <SafetyOutlined />
            <span>{t('Package Whitelist')}</span>
          </Space>
        }
        size="small"
      >
        {hasWhitelist ? (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Alert
              type="info"
              showIcon
              message={t('Only these packages can be imported in skill code')}
              style={{ marginBottom: 8 }}
            />
            {whitelist?.python?.length > 0 && (
              <div>
                <Text strong>Python: </Text>
                {whitelist.python.map((p: string) => (
                  <Tag key={p} color="blue" style={{ marginBottom: 2 }}>{p}</Tag>
                ))}
              </div>
            )}
            {whitelist?.node?.length > 0 && (
              <div>
                <Text strong>Node: </Text>
                {whitelist.node.map((p: string) => (
                  <Tag key={p} color="green" style={{ marginBottom: 2 }}>{p}</Tag>
                ))}
              </div>
            )}
          </Space>
        ) : (
          <Alert
            type="warning"
            showIcon
            message={t('No whitelist configured. Click "Init Environment" to install packages and generate the whitelist.')}
          />
        )}

        <Divider style={{ margin: '16px 0' }} />
        <Text strong style={{ display: 'block', marginBottom: 8 }}>{t('Add Custom Library')}</Text>
        <Space>
          <Select 
            value={customPkgLang} 
            onChange={setCustomPkgLang} 
            options={[{ label: 'Python (pip)', value: 'python' }, { label: 'Node.js (npm)', value: 'node' }]}
            style={{ width: 150 }} 
          />
          <Input 
            placeholder={t('Package name (e.g. axios)')} 
            value={customPkgName}
            onChange={(e) => setCustomPkgName(e.target.value)}
            onPressEnter={handleAddPackage}
            style={{ width: 250 }}
          />
          <Button 
            type="primary" 
            onClick={handleAddPackage} 
            loading={addingPkg || initRunning}
            disabled={!customPkgName.trim()}
          >
            {t('Add & Install')}
          </Button>
        </Space>
      </Card>
    </div>
  );
};
