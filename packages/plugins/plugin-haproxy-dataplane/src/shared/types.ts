// SPDX-License-Identifier: Apache-2.0

export type HaproxyAuthType = 'basic' | 'none';
export type HaproxyAdminState = 'ready' | 'drain' | 'maint';
export type HaproxyOperationalState = 'up' | 'down' | 'stopping';
export type HaproxyStatEntityType = 'frontend' | 'backend' | 'server';
export type HaproxyProxyMode = 'http' | 'tcp';

export interface HaproxyConnectionPublic {
  id: number;
  name: string;
  title: string | null;
  baseUrl: string;
  authType: HaproxyAuthType;
  username: string | null;
  password: string | null;
  tlsSkipVerify: boolean;
  timeoutMs: number;
  enabled: boolean;
  notes: string | null;
  lastCheckAt: string | null;
  lastApiVersion: string | null;
  lastHaproxyVersion: string | null;
  lastError: string | null;
}

export interface HaproxyUserPermissions {
  canAccess: boolean;
  canRead: boolean;
  canRuntime: boolean;
  canConfig: boolean;
  canRawConfig: boolean;
  canStorage: boolean;
  canManageConnections: boolean;
  canManage: boolean;
}

export interface DataplaneApiInfo {
  apiVersion: string | null;
  buildDate: string | null;
  hostname: string | null;
  osString: string | null;
  systemUptime: number | null;
}

export interface HaproxyProcessSummary {
  runtimeApi: string | null;
  error: string | null;
  version: string | null;
  uptime: number | null;
  pid: number | null;
  nbthread: number | null;
  currConns: number | null;
  cumConns: number | null;
  connRate: number | null;
  maxConn: number | null;
  currSslConns: number | null;
  bytesOutRate: number | null;
}

export interface HaproxyStatRow {
  key: string;
  type: HaproxyStatEntityType;
  name: string;
  backendName: string | null;
  status: string;
  mode: string | null;
  algo: string | null;
  addr: string | null;
  weight: number | null;
  act: number | null;
  bck: number | null;
  scur: number;
  smax: number;
  slim: number | null;
  stot: number;
  reqRate: number | null;
  reqTot: number | null;
  bin: number;
  bout: number;
  hrsp2xx: number;
  hrsp4xx: number;
  hrsp5xx: number;
  econ: number;
  eresp: number;
  ereq: number;
  qcur: number;
  rtime: number | null;
  ttime: number | null;
  checkStatus: string | null;
  checkCode: number | null;
  checkDuration: number | null;
  lastchg: number | null;
  downtime: number | null;
}

export interface HaproxyRuntimeServer {
  id: string | null;
  name: string;
  backendName: string;
  address: string | null;
  port: number | null;
  adminState: HaproxyAdminState | string;
  operationalState: HaproxyOperationalState | string;
  weight: number | null;
  uweight: number | null;
  iweight: number | null;
  useSsl: boolean | null;
  lastTimeChange: number | null;
}

export interface HaproxyMergedServerRow {
  key: string;
  backendName: string;
  name: string;
  address: string | null;
  port: number | null;
  status: string;
  adminState: string;
  operationalState: string;
  weight: number | null;
  uweight: number | null;
  iweight: number | null;
  scur: number;
  smax: number;
  stot: number;
  qcur: number;
  bin: number;
  bout: number;
  hrsp2xx: number;
  hrsp4xx: number;
  hrsp5xx: number;
  econ: number;
  eresp: number;
  rtime: number | null;
  checkStatus: string | null;
  checkCode: number | null;
  checkDuration: number | null;
  lastchg: number | null;
}

export interface HaproxyNodeSnapshot {
  connectionId: number;
  connectionName: string;
  fetchedAt: string;
  configVersion: number | null;
  apiInfo: DataplaneApiInfo;
  processInfo: HaproxyProcessSummary;
  statsError: string | null;
  frontends: HaproxyStatRow[];
  backends: HaproxyStatRow[];
  servers: HaproxyMergedServerRow[];
}

export interface HaproxyFleetNodeStatus {
  connectionId: number;
  name: string;
  title: string | null;
  reachable: boolean;
  error: string | null;
  hostname: string | null;
  apiVersion: string | null;
  haproxyVersion: string | null;
  uptime: number | null;
  configVersion: number | null;
  currConns: number | null;
  maxConn: number | null;
  upServers: number;
  totalServers: number;
  frontendsCount: number;
  backendsCount: number;
  openTransactions: number;
  lastReloadStatus: string | null;
  lastReloadId: string | null;
}

export interface UpdateRuntimeServerInput {
  connectionId: number;
  backend: string;
  server: string;
  adminState?: HaproxyAdminState;
  weight?: number;
  address?: string;
  port?: number;
}

