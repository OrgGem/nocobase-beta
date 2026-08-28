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
import { STORAGE_TYPE_SFTP_PRIVATE } from '../constants';

const STORAGE_NS = 'file-manager';

const sftpPrivateStorageType = {
  title: `{{t("SFTP (Private)", { ns: "${STORAGE_NS}" })}}`,
  name: STORAGE_TYPE_SFTP_PRIVATE,
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
        host: {
          title: `{{t("Host", { ns: "${STORAGE_NS}" })}}`,
          type: 'string',
          'x-decorator': 'FormItem',
          'x-component': 'TextAreaWithGlobalScope',
          required: true,
        },
        port: {
          title: `{{t("Port", { ns: "${STORAGE_NS}" })}}`,
          type: 'number',
          'x-decorator': 'FormItem',
          'x-component': 'InputNumber',
          default: 22,
          required: true,
        },
        username: {
          title: `{{t("Username", { ns: "${STORAGE_NS}" })}}`,
          type: 'string',
          'x-decorator': 'FormItem',
          'x-component': 'TextAreaWithGlobalScope',
          required: true,
        },
        authMethod: {
          title: `{{t("Authentication method", { ns: "${STORAGE_NS}" })}}`,
          type: 'string',
          'x-decorator': 'FormItem',
          'x-component': 'Select',
          enum: [
            { label: `{{t("Password", { ns: "${STORAGE_NS}" })}}`, value: 'password' },
            { label: `{{t("Private key", { ns: "${STORAGE_NS}" })}}`, value: 'privateKey' },
          ],
          default: 'password',
        },
        password: {
          title: `{{t("Password", { ns: "${STORAGE_NS}" })}}`,
          type: 'string',
          'x-decorator': 'FormItem',
          'x-component': 'TextAreaWithGlobalScope',
          'x-component-props': { password: true },
        },
        privateKey: {
          title: `{{t("Private key", { ns: "${STORAGE_NS}" })}}`,
          type: 'string',
          'x-decorator': 'FormItem',
          'x-component': 'TextAreaWithGlobalScope',
        },
        passphrase: {
          title: `{{t("Passphrase", { ns: "${STORAGE_NS}" })}}`,
          type: 'string',
          'x-decorator': 'FormItem',
          'x-component': 'TextAreaWithGlobalScope',
          'x-component-props': { password: true },
        },
        basePath: {
          title: `{{t("Base path", { ns: "${STORAGE_NS}" })}}`,
          type: 'string',
          'x-decorator': 'FormItem',
          'x-component': 'TextAreaWithGlobalScope',
          default: '/',
          description: `{{t("Base directory on the SFTP server.", { ns: "${STORAGE_NS}" })}}`,
        },
      },
    },
    path: {
      'x-component': 'CollectionField',
      'x-decorator': 'FormItem',
      description: `{{t('Relative path the file will be saved to. Left blank as root path. The leading and trailing slashes "/" will be ignored. For example: "user/avatar".', { ns: "${STORAGE_NS}" })}}`,
    },
    renameMode: {
      title: `{{t("Renaming", { ns: "${STORAGE_NS}" })}}`,
      description: `{{t("Renaming strategy to avoid filename conflicts when uploading files.", { ns: "${STORAGE_NS}" })}}`,
      type: 'string',
      'x-decorator': 'FormItem',
      'x-component': 'Radio.Group',
      enum: [
        { label: `{{t("Append random ID", { ns: "${STORAGE_NS}" })}}`, value: 'appendRandomID' },
        { label: `{{t("Random string", { ns: "${STORAGE_NS}" })}}`, value: 'random' },
        {
          label: `{{t("Keep original filename (will be overwrite if filename is existed)", { ns: "${STORAGE_NS}" })}}`,
          value: 'none',
        },
      ],
      default: 'appendRandomID',
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

export class PluginSftpPrivateStorageClient extends Plugin {
  async load() {
    // @ts-ignore
    const fileManagerPlugin = this.app.pm.get(PluginFileManagerClient) as any;
    if (fileManagerPlugin) {
      fileManagerPlugin.registerStorageType(STORAGE_TYPE_SFTP_PRIVATE, sftpPrivateStorageType);
    }

    // Settings for SFTP are now managed directly in the File Manager plugin.
    // The left navigator setting "SFTP Private Storage" has been hidden.
  }
}

export default PluginSftpPrivateStorageClient;

