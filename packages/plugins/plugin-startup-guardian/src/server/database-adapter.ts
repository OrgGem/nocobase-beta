/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { Database, parseDatabaseOptionsFromEnv, type IDatabaseOptions } from '@nocobase/database';
import { randomUUID } from 'node:crypto';
import { QueryTypes, type TableName, type Transaction } from 'sequelize';
import type {
  ClusterDrainDecision,
  ClusterRecoveryAuthority,
  ClusterRetryRequest,
  GuardianPolicy,
  QuarantineReceipt,
  QuarantineResult,
  QuarantineTarget,
  SharedClusterControl,
  SharedClusterMember,
  StartupIncident,
} from './contracts';
import { isValidatedCoreVersion, readRuntimeCoreVersion, VALIDATED_CORE_VERSION } from './compatibility';
import {
  BUILT_IN_PROTECTED_PACKAGES,
  createDefaultPolicy,
  isApprovedIncident,
  isGuardianPolicy,
  isProtectedPackage,
} from './policy';
import { isQuarantineReceipt } from './journal';
import { isStartupIncident } from './security';

export interface ApplicationPluginRow {
  id: string | number;
  name: string;
  packageName: string;
  version: string;
  enabled: boolean;
  installed: boolean;
  builtIn: boolean | null;
  options: unknown;
  updatedAt: Date | string;
  updatedAtExact: string;
}

export interface EnabledPluginRow {
  name: string;
  packageName: string;
  version: string;
  enabled: boolean;
  installed: boolean;
  builtIn: boolean | null;
}

export interface ClusterInitializationInput {
  appId: string;
  deploymentId: string;
  members: string[];
  policy?: unknown;
  maxQuarantineAttempts?: number;
}

export interface ClusterNodeBoot {
  nodeId: string;
  bootId: string;
  coreVersion: string;
}

export interface ClusterQuarantineInput {
  authority: ClusterRecoveryAuthority;
  drainRevision: number;
  target: QuarantineTarget;
  incident: StartupIncident;
  assertNoMandatoryDependent: (targetPackageName: string, enabled: EnabledPluginRow[]) => Promise<void>;
}

export interface ClusterDrainContext {
  drainRevision: number;
  participants: Array<{ nodeId: string; bootId: string }>;
}

interface SequelizeIdentifierQueryGenerator {
  quoteTable(identifier: TableName): string;
  quoteIdentifier(identifier: string): string;
}

export class StartupGuardianDatabase {
  private constructor(
    private readonly database: Database,
    private readonly options: IDatabaseOptions,
  ) {}

  static async connectFromEnvironment(): Promise<StartupGuardianDatabase> {
    const coreVersion = await readRuntimeCoreVersion();
    if (!isValidatedCoreVersion(coreVersion)) {
      throw new Error(
        `Automatic recovery is validated only for @nocobase/server ${VALIDATED_CORE_VERSION}; detected ${
          coreVersion || 'unknown'
        }`,
      );
    }
    const options = await parseDatabaseOptionsFromEnv();
    if (options.dialect !== 'postgres') {
      throw new Error(`Automatic quarantine is supported only with DB_DIALECT=postgres; received ${options.dialect}`);
    }
    return new StartupGuardianDatabase(new Database({ ...options, logging: false }), options);
  }

  async readPlugin(target: QuarantineTarget): Promise<ApplicationPluginRow | null> {
    const table = this.quotedTableName();
    const rows = (await this.database.sequelize.query(
      `SELECT "id", "name", "packageName", "version", "enabled", "installed", "builtIn", "options", ${this.updatedAtColumn()} AS "updatedAt", ${this.updatedAtColumn()}::text AS "updatedAtExact" FROM ${table} WHERE "name" = :name AND "packageName" = :packageName`,
      { replacements: { name: target.pluginName, packageName: target.packageName }, type: QueryTypes.SELECT },
    )) as ApplicationPluginRow[];
    if (rows.length > 1) throw new Error('Plugin identity is ambiguous in applicationPlugins');
    const row = rows[0];
    if (!row || row.version !== target.pluginVersion) return null;
    return row;
  }

  async quarantinePlugin(
    target: QuarantineTarget,
    beforeCommit?: (result: QuarantineResult) => Promise<void>,
  ): Promise<QuarantineResult> {
    const table = this.quotedTableName();
    const updatedAtColumn = this.updatedAtColumn();
    return this.database.sequelize.transaction(async (transaction) => {
      const rows = (await this.database.sequelize.query(
        `SELECT "id", "name", "packageName", "version", "enabled", "installed", "builtIn", "options", ${updatedAtColumn} AS "updatedAt", ${updatedAtColumn}::text AS "updatedAtExact" FROM ${table} WHERE "name" = :name AND "packageName" = :packageName FOR UPDATE`,
        {
          replacements: { name: target.pluginName, packageName: target.packageName },
          transaction,
          type: QueryTypes.SELECT,
        },
      )) as ApplicationPluginRow[];
      if (rows.length !== 1) throw new Error('Plugin identity was not found exactly once in applicationPlugins');
      const row = rows[0];
      if (row.version !== target.pluginVersion) throw new Error('Plugin version changed before quarantine');
      if (!row.installed || row.builtIn === true) throw new Error('Plugin is not an installed custom plugin');
      if (!row.enabled) throw new Error('Plugin enabled state changed before quarantine');
      const priorUpdatedAt = row.updatedAtExact;

      const changed = (await this.database.sequelize.query(
        `UPDATE ${table} SET "enabled" = FALSE, ${updatedAtColumn} = date_trunc('milliseconds', clock_timestamp()) WHERE "id" = :id AND "name" = :name AND "packageName" = :packageName AND "version" = :version AND ${updatedAtColumn} = :updatedAt AND "enabled" = TRUE AND "installed" = TRUE AND COALESCE("builtIn", FALSE) = FALSE RETURNING "id", ${updatedAtColumn}::text AS "updatedAtExact"`,
        {
          replacements: {
            id: row.id,
            name: target.pluginName,
            packageName: target.packageName,
            version: target.pluginVersion,
            updatedAt: row.updatedAtExact,
          },
          transaction,
          type: QueryTypes.SELECT,
        },
      )) as Array<{ id: string | number; updatedAtExact: string }>;
      if (changed.length !== 1) throw new Error('Plugin row changed concurrently; quarantine was not applied');

      const result: QuarantineResult = {
        changed: true,
        target,
        rowId: row.id,
        postUpdateTimestamp: changed[0].updatedAtExact,
        priorUpdatedAt,
        before: {
          enabled: row.enabled,
          version: row.version,
          installed: row.installed,
          builtIn: false,
          options: row.options,
          updatedAt: priorUpdatedAt,
        },
      };
      await beforeCommit?.(result);
      return result;
    });
  }

