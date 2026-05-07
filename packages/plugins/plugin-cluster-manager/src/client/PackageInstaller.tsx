import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Card, Form, Input, Button, Alert, Progress, Tag, Typography, Space, Divider, message, Select } from 'antd';
import { CloudServerOutlined, SafetyOutlined, ReloadOutlined } from '@ant-design/icons';
import { useAPIClient } from '@nocobase/client';
import { useT } from './utils';
import {
  DEFAULT_WORKER_PACKAGES,
  formatPackageText,
  parsePackageText,
  packagesFromConfig,
  type WorkerPackageMap,
} from '../shared/packages';

const { Text } = Typography;

const STATUS_MAP: Record<string, { color: string; text: string }> = {
  pending: { color: 'default', text: 'Not initialized' },
  running: { color: 'processing', text: 'Running...' },
  succeeded: { color: 'success', text: 'Succeeded' },
  failed: { color: 'error', text: 'Failed' },
};

function buildInstallPackages(values: any): WorkerPackageMap {
  return packagesFromConfig(values || {});
}

function renderPackageTags(packages: string[], color?: string) {
  if (!packages.length) {
    return <Text type="secondary">-</Text>;
  }
  return packages.map((pkg) => (
    <Tag key={pkg} color={color} style={{ marginBottom: 2 }}>
      {pkg}
    </Tag>
  ));
}

