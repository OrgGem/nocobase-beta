import React, { useState } from 'react';
import { Modal, Input, Button, Alert, Typography, Space, Spin } from 'antd';
import { Upload } from '@nocobase/client';
import { useApp } from '@nocobase/client-v2';
import { useT } from '../locale';
import { parseJsonText } from '../utils/jsonFields';

const { TextArea } = Input;

interface SkillTestPanelProps {
  skill: any;
  onClose: () => void;
}

export const SkillTestPanel: React.FC<SkillTestPanelProps> = ({ skill, onClose }) => {
  const api = useApp().apiClient;
  const t = useT();
  const inputSchema = parseJsonText(skill.inputSchema, null);
  const [input, setInput] = useState(
    inputSchema?.properties
      ? JSON.stringify(
          Object.fromEntries(
            Object.keys(inputSchema.properties).map((k) => [k, '']),
          ),
          null,
          2,
        )
      : '{}',
  );
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState('');

  const handleRun = async () => {
    setRunning(true);
    setResult(null);
    setError('');

    let parsedInput;
    try {
      parsedInput = JSON.parse(input);
    } catch {
      setError(t('Invalid JSON input'));
      setRunning(false);
      return;
    }

    try {
      const { data } = await api.request({
        url: 'skillHub:test',
        method: 'POST',
        data: { skillId: skill.id, input: parsedInput },
      });
      const responseData = data?.data?.data || data?.data || data;
      setResult(responseData);
    } catch (err: any) {
      setError(err?.response?.data?.errors?.[0]?.message || err.message || t('Execution failed'));
    } finally {
      setRunning(false);
    }
  };

  return (
    <Modal
      open
      title={`${t('Test Skill')}: ${skill.title}`}
      onCancel={onClose}
      footer={[
        <Button key="close" onClick={onClose}>
          {t('Close')}
        </Button>,
        <Button key="run" type="primary" onClick={handleRun} loading={running}>
          {t('Run')}
        </Button>,
      ]}
      width={640}
      destroyOnClose
    >
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        <div>
          <Typography.Text strong>{t('Input (JSON)')}</Typography.Text>
          <TextArea
            rows={6}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            style={{ fontFamily: 'monospace', fontSize: 13, marginTop: 4 }}
          />
        </div>

        {running && <Spin tip={t('Running skill on worker...')} />}

        {error && <Alert type="error" message={error} showIcon />}

        {result && (
          <>
            <Alert
              type={result.status === 'succeeded' ? 'success' : 'error'}
              message={result.status === 'succeeded' ? t('Succeeded') : t('Failed')}
              description={`Duration: ${result.durationMs || 0}ms`}
              showIcon
            />

            {result.stdout && (
              <div>
                <Typography.Text strong>stdout:</Typography.Text>
                <pre style={{ background: '#f5f5f5', padding: 8, maxHeight: 200, overflow: 'auto', fontSize: 12 }}>
                  {result.stdout}
                </pre>
              </div>
            )}

            {result.stderr && (
              <div>
                <Typography.Text strong type="danger">stderr:</Typography.Text>
                <pre style={{ background: '#fff2f0', padding: 8, maxHeight: 200, overflow: 'auto', fontSize: 12 }}>
                  {result.stderr}
                </pre>
              </div>
            )}

            {result.files?.length > 0 && (
              <div>
                <Typography.Text strong>{t('Output Files')}:</Typography.Text>
                <div style={{ marginTop: 8 }}>
                  <Upload.ReadPretty 
                    value={result.files.map((f: any, i: number) => ({
                      id: `test-${f.name}-${i}`,
                      title: f.name,
                      filename: f.name,
                      extname: f.name.includes('.') ? `.${f.name.split('.').pop()}` : '',
                      url: f.downloadUrl,
                      status: 'done'
                    }))} 
                    multiple={true} 
                    showFileName={true} 
                  />
                </div>
              </div>
            )}
          </>
        )}
      </Space>
    </Modal>
  );
};