  async restorePlugin(
    receipt: Pick<QuarantineReceipt, 'target' | 'rowId' | 'postUpdateTimestamp' | 'prior'>,
    beforeCommit?: (updatedAt: string) => Promise<void>,
  ): Promise<string | null> {
    const table = this.quotedTableName();
    const updatedAtColumn = this.updatedAtColumn();
    return this.database.sequelize.transaction(async (transaction) => {
      const rows = (await this.database.sequelize.query(
        `UPDATE ${table} SET "enabled" = TRUE, ${updatedAtColumn} = date_trunc('milliseconds', clock_timestamp()) WHERE "id" = :id AND "name" = :name AND "packageName" = :packageName AND "version" = :version AND ${updatedAtColumn} = :updatedAt AND "enabled" = FALSE AND "installed" = :installed AND COALESCE("builtIn", FALSE) = :builtIn AND "options"::jsonb = CAST(:options AS jsonb) RETURNING "id", ${updatedAtColumn}::text AS "updatedAtExact"`,
        {
          replacements: {
            id: receipt.rowId,
            name: receipt.target.pluginName,
            packageName: receipt.target.packageName,
            version: receipt.prior.version,
            updatedAt: receipt.postUpdateTimestamp,
            installed: receipt.prior.installed,
            builtIn: receipt.prior.builtIn,
            options: JSON.stringify(receipt.prior.options),
          },
          transaction,
          type: QueryTypes.SELECT,
        },
      )) as Array<{ id: string | number; updatedAtExact: string }>;
      if (rows.length > 1) throw new Error('Plugin identity is ambiguous in applicationPlugins');
      if (!rows.length) return null;
      const updatedAt = rows[0].updatedAtExact;
      await beforeCommit?.(updatedAt);
      return updatedAt;
    });
  }

  async initializeCluster(input: ClusterInitializationInput): Promise<void> {
    const appId = safeClusterIdentifier(input.appId, 'appId');
    const deploymentId = safeClusterIdentifier(input.deploymentId, 'deploymentId');
    const members = [...new Set(input.members.map((member) => safeClusterIdentifier(member, 'member')))].sort();
    if (members.length === 0 || members.length !== input.members.length) {
      throw new Error('Cluster initialization requires a non-empty, unique app-node roster');
    }
    const suppliedPolicy = input.policy === undefined ? createDefaultPolicy() : input.policy;
    if (!isGuardianPolicy(suppliedPolicy)) throw new Error('Cluster policy is invalid');
    const policy: GuardianPolicy = {
      ...suppliedPolicy,
      protectedPackages: [...new Set([...BUILT_IN_PROTECTED_PACKAGES, ...suppliedPolicy.protectedPackages])],
    };
    if (policy.approvedRules.some((rule) => isProtectedPackage(rule.packageName, policy))) {
      throw new Error('Protected packages cannot be approved');
    }
    const controlTable = this.clusterTable('startupGuardianClusterState');
    const memberTable = this.clusterTable('startupGuardianClusterMembers');
    await this.database.sequelize.transaction(async (transaction) => {
      const existing = (await this.database.sequelize.query(
        `SELECT "appId" FROM ${controlTable} WHERE "appId" = :appId AND "deploymentId" = :deploymentId FOR UPDATE`,
        { replacements: { appId, deploymentId }, transaction, type: QueryTypes.SELECT },
      )) as Array<{ appId: string }>;
      if (existing.length)
        throw new Error('Cluster is already initialized; enrollment is never inferred from an empty table');
      await this.database.sequelize.query(
        `INSERT INTO ${controlTable} ("appId", "deploymentId", "revision", "fence", "drainRevision", "decisionRevision", "policyRevision", "ownerToken", "ownerNodeId", "ownerLeaseExpiresAt", "phase", "expectedMembers", "policy", "campaignId", "quarantineAttempts", "maxQuarantineAttempts") VALUES (:appId, :deploymentId, 0, 0, 0, 0, :policyRevision, NULL, NULL, NULL, 'ready', CAST(:members AS jsonb), CAST(:policy AS jsonb), :campaignId, 0, :maxAttempts)`,
        {
          replacements: {
            appId,
            deploymentId,
            policyRevision: policy.revision,
            members: JSON.stringify(members),
            policy: JSON.stringify(policy),
            campaignId: randomDatabaseId(),
            maxAttempts: Math.max(1, Math.min(10, Math.trunc(input.maxQuarantineAttempts ?? 2))),
          },
          transaction,
          type: QueryTypes.INSERT,
        },
      );
      for (const nodeId of members) {
        await this.database.sequelize.query(
          `INSERT INTO ${memberTable} ("appId", "deploymentId", "nodeId", "bootId", "coreVersion", "protocolVersion", "state", "acknowledgedRevision", "appliedRevision", "lastHeartbeatAt", "incident") VALUES (:appId, :deploymentId, :nodeId, NULL, NULL, 1, 'never-started', 0, 0, NULL, NULL)`,
          { replacements: { appId, deploymentId, nodeId }, transaction, type: QueryTypes.INSERT },
        );
      }
    });
  }

