// SPDX-License-Identifier: Apache-2.0

import type { Model } from '@nocobase/database';
import { VALID_BALANCE_ALGORITHMS } from '../../shared/constants';
import type {
  ConfigMutationMeta,
  DeleteReverseProxyInput,
  HaproxyAclConfig,
  HaproxyBackendConfig,
  HaproxyBackendSwitchingRule,
  HaproxyBindConfig,
  HaproxyDefaultsConfig,
  HaproxyFrontendConfig,
  HaproxyProxyMode,
  HaproxyReverseProxyRoute,
  HaproxyServerConfig,
  HaproxyStatRow,
  ReverseProxyBindSummary,
  ReverseProxyHealthState,
  ReverseProxyListResponse,
  ReverseProxyNodeError,
  ReverseProxyTargetSummary,
  ToggleReverseProxyInput,
  UpsertReverseProxyInput,
} from '../../shared/types';
import type { HaproxyConnectionManager } from './connection-manager';
import {
  assertValidEntityName,
  DataplaneApiError,
  mapWithConcurrency,
  type DataplaneV3Client,
} from './dataplane-v3-client';

function extractSafeNodeAddress(connectionManager: HaproxyConnectionManager, rawBaseUrl: string): string {
  try {
    const resolved = connectionManager.resolveNormalizedUrl(rawBaseUrl);
    return new URL(resolved).hostname;
  } catch {
    try {
      return new URL(rawBaseUrl).hostname;
    } catch {
      return '—';
    }
  }
}

function sanitizeSlug(raw: string): string {
  return raw
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
}

function stripCaseInsensitiveFlag(val?: string): string {
  if (!val) return '';
  return val.replace(/^-i\s+/i, '').trim();
}

function computeHealthState(
  enabled: boolean,
  isDynamicBackend: boolean,
  targets: ReverseProxyTargetSummary[],
): { healthState: ReverseProxyHealthState; upTargets: number; totalTargets: number } {
  if (!enabled) {
    const up = targets.filter((t) => (t.liveStatus ?? '').toUpperCase().startsWith('UP')).length;
    return { healthState: 'disabled', upTargets: up, totalTargets: targets.length };
  }
  if (isDynamicBackend) {
    return { healthState: 'dynamic', upTargets: 0, totalTargets: 0 };
  }
  if (targets.length === 0) {
    return { healthState: 'no_servers', upTargets: 0, totalTargets: 0 };
  }
  const upTargets = targets.filter((t) => {
    const st = (t.liveStatus ?? '').toUpperCase();
    if (st.startsWith('UP')) return true;
    if (!st && !t.maintenance) return true;
    return false;
  }).length;

  if (upTargets === targets.length) {
    return { healthState: 'healthy', upTargets, totalTargets: targets.length };
  }
  if (upTargets > 0) {
    return { healthState: 'degraded', upTargets, totalTargets: targets.length };
  }
  return { healthState: 'down', upTargets: 0, totalTargets: targets.length };
}

function resolveTimeouts(
  backend: HaproxyBackendConfig | undefined,
  defaultsMap: Map<string, HaproxyDefaultsConfig>,
  fallbackDefaults: HaproxyDefaultsConfig | undefined,
): { connectTimeoutMs: number | null; serverTimeoutMs: number | null; timeoutInherited: boolean } {
  const fromName = typeof backend?.from === 'string' ? backend.from : '';
  const defSection = (fromName ? defaultsMap.get(fromName) : undefined) ?? fallbackDefaults;

  const ownConn = typeof backend?.connect_timeout === 'number' ? backend.connect_timeout : null;
  const ownSrv = typeof backend?.server_timeout === 'number' ? backend.server_timeout : null;
  const defConn = typeof defSection?.connect_timeout === 'number' ? defSection.connect_timeout : null;
  const defSrv = typeof defSection?.server_timeout === 'number' ? defSection.server_timeout : null;

  return {
    connectTimeoutMs: ownConn ?? defConn ?? null,
    serverTimeoutMs: ownSrv ?? defSrv ?? null,
    timeoutInherited: ownConn === null && ownSrv === null && (defConn !== null || defSrv !== null),
  };
}

