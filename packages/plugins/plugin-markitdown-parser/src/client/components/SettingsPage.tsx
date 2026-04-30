import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Card, Descriptions, Space, Spin, Tag, Typography, message } from 'antd';
import { CheckCircleOutlined, ReloadOutlined, WarningOutlined } from '@ant-design/icons';
import { useAPIClient } from '@nocobase/client';
import { useMarkItDownParserTranslation } from '../locale';

const { Text } = Typography;

type RuntimeInfo = {
  command: string;
  baseArgs: string[];
  builtinSourcePath: string;
  builtinRunnerPath: string;
  enablePlugins: boolean;
  timeoutMs: number;
  maxOutputBytes: number;
  supportedExtnames: string[];
};

type CheckResult = RuntimeInfo & {
  available: boolean;
  message: string;
};

export const SettingsPage: React.FC = () => {
  const api = useAPIClient();
  const { t } = useMarkItDownParserTranslation();
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [check, setCheck] = useState<CheckResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);

  const loadRuntime = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.request({ url: 'markitdown:getRuntime' });
      setRuntime(res?.data?.data);
    } catch (err: any) {
      message.error(err?.message || t('Failed to load runtime settings'));
    } finally {
      setLoading(false);
    }
  }, [api, t]);

  const runCheck = async () => {
    setChecking(true);
    try {
      const res = await api.request({ url: 'markitdown:check', method: 'POST' });
      setCheck(res?.data?.data);
    } catch (err: any) {
      message.error(err?.message || t('Availability check failed'));
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    // eslint-disable-next-line promise/catch-or-return
    loadRuntime();
  }, [loadRuntime]);

  if (loading) return <Spin style={{ display: 'block', margin: '40px auto' }} />;

  return (
    <Card bordered={false}>
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        {check && (
          <Alert
            type={check.available ? 'success' : 'warning'}
            icon={check.available ? <CheckCircleOutlined /> : <WarningOutlined />}
            showIcon
            message={check.available ? t('MarkItDown is available') : t('MarkItDown is not available')}
            description={<Text>{check.message}</Text>}
          />
        )}

        <Descriptions column={1} size="small" bordered>
          <Descriptions.Item label={t('Command')}>{runtime?.command}</Descriptions.Item>
          <Descriptions.Item label={t('Base arguments')}>
            {runtime?.baseArgs?.length ? runtime.baseArgs.join(' ') : '-'}
          </Descriptions.Item>
          <Descriptions.Item label={t('Bundled source')}>{runtime?.builtinSourcePath || '-'}</Descriptions.Item>
          <Descriptions.Item label={t('Plugins enabled')}>
            {runtime?.enablePlugins ? <Tag color="green">true</Tag> : <Tag>false</Tag>}
          </Descriptions.Item>
          <Descriptions.Item label={t('Timeout')}>{runtime?.timeoutMs}ms</Descriptions.Item>
          <Descriptions.Item label={t('Max output')}>{runtime?.maxOutputBytes} bytes</Descriptions.Item>
          <Descriptions.Item label={t('Extensions')}>
            <Space wrap>
              {runtime?.supportedExtnames?.length ? (
                runtime.supportedExtnames.map((ext) => <Tag key={ext}>{ext}</Tag>)
              ) : (
                <Tag>*</Tag>
              )}
            </Space>
          </Descriptions.Item>
        </Descriptions>

        <Space>
          <Button icon={<ReloadOutlined />} onClick={loadRuntime}>
            {t('Reload')}
          </Button>
          <Button type="primary" icon={<CheckCircleOutlined />} onClick={runCheck} loading={checking}>
            {t('Check availability')}
          </Button>
        </Space>
      </Space>
    </Card>
  );
};