  async readClusterControl(appId: string, deploymentId: string): Promise<SharedClusterControl | null> {
    const rows = (await this.database.sequelize.query(
      `SELECT * FROM ${this.clusterTable(
        'startupGuardianClusterState',
      )} WHERE "appId" = :appId AND "deploymentId" = :deploymentId`,
      { replacements: { appId, deploymentId }, type: QueryTypes.SELECT },
    )) as unknown[];
    return rows.length ? decodeClusterControl(rows[0]) : null;
  }

  async readClusterMembers(appId: string, deploymentId: string): Promise<SharedClusterMember[]> {
    const rows = (await this.database.sequelize.query(
      `SELECT * FROM ${this.clusterTable(
        'startupGuardianClusterMembers',
      )} WHERE "appId" = :appId AND "deploymentId" = :deploymentId ORDER BY "nodeId"`,
      { replacements: { appId, deploymentId }, type: QueryTypes.SELECT },
    )) as unknown[];
    return rows.map(decodeClusterMember);
  }

  async updateClusterPolicy(input: {
    appId: string;
    deploymentId: string;
    expectedPolicyRevision: number;
    policy: GuardianPolicy;
  }): Promise<SharedClusterControl> {
    if (!Number.isSafeInteger(input.expectedPolicyRevision) || input.expectedPolicyRevision < 0) {
      throw new Error('Expected HA policy revision must be a non-negative integer');
    }
    if (!isGuardianPolicy(input.policy)) throw new Error('New HA policy is invalid');
    const policy: GuardianPolicy = {
      ...input.policy,
      protectedPackages: [...new Set([...BUILT_IN_PROTECTED_PACKAGES, ...input.policy.protectedPackages])],
    };
    if (policy.approvedRules.some((rule) => isProtectedPackage(rule.packageName, policy))) {
      throw new Error('Protected packages cannot be approved');
    }
    const table = this.clusterTable('startupGuardianClusterState');
    return this.database.sequelize.transaction(async (transaction) => {
      const rows = (await this.database.sequelize.query(
        `SELECT * FROM ${table} WHERE "appId" = :appId AND "deploymentId" = :deploymentId FOR UPDATE`,
        {
          replacements: { appId: input.appId, deploymentId: input.deploymentId },
          transaction,
          type: QueryTypes.SELECT,
        },
      )) as unknown[];
      if (rows.length !== 1) throw new Error('HA cluster enrollment is missing or ambiguous');
      const control = decodeClusterControl(rows[0]);
      if (control.phase !== 'ready' || control.pendingDecision) {
        throw new Error('HA policy cannot change while the app cohort is draining or held');
      }
      if (control.policyRevision !== input.expectedPolicyRevision) {
        throw new Error('HA policy revision changed; inspect the shared state and retry with the current revision');
      }
      if (policy.revision !== input.expectedPolicyRevision + 1) {
        throw new Error('New HA policy must increment the expected revision exactly once');
      }
      const updated = (await this.database.sequelize.query(
        `UPDATE ${table} SET "policy" = CAST(:policy AS jsonb), "policyRevision" = :policyRevision, "revision" = "revision" + 1 WHERE "appId" = :appId AND "deploymentId" = :deploymentId AND "policyRevision" = :expectedPolicyRevision AND "phase" = 'ready' RETURNING *`,
        {
          replacements: {
            appId: input.appId,
            deploymentId: input.deploymentId,
            expectedPolicyRevision: input.expectedPolicyRevision,
            policyRevision: policy.revision,
            policy: JSON.stringify(policy),
          },
          transaction,
          type: QueryTypes.SELECT,
        },
      )) as unknown[];
      if (updated.length !== 1) throw new Error('HA policy update lost its revision compare-and-swap');
      return decodeClusterControl(updated[0]);
    });
  }