function buildBackendRefCounts(
  frontends: HaproxyFrontendConfig[],
  switchingByFrontend: Map<string, HaproxyBackendSwitchingRule[]>,
): Map<string, number> {
  const counts = new Map<string, number>();
  const inc = (beName?: string) => {
    if (!beName || beName.includes('%[')) return;
    counts.set(beName, (counts.get(beName) ?? 0) + 1);
  };
  for (const fe of frontends) {
    inc(fe.default_backend);
    for (const rule of switchingByFrontend.get(fe.name) ?? []) {
      inc(rule.name);
    }
  }
  return counts;
}

export class HaproxyReverseProxyService {
  constructor(private readonly connectionManager: HaproxyConnectionManager) {}

  async listReverseProxies(connectionRows: Model[], filterConnectionId?: number): Promise<ReverseProxyListResponse> {
    const selectedRows = filterConnectionId
      ? connectionRows.filter((row) => Number(row.get('id')) === Number(filterConnectionId))
      : connectionRows;

    const nodeErrors: ReverseProxyNodeError[] = [];
    const perNodeRoutes = await mapWithConcurrency(
      selectedRows,
      6,
      async (row): Promise<HaproxyReverseProxyRoute[]> => {
        const connectionId = Number(row.get('id'));
        const nodeName = String(row.get('name') ?? '');
        const nodeTitle = (row.get('title') as string | null) ?? null;
        const nodeAddress = extractSafeNodeAddress(this.connectionManager, String(row.get('baseUrl') ?? ''));

        try {
          const client = await this.connectionManager.getClientByModel(row);
          return await this.collectNodeRoutes(client, { connectionId, nodeName, nodeTitle, nodeAddress });
        } catch (err) {
          nodeErrors.push({
            connectionId,
            nodeName,
            nodeAddress,
            error: err instanceof Error ? err.message : String(err),
          });
          return [];
        }
      },
    );

    return {
      routes: perNodeRoutes.flat(),
      nodeErrors,
    };
  }

