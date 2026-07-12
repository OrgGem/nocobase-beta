/**
 * MSSQL V2 Configuration Form — connection settings UI.
 */

import React, { useCallback, useState } from 'react';
import { Checkbox, Form, Input, InputNumber, Select } from 'antd';
import { useTranslation } from 'react-i18next';

interface MssqlV2ConfigFormProps {
  mode: 'create' | 'edit';
  type: Record<string, any>;
  initialValues?: Record<string, any>;
  loadCollections: (key: string) => Promise<any>;
}

function toCollectionOptions(result: any): { label: string; value: string }[] {
  const list = result?.data?.data ?? result?.data ?? result ?? [];
  if (!Array.isArray(list)) return [];
  return list.map((item: any) => {
    const name = typeof item === 'string' ? item : item?.name;
    return { label: name, value: name };
  });
}

export const MssqlV2ConfigForm: React.FC<MssqlV2ConfigFormProps> = ({ initialValues, loadCollections }) => {
  const { t } = useTranslation();
  const form = Form.useFormInstance();
  const addAllCollections = Form.useWatch('addAllCollections', form);
  const [collectionOptions, setCollectionOptions] = useState<{ label: string; value: string }[]>([]);
  const [loading, setLoading] = useState(false);

  const handleLoadCollections = useCallback(async () => {
    setLoading(true);
    try {
      const result = await loadCollections(initialValues?.key);
      setCollectionOptions(toCollectionOptions(result));
    } finally {
      setLoading(false);
    }
  }, [loadCollections, initialValues?.key]);

  return (
    <>
      <Form.Item name={['options', 'server']} label={t('Server')} rules={[{ required: true }]}>
        <Input placeholder="localhost or server\\instance" />
      </Form.Item>
      <Form.Item name={['options', 'port']} label={t('Port')} initialValue={1433}>
        <InputNumber min={1} max={65535} style={{ width: '100%' }} />
      </Form.Item>
      <Form.Item name={['options', 'database']} label={t('Database')} rules={[{ required: true }]}>
        <Input />
      </Form.Item>
      <Form.Item name={['options', 'schema']} label={t('Schema')} initialValue="dbo">
        <Input />
      </Form.Item>
      <Form.Item name={['options', 'authType']} label={t('Authentication')} initialValue="tedious">
        <Select
          options={[
            { label: 'SQL Server (tedious)', value: 'tedious' },
            { label: 'Windows (SSPI)', value: 'sspi' },
            { label: 'Azure AD / Entra ID', value: 'msentra' },
          ]}
        />
      </Form.Item>
      <Form.Item name={['options', 'username']} label={t('Username')}>
        <Input />
      </Form.Item>
      <Form.Item name={['options', 'password']} label={t('Password')}>
        <Input.Password />
      </Form.Item>
      <Form.Item name={['options', 'encrypt']} label={t('Encrypt')} valuePropName="checked">
        <Checkbox />
      </Form.Item>
      <Form.Item name={['options', 'trustServerCertificate']} label={t('Trust Server Certificate')} valuePropName="checked">
        <Checkbox />
      </Form.Item>
      <Form.Item name="addAllCollections" label={t('Load all collections')} valuePropName="checked" initialValue={true}>
        <Checkbox />
      </Form.Item>
      {!addAllCollections ? (
        <Form.Item name="collections" label={t('Collections')}>
          <Select
            mode="multiple"
            allowClear
            loading={loading}
            options={collectionOptions}
            onFocus={handleLoadCollections}
            optionFilterProp="label"
          />
        </Form.Item>
      ) : null}
    </>
  );
};

export default MssqlV2ConfigForm;