  async registerClusterMember(
    identity: { appId: string; deploymentId: string },
    boot: ClusterNodeBoot,
  ): Promise<SharedClusterMember> {
    const controlTable = this.clusterTable('startupGuardianClusterState');
    const memberTable = this.clusterTable('startupGuardianClusterMembers');
    return this.database.sequelize.transaction(async (transaction) => {
      const controls = (await this.database.sequelize.query(
        `SELECT "phase", "pendingDecision", "decisionRevision" FROM ${controlTable} WHERE "appId" = :appId AND "deploymentId" = :deploymentId FOR UPDATE`,
        { replacements: identity, transaction, type: QueryTypes.SELECT },
      )) as Array<{ phase: string; pendingDecision: unknown; decisionRevision: number }>;
      const control = controls[0];
      if (!control)
        throw new Error('HA Guardian cluster is not enrolled; initialize it while all app nodes are stopped');
      if (control.phase !== 'ready' || control.pendingDecision) {
        throw new Error('Cluster recovery decision is in progress; this app node must remain stopped');
      }
      const priorMembers = (await this.database.sequelize.query(
        `SELECT "bootId", "state" FROM ${memberTable} WHERE "appId" = :appId AND "deploymentId" = :deploymentId AND "nodeId" = :nodeId FOR UPDATE`,
        { replacements: { ...identity, nodeId: boot.nodeId }, transaction, type: QueryTypes.SELECT },
      )) as Array<{ bootId: string | null; state: SharedClusterMember['state'] }>;
      const prior = priorMembers[0];
      if (!prior) throw new Error(`App node ${boot.nodeId} is not in the explicitly enrolled roster`);
      if (!['never-started', 'stopped'].includes(prior.state)) {
        throw new Error(
          `App node ${boot.nodeId} still has an unacknowledged ${prior.state} boot; enrollment does not infer process death`,
        );
      }
      const updated = (await this.database.sequelize.query(
        `UPDATE ${memberTable} SET "bootId" = :bootId, "coreVersion" = :coreVersion, "protocolVersion" = 1, "state" = 'starting', "lastHeartbeatAt" = clock_timestamp(), "incident" = NULL WHERE "appId" = :appId AND "deploymentId" = :deploymentId AND "nodeId" = :nodeId RETURNING *`,
        {
          replacements: { ...identity, nodeId: boot.nodeId, bootId: boot.bootId, coreVersion: boot.coreVersion },
          transaction,
          type: QueryTypes.SELECT,
        },
      )) as unknown[];
      if (updated.length !== 1) throw new Error(`App node ${boot.nodeId} is not in the explicitly enrolled roster`);
      return decodeClusterMember(updated[0]);
    });
  }

  async heartbeatClusterMember(
    identity: { appId: string; deploymentId: string },
    boot: ClusterNodeBoot,
    state: SharedClusterMember['state'],
    appliedRevision?: number,
    incident?: StartupIncident,
  ): Promise<void> {
    await this.database.sequelize.transaction(async (transaction) => {
      const controls = (await this.database.sequelize.query(
        `SELECT "phase" FROM ${this.clusterTable(
          'startupGuardianClusterState',
        )} WHERE "appId" = :appId AND "deploymentId" = :deploymentId FOR SHARE`,
        { replacements: identity, transaction, type: QueryTypes.SELECT },
      )) as Array<{ phase: string }>;
      if (!controls.length) throw new Error('Cluster enrollment is missing');
      if ((state === 'ready' || state === 'starting') && controls[0].phase !== 'ready') {
        throw new Error('Cluster drain or recovery hold is active; member cannot report ready');
      }
      const rows = (await this.database.sequelize.query(
        `UPDATE ${this.clusterTable(
          'startupGuardianClusterMembers',
        )} SET "state" = :state, "lastHeartbeatAt" = clock_timestamp(), "appliedRevision" = COALESCE(:appliedRevision, "appliedRevision"), "incident" = CAST(:incident AS jsonb) WHERE "appId" = :appId AND "deploymentId" = :deploymentId AND "nodeId" = :nodeId AND "bootId" = :bootId RETURNING "nodeId"`,
        {
          replacements: {
            ...identity,
            nodeId: boot.nodeId,
            bootId: boot.bootId,
            state,
            appliedRevision: appliedRevision ?? null,
            incident: incident ? JSON.stringify(incident) : null,
          },
          transaction,
          type: QueryTypes.SELECT,
        },
      )) as Array<{ nodeId: string }>;
      if (rows.length !== 1) throw new Error('Cluster member boot changed or was removed; heartbeat is stale');
    });
  }

  async recordClusterIncident(
    identity: { appId: string; deploymentId: string },
    boot: ClusterNodeBoot,
    incident: StartupIncident,
  ): Promise<void> {
    await this.database.sequelize.transaction(async (transaction) => {
      const updated = (await this.database.sequelize.query(
        `UPDATE ${this.clusterTable(
          'startupGuardianClusterMembers',
        )} SET "state" = 'stopped', "incident" = CAST(:incident AS jsonb), "lastHeartbeatAt" = clock_timestamp() WHERE "appId" = :appId AND "deploymentId" = :deploymentId AND "nodeId" = :nodeId AND "bootId" = :bootId RETURNING "nodeId"`,
        {
          replacements: { ...identity, nodeId: boot.nodeId, bootId: boot.bootId, incident: JSON.stringify(incident) },
          transaction,
          type: QueryTypes.SELECT,
        },
      )) as Array<{ nodeId: string }>;
      if (updated.length !== 1) throw new Error('Incident belongs to a stale or unregistered cluster boot');
      await this.database.sequelize.query(
        `UPDATE ${this.clusterTable(
          'startupGuardianClusterState',
        )} SET "incident" = CAST(:incident AS jsonb), "revision" = "revision" + 1 WHERE "appId" = :appId AND "deploymentId" = :deploymentId AND "phase" = 'ready'`,
        { replacements: { ...identity, incident: JSON.stringify(incident) }, transaction, type: QueryTypes.UPDATE },
      );
    });
  }

  async holdClusterRecovery(
    identity: { appId: string; deploymentId: string },
    authority: ClusterRecoveryAuthority,
    drainRevision: number,
    detail: string,
  ): Promise<void> {
    const table = this.clusterTable('startupGuardianClusterState');
    await this.database.sequelize.transaction(async (transaction) => {
      const control = await this.lockAuthorizedControl(transaction, identity, authority);
      if (control.phase !== 'draining' || control.drainRevision !== drainRevision) {
        throw new Error('Recovery hold refers to a stale cluster decision');
      }
      await this.database.sequelize.query(
        `UPDATE ${table} SET "phase" = 'recovery-required', "revision" = "revision" + 1, "detail" = :detail WHERE "appId" = :appId AND "deploymentId" = :deploymentId`,
        { replacements: { ...identity, detail: detail.slice(0, 1000) }, transaction, type: QueryTypes.UPDATE },
      );
    });
  }