export const PackageInstaller: React.FC = () => {
  const t = useT();
  const api = useAPIClient();
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [initRunning, setInitRunning] = useState(false);
  const [config, setConfig] = useState<any>(null);
  const [progress, setProgress] = useState<{ percent: number; log: string } | null>(null);
  const [targetRole, setTargetRole] = useState<'app' | 'worker' | 'all'>('all');

  const aptPackagesValue = Form.useWatch('aptPackages', form);
  const pythonPackagesValue = Form.useWatch('pythonPackages', form);
  const npmPackagesValue = Form.useWatch('npmPackages', form);

  const isFetching = useRef(false);

  const loadConfig = useCallback(async (silent = false) => {
    if (isFetching.current) return;
    isFetching.current = true;
    if (!silent) setLoading(true);
    try {
      const { data } = await api.request({ url: 'workerPackages:getPackageConfig' });
      const cfg = data?.data?.data || data?.data;
      if (cfg) {
        try {
          cfg.packageWhitelist =
            typeof cfg.packageWhitelist === 'string' ? JSON.parse(cfg.packageWhitelist) : cfg.packageWhitelist;
        } catch {
          cfg.packageWhitelist = { python: [], node: [], apt: [] };
        }
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
          aptPackages: parsePackageText(cfg.aptPackages, DEFAULT_WORKER_PACKAGES.apt),
          pythonPackages: parsePackageText(cfg.pythonPackages, DEFAULT_WORKER_PACKAGES.python),
          npmPackages: parsePackageText(cfg.npmPackages, DEFAULT_WORKER_PACKAGES.npm),
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
      // Config may not exist yet.
    } finally {
      if (!silent) setLoading(false);
      isFetching.current = false;
    }
  }, [api, form, t]);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  useEffect(() => {
    const interval = setInterval(() => loadConfig(true), 10000);
    return () => clearInterval(interval);
  }, [loadConfig]);

  const saveConfigValues = async (values: any) => {
    const payload = {
      ...values,
      aptPackages: formatPackageText(values.aptPackages),
      pythonPackages: formatPackageText(values.pythonPackages),
      npmPackages: formatPackageText(values.npmPackages),
    };

    if (config?.id) {
      await api.request({
        url: 'workerPackages:savePackageConfig',
        method: 'post',
        params: { filterByTk: config.id },
        data: payload,
      });
    } else {
      await api.request({
        url: 'workerPackages:savePackageConfig',
        method: 'post',
        data: payload,
      });
    }
  };

  const handleSaveConfig = async () => {
    setSaving(true);
    try {
      const values = form.getFieldsValue();
      await saveConfigValues(values);
      message.success(t('Config saved'));
      await loadConfig();
    } catch {
      message.error(t('Failed to save config'));
    } finally {
      setSaving(false);
    }
  };

  const handleInitEnv = async () => {
    setInitRunning(true);
    setProgress({ percent: 0, log: t('Dispatching to target nodes...') });
    try {
      const values = form.getFieldsValue();
      await saveConfigValues(values);
      await api.request({
        url: 'workerPackages:installPackages',
        method: 'post',
        data: {
          targetRole,
          packages: buildInstallPackages(values),
          registryConfig: {
            aptMirrorUrl: values.aptMirrorUrl,
            npmRegistryUrl: values.npmRegistryUrl,
            pypiIndexUrl: values.pypiIndexUrl,
            pypiTrustedHost: values.pypiTrustedHost,
          },
        },
      });
      message.info(t('Install task dispatched'));
      await loadConfig();
    } catch (err: any) {
      message.error(err?.message || t('Failed to install packages/modules'));
      setInitRunning(false);
      setProgress(null);
    }
  };

  const statusInfo = STATUS_MAP[config?.initStatus] || STATUS_MAP.pending;
  const whitelist = config?.packageWhitelist || {};
  const hasWhitelist = whitelist?.python?.length > 0 || whitelist?.node?.length > 0 || whitelist?.apt?.length > 0;
  const installPlan = packagesFromConfig({
    aptPackages: aptPackagesValue ?? DEFAULT_WORKER_PACKAGES.apt,
    pythonPackages: pythonPackagesValue ?? DEFAULT_WORKER_PACKAGES.python,
    npmPackages: npmPackagesValue ?? DEFAULT_WORKER_PACKAGES.npm,
  });

  return (
    <div style={{ padding: 16, maxWidth: 920 }}>
      <Card
        title={
          <Space>
            <CloudServerOutlined />
            <span>{t('Cluster Package Installer')}</span>
          </Space>
        }
        size="small"
        style={{ marginBottom: 16 }}
        extra={
          <Button icon={<ReloadOutlined />} size="small" onClick={() => loadConfig(false)} loading={loading}>
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

          <div>
            <Text strong style={{ marginRight: 8 }}>{t('Target')}: </Text>
            <Select
              value={targetRole}
              onChange={setTargetRole}
              style={{ width: 240 }}
              options={[
                { label: t('All app and worker nodes'), value: 'all' },
                { label: t('App nodes only'), value: 'app' },
                { label: t('Worker nodes only'), value: 'worker' },
              ]}
            />
          </div>

          <Alert
            type="info"
            showIcon
            message={t('Each target node checks whether a package/module is already installed before installing it.')}
          />

          <Space>
            <Button
              type="primary"
              icon={initRunning ? <ReloadOutlined spin /> : <CloudServerOutlined />}
              onClick={() => handleInitEnv()}
              size="large"
            >
              {initRunning ? t('Installing... (Click to Force Run)') : t('Install packages/modules')}
            </Button>
            
            {initRunning && (
              <Button
                danger
                onClick={async () => {
                  try {
                    await api.request({ url: 'workerPackages:resetInitStatus', method: 'post' });
                    message.success(t('Install status reset to stopped'));
                    await loadConfig();
                  } catch {
                    message.error(t('Failed to stop installation'));
                  }
                }}
                size="large"
              >
                {t('Stop / Reset Status')}
              </Button>
            )}
          </Space>

          {initRunning && progress && (
            <div>
              <Progress percent={progress.percent} status="active" />
              <Text type="secondary">{progress.log}</Text>
            </div>
          )}

          {config?.lastInitLog && config.initStatus !== 'running' && (
            <div>
              <Text strong>{t('Last Install Log')}:</Text>
              <pre style={{
                background: '#f5f5f5',
                padding: 8,
                borderRadius: 4,
                fontSize: 11,
                maxHeight: 220,
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

      <Card title={t('Package/module settings')} size="small" style={{ marginBottom: 16 }}>
        <Form form={form} layout="vertical">
          <Form.Item name="aptPackages" label={t('OS packages (APT)')}>
            <Select mode="tags" style={{ width: '100%' }} placeholder="python3, python3-pip" tokenSeparators={[',', '\n', ' ']} />
          </Form.Item>
          <Form.Item name="pythonPackages" label={t('Python modules (pip)')}>
            <Select mode="tags" style={{ width: '100%' }} placeholder="python-docx, openpyxl" tokenSeparators={[',', '\n', ' ']} />
          </Form.Item>
          <Form.Item name="npmPackages" label={t('Node modules (npm global)')}>
            <Select mode="tags" style={{ width: '100%' }} placeholder="xlsx, docx" tokenSeparators={[',', '\n', ' ']} />
          </Form.Item>

          <Divider style={{ margin: '8px 0 16px' }} />
          <Form.Item name="aptMirrorUrl" label={t('APT mirror URL')}>
            <Input placeholder="https://deb.debian.org/debian" />
          </Form.Item>
          <Form.Item name="npmRegistryUrl" label={t('NPM registry URL')}>
            <Input placeholder="https://registry.npmjs.org/" />
          </Form.Item>
          <Form.Item name="pypiIndexUrl" label={t('PyPI index URL')}>
            <Input placeholder="https://pypi.org/simple" />
          </Form.Item>

          <Button type="primary" onClick={handleSaveConfig} loading={saving}>
            {t('Save settings')}
          </Button>
        </Form>

        <Divider style={{ margin: '16px 0' }} />
        <Text strong>{t('Install plan')}:</Text>
        <div style={{ marginTop: 8 }}>
          <Text type="secondary">APT: </Text>
          {renderPackageTags(installPlan.apt || [])}
        </div>
        <div style={{ marginTop: 4 }}>
          <Text type="secondary">Python: </Text>
          {renderPackageTags(installPlan.python || [], 'blue')}
        </div>
        <div style={{ marginTop: 4 }}>
          <Text type="secondary">Node: </Text>
          {renderPackageTags(installPlan.npm || [], 'green')}
        </div>
      </Card>

      <Card
        title={
          <Space>
            <SafetyOutlined />
            <span>{t('Installed package/module whitelist')}</span>
          </Space>
        }
        size="small"
      >
        {hasWhitelist ? (
          <Space direction="vertical" style={{ width: '100%' }}>
            {whitelist?.apt?.length > 0 && (
              <div>
                <Text strong>APT: </Text>
                {renderPackageTags(whitelist.apt)}
              </div>
            )}
            {whitelist?.python?.length > 0 && (
              <div>
                <Text strong>Python: </Text>
                {renderPackageTags(whitelist.python, 'blue')}
              </div>
            )}
            {whitelist?.node?.length > 0 && (
              <div>
                <Text strong>Node: </Text>
                {renderPackageTags(whitelist.node, 'green')}
              </div>
            )}
          </Space>
        ) : (
          <Alert
            type="warning"
            showIcon
            message={t('No successful install has generated a whitelist yet.')}
          />
        )}
      </Card>
    </div>
  );
};
