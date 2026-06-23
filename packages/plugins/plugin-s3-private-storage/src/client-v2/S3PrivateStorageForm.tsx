import { EnvVariableInput } from '@nocobase/client-v2';
import {
  BaseUrlField,
  DefaultField,
  FileSizeField,
  MimetypeField,
  NameField,
  ParanoidField,
  PathField,
  RenameModeField,
  TitleField,
} from '@nocobase/plugin-file-manager/client-v2';
import { Form } from 'antd';
import React from 'react';
import { useT } from './locale';

export default function S3PrivateStorageForm() {
  const t = useT();
  const requiredRule = [{ required: true, message: t('The field value is required') }];

  return (
    <>
      <TitleField />
      <NameField />
      <BaseUrlField />
      <Form.Item name={['options', 'region']} label={`${t('Region')} :`} rules={requiredRule}>
        <EnvVariableInput />
      </Form.Item>
      <Form.Item name={['options', 'accessKeyId']} label={`${t('AccessKey ID')} :`} rules={requiredRule}>
        <EnvVariableInput />
      </Form.Item>
      <Form.Item name={['options', 'secretAccessKey']} label={`${t('AccessKey Secret')} :`} rules={requiredRule}>
        <EnvVariableInput password />
      </Form.Item>
      <Form.Item name={['options', 'bucket']} label={`${t('Bucket')} :`} rules={requiredRule}>
        <EnvVariableInput />
      </Form.Item>
      <Form.Item name={['options', 'endpoint']} label={`${t('Endpoint')} :`}>
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