  async acquireClusterAuthority(
    identity: { appId: string; deploymentId: string },
    ownerNodeId: string,
    ownerToken: string,
    leaseMs: number,
  ): Promise<ClusterRecoveryAuthority> {
    const table = this.clusterTable('startupGuardianClusterState');
    return this.database.sequelize.transaction(async (transaction) => {
      const rows = (await this.database.sequelize.query(
        `SELECT "fence", "ownerToken", "ownerNodeId", ("ownerLeaseExpiresAt" > clock_timestamp()) AS "leaseActive" FROM ${table} WHERE "appId" = :appId AND "deploymentId" = :deploymentId FOR UPDATE`,
        { replacements: identity, transaction, type: QueryTypes.SELECT },
      )) as Array<{ fence: number; ownerToken: string | null; ownerNodeId: string | null; leaseActive: boolean }>;
      const row = rows[0];
      if (!row) throw new Error('Cluster enrollment is missing; shared recovery is refused');
      if (row.leaseActive && row.ownerToken !== ownerToken)
        throw new Error('Another cluster recovery owner holds the database lease');
      const fence =
        row.ownerToken === ownerToken && row.ownerNodeId === ownerNodeId ? Number(row.fence) : Number(row.fence) + 1;
      const changed = (await this.database.sequelize.query(
        `UPDATE ${table} SET "fence" = :fence, "ownerToken" = :ownerToken, "ownerNodeId" = :ownerNodeId, "ownerLeaseExpiresAt" = clock_timestamp() + (:leaseMs * interval '1 millisecond') WHERE "appId" = :appId AND "deploymentId" = :deploymentId RETURNING "fence"`,
        {
          replacements: { ...identity, ownerToken, ownerNodeId, fence, leaseMs },
          transaction,
          type: QueryTypes.SELECT,
        },
      )) as Array<{ fence: number }>;
      return { ownerToken, ownerNodeId, fence: Number(changed[0].fence) };
    });
  }

  async renewClusterAuthority(
    identity: { appId: string; deploymentId: string },
    authority: ClusterRecoveryAuthority,
    leaseMs: number,
  ): Promise<boolean> {
    const rows = (await this.database.sequelize.query(
      `UPDATE ${this.clusterTable(
        'startupGuardianClusterState',
      )} SET "ownerLeaseExpiresAt" = clock_timestamp() + (:leaseMs * interval '1 millisecond') WHERE "appId" = :appId AND "deploymentId" = :deploymentId AND "fence" = :fence AND "ownerToken" = :ownerToken AND "ownerNodeId" = :ownerNodeId AND "ownerLeaseExpiresAt" > clock_timestamp() RETURNING "fence"`,
      { replacements: { ...identity, ...authority, leaseMs }, type: QueryTypes.SELECT },
    )) as Array<{ fence: number }>;
    return rows.length === 1;
  }

  async releaseClusterAuthority(
    identity: { appId: string; deploymentId: string },
    authority: ClusterRecoveryAuthority,
  ): Promise<void> {
    await this.database.sequelize.query(
      `UPDATE ${this.clusterTable(
        'startupGuardianClusterState',
      )} SET "ownerToken" = NULL, "ownerNodeId" = NULL, "ownerLeaseExpiresAt" = NULL WHERE "appId" = :appId AND "deploymentId" = :deploymentId AND "fence" = :fence AND "ownerToken" = :ownerToken AND "ownerNodeId" = :ownerNodeId`,
      { replacements: { ...identity, ...authority }, type: QueryTypes.UPDATE },
    );
  }

  async beginClusterDrain(
    identity: { appId: string; deploymentId: string },
    authority: ClusterRecoveryAuthority,
    decision: Omit<ClusterDrainDecision, 'revision' | 'policyRevision' | 'requestedAt' | 'participants'>,
  ): Promise<ClusterDrainContext> {
    const controlTable = this.clusterTable('startupGuardianClusterState');
    const memberTable = this.clusterTable('startupGuardianClusterMembers');
    return this.database.sequelize.transaction(async (transaction) => {
      const control = await this.lockAuthorizedControl(transaction, identity, authority);
      if (control.phase !== 'ready' || control.pendingDecision)
        throw new Error('Another cluster decision is already active');
      const participants = (await this.database.sequelize.query(
        `SELECT "nodeId", "bootId" FROM ${memberTable} WHERE "appId" = :appId AND "deploymentId" = :deploymentId AND "state" IN ('starting', 'ready', 'draining') AND "bootId" IS NOT NULL ORDER BY "nodeId"`,
        { replacements: identity, transaction, type: QueryTypes.SELECT },
      )) as Array<{ nodeId: string; bootId: string }>;
      const drainRevision = Number(control.drainRevision) + 1;
      const pendingDecision: ClusterDrainDecision = {
        ...decision,
        revision: drainRevision,
        policyRevision: Number(control.policyRevision),
        requestedAt: new Date().toISOString(),
        participants,
      };
      await this.database.sequelize.query(
        `UPDATE ${controlTable} SET "phase" = 'draining', "drainRevision" = :drainRevision, "revision" = "revision" + 1, "pendingDecision" = CAST(:pendingDecision AS jsonb) WHERE "appId" = :appId AND "deploymentId" = :deploymentId`,
        {
          replacements: { ...identity, drainRevision, pendingDecision: JSON.stringify(pendingDecision) },
          transaction,
          type: QueryTypes.UPDATE,
        },
      );
      return { drainRevision, participants };
    });
  }

