/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Plugin } from '@nocobase/client';
// @ts-ignore
import { PluginFileManagerClient } from "@nocobase/plugin-file-manager";
import { NAMESPACE } from '../constants';

const STORAGE_NS = 'file-manager';

const s3PrivateStorageType = {
  title: `{{t("Amazon S3 (Private)", { ns: "${STORAGE_NS}" })}}`,
  name: 's3-private',
  fieldset: {
    title: {
      'x-component': 'CollectionField',
      'x-decorator': 'FormItem',
    },
    name: {
      'x-component': 'CollectionField',
      'x-decorator': 'FormItem',
      'x-disabled': '{{ !createOnly }}',
      required: true,
      default: '{{ useNewId("s_") }}',
      description:
        '{{t("Randomly generated and can be modified. Support letters, numbers and underscores, must start with an letter.")}}',
    },
    options: {
      type: 'object',
      'x-component': 'fieldset',
      properties: {
        region: {
          title: `{{t("Region", { ns: "${STORAGE_NS}" })}}`,
          type: 'string',
          'x-decorator': 'FormItem',
          'x-component': 'TextAreaWithGlobalScope',
          required: true,
        },
        accessKeyId: {
          title: `{{t("AccessKey ID", { ns: "${STORAGE_NS}" })}}`,
          type: 'string',
          'x-decorator': 'FormItem',
          'x-component': 'TextAreaWithGlobalScope',
          description: `{{t("Optional. Leave blank to use IAM role / default credential chain (e.g. EC2 with same-account bucket).", { ns: "${STORAGE_NS}" })}}`,
        },
        secretAccessKey: {
          title: `{{t("AccessKey Secret", { ns: "${STORAGE_NS}" })}}`,
          type: 'string',
          'x-decorator': 'FormItem',
          'x-component': 'TextAreaWithGlobalScope',
          'x-component-props': { password: true },
          description: `{{t("Optional. Required when accessKeyId is provided.", { ns: "${STORAGE_NS}" })}}`,
        },
        bucket: {
          title: `{{t("Bucket", { ns: "${STORAGE_NS}" })}}`,
          type: 'string',
          'x-decorator': 'FormItem',
          'x-component': 'TextAreaWithGlobalScope',
          required: true,
        },
        endpoint: {
          title: `{{t("Endpoint", { ns: "${STORAGE_NS}" })}}`,
          type: 'string',
          'x-decorator': 'FormItem',
          'x-component': 'TextAreaWithGlobalScope',
          description: `{{t("Optional. Custom endpoint for S3-compatible services (e.g., MinIO).", { ns: "${STORAGE_NS}" })}}`,
        },
        roleArn: {
          title: `{{t("Role ARN", { ns: "${STORAGE_NS}" })}}`,
          type: 'string',
          'x-decorator': 'FormItem',
          'x-component': 'TextAreaWithGlobalScope',
          description: `{{t("Optional. IAM role ARN to assume (e.g., for cross-account access).", { ns: "${STORAGE_NS}" })}}`,
        },
        roleSessionName: {
          title: `{{t("Role Session Name", { ns: "${STORAGE_NS}" })}}`,
          type: 'string',
          'x-decorator': 'FormItem',
          'x-component': 'TextAreaWithGlobalScope',
          description: `{{t("Optional. Role session name for STS AssumeRole.", { ns: "${STORAGE_NS}" })}}`,
        },
        externalId: {
          title: `{{t("External ID", { ns: "${STORAGE_NS}" })}}`,
          type: 'string',
          'x-decorator': 'FormItem',
          'x-component': 'TextAreaWithGlobalScope',
          description: `{{t("Optional. External ID for STS AssumeRole.", { ns: "${STORAGE_NS}" })}}`,
        },
      },
    },
    path: {
      'x-component': 'CollectionField',
      'x-decorator': 'FormItem',
      description: `{{t('Relative path the file will be saved to. Left blank as root path. The leading and trailing slashes "/" will be ignored. For example: "user/avatar".', { ns: "${STORAGE_NS}" })}}`,
    },
    rules: {
      type: 'object',
      'x-component': 'fieldset',
      properties: {
        size: {
          type: 'number',
          title: `{{t("File size limit", { ns: "${STORAGE_NS}" })}}`,
          description: `{{t("Minimum from 1 byte.", { ns: "${STORAGE_NS}" })}}`,
          'x-decorator': 'FormItem',
          'x-component': 'FileSizeField',
          required: true,
          default: 1024 * 1024 * 20,
        },
        mimetype: {
          type: 'string',
          title: `{{t("File type (in MIME type format)", { ns: "${STORAGE_NS}" })}}`,
          description: `{{t('Multi-types seperated with comma, for example: "image/*", "image/png", "image/*, application/pdf" etc.', { ns: "${STORAGE_NS}" })}}`,
          'x-decorator': 'FormItem',
          'x-component': 'Input',
          'x-component-props': {
            placeholder: '*',
          },
        },
      },
    },
    default: {
      'x-component': 'CollectionField',
      'x-decorator': 'FormItem',
      'x-content': `{{t("Default storage", { ns: "${STORAGE_NS}" })}}`,
    },
    paranoid: {
      'x-component': 'CollectionField',
      'x-decorator': 'FormItem',
      'x-content': `{{t("Keep file in storage when destroy the file record", { ns: "${STORAGE_NS}" })}}`,
    },
  },
};

export class PluginS3PrivateStorageClient extends Plugin {
  async load() {
    // @ts-ignore
    const fileManagerPlugin = this.app.pm.get(PluginFileManagerClient) as any;
    if (fileManagerPlugin) {
      fileManagerPlugin.registerStorageType('s3-private', s3PrivateStorageType);
    }
  }
}

export default PluginS3PrivateStorageClient;

