import { Alert, Input, Radio, Select, Space, Tag, Upload, message } from 'antd';
import { InboxOutlined, KeyOutlined } from '@ant-design/icons';
import React, { useEffect, useMemo, useState } from 'react';
import { useApp } from '@nocobase/client-v2';
import { useT } from '../locale';

export type KeyInputMode = 'text' | 'attachment' | 'env';

export interface KeyInputValue {
  mode: KeyInputMode;
  text?: string;
  attachmentId?: number | null;
  envVar?: string;
}

export interface EnvVariableOption {
  name: string;
  type?: string;
}

const PRIVATE_MATERIAL_RE = /-----BEGIN [^-]*PRIVATE KEY( BLOCK)?-----/;

export interface KeyInputProps {
  value?: KeyInputValue;
  onChange?: (value: KeyInputValue) => void;
  /** If true, the input is for an own private key — defaults mode to 'env' and warns on text/upload. */
  acceptPrivate?: boolean;
  disabled?: boolean;
  textPlaceholder?: string;
}

const DEFAULT_VALUE: KeyInputValue = { mode: 'text', text: '' };

function detectFormat(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (/-----BEGIN PGP PUBLIC KEY BLOCK-----/.test(trimmed)) return 'openpgp';
  if (/-----BEGIN [^-]+-----/.test(trimmed)) return 'pem';
  if (/^ssh-[a-z0-9-]+ /.test(trimmed)) return 'openssh';
  if (PRIVATE_MATERIAL_RE.test(trimmed)) return 'private';
  return null;
}

export const KeyInput: React.FC<KeyInputProps> = ({
  value,
  onChange,
  acceptPrivate = false,
  disabled,
  textPlaceholder,
}) => {
  const t = useT();
  const app = useApp();
  const api = app.apiClient;
  const [envVariables, setEnvVariables] = useState<EnvVariableOption[]>([]);
  const [uploading, setUploading] = useState(false);

  const current = value ?? DEFAULT_VALUE;

  useEffect(() => {
    if (current.mode !== 'env') return;
    let cancelled = false;
    api
      .request({ url: 'environmentVariables:list', params: { paginate: false } })
      .then((res) => {
        if (cancelled) return;
        const list = (res?.data?.data as EnvVariableOption[] | undefined) ?? [];
        setEnvVariables(list);
      })
      .catch(() => {
        if (cancelled) return;
        setEnvVariables([]);
      });
    return () => {
      cancelled = true;
    };
  }, [api, current.mode]);

  const detected = useMemo(() => {
    if (current.mode !== 'text' || !current.text) return null;
    return detectFormat(current.text);
  }, [current.mode, current.text]);

  const warnPrivate =
    !acceptPrivate &&
    (detected === 'private' || (current.mode === 'text' && current.text && PRIVATE_MATERIAL_RE.test(current.text)));

  const update = (patch: Partial<KeyInputValue>) => {
    onChange?.({ ...current, ...patch });
  };

  const handleUpload = async (file: File): Promise<boolean> => {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await api.request({
        url: 'attachments:create',
        method: 'post',
        data: fd,
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      const attachment = res?.data?.data;
      if (!attachment?.id) throw new Error('attachment upload failed');
      update({ attachmentId: attachment.id });
      message.success(file.name);
    } catch (err) {
      const msg = (err as { message?: string })?.message ?? 'Upload failed';
      message.error(msg);
    } finally {
      setUploading(false);
    }
    return false; // prevent antd default submit
  };

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Radio.Group
        value={current.mode}
        onChange={(e) => update({ mode: e.target.value as KeyInputMode })}
        disabled={disabled}
        aria-label="Key input mode"
      >
        <Radio.Button value="text">{t('Pasted text')}</Radio.Button>
        <Radio.Button value="attachment">{t('Upload file')}</Radio.Button>
        <Radio.Button value="env">{t('Environment variable')}</Radio.Button>
      </Radio.Group>

      {current.mode === 'text' && (
        <div>
          <Input.TextArea
            value={current.text ?? ''}
            onChange={(e) => update({ text: e.target.value })}
            disabled={disabled}
            placeholder={textPlaceholder ?? '-----BEGIN PUBLIC KEY----- ...'}
            autoSize={{ minRows: 6, maxRows: 16 }}
            style={{ fontFamily: 'monospace' }}
            aria-label="Pasted key material"
          />
          {detected && detected !== 'private' && (
            <Tag color="blue" style={{ marginTop: 8 }}>
              {detected}
            </Tag>
          )}
        </div>
      )}

      {current.mode === 'attachment' && (
        <Upload.Dragger
          name="file"
          multiple={false}
          beforeUpload={handleUpload}
          showUploadList={false}
          disabled={disabled || uploading}
        >
          <p className="ant-upload-drag-icon">
            <InboxOutlined />
          </p>
          <p className="ant-upload-text">{t('Upload file')}</p>
          {current.attachmentId != null && <p className="ant-upload-hint">attachment #{current.attachmentId}</p>}
        </Upload.Dragger>
      )}

      {current.mode === 'env' && (
        <Select
          value={current.envVar ?? undefined}
          onChange={(envVar) => update({ envVar })}
          disabled={disabled}
          showSearch
          placeholder={t('Select environment variable') as string}
          style={{ width: '100%' }}
          aria-label="Environment variable"
          notFoundContent={t('No environment variables available') as string}
          options={envVariables.map((env) => ({
            value: env.name,
            label: (
              <Space>
                <KeyOutlined />
                <span style={{ fontFamily: 'monospace' }}>{`{{$env.${env.name}}}`}</span>
                <Tag color={env.type === 'secret' ? 'red' : 'blue'} style={{ fontSize: 10, margin: 0 }}>
                  {env.type ?? 'default'}
                </Tag>
              </Space>
            ),
          }))}
        />
      )}

      {warnPrivate && (
        <Alert
          showIcon
          type="error"
          message={
            t(
              'Private key material detected — partner keys cannot contain private material. Use Generate to create own keys.',
            ) as string
          }
        />
      )}

      {acceptPrivate && (current.mode === 'text' || current.mode === 'attachment') && (
        <Alert
          showIcon
          type="warning"
          message={t('Prefer storing private material in a secret environment variable') as string}
        />
      )}
    </Space>
  );
};

export default KeyInput;