  private async collectNodeRoutes(
    client: DataplaneV3Client,
    nodeMeta: { connectionId: number; nodeName: string; nodeTitle: string | null; nodeAddress: string },
  ): Promise<HaproxyReverseProxyRoute[]> {
    const [apiInfo, stats, defaultsList, frontends, backends] = await Promise.all([
      client
        .getInfo()
        .catch(() => ({ hostname: null, apiVersion: null, buildDate: null, osString: null, systemUptime: null })),
      client.getNativeStats().catch(() => ({ rows: [] as HaproxyStatRow[], statsError: null })),
      client.listDefaults().catch(() => [] as HaproxyDefaultsConfig[]),
      client.listFrontends(),
      client.listBackends(),
    ]);

    const defaultsMap = new Map<string, HaproxyDefaultsConfig>();
    for (const d of defaultsList) {
      if (d.name) defaultsMap.set(d.name, d);
    }
    const fallbackDefaults = defaultsList[0];

    const backendMap = new Map<string, HaproxyBackendConfig>();
    for (const be of backends) {
      backendMap.set(be.name, be);
    }

    const statServerMap = new Map<string, HaproxyStatRow>();
    for (const stat of stats.rows) {
      if (stat.type === 'server' && stat.backendName) {
        statServerMap.set(`${stat.backendName}/${stat.name}`, stat);
      }
    }

    const [feDetails, beDetails] = await Promise.all([
      mapWithConcurrency(frontends, 6, async (fe) => {
        const [binds, acls, switchingRules] = await Promise.all([
          client.listBinds(fe.name).catch(() => [] as HaproxyBindConfig[]),
          client.listFrontendAcls(fe.name).catch(() => [] as HaproxyAclConfig[]),
          client.listBackendSwitchingRules(fe.name).catch(() => [] as HaproxyBackendSwitchingRule[]),
        ]);
        return { feName: fe.name, binds, acls, switchingRules };
      }),
      mapWithConcurrency(backends, 6, async (be) => {
        const servers = await client.listBackendServers(be.name).catch(() => [] as HaproxyServerConfig[]);
        return { beName: be.name, servers };
      }),
    ]);

    const bindsByFe = new Map<string, ReverseProxyBindSummary[]>();
    const aclsByFe = new Map<string, HaproxyAclConfig[]>();
    const switchingByFe = new Map<string, HaproxyBackendSwitchingRule[]>();
    for (const item of feDetails) {
      bindsByFe.set(
        item.feName,
        item.binds.map((b) => ({
          name: b.name,
          address: b.address || '*',
          port: typeof b.port === 'number' ? b.port : null,
          ssl: Boolean(b.ssl),
          sslCertificate: b.ssl_certificate ?? null,
        })),
      );
      aclsByFe.set(item.feName, item.acls);
      switchingByFe.set(item.feName, item.switchingRules);
    }

    const targetsByBe = new Map<string, ReverseProxyTargetSummary[]>();
    for (const item of beDetails) {
      targetsByBe.set(
        item.beName,
        item.servers.map((srv) => {
          const liveStat = statServerMap.get(`${item.beName}/${srv.name}`);
          return {
            name: srv.name,
            address: srv.address,
            port: typeof srv.port === 'number' ? srv.port : null,
            weight: typeof srv.weight === 'number' ? srv.weight : null,
            ssl: srv.ssl === 'enabled',
            check: srv.check === 'enabled',
            backup: srv.backup === 'enabled',
            maintenance: srv.maintenance === 'enabled',
            liveStatus: liveStat?.status ?? null,
            checkStatus: liveStat?.checkStatus ?? null,
            checkCode: liveStat?.checkCode ?? null,
          };
        }),
      );
    }

    const backendRefCounts = buildBackendRefCounts(frontends, switchingByFe);
    const routes: HaproxyReverseProxyRoute[] = [];

    for (const fe of frontends) {
      const binds = bindsByFe.get(fe.name) ?? [];
      const feAcls = aclsByFe.get(fe.name) ?? [];
      const switchingRules = switchingByFe.get(fe.name) ?? [];
      const feEnabled = !fe.disabled;

      // 1. Emit ACL / switching-rule routes on this frontend
      for (const [idx, rule] of switchingRules.entries()) {
        const beName = rule.name;
        const isDynamicBackend = beName.includes('%[');
        const be = isDynamicBackend ? undefined : backendMap.get(beName);
        const targets = isDynamicBackend ? [] : targetsByBe.get(beName) ?? [];
        const routeEnabled = feEnabled && !be?.disabled;
        const { healthState, upTargets, totalTargets } = computeHealthState(routeEnabled, isDynamicBackend, targets);
        const timeouts = resolveTimeouts(be, defaultsMap, fallbackDefaults);

        const condTokens = (rule.cond_test ?? '')
          .split(/\s+/)
          .map((tok) => tok.replace(/^!/, '').trim())
          .filter(Boolean);
        const matchedAcls = feAcls.filter((a) => condTokens.includes(a.acl_name));
        const hostAcl = matchedAcls.find((a) => a.criterion.toLowerCase() === 'hdr(host)');
        const pathAcl = matchedAcls.find((a) => a.criterion.toLowerCase() === 'path_beg');

        routes.push({
          routeKey: `${nodeMeta.connectionId}:rule:${fe.name}:${idx}:${beName}`,
          kind: 'routing_rule',
          connectionId: nodeMeta.connectionId,
          nodeName: nodeMeta.nodeName,
          nodeTitle: nodeMeta.nodeTitle,
          nodeAddress: nodeMeta.nodeAddress,
          nodeHostname: apiInfo.hostname,
          frontendName: fe.name,
          mode: fe.mode ?? be?.mode ?? 'http',
          binds,
          ruleIndex: idx,
          ruleCond: rule.cond ?? null,
          ruleCondTest: rule.cond_test ?? null,
          matchedAcls,
          hostMatch: hostAcl ? stripCaseInsensitiveFlag(hostAcl.value) : null,
          pathBegMatch: pathAcl ? stripCaseInsensitiveFlag(pathAcl.value) : null,
          backendName: beName,
          isDynamicBackend,
          balanceAlgorithm: be?.balance?.algorithm ?? null,
          targets,
          enabled: routeEnabled,
          canToggle: !isDynamicBackend && Boolean(be) && (backendRefCounts.get(beName) ?? 0) <= 1,
          healthState,
          upTargets,
          totalTargets,
          ...timeouts,
          advCheck: be?.adv_check ?? null,
          httpCheckMethod: be?.httpchk_params?.method ?? null,
          httpCheckUri: be?.httpchk_params?.uri ?? null,
        });
      }

      // 2. Emit the frontend's primary / default_backend route
      if (fe.default_backend || switchingRules.length === 0) {
        const beName = fe.default_backend ?? '';
        const be = beName ? backendMap.get(beName) : undefined;
        const targets = beName ? targetsByBe.get(beName) ?? [] : [];
        const routeEnabled = feEnabled && !be?.disabled;
        const { healthState, upTargets, totalTargets } = computeHealthState(routeEnabled, false, targets);
        const timeouts = resolveTimeouts(be, defaultsMap, fallbackDefaults);

        routes.push({
          routeKey: `${nodeMeta.connectionId}:default:${fe.name}:${beName || 'none'}`,
          kind: 'dedicated_port',
          connectionId: nodeMeta.connectionId,
          nodeName: nodeMeta.nodeName,
          nodeTitle: nodeMeta.nodeTitle,
          nodeAddress: nodeMeta.nodeAddress,
          nodeHostname: apiInfo.hostname,
          frontendName: fe.name,
          mode: fe.mode ?? be?.mode ?? 'http',
          binds,
          ruleIndex: null,
          ruleCond: null,
          ruleCondTest: null,
          matchedAcls: [],
          hostMatch: null,
          pathBegMatch: null,
          backendName: beName,
          isDynamicBackend: false,
          balanceAlgorithm: be?.balance?.algorithm ?? null,
          targets,
          enabled: routeEnabled,
          canToggle: switchingRules.length === 0 || (Boolean(be) && (backendRefCounts.get(beName) ?? 0) <= 1),
          healthState,
          upTargets,
          totalTargets,
          ...timeouts,
          advCheck: be?.adv_check ?? null,
          httpCheckMethod: be?.httpchk_params?.method ?? null,
          httpCheckUri: be?.httpchk_params?.uri ?? null,
        });
      }
    }

    return routes;
  }