  async acknowledgeClusterStopped(
    identity: { appId: string; deploymentId: string },
    nodeId: string,
    bootId: string,
    drainRevision: number,
  ): Promise<void> {
    const table = this.clusterTable('startupGuardianClusterState');
    const members = this.clusterTable('startupGuardianClusterMembers');
    await this.database.sequelize.transaction(async (transaction) => {
      const controls = (await this.database.sequelize.query(
        `SELECT "phase", "drainRevision", "pendingDecision" FROM ${table} WHERE "appId" = :appId AND "deploymentId" = :deploymentId FOR UPDATE`,
        { replacements: identity, transaction, type: QueryTypes.SELECT },
      )) as Array<{ phase: string; drainRevision: number; pendingDecision: unknown }>;
      const pending = parseJson<ClusterDrainDecision>(controls[0]?.pendingDecision);
      if (controls[0]?.phase !== 'draining' || Number(controls[0].drainRevision) !== drainRevision || !pending) {
        throw new Error('Drain acknowledgement refers to a stale or missing decision');
      }
      if (!pending.participants.some((participant) => participant.nodeId === nodeId && participant.bootId === bootId)) {
        throw new Error('Drain acknowledgement boot is not part of the current decision');
      }
      const updated = (await this.database.sequelize.query(
        `UPDATE ${members} SET "state" = 'stopped', "acknowledgedRevision" = :drainRevision, "lastHeartbeatAt" = clock_timestamp() WHERE "appId" = :appId AND "deploymentId" = :deploymentId AND "nodeId" = :nodeId AND "bootId" = :bootId RETURNING "nodeId"`,
        { replacements: { ...identity, nodeId, bootId, drainRevision }, transaction, type: QueryTypes.SELECT },
      )) as Array<{ nodeId: string }>;
      if (updated.length !== 1)
        throw new Error('Drain acknowledgement boot is stale; member must remain unacknowledged');
    });
  }

  async quarantineClusterPlugin(input: ClusterQuarantineInput): Promise<QuarantineReceipt> {
    const controlTable = this.clusterTable('startupGuardianClusterState');
    const memberTable = this.clusterTable('startupGuardianClusterMembers');
    const appTable = this.quotedTableName();
    const updatedAtColumn = this.updatedAtColumn();
    return this.database.sequelize.transaction(async (transaction) => {
      const control = await this.lockAuthorizedControl(
        transaction,
        { appId: input.incident.appId, deploymentId: input.incident.deploymentId },
        input.authority,
      );
      if (control.phase !== 'draining' || Number(control.drainRevision) !== input.drainRevision) {
        throw new Error('Cluster decision revision is stale; plugin state was not changed');
      }
      const pending = parseJson<ClusterDrainDecision>(control.pendingDecision);
      if (!pending || pending.type !== 'quarantine' || !sameTarget(pending.target, input.target)) {
        throw new Error('The active cluster decision does not match this quarantine target');
      }
      if (
        pending.policyRevision !== Number(control.policyRevision) ||
        !isApprovedIncident(control.policy, input.incident)
      ) {
        throw new Error('No current exact approved policy matches this cluster incident');
      }
      const activeParticipants = pending.participants;
      for (const participant of activeParticipants) {
        const rows = (await this.database.sequelize.query(
          `SELECT "bootId", "state", "acknowledgedRevision" FROM ${memberTable} WHERE "appId" = :appId AND "deploymentId" = :deploymentId AND "nodeId" = :nodeId FOR UPDATE`,
          {
            replacements: { appId: control.appId, deploymentId: control.deploymentId, nodeId: participant.nodeId },
            transaction,
            type: QueryTypes.SELECT,
          },
        )) as Array<{ bootId: string; state: string; acknowledgedRevision: number }>;
        const member = rows[0];
        if (
          !member ||
          member.bootId !== participant.bootId ||
          member.state !== 'stopped' ||
          Number(member.acknowledgedRevision) !== input.drainRevision
        ) {
          throw new Error(
            `Cluster node ${participant.nodeId} has not confirmed that boot ${participant.bootId} stopped`,
          );
        }
      }
      if (Number(control.quarantineAttempts) >= Number(control.maxQuarantineAttempts)) {
        throw new Error('Cluster campaign quarantine attempt budget is exhausted');
      }
      const rows = (await this.database.sequelize.query(
        `SELECT "id", "name", "packageName", "version", "enabled", "installed", "builtIn", "options", ${updatedAtColumn} AS "updatedAt", ${updatedAtColumn}::text AS "updatedAtExact" FROM ${appTable} WHERE "name" = :name AND "packageName" = :packageName FOR UPDATE`,
        {
          replacements: { name: input.target.pluginName, packageName: input.target.packageName },
          transaction,
          type: QueryTypes.SELECT,
        },
      )) as ApplicationPluginRow[];
      if (rows.length !== 1) throw new Error('Plugin identity was not found exactly once in applicationPlugins');
      const row = rows[0];
      if (row.version !== input.target.pluginVersion || !row.enabled || !row.installed || row.builtIn === true) {
        throw new Error('Plugin version, enabled state or ownership changed before cluster quarantine');
      }
      const enabled = (await this.database.sequelize.query(
        `SELECT "name", "packageName", "version", "enabled", "installed", "builtIn" FROM ${appTable} WHERE "enabled" = TRUE AND "installed" = TRUE`,
        { transaction, type: QueryTypes.SELECT },
      )) as EnabledPluginRow[];
      await input.assertNoMandatoryDependent(input.target.packageName, enabled);
      const changed = (await this.database.sequelize.query(
        `UPDATE ${appTable} SET "enabled" = FALSE, ${updatedAtColumn} = date_trunc('milliseconds', clock_timestamp()) WHERE "id" = :id AND "name" = :name AND "packageName" = :packageName AND "version" = :version AND ${updatedAtColumn} = :updatedAt AND "enabled" = TRUE AND "installed" = TRUE AND COALESCE("builtIn", FALSE) = FALSE RETURNING ${updatedAtColumn}::text AS "updatedAtExact"`,
        {
          replacements: {
            id: row.id,
            name: input.target.pluginName,
            packageName: input.target.packageName,
            version: input.target.pluginVersion,
            updatedAt: row.updatedAtExact,
          },
          transaction,
          type: QueryTypes.SELECT,
        },
      )) as Array<{ updatedAtExact: string }>;
      if (changed.length !== 1) throw new Error('Plugin row changed concurrently; cluster quarantine was not applied');
      const result: QuarantineResult = {
        changed: true,
        target: input.target,
        rowId: row.id,
        postUpdateTimestamp: changed[0].updatedAtExact,
        priorUpdatedAt: row.updatedAtExact,
        before: {
          enabled: row.enabled,
          installed: row.installed,
          builtIn: false,
          version: row.version,
          options: row.options,
          updatedAt: row.updatedAtExact,
        },
      };
      const receipt: QuarantineReceipt = {
        quarantineId: randomDatabaseId(),
        status: 'quarantined',
        incident: input.incident,
        target: input.target,
        rowId: row.id,
        postUpdateTimestamp: result.postUpdateTimestamp,
        prior: result.before,
        quarantinedAt: new Date().toISOString(),
      };
      (await this.database.sequelize.query(
        `UPDATE ${controlTable} SET "phase" = 'ready', "revision" = "revision" + 1, "decisionRevision" = "decisionRevision" + 1, "pendingDecision" = NULL, "quarantine" = CAST(:receipt AS jsonb), "incident" = NULL, "quarantineAttempts" = "quarantineAttempts" + 1, "campaignId" = :campaignId, "detail" = 'Plugin quarantined by approved cluster decision' WHERE "appId" = :appId AND "deploymentId" = :deploymentId AND "drainRevision" = :drainRevision AND "fence" = :fence AND "ownerToken" = :ownerToken AND "ownerNodeId" = :ownerNodeId AND "ownerLeaseExpiresAt" > clock_timestamp() RETURNING "fence"`,
        {
          replacements: {
            appId: control.appId,
            deploymentId: control.deploymentId,
            fence: input.authority.fence,
            ownerToken: input.authority.ownerToken,
            ownerNodeId: input.authority.ownerNodeId,
            drainRevision: input.drainRevision,
            receipt: JSON.stringify(receipt),
            campaignId: control.campaignId,
          },
          transaction,
          type: QueryTypes.SELECT,
        },
      )) as Array<{ fence: number }>;
      if (changed.length !== 1)
        throw new Error('Cluster database fence expired during quarantine; transaction rolled back');
      return receipt;
    });
  }

