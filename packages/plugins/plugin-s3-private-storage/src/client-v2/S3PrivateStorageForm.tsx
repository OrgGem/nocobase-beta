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
      <Form.Item
        name={['options', 'accessKeyId']}
        label={`${t('AccessKey ID')} :`}
        extra={t(
          'Optional. Leave blank to use IAM role / default credential chain (e.g. EC2 with same-account bucket).',
        )}
      >
        <EnvVariableInput />
      </Form.Item>
      <Form.Item
        name={['options', 'secretAccessKey']}
        label={`${t('AccessKey Secret')} :`}
        extra={t('Optional. Required when AccessKey ID is provided.')}
      >
        <EnvVariableInput password />
      </Form.Item>
      <Form.Item name={['options', 'bucket']} label={`${t('Bucket')} :`} rules={requiredRule}>
        <EnvVariableInput />
      </Form.Item>
      <Form.Item name={['options', 'endpoint']} label={`${t('Endpoint')} :`}>
        <EnvVariableInput />
      </Form.Item>
      <Form.Item
        name={['options', 'roleArn']}
        label={`${t('Role ARN')} :`}
        extra={t('Optional. IAM role ARN to assume (e.g., for cross-account access).')}
      >
        <EnvVariableInput />
      </Form.Item>
      <Form.Item
        name={['options', 'roleSessionName']}
        label={`${t('Role Session Name')} :`}
        extra={t('Optional. Role session name for STS AssumeRole.')}
      >
        <EnvVariableInput />
      </Form.Item>
      <Form.Item
        name={['options', 'externalId']}
        label={`${t('External ID')} :`}
        extra={t('Optional. External ID for STS AssumeRole.')}
      >
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