  async upsertReverseProxy(
    client: DataplaneV3Client,
    input: UpsertReverseProxyInput,
  ): Promise<{ frontendName: string; backendName: string; meta: ConfigMutationMeta }> {
    const mode: HaproxyProxyMode = input.mode === 'tcp' ? 'tcp' : 'http';
    const validTargets = (Array.isArray(input.targets) ? input.targets : []).filter(
      (t) =>
        t &&
        String(t.address ?? '').trim() !== '' &&
        Number.isInteger(Number(t.port)) &&
        Number(t.port) >= 1 &&
        Number(t.port) <= 65535,
    );
    if (validTargets.length === 0) {
      throw new DataplaneApiError('At least one valid outbound target IP/host and port (1-65535) is required', 400);
    }

    const algorithm = (VALID_BALANCE_ALGORITHMS as readonly string[]).includes(String(input.balanceAlgorithm ?? ''))
      ? String(input.balanceAlgorithm)
      : 'roundrobin';

    const connectTimeout =
      input.connectTimeoutMs != null &&
      Number.isFinite(Number(input.connectTimeoutMs)) &&
      Number(input.connectTimeoutMs) > 0
        ? Math.trunc(Number(input.connectTimeoutMs))
        : undefined;
    const serverTimeout =
      input.serverTimeoutMs != null &&
      Number.isFinite(Number(input.serverTimeoutMs)) &&
      Number(input.serverTimeoutMs) > 0
        ? Math.trunc(Number(input.serverTimeoutMs))
        : undefined;

    const isEnabled = input.enabled !== false;

    if (input.kind === 'dedicated_port') {
      const port = Number(input.inboundPort);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new DataplaneApiError('Inbound port must be an integer between 1 and 65535', 400);
      }
      const listenAddress = String(input.listenAddress ?? '0.0.0.0').trim() || '0.0.0.0';
      const slug = sanitizeSlug(input.proxySlug || `port_${port}`) || `port_${port}`;
      const feName =
        input.isEdit && input.frontendName
          ? assertValidEntityName(input.frontendName, 'frontend')
          : assertValidEntityName(`fe_${slug}`, 'frontend');
      const beName =
        input.isEdit && input.backendName
          ? assertValidEntityName(input.backendName, 'backend')
          : assertValidEntityName(`be_${slug}`, 'backend');

      const tx = await client.startTransaction();
      try {
        await this.stageBackendAndServers(client, tx.id, {
          isEdit: Boolean(input.isEdit && input.backendName),
          beName,
          mode,
          algorithm,
          connectTimeout,
          serverTimeout,
          httpCheckEnabled: mode === 'http' && Boolean(input.httpCheckEnabled),
          httpCheckMethod: input.httpCheckMethod || 'GET',
          httpCheckUri: input.httpCheckUri || '/',
          targets: validTargets,
          enabled: true,
        });

        const fePayload: HaproxyFrontendConfig = {
          name: feName,
          mode,
          default_backend: beName,
          ...(mode === 'http' ? { httplog: true } : { tcplog: true }),
          ...(isEnabled ? { enabled: true } : { disabled: true }),
        };

        if (input.isEdit && input.frontendName) {
          const existingFes = await client.listFrontends(tx.id);
          const prevFe = existingFes.find((f) => f.name === feName);
          const { enabled: _e, disabled: _d, ...restFe } = prevFe ?? {};
          await client.updateFrontend(feName, { ...restFe, ...fePayload }, { transactionId: tx.id });

          const existingBinds = await client.listBinds(feName, tx.id);
          const bindPayload: HaproxyBindConfig = {
            name: existingBinds[0]?.name ?? `bind_${port}`,
            address: listenAddress,
            port,
            ssl: Boolean(input.inboundSsl),
            ...(input.inboundSsl && input.sslCertificate ? { ssl_certificate: input.sslCertificate } : {}),
          };
          if (existingBinds[0]) {
            await client.updateBind(feName, existingBinds[0].name, bindPayload, { transactionId: tx.id });
          } else {
            await client.createBind(feName, bindPayload, { transactionId: tx.id });
          }
        } else {
          await client.createFrontend(fePayload, { transactionId: tx.id });
          await client.createBind(
            feName,
            {
              name: `bind_${port}`,
              address: listenAddress,
              port,
              ssl: Boolean(input.inboundSsl),
              ...(input.inboundSsl && input.sslCertificate ? { ssl_certificate: input.sslCertificate } : {}),
            },
            { transactionId: tx.id },
          );
        }

        const committed = await client.commitTransaction(tx.id, true);
        return { frontendName: feName, backendName: beName, meta: committed.meta };
      } catch (err) {
        await client.deleteTransaction(tx.id).catch(() => {});
        throw err;
      }
    }