  async close(): Promise<void> {
    await this.database.close();
  }

  async listEnabledPlugins(): Promise<EnabledPluginRow[]> {
    const rows = (await this.database.sequelize.query(
      `SELECT "name", "packageName", "version", "enabled", "installed", "builtIn" FROM ${this.quotedTableName()} WHERE "enabled" = TRUE AND "installed" = TRUE`,
      { type: QueryTypes.SELECT },
    )) as EnabledPluginRow[];
    return rows;
  }

  private quotedTableName(): string {
    const queryGenerator = this.getIdentifierQueryGenerator();
    const tableName = `${this.options.tablePrefix || ''}applicationPlugins`;
    const schema = this.options.schema;
    return queryGenerator.quoteTable(schema ? { tableName, schema } : tableName);
  }

  private clusterTable(name: 'startupGuardianClusterState' | 'startupGuardianClusterMembers'): string {
    const queryGenerator = this.getIdentifierQueryGenerator();
    const tableName = `${this.options.tablePrefix || ''}${name}`;
    return queryGenerator.quoteTable(this.options.schema ? { tableName, schema: this.options.schema } : tableName);
  }

  private async lockAuthorizedControl(
    transaction: Transaction,
    identity: { appId: string; deploymentId: string },
    authority: ClusterRecoveryAuthority,
  ): Promise<SharedClusterControl> {
    const rows = (await this.database.sequelize.query(
      `SELECT *, ("ownerLeaseExpiresAt" > clock_timestamp()) AS "leaseActive" FROM ${this.clusterTable(
        'startupGuardianClusterState',
      )} WHERE "appId" = :appId AND "deploymentId" = :deploymentId FOR UPDATE`,
      { replacements: identity, transaction, type: QueryTypes.SELECT },
    )) as unknown[];
    const raw = rows[0];
    if (!raw || typeof raw !== 'object') throw new Error('HA Guardian cluster enrollment is missing');
    const value = raw as Record<string, unknown>;
    if (
      value.ownerToken !== authority.ownerToken ||
      value.ownerNodeId !== authority.ownerNodeId ||
      Number(value.fence) !== authority.fence ||
      value.leaseActive !== true
    ) {
      throw new Error('Cluster database fence or lease is stale; refusing shared mutation');
    }
    return decodeClusterControl(raw);
  }

  private updatedAtColumn(): string {
    const queryGenerator = this.getIdentifierQueryGenerator();
    const identifier = this.options.underscored ? 'updated_at' : 'updatedAt';
    return queryGenerator.quoteIdentifier(identifier);
  }

  private getIdentifierQueryGenerator(): SequelizeIdentifierQueryGenerator {
    const queryGenerator: unknown = this.database.sequelize.getQueryInterface().queryGenerator;
    if (!isSequelizeIdentifierQueryGenerator(queryGenerator)) {
      throw new Error('The configured Sequelize dialect does not expose safe identifier quoting');
    }
    return queryGenerator;
  }
}

