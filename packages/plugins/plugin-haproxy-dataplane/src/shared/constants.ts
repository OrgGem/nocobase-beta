// SPDX-License-Identifier: Apache-2.0

export const PLUGIN_NAME = 'plugin-haproxy-dataplane';
export const SETTINGS_KEY = 'haproxy-dataplane';
export const RESOURCE_NAME = 'haproxyDataplane';
export const SECRET_MASK = '********';

export const COLLECTIONS = {
  connections: 'haproxy_dataplane_connections',
  revisions: 'haproxy_config_revisions',
  auditLogs: 'haproxy_audit_logs',
} as const;

export const MAX_REVISIONS_PER_NODE = 50;
export const MAX_AUDIT_LOGS_PER_NODE = 300;

export const HAPROXY_SNIPPETS = {
  access: 'pm.plugin-haproxy-dataplane.access',
  read: 'pm.plugin-haproxy-dataplane.read',
  runtime: 'pm.plugin-haproxy-dataplane.runtime',
  config: 'pm.plugin-haproxy-dataplane.config',
  rawConfig: 'pm.plugin-haproxy-dataplane.raw-config',
  storage: 'pm.plugin-haproxy-dataplane.storage',
  connections: 'pm.plugin-haproxy-dataplane.connections',
  manage: 'pm.plugin-haproxy-dataplane',
} as const;

export const HAPROXY_PERMISSION_ITEMS: ReadonlyArray<{ key: string; title: string; aclSnippet: string }> = [
  {
    key: 'perm-runtime',
    title: 'Runtime Operations (Ready / Drain / Maint / Weight / Maps)',
    aclSnippet: HAPROXY_SNIPPETS.runtime,
  },
  {
    key: 'perm-config',
    title: 'Structured Configuration & Transactions',
    aclSnippet: HAPROXY_SNIPPETS.config,
  },
  {
    key: 'perm-raw-config',
    title: 'Raw haproxy.cfg Push & Multi-Server Sync (High Privilege)',
    aclSnippet: HAPROXY_SNIPPETS.rawConfig,
  },
  {
    key: 'perm-storage',
    title: 'SSL Certificates, Maps & Storage Files (High Privilege)',
    aclSnippet: HAPROXY_SNIPPETS.storage,
  },
];

export const VALID_ADMIN_STATES = ['ready', 'drain', 'maint'] as const;
export const VALID_OPERATIONAL_STATES = ['up', 'down', 'stopping'] as const;
export const VALID_PROXY_MODES = ['http', 'tcp'] as const;
export const VALID_BALANCE_ALGORITHMS = [
  'roundrobin',
  'leastconn',
  'source',
  'uri',
  'url_param',
  'hdr',
  'first',
  'random',
  'static-rr',
] as const;

export const MIN_SERVER_WEIGHT = 0;
export const MAX_SERVER_WEIGHT = 256;
export const DEFAULT_TIMEOUT_MS = 10000;
export const MIN_TIMEOUT_MS = 1000;
export const MAX_TIMEOUT_MS = 60000;