export interface AddRuntimeServerInput {
  connectionId: number;
  backend: string;
  name: string;
  address: string;
  port?: number;
  weight?: number;
  check?: 'enabled' | 'disabled';
  maintenance?: 'enabled' | 'disabled';
}

export interface HaproxyTransaction {
  id: string;
  status: 'in_progress' | 'failed' | 'outdated' | 'success' | string;
  _version?: number;
}

export interface HaproxyReload {
  id: string;
  status: 'in_progress' | 'succeeded' | 'failed' | string;
  reload_timestamp?: number;
  response?: string;
}

export interface ConfigMutationMeta {
  status: number;
  reloadId: string | null;
  configurationVersion: number | null;
}

export interface HaproxyFrontendConfig {
  name: string;
  mode?: HaproxyProxyMode | string;
  default_backend?: string;
  maxconn?: number | null;
  httplog?: boolean;
  tcplog?: boolean;
  description?: string;
  disabled?: boolean;
  [key: string]: unknown;
}

export interface HaproxyBindConfig {
  name: string;
  address?: string;
  port?: number | null;
  ssl?: boolean;
  ssl_certificate?: string;
  alpn?: string;
  accept_proxy?: boolean;
  maxconn?: number;
  [key: string]: unknown;
}

export interface HaproxyAclConfig {
  acl_name: string;
  criterion: string;
  value?: string;
}

export interface HaproxyBackendSwitchingRule {
  name: string;
  cond?: 'if' | 'unless' | string;
  cond_test?: string;
}

export interface HaproxyHttpRequestRule {
  type: string;
  cond?: 'if' | 'unless' | string;
  cond_test?: string;
  hdr_name?: string;
  hdr_format?: string;
  redir_type?: 'location' | 'prefix' | 'scheme' | string;
  redir_value?: string;
  redir_code?: number;
  deny_status?: number;
  auth_realm?: string;
  path_fmt?: string;
  [key: string]: unknown;
}

export interface HaproxyBackendConfig {
  name: string;
  mode?: HaproxyProxyMode | string;
  balance?: {
    algorithm?: string;
    hdr_name?: string;
  };
  adv_check?: string;
  httpchk_params?: {
    method?: string;
    uri?: string;
    version?: string;
  };
  connect_timeout?: number | null;
  server_timeout?: number | null;
  queue_timeout?: number | null;
  check_timeout?: number | null;
  description?: string;
  [key: string]: unknown;
}

export interface HaproxyServerConfig {
  name: string;
  address: string;
  port?: number | null;
  weight?: number | null;
  check?: 'enabled' | 'disabled' | string;
  backup?: 'enabled' | 'disabled' | string;
  maintenance?: 'enabled' | 'disabled' | string;
  ssl?: 'enabled' | 'disabled' | string;
  verify?: 'none' | 'required' | string;
  sni?: string;
  maxconn?: number | null;
  inter?: number | null;
  fall?: number | null;
  rise?: number | null;
  [key: string]: unknown;
}

export interface HaproxyRawConfigResponse {
  content: string;
  version: number | null;
  checksum: string | null;
}

export interface BatchSyncItemResult {
  connectionId: number;
  connectionName: string;
  ok: boolean;
  status?: number;
  version?: number | null;
  reloadId?: string | null;
  error?: string;
}

export interface HaproxySslCertificate {
  storage_name: string;
  file?: string;
  description?: string;
  subject?: string;
  issuers?: string;
  domains?: string;
  subject_alternative_names?: string;
  not_before?: string;
  not_after?: string;
  serial?: string;
  sha256_finger_print?: string;
  algorithm?: string;
  size?: number | null;
}

export interface HaproxyStorageFile {
  storage_name: string;
  file?: string;
  description?: string;
  size?: number | null;
  id?: string;
}

export interface HaproxyRuntimeMapEntry {
  id?: string;
  key: string;
  value: string;
}

export interface HaproxyStickTable {
  name: string;
  type?: string;
  size?: number | null;
  used?: number | null;
}

export interface HaproxyStickTableEntry {
  id?: string;
  key?: string;
  exp?: number | null;
  server_id?: number | null;
  [key: string]: unknown;
}

// --- Phase 1: Config Revisions, Visual Diff & Audit Trail ---

export type HaproxyRevisionSource =
  | 'manual_snapshot'
  | 'structured'
  | 'transaction_commit'
  | 'raw_push'
  | 'batch_sync'
  | 'rollback';

export interface HaproxyConfigRevisionSummary {
  id: number;
  connectionId: number;
  connectionName: string;
  configVersion: number | null;
  checksum: string | null;
  source: HaproxyRevisionSource | string;
  summary: string | null;
  lineCount: number;
  byteSize: number;
  actorUserId: number | null;
  actorName: string | null;
  createdAt: string | null;
}