function decodeClusterControl(value: unknown): SharedClusterControl {
  if (!value || typeof value !== 'object') throw new Error('Cluster control row is invalid');
  const row = value as Record<string, unknown>;
  const policy = parseJson<unknown>(row.policy);
  const expectedMembers = parseJson<unknown>(row.expectedMembers);
  const phase = row.phase;
  if (
    typeof row.appId !== 'string' ||
    typeof row.deploymentId !== 'string' ||
    !Number.isSafeInteger(Number(row.revision)) ||
    !Number.isSafeInteger(Number(row.fence)) ||
    !Number.isSafeInteger(Number(row.drainRevision)) ||
    !Number.isSafeInteger(Number(row.decisionRevision)) ||
    !Number.isSafeInteger(Number(row.policyRevision)) ||
    !Number.isSafeInteger(Number(row.quarantineAttempts)) ||
    !Number.isSafeInteger(Number(row.maxQuarantineAttempts)) ||
    !['ready', 'draining', 'restarting', 'recovery-required'].includes(String(phase)) ||
    !Array.isArray(expectedMembers) ||
    expectedMembers.some((member) => typeof member !== 'string') ||
    !isGuardianPolicy(policy) ||
    typeof row.campaignId !== 'string'
  ) {
    throw new Error('Cluster control row has an unsupported schema or invalid fields');
  }
  const pendingDecision = parseOptionalJson<ClusterDrainDecision>(row.pendingDecision);
  const quarantine = parseOptionalJson<QuarantineReceipt>(row.quarantine);
  if (quarantine && !isQuarantineReceipt(quarantine)) throw new Error('Cluster quarantine receipt is invalid');
  const incident = parseOptionalJson<StartupIncident>(row.incident);
  if (incident && !isStartupIncident(incident)) throw new Error('Cluster incident is invalid');
  const retryRequest = parseOptionalJson<ClusterRetryRequest>(row.retryRequest);
  return {
    appId: row.appId,
    deploymentId: row.deploymentId,
    revision: Number(row.revision),
    fence: Number(row.fence),
    drainRevision: Number(row.drainRevision),
    decisionRevision: Number(row.decisionRevision),
    policyRevision: Number(row.policyRevision),
    ownerToken: typeof row.ownerToken === 'string' ? row.ownerToken : null,
    ownerNodeId: typeof row.ownerNodeId === 'string' ? row.ownerNodeId : null,
    ownerLeaseExpiresAt: row.ownerLeaseExpiresAt ? new Date(String(row.ownerLeaseExpiresAt)).toISOString() : null,
    phase: phase as SharedClusterControl['phase'],
    expectedMembers: expectedMembers as string[],
    policy,
    campaignId: row.campaignId,
    quarantineAttempts: Number(row.quarantineAttempts),
    maxQuarantineAttempts: Number(row.maxQuarantineAttempts),
    pendingDecision,
    quarantine,
    retryRequest,
    incident,
    detail: typeof row.detail === 'string' ? row.detail : undefined,
  };
}

function decodeClusterMember(value: unknown): SharedClusterMember {
  if (!value || typeof value !== 'object') throw new Error('Cluster member row is invalid');
  const row = value as Record<string, unknown>;
  const state = row.state;
  const incident = parseOptionalJson<StartupIncident>(row.incident);
  if (
    typeof row.appId !== 'string' ||
    typeof row.deploymentId !== 'string' ||
    typeof row.nodeId !== 'string' ||
    !Number.isSafeInteger(Number(row.protocolVersion)) ||
    !['never-started', 'starting', 'ready', 'draining', 'stopped', 'recovery-required'].includes(String(state)) ||
    !Number.isSafeInteger(Number(row.acknowledgedRevision)) ||
    !Number.isSafeInteger(Number(row.appliedRevision)) ||
    (incident && !isStartupIncident(incident))
  ) {
    throw new Error('Cluster member row has an unsupported schema or invalid fields');
  }
  return {
    appId: row.appId,
    deploymentId: row.deploymentId,
    nodeId: row.nodeId,
    bootId: typeof row.bootId === 'string' ? row.bootId : null,
    coreVersion: typeof row.coreVersion === 'string' ? row.coreVersion : null,
    protocolVersion: Number(row.protocolVersion),
    state: state as SharedClusterMember['state'],
    acknowledgedRevision: Number(row.acknowledgedRevision),
    appliedRevision: Number(row.appliedRevision),
    lastHeartbeatAt: row.lastHeartbeatAt ? new Date(String(row.lastHeartbeatAt)).toISOString() : null,
    incident,
  };
}

function parseJson<T>(value: unknown): T {
  return (typeof value === 'string' ? JSON.parse(value) : value) as T;
}

function parseOptionalJson<T>(value: unknown): T | undefined {
  return value === null || value === undefined ? undefined : parseJson<T>(value);
}

function safeClusterIdentifier(value: string, name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(value)) throw new Error(`Cluster ${name} is invalid`);
  return value;
}

function sameTarget(left: QuarantineTarget, right: QuarantineTarget): boolean {
  return (
    left.pluginName === right.pluginName &&
    left.packageName === right.packageName &&
    left.pluginVersion === right.pluginVersion
  );
}

function randomDatabaseId(): string {
  return randomUUID();
}

function isSequelizeIdentifierQueryGenerator(value: unknown): value is SequelizeIdentifierQueryGenerator {
  if (!value || typeof value !== 'object') return false;
  return (
    'quoteTable' in value &&
    typeof value.quoteTable === 'function' &&
    'quoteIdentifier' in value &&
    typeof value.quoteIdentifier === 'function'
  );
}
