import { EnvVariableInput } from '@nocobase/client-v2';
import {
  DefaultField,
  FileSizeField,
  MimetypeField,
  NameField,
  ParanoidField,
  PathField,
  RenameModeField,
  TitleField,
} from '@nocobase/plugin-file-manager/client-v2';
import { Form, Input, InputNumber, Select } from 'antd';
import React from 'react';
import { useTranslation } from 'react-i18next';

export default function SftpPrivateStorageForm() {
  const { t } = useTranslation('plugin-sftp-private-storage');
  const authMethod = Form.useWatch(['options', 'authMethod']);

  return (
    <>
      <TitleField />
      <NameField />
      <Form.Item name={['options', 'host']} label={t('Host')} rules={[{ required: true }]}>
        <EnvVariableInput />
      </Form.Item>
      <Form.Item name={['options', 'port']} label={t('Port')} rules={[{ required: true }]}>
        <InputNumber min={1} max={65535} />
      </Form.Item>
      <Form.Item name={['options', 'username']} label={t('Username')} rules={[{ required: true }]}>
        <EnvVariableInput />
      </Form.Item>
      <Form.Item name={['options', 'authMethod']} label={t('Authentication Method')}>
        <Select
          options={[
            { label: t('Password'), value: 'password' },
            { label: t('Private Key'), value: 'privateKey' },
          ]}
        />
      </Form.Item>
      {authMethod === 'privateKey' ? (
        <>
          <Form.Item
            name={['options', 'privateKey']}
            label={t('Private Key')}
            extra={t('PEM format private key content')}
          >
            <Input.TextArea rows={6} />
          </Form.Item>
          <Form.Item name={['options', 'passphrase']} label={t('Passphrase')}>
            <EnvVariableInput password />
          </Form.Item>
        </>
      ) : (
        <Form.Item name={['options', 'password']} label={t('Password')}>
          <EnvVariableInput password />
        </Form.Item>
      )}
      <Form.Item name={['options', 'basePath']} label={t('Base Path')}>
        <EnvVariableInput />
      </Form.Item>
      <PathField />
      <RenameModeField />
      <FileSizeField />
      <MimetypeField />
      <DefaultField />
      <ParanoidField />
    </>
  );
}