    // --- Shared Frontend Domain / Path Routing Rule ---
    const sharedFeName = assertValidEntityName(String(input.frontendName ?? ''), 'frontend');
    const hostMatch = String(input.hostMatch ?? '').trim();
    const pathBegMatch = String(input.pathBegMatch ?? '').trim();
    if (!hostMatch && !pathBegMatch) {
      throw new DataplaneApiError('Domain match (Host) or Path prefix is required for shared-port routing', 400);
    }

    const autoSlug =
      sanitizeSlug(input.proxySlug || hostMatch || pathBegMatch || `route_${Date.now()}`) || `route_${Date.now()}`;
    const beName =
      input.isEdit && input.backendName
        ? assertValidEntityName(input.backendName, 'backend')
        : assertValidEntityName(`be_${autoSlug}`, 'backend');

    const tx = await client.startTransaction();
    try {
      await this.stageBackendAndServers(client, tx.id, {
        isEdit: Boolean(input.isEdit && input.backendName),
        beName,
        mode: 'http',
        algorithm,
        connectTimeout,
        serverTimeout,
        httpCheckEnabled: Boolean(input.httpCheckEnabled),
        httpCheckMethod: input.httpCheckMethod || 'GET',
        httpCheckUri: input.httpCheckUri || '/',
        targets: validTargets,
        enabled: isEnabled,
      });

      const [existingAcls, existingRules] = await Promise.all([
        client.listFrontendAcls(sharedFeName, tx.id),
        client.listBackendSwitchingRules(sharedFeName, tx.id),
      ]);

      const aclBase = sanitizeSlug(beName.replace(/^be_/, '')) || 'route';
      const hostAclName = `acl_${aclBase}_host`;
      const pathAclName = `acl_${aclBase}_path`;

      const nextAcls = existingAcls.filter((a) => a.acl_name !== hostAclName && a.acl_name !== pathAclName);
      const condParts: string[] = [];
      if (hostMatch) {
        nextAcls.push({ acl_name: hostAclName, criterion: 'hdr(host)', value: `-i ${hostMatch}` });
        condParts.push(hostAclName);
      }
      if (pathBegMatch) {
        nextAcls.push({ acl_name: pathAclName, criterion: 'path_beg', value: `-i ${pathBegMatch}` });
        condParts.push(pathAclName);
      }

      await client.replaceFrontendAcls(sharedFeName, nextAcls, { transactionId: tx.id });

      const newRule: HaproxyBackendSwitchingRule = {
        name: beName,
        cond: 'if',
        cond_test: condParts.join(' '),
      };

      const nextRules = [...existingRules];
      if (input.isEdit && input.ruleIndex != null && input.ruleIndex >= 0 && input.ruleIndex < nextRules.length) {
        nextRules[input.ruleIndex] = newRule;
      } else {
        nextRules.unshift(newRule);
      }

      await client.replaceBackendSwitchingRules(sharedFeName, nextRules, { transactionId: tx.id });

      const committed = await client.commitTransaction(tx.id, true);
      return { frontendName: sharedFeName, backendName: beName, meta: committed.meta };
    } catch (err) {
      await client.deleteTransaction(tx.id).catch(() => {});
      throw err;
    }
  }

  private async stageBackendAndServers(
    client: DataplaneV3Client,
    txId: string,
    opts: {
      isEdit: boolean;
      beName: string;
      mode: HaproxyProxyMode;
      algorithm: string;
      connectTimeout?: number;
      serverTimeout?: number;
      httpCheckEnabled: boolean;
      httpCheckMethod: string;
      httpCheckUri: string;
      targets: UpsertReverseProxyInput['targets'];
      enabled: boolean;
    },
  ): Promise<void> {
    const baseBackend: HaproxyBackendConfig = {
      name: opts.beName,
      mode: opts.mode,
      balance: { algorithm: opts.algorithm },
      ...(opts.connectTimeout !== undefined ? { connect_timeout: opts.connectTimeout } : {}),
      ...(opts.serverTimeout !== undefined ? { server_timeout: opts.serverTimeout } : {}),
      ...(opts.httpCheckEnabled
        ? {
            adv_check: 'httpchk',
            httpchk_params: {
              method: opts.httpCheckMethod || 'GET',
              uri: opts.httpCheckUri || '/',
            },
          }
        : {}),
      ...(opts.enabled ? { enabled: true } : { disabled: true }),
    };

    if (opts.isEdit) {
      const existingBackends = await client.listBackends(txId);
      const prevBe = existingBackends.find((b) => b.name === opts.beName);
      if (prevBe) {
        const {
          enabled: _e,
          disabled: _d,
          adv_check: _ac,
          httpchk_params: _hp,
          connect_timeout: _ct,
          server_timeout: _st,
          ...restBe
        } = prevBe;
        await client.updateBackend(opts.beName, { ...restBe, ...baseBackend }, { transactionId: txId });
      } else {
        await client.createBackend(baseBackend, { transactionId: txId });
      }
    } else {
      await client.createBackend(baseBackend, { transactionId: txId });
    }

    const existingServers = opts.isEdit ? await client.listBackendServers(opts.beName, txId).catch(() => []) : [];
    const existingByName = new Map(existingServers.map((s) => [s.name, s]));
    const keptNames = new Set<string>();

    for (const [idx, target] of opts.targets.entries()) {
      const srvName = assertValidEntityName(target.name?.trim() || `srv_${idx + 1}`, 'server');
      keptNames.add(srvName);
      const srvPayload: HaproxyServerConfig = {
        name: srvName,
        address: assertValidEntityName(String(target.address).trim(), 'server address'),
        port: Number(target.port),
        weight: target.weight != null ? Number(target.weight) : 100,
        check: target.check === false ? 'disabled' : 'enabled',
        backup: target.backup ? 'enabled' : 'disabled',
        ssl: target.ssl ? 'enabled' : 'disabled',
        ...(target.ssl ? { verify: 'none' } : {}),
      };
      const prev = existingByName.get(srvName);
      if (prev) {
        await client.updateBackendServer(opts.beName, srvName, { ...prev, ...srvPayload }, { transactionId: txId });
      } else {
        await client.createBackendServer(opts.beName, srvPayload, { transactionId: txId });
      }
    }

    for (const oldSrv of existingServers) {
      if (!keptNames.has(oldSrv.name)) {
        await client.deleteBackendServer(opts.beName, oldSrv.name, { transactionId: txId });
      }
    }
  }

  async toggleReverseProxy(client: DataplaneV3Client, input: ToggleReverseProxyInput): Promise<ConfigMutationMeta> {
    const feName = assertValidEntityName(input.frontendName, 'frontend');
    if (input.kind === 'dedicated_port') {
      const [frontends, rules] = await Promise.all([
        client.listFrontends(),
        client.listBackendSwitchingRules(feName).catch(() => []),
      ]);
      // If frontend has no other switching rules, toggle the frontend listener itself.
      if (rules.length === 0) {
        const prevFe = frontends.find((f) => f.name === feName);
        if (!prevFe) {
          throw new DataplaneApiError(`Frontend "${feName}" was not found`, 404);
        }
        const { enabled: _e, disabled: _d, ...rest } = prevFe;
        const nextFe: HaproxyFrontendConfig = {
          ...rest,
          name: feName,
          ...(input.enabled ? { enabled: true } : { disabled: true }),
        };
        const res = await client.updateFrontend(feName, nextFe, { forceReload: true });
        return res.meta;
      }
    }

    // Shared frontend or multi-rule frontend -> toggle target backend directly
    const beName = assertValidEntityName(input.backendName, 'backend');
    const backends = await client.listBackends();
    const prevBe = backends.find((b) => b.name === beName);
    if (!prevBe) {
      throw new DataplaneApiError(`Backend "${beName}" was not found`, 404);
    }
    const { enabled: _e, disabled: _d, ...rest } = prevBe;
    const nextBe: HaproxyBackendConfig = {
      ...rest,
      name: beName,
      ...(input.enabled ? { enabled: true } : { disabled: true }),
    };
    const res = await client.updateBackend(beName, nextBe, { forceReload: true });
    return res.meta;
  }

  async deleteReverseProxy(client: DataplaneV3Client, input: DeleteReverseProxyInput): Promise<ConfigMutationMeta> {
    const feName = assertValidEntityName(input.frontendName, 'frontend');
    const beName = input.backendName && !input.backendName.includes('%[') ? input.backendName.trim() : '';

    const tx = await client.startTransaction();
    try {
      const frontends = await client.listFrontends(tx.id);
      const switchingByFe = new Map<string, HaproxyBackendSwitchingRule[]>();
      for (const fe of frontends) {
        switchingByFe.set(fe.name, await client.listBackendSwitchingRules(fe.name, tx.id).catch(() => []));
      }

      if (input.kind === 'dedicated_port') {
        await client.deleteFrontend(feName, { transactionId: tx.id });
        const remainingFrontends = frontends.filter((f) => f.name !== feName);
        const remainingCounts = buildBackendRefCounts(remainingFrontends, switchingByFe);
        if (beName && (remainingCounts.get(beName) ?? 0) === 0) {
          await client.deleteBackend(beName, { transactionId: tx.id }).catch(() => {});
        }
      } else {
        const currentRules = [...(switchingByFe.get(feName) ?? [])];
        const idx =
          input.ruleIndex != null && input.ruleIndex >= 0 && input.ruleIndex < currentRules.length
            ? Number(input.ruleIndex)
            : currentRules.findIndex((r) => r.name === input.backendName);
        if (idx < 0) {
          throw new DataplaneApiError(`Routing rule for "${input.backendName}" was not found on "${feName}"`, 404);
        }
        const [removedRule] = currentRules.splice(idx, 1);
        switchingByFe.set(feName, currentRules);
        await client.replaceBackendSwitchingRules(feName, currentRules, { transactionId: tx.id });

        // Clean up ACLs on feName that were exclusively referenced by removedRule
        if (removedRule?.cond_test) {
          const removedTokens = new Set(
            removedRule.cond_test
              .split(/\s+/)
              .map((tok) => tok.replace(/^!/, '').trim())
              .filter(Boolean),
          );
          const stillUsedTokens = new Set(
            currentRules
              .flatMap((r) => (r.cond_test ?? '').split(/\s+/))
              .map((tok) => tok.replace(/^!/, '').trim())
              .filter(Boolean),
          );
          const acls = await client.listFrontendAcls(feName, tx.id).catch(() => []);
          const filteredAcls = acls.filter((a) => !removedTokens.has(a.acl_name) || stillUsedTokens.has(a.acl_name));
          if (filteredAcls.length !== acls.length) {
            await client.replaceFrontendAcls(feName, filteredAcls, { transactionId: tx.id });
          }
        }

        const remainingCounts = buildBackendRefCounts(frontends, switchingByFe);
        if (beName && (remainingCounts.get(beName) ?? 0) === 0) {
          await client.deleteBackend(beName, { transactionId: tx.id }).catch(() => {});
        }
      }

      const committed = await client.commitTransaction(tx.id, true);
      return committed.meta;
    } catch (err) {
      await client.deleteTransaction(tx.id).catch(() => {});
      throw err;
    }
  }
}
