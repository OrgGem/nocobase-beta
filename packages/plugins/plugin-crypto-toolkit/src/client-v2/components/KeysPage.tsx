import { Button, Popconfirm, Space, Table, Tag, message } from 'antd';
import {
  DeleteOutlined,
  DownloadOutlined,
  ImportOutlined,
  KeyOutlined,
  PlusOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { useApp } from '@nocobase/client-v2';
import React, { useCallback, useEffect, useState } from 'react';
import { useT } from '../locale';
import { getErrorMessage } from '../utils/errors';
import { KeyExportModal } from './KeyExportModal';
import { KeyGenerateModal, type KeyGenerateFormValues } from './KeyGenerateModal';
import { KeyGeneratedModal, type GeneratedKeyResult } from './KeyGeneratedModal';
import { KeyImportModal, type KeyImportFormValues } from './KeyImportModal';

interface CryptoKeyRow {
  id: number;
  name: string;
  displayName?: string;
  kind: string;
  direction: 'own' | 'partner';
  purpose: 'encrypt' | 'sign' | 'both';
  fingerprint: string;
  publicFormat: 'pem' | 'openpgp' | 'openssh' | string;
  publicMaterial: string;
  privateEnvVar?: string | null;
  enabled: boolean;
  createdAt: string;
  notes?: string;
}

const KIND_LABEL: Record<string, string> = {
  'pgp-rsa4096': 'PGP (RSA-4096)',
  'pgp-curve25519': 'PGP (Curve25519)',
  'rsa-4096': 'RSA-4096',
  ed25519: 'Ed25519',
  'ssh-ed25519': 'SSH (Ed25519)',
  'ssh-rsa': 'SSH (RSA)',
};

export const KeysPage: React.FC = () => {
  const t = useT();
  const app = useApp();
  const api = app.apiClient;

  const [rows, setRows] = useState<CryptoKeyRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [generateOpen, setGenerateOpen] = useState(false);
  const [savingGenerate, setSavingGenerate] = useState(false);
  const [generated, setGenerated] = useState<GeneratedKeyResult | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [savingImport, setSavingImport] = useState(false);
  const [exportRec, setExportRec] = useState<CryptoKeyRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.request({
        url: 'cryptoKeys:list',
        params: { paginate: false, sort: ['-createdAt'] },
      });
      const data = (res?.data?.data as CryptoKeyRow[] | undefined) ?? [];
      setRows(data);
    } catch (err) {
      message.error(getErrorMessage(err, t('Failed to load keys') as string));
    } finally {
      setLoading(false);
    }
  }, [api, t]);

  useEffect(() => {
    load();
  }, [load]);

  const onGenerate = async (values: KeyGenerateFormValues) => {
    setSavingGenerate(true);
    try {
      const res = await api.request({
        url: 'cryptoKeys:generate',
        method: 'post',
        data: { ...values, direction: 'own' },
      });
      const data = (res?.data?.data ?? res?.data) as GeneratedKeyResult;
      setGenerated(data);
      setGenerateOpen(false);
      message.success(t('Key generated') as string);
      load();
    } catch (err) {
      message.error(getErrorMessage(err, t('Failed to generate key') as string));
    } finally {
      setSavingGenerate(false);
    }
  };

  const onImport = async (values: KeyImportFormValues) => {
    setSavingImport(true);
    try {
      await api.request({
        url: 'cryptoKeys:importKey',
        method: 'post',
        data: { ...values, direction: 'partner' },
      });
      setImportOpen(false);
      message.success(t('Key imported') as string);
      load();
    } catch (err) {
      message.error(getErrorMessage(err, t('Failed to import key') as string));
    } finally {
      setSavingImport(false);
    }
  };

  const onDelete = async (id: number) => {
    try {
      await api.request({ url: 'cryptoKeys:destroy', method: 'post', params: { filterByTk: id } });
      message.success(t('Key deleted') as string);
      load();
    } catch (err) {
      message.error(getErrorMessage(err, t('Failed to delete key') as string));
    }
  };

  return (
    <div>
      <Space style={{ marginBottom: 12 }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setGenerateOpen(true)}>
          {t('Generate')}
        </Button>
        <Button icon={<ImportOutlined />} onClick={() => setImportOpen(true)}>
          {t('Import')}
        </Button>
        <Button icon={<ReloadOutlined />} onClick={load} loading={loading}>
          {t('Refresh')}
        </Button>
      </Space>

      <Table<CryptoKeyRow>
        rowKey="id"
        loading={loading}
        dataSource={rows}
        pagination={{ pageSize: 20, showSizeChanger: false }}
        scroll={{ x: 1500 }}
        columns={[
          { title: t('Name'), dataIndex: 'name', width: 200 },
          { title: t('Display name'), dataIndex: 'displayName', width: 200, ellipsis: true },
          {
            title: t('Kind'),
            dataIndex: 'kind',
            width: 160,
            render: (v: string) => <Tag>{KIND_LABEL[v] ?? v}</Tag>,
          },
          {
            title: t('Direction'),
            dataIndex: 'direction',
            width: 100,
            render: (v: string) => (
              <Tag color={v === 'own' ? 'geekblue' : 'purple'}>{v === 'own' ? t('Own') : t('Partner')}</Tag>
            ),
          },
          {
            title: t('Purpose'),
            dataIndex: 'purpose',
            width: 100,
            render: (v: string) => {
              const map: Record<string, string> = { encrypt: t('Encrypt'), sign: t('Sign'), both: t('Both') };
              return <Tag>{map[v] ?? v}</Tag>;
            },
          },
          {
            title: t('Fingerprint'),
            dataIndex: 'fingerprint',
            ellipsis: true,
            render: (v: string) => <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{v}</span>,
          },
          {
            title: t('Format'),
            dataIndex: 'publicFormat',
            width: 100,
            render: (v: string) => <Tag color="cyan">{v}</Tag>,
          },
          {
            title: t('Private env var'),
            dataIndex: 'privateEnvVar',
            width: 200,
            render: (v: string | null) =>
              v ? <code style={{ fontSize: 12 }}>{`{{$env.${v}}}`}</code> : <span style={{ color: '#bbb' }}>—</span>,
          },
          { title: t('Created at'), dataIndex: 'createdAt', width: 180 },
          {
            title: t('Actions'),
            width: 200,
            render: (_: unknown, record) => (
              <Space>
                <Button
                  size="small"
                  icon={<DownloadOutlined />}
                  onClick={() => setExportRec(record)}
                  title={t('Export') as string}
                />
                <Popconfirm
                  title={t('Delete this key?') as string}
                  description={t('This will also delete the associated environment variables.') as string}
                  onConfirm={() => onDelete(record.id)}
                  okText={t('Yes') as string}
                  cancelText={t('No') as string}
                >
                  <Button size="small" danger icon={<DeleteOutlined />} />
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />

      <KeyGenerateModal
        open={generateOpen}
        saving={savingGenerate}
        onClose={() => setGenerateOpen(false)}
        onSubmit={onGenerate}
      />

      <KeyGeneratedModal open={!!generated} result={generated} onClose={() => setGenerated(null)} />

      <KeyImportModal
        open={importOpen}
        saving={savingImport}
        onClose={() => setImportOpen(false)}
        onSubmit={onImport}
      />

      <KeyExportModal open={!!exportRec} record={exportRec} onClose={() => setExportRec(null)} />

      {rows.length === 0 && !loading && (
        <div style={{ textAlign: 'center', color: '#999', marginTop: 32 }}>
          <KeyOutlined style={{ fontSize: 32, marginBottom: 8 }} />
          <div>{t('No keys yet — generate or import one to get started')}</div>
        </div>
      )}
    </div>
  );
};

export default KeysPage;
