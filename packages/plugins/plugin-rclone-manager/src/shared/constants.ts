// SPDX-License-Identifier: Apache-2.0

export const PLUGIN_NAME = 'plugin-rclone-manager';
export const SETTINGS_KEY = 'rclone-manager';
export const RESOURCE_NAME = 'rcloneManager';
export const RCLONE_TRANSFER_INSTRUCTION_TYPE = 'rclone-transfer';
export const RCLONE_WORKFLOW_GROUP = 'rclone';
export const DEFAULT_EXPLORER_WORKFLOW_KEY = 'rclone-default-explorer-transfer';
export const SECRET_MASK = '••••••••';

export const COLLECTIONS = {
  connections: 'rcloneConnections',
  tasks: 'rcloneTransferTasks',
} as const;

export const TRANSFER_OPERATIONS = [
  'sync/copy',
  'sync/move',
  'sync/sync',
  'sync/bisync',
  'operations/copyfile',
  'operations/movefile',
] as const;

export const RCLONE_SNIPPETS = {
  access: `pm.${PLUGIN_NAME}.access`,
  read: `pm.${PLUGIN_NAME}.read`,
  transfer: `pm.${PLUGIN_NAME}.transfer`,
  remotes: `pm.${PLUGIN_NAME}.remotes`,
  localFs: `pm.${PLUGIN_NAME}.local-fs`,
  mounts: `pm.${PLUGIN_NAME}.mounts`,
  serves: `pm.${PLUGIN_NAME}.serves`,
  rawConfig: `pm.${PLUGIN_NAME}.raw-config`,
  connections: `pm.${PLUGIN_NAME}.connections`,
  manage: `pm.${PLUGIN_NAME}.manage`,
  legacyManage: `pm.${PLUGIN_NAME}`,
} as const;

export const RCLONE_PERMISSION_ITEMS = [
  {
    key: 'permission-transfer',
    title: 'Execute file operations & trigger sync/copy workflows',
    aclSnippet: RCLONE_SNIPPETS.transfer,
  },
  {
    key: 'permission-remotes',
    title: 'Create, edit, and delete cloud remotes',
    aclSnippet: RCLONE_SNIPPETS.remotes,
  },
  {
    key: 'permission-local-fs',
    title: 'High privilege: Browse & transfer on host local disks',
    aclSnippet: RCLONE_SNIPPETS.localFs,
  },
  {
    key: 'permission-raw-config',
    title: 'High privilege: Edit raw rclone.conf & runtime flags',
    aclSnippet: RCLONE_SNIPPETS.rawConfig,
  },
] as const;

export const SUPPORTS_ABOUT_BACKENDS = new Set([
  'azurefiles',
  'box',
  'drive',
  'dropbox',
  'filen',
  'gofile',
  'hdfs',
  'internetarchive',
  'jottacloud',
  'koofr',
  'local',
  'mailru',
  'mega',
  'onedrive',
  'opendrive',
  'pcloud',
  'pikpak',
  'pixeldrain',
  'premiumizeme',
  'protondrive',
  'putio',
  'quatrix',
  'seafile',
  'sftp',
  'swift',
  'webdav',
  'yandex',
  'zoho',
]);
