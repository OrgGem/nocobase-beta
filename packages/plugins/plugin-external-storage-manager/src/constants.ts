/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

export const NAMESPACE = 'plugin-external-storage-manager';
export const STORAGE_TYPE_S3 = 's3-private';
export const STORAGE_TYPE_SFTP = 'sftp-private';

export const DIRECTORY_ACTIONS = ['list', 'view', 'upload', 'download', 'delete', 'mkdir'] as const;
export type DirectoryAction = (typeof DIRECTORY_ACTIONS)[number];
