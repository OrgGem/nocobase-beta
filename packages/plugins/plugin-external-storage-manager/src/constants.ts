// SPDX-License-Identifier: Apache-2.0

export const NAMESPACE = 'plugin-external-storage-manager';
export const STORAGE_TYPE_S3 = 's3-private';
export const STORAGE_TYPE_SFTP = 'sftp-private';

export const DIRECTORY_ACTIONS = ['list', 'view', 'upload', 'download', 'delete', 'mkdir'] as const;
export type DirectoryAction = (typeof DIRECTORY_ACTIONS)[number];