export interface HaproxyConfigRevisionDetail extends HaproxyConfigRevisionSummary {
  rawContent: string;
}

export type HaproxyAuditCategory = 'runtime' | 'config' | 'raw' | 'storage' | 'connection';

export interface HaproxyAuditLogRecord {
  id: number;
  connectionId: number | null;
  connectionName: string | null;
  category: HaproxyAuditCategory | string;
  action: string;
  target: string | null;
  status: 'success' | 'failed' | string;
  detail: string | null;
  actorUserId: number | null;
  actorName: string | null;
  createdAt: string | null;
}

export type DiffLineType = 'context' | 'add' | 'del';

export interface DiffLine {
  type: DiffLineType;
  oldLineNumber: number | null;
  newLineNumber: number | null;
  content: string;
}

export interface ConfigDiffResult {
  leftLabel: string;
  rightLabel: string;
  identical: boolean;
  addedCount: number;
  deletedCount: number;
  unchangedCount: number;
  truncated: boolean;
  lines: DiffLine[];
}

// --- Unified Reverse Proxy (In -> Out) ---

export interface HaproxyDefaultsConfig {
  name?: string;
  mode?: string;
  connect_timeout?: number | null;
  server_timeout?: number | null;
  client_timeout?: number | null;
  check_timeout?: number | null;
  queue_timeout?: number | null;
  [key: string]: unknown;
}

export type ReverseProxyRouteKind = 'dedicated_port' | 'routing_rule';

export type ReverseProxyHealthState = 'healthy' | 'degraded' | 'down' | 'disabled' | 'no_servers' | 'dynamic';

export interface ReverseProxyBindSummary {
  name: string;
  address: string;
  port: number | null;
  ssl: boolean;
  sslCertificate: string | null;
}

export interface ReverseProxyTargetSummary {
  name: string;
  address: string;
  port: number | null;
  weight: number | null;
  ssl: boolean;
  check: boolean;
  backup: boolean;
  maintenance: boolean;
  liveStatus: string | null;
  checkStatus: string | null;
  checkCode: number | null;
}

export interface HaproxyReverseProxyRoute {
  routeKey: string;
  kind: ReverseProxyRouteKind;
  connectionId: number;
  nodeName: string;
  nodeTitle: string | null;
  nodeAddress: string;
  nodeHostname: string | null;
  frontendName: string;
  mode: HaproxyProxyMode | string;
  binds: ReverseProxyBindSummary[];
  ruleIndex: number | null;
  ruleCond: string | null;
  ruleCondTest: string | null;
  matchedAcls: HaproxyAclConfig[];
  hostMatch: string | null;
  pathBegMatch: string | null;
  backendName: string;
  isDynamicBackend: boolean;
  balanceAlgorithm: string | null;
  targets: ReverseProxyTargetSummary[];
  enabled: boolean;
  canToggle: boolean;
  healthState: ReverseProxyHealthState;
  upTargets: number;
  totalTargets: number;
  connectTimeoutMs: number | null;
  serverTimeoutMs: number | null;
  timeoutInherited: boolean;
  advCheck: string | null;
  httpCheckMethod: string | null;
  httpCheckUri: string | null;
}

export interface ReverseProxyNodeError {
  connectionId: number;
  nodeName: string;
  nodeAddress: string;
  error: string;
}

export interface ReverseProxyListResponse {
  routes: HaproxyReverseProxyRoute[];
  nodeErrors: ReverseProxyNodeError[];
}

export interface UpsertReverseProxyTargetInput {
  name?: string;
  address: string;
  port: number;
  weight?: number;
  ssl?: boolean;
  check?: boolean;
  backup?: boolean;
}

export interface UpsertReverseProxyInput {
  connectionId: number;
  isEdit?: boolean;
  kind: ReverseProxyRouteKind;
  proxySlug?: string;
  frontendName?: string;
  backendName?: string;
  ruleIndex?: number | null;
  mode: HaproxyProxyMode;
  listenAddress?: string;
  inboundPort?: number;
  inboundSsl?: boolean;
  sslCertificate?: string | null;
  hostMatch?: string | null;
  pathBegMatch?: string | null;
  balanceAlgorithm?: string;
  targets: UpsertReverseProxyTargetInput[];
  httpCheckEnabled?: boolean;
  httpCheckMethod?: string;
  httpCheckUri?: string;
  connectTimeoutMs?: number | null;
  serverTimeoutMs?: number | null;
  enabled?: boolean;
}

export interface ToggleReverseProxyInput {
  connectionId: number;
  kind: ReverseProxyRouteKind;
  frontendName: string;
  backendName: string;
  enabled: boolean;
}

export interface DeleteReverseProxyInput {
  connectionId: number;
  kind: ReverseProxyRouteKind;
  frontendName: string;
  backendName: string;
  ruleIndex?: number | null;
}
