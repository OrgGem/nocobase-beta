/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { Database, Filter, Model, Transaction } from '@nocobase/database';
import { z } from 'zod';
import { read } from '../utils/record-utils';
import { resolveUserDepartment } from './DepartmentAttribution';

const settingsSchema = z
  .object({
    instruction: z.string().max(50000).optional(),
    systemPrompt: z.string().max(50000).nullable().optional(),
    allowedModels: z.array(z.string().min(1).max(355)).max(200).optional(),
    allow: z.boolean().optional(),
    maxMonthlyTokens: z.number().int().nonnegative().nullable().optional(),
    maxMonthlyCost: z.number().finite().nonnegative().nullable().optional(),
  })
  .strict();

export type GovernanceSettings = z.infer<typeof settingsSchema>;
export type GovernanceScope = 'department' | 'user' | 'employee';
type RecordValue = Model | Record<string, unknown>;
type ActivePolicy = {
  id: number;
  scope: GovernanceScope;
  scopeId: string;
  employeeUsername: string | null;
  modelKey: string | null;
  version: number;
  versionId: number;
  settings: GovernanceSettings;
};

const managedWrites = new AsyncLocalStorage<boolean>();

export function isManagedPromptWrite() {
  return managedWrites.getStore() === true;
}

function idValue(value: unknown, _label: string): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid governance identifier.');
  return id;
}

function requiredText(value: unknown, _label: string, maxLength: number) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength) {
    throw new Error('Invalid governance text value.');
  }
  return value.trim();
}

function safeSettings(value: unknown, scope: GovernanceScope) {
  const result = settingsSchema.safeParse(value);
  if (!result.success) throw new Error('Invalid governance settings.');
  const settings = result.data;
  if (scope !== 'employee' && settings.systemPrompt !== undefined) {
    throw new Error('A system prompt can only be configured for an employee policy.');
  }
  return settings;
}

function plain(row: RecordValue): Record<string, unknown> {
  if ('toJSON' in row && typeof row.toJSON === 'function') return row.toJSON() as Record<string, unknown>;
  return row as Record<string, unknown>;
}

function policyScope(value: unknown): GovernanceScope {
  if (value === 'department' || value === 'user' || value === 'employee') return value;
  throw new Error('Policy scope is invalid.');
}

export class AgentGovernanceService {
  constructor(private readonly db: Database) {}

  async list(input: { page?: unknown; pageSize?: unknown; scope?: unknown; scopeId?: unknown }) {
    const page = Math.max(1, Math.trunc(Number(input.page) || 1));
    const pageSize = Math.min(100, Math.max(1, Math.trunc(Number(input.pageSize) || 20)));
    const filter: Record<string, unknown> = {};
    if (input.scope) filter.scope = policyScope(input.scope);
    if (input.scopeId) filter.scopeId = requiredText(input.scopeId, 'Scope id', 200);
    const policies = this.db.getRepository('agentGovernancePolicies');
    const [rows, count] = await Promise.all([
      policies.find({
        filter: filter as Filter,
        sort: ['-updatedAt', '-id'],
        limit: pageSize,
        offset: (page - 1) * pageSize,
      }),
      policies.count({ filter: filter as Filter }),
    ]);
    const versions = this.db.getRepository('agentGovernancePolicyVersions');
    const data = await Promise.all(
      rows.map(async (row: Model) => {
        const policyId = idValue(read(row, 'id'), 'Policy id');
        const currentVersionId = read(row, 'currentVersionId');
        const [current, draft] = await Promise.all([
          currentVersionId ? versions.findOne({ filterByTk: idValue(currentVersionId, 'Version id') }) : null,
          versions.findOne({ filter: { policyId, status: 'draft' }, sort: ['-version'] }),
        ]);
        return { ...plain(row), currentVersion: current ? plain(current) : null, draft: draft ? plain(draft) : null };
      }),
    );
    return { data, meta: { count, page, pageSize } };
  }

  async listVersions(policyId: unknown) {
    const id = idValue(policyId, 'Policy id');
    return this.db.getRepository('agentGovernancePolicyVersions').find({
      filter: { policyId: id },
      sort: ['-version'],
      limit: 500,
    });
  }

  async saveDraft(input: Record<string, unknown>, actorId: number) {
    const scope = policyScope(input.scope);
    const rawScopeId = requiredText(input.scopeId, 'Scope id', 200);
    let scopeId = rawScopeId;
    if (scope === 'user') scopeId = String(idValue(rawScopeId, 'Scope id'));
    if (scope === 'department') {
      if (!/^[1-9]\d{0,18}$/.test(rawScopeId) || BigInt(rawScopeId) > 9223372036854775807n) {
        throw new Error('Department id is invalid.');
      }
      scopeId = BigInt(rawScopeId).toString();
    }
    let employeeUsername = input.employeeUsername ? requiredText(input.employeeUsername, 'Employee', 100) : null;
    const modelKey = input.modelKey ? requiredText(input.modelKey, 'Model key', 355) : null;
    if (scope === 'employee' && employeeUsername && employeeUsername !== scopeId) {
      throw new Error('Employee policy scope does not match its employee selector.');
    }
    if (scope === 'employee') employeeUsername = null;
    if (modelKey && (modelKey.indexOf(':') < 1 || modelKey.endsWith(':'))) {
      throw new Error('Model key must include the LLM service and model.');
    }
    const settings = safeSettings(input.settings ?? {}, scope);
    if (modelKey && (settings.instruction || settings.systemPrompt !== undefined)) {
      throw new Error('A model-specific policy cannot change a persistent prompt.');
    }
    const key = `v1:${createHash('sha256')
      .update(JSON.stringify([scope, scopeId, employeeUsername, modelKey]))
      .digest('hex')}`;
    return this.db.sequelize.transaction(async (transaction: Transaction) => {
      const policies = this.db.getRepository('agentGovernancePolicies');
      let policy = await policies.findOne({ filter: { policyKey: key }, transaction, lock: transaction.LOCK.UPDATE });
      if (!policy) {
        const targetCollection = scope === 'employee' ? 'aiEmployees' : scope === 'user' ? 'users' : 'departments';
        if (!this.db.hasCollection(targetCollection)) throw new Error('Policy scope is unavailable.');
        const target = await this.db.getRepository(targetCollection).findOne({
          ...(scope === 'employee' ? { filter: { username: scopeId } } : { filterByTk: scopeId }),
          transaction,
        });
        if (!target) throw new Error('Policy scope does not exist.');
        policy = await policies.create({
          values: { policyKey: key, scope, scopeId, employeeUsername, modelKey },
          transaction,
        });
        if (scope === 'employee' && !modelKey) {
          const original = read(target, 'about');
          const baseline = await this.db.getRepository('agentGovernancePolicyVersions').create({
            values: {
              policyId: read(policy, 'id'),
              version: 1,
              status: 'published',
              settings: { systemPrompt: typeof original === 'string' ? original : null },
              publishedById: actorId,
              publishedAt: new Date(),
            },
            transaction,
          });
          await policies.update({
            filterByTk: idValue(read(policy, 'id'), 'Policy id'),
            values: { currentVersionId: idValue(read(baseline, 'id'), 'Version id') },
            transaction,
          });
        }
      }
      const policyId = idValue(read(policy, 'id'), 'Policy id');
      const versions = this.db.getRepository('agentGovernancePolicyVersions');
      const latest = await versions.findOne({ filter: { policyId }, sort: ['-version'], transaction });
      if (latest && read(latest, 'status') === 'draft') {
        const versionId = idValue(read(latest, 'id'), 'Version id');
        const revision = idValue(read(latest, 'revision') ?? 1, 'Revision') + 1;
        await versions.update({ filterByTk: versionId, values: { settings, revision }, transaction });
        await this.audit({ action: 'saveDraft', actorId, policyId, versionId }, transaction);
        return { policyId, version: await versions.findOne({ filterByTk: versionId, transaction }) };
      }
      const version = latest ? idValue(read(latest, 'version'), 'Version') + 1 : 1;
      const draft = await versions.create({ values: { policyId, version, status: 'draft', settings }, transaction });
      await this.audit(
        { action: 'saveDraft', actorId, policyId, versionId: idValue(read(draft, 'id'), 'Version id') },
        transaction,
      );
      return {
        policyId,
        version: draft,
      };
    });
  }

  async publish(
    policyIdValue: unknown,
    actorId: number,
    options: { rollbackVersion?: unknown; versionId?: unknown; revision?: unknown },
  ) {
    const policyId = idValue(policyIdValue, 'Policy id');
    return this.db.sequelize.transaction(async (transaction: Transaction) => {
      const policies = this.db.getRepository('agentGovernancePolicies');
      const versions = this.db.getRepository('agentGovernancePolicyVersions');
      const policy = await policies.findOne({ filterByTk: policyId, transaction, lock: transaction.LOCK.UPDATE });
      if (!policy) throw new Error('Policy does not exist.');
      const scope = policyScope(read(policy, 'scope'));
      let version = await versions.findOne({ filter: { policyId, status: 'draft' }, sort: ['-version'], transaction });
      if (options.rollbackVersion !== undefined) {
        const target = await versions.findOne({
          filter: { policyId, version: idValue(options.rollbackVersion, 'Version'), status: 'published' },
          transaction,
        });
        if (!target) throw new Error('Published policy version does not exist.');
        const latest = await versions.findOne({ filter: { policyId }, sort: ['-version'], transaction });
        version = await versions.create({
          values: {
            policyId,
            version: idValue(read(latest, 'version'), 'Version') + 1,
            status: 'draft',
            settings: read(target, 'settings'),
          },
          transaction,
        });
      }
      if (!version) throw new Error('Policy has no draft to publish.');
      if (
        options.rollbackVersion === undefined &&
        (idValue(read(version, 'id'), 'Version id') !== idValue(options.versionId, 'Version id') ||
          idValue(read(version, 'revision') ?? 1, 'Revision') !== idValue(options.revision, 'Revision'))
      ) {
        throw new Error('The policy draft changed. Refresh it before publishing.');
      }
      const settings = safeSettings(read(version, 'settings'), scope);
      if (scope === 'employee' && !read(policy, 'modelKey')) {
        const username = requiredText(read(policy, 'scopeId'), 'Employee', 100);
        const employees = this.db.getRepository('aiEmployees');
        const employee = await employees.findOne({ filter: { username }, transaction, lock: transaction.LOCK.UPDATE });
        if (!employee) throw new Error('AI employee does not exist.');
        if (settings.systemPrompt !== undefined) {
          await employees.update({ filter: { username }, values: { about: settings.systemPrompt }, transaction });
        } else {
          const currentPrompt = read(employee, 'about');
          settings.systemPrompt = typeof currentPrompt === 'string' ? currentPrompt : null;
        }
      }
      const versionId = idValue(read(version, 'id'), 'Version id');
      await versions.update({
        filterByTk: versionId,
        values: { status: 'published', settings, publishedById: actorId, publishedAt: new Date() },
        transaction,
      });
      await policies.update({ filterByTk: policyId, values: { currentVersionId: versionId }, transaction });
      await this.audit(
        { action: options.rollbackVersion === undefined ? 'publish' : 'rollback', actorId, policyId, versionId },
        transaction,
      );
      return { policyId, version: await versions.findOne({ filterByTk: versionId, transaction }) };
    });
  }

  async preview(input: { userId: unknown; employeeUsername: unknown; modelKey?: unknown }, transaction?: Transaction) {
    const userId = idValue(input.userId, 'User id');
    const employeeUsername = requiredText(input.employeeUsername, 'Employee', 100);
    const users = this.db.getRepository('users');
    const user = await users.findOne({ filterByTk: userId, transaction });
    if (!user) throw new Error('User does not exist.');
    const employee = await this.db
      .getRepository('aiEmployees')
      .findOne({ filter: { username: employeeUsername }, transaction });
    if (!employee) throw new Error('AI employee does not exist.');
    const department = await resolveUserDepartment(this.db, userId, transaction);
    const modelKey = input.modelKey ? requiredText(input.modelKey, 'Model key', 355) : undefined;
    const policies = await this.activePolicies(
      userId,
      employeeUsername,
      department.departmentId,
      transaction,
      modelKey,
    );
    const settings = read(employee, 'chatSettings');
    const promptMode =
      settings && typeof settings === 'object' && 'systemPromptMode' in settings
        ? String(settings.systemPromptMode || 'default')
        : 'default';
    const instructions = policies.map((policy) => policy.settings.instruction?.trim()).filter(Boolean);
    const instruction = instructions.join('\n\n');
    const bindings = this.db.getRepository('agentGovernancePromptBindings');
    const binding = await bindings.findOne({ filter: { userId, employeeUsername }, transaction });
    const native = await this.db.getRepository('usersAiEmployees').findOne({
      filter: { userId, aiEmployee: employeeUsername },
      transaction,
    });
    const original = binding ? read(binding, 'originalPrompt') : read(native, 'prompt');
    const originalPrompt = typeof original === 'string' ? original : null;
    const currentPrompt = read(native, 'prompt');
    const nativePromptHash = native
      ? createHash('sha256')
          .update(typeof currentPrompt === 'string' ? currentPrompt : '')
          .digest('hex')
      : null;
    const conflict = Boolean(binding && (!native || nativePromptHash !== read(binding, 'contentHash')));
    const projectedPrompt = [instruction, originalPrompt].filter(Boolean).join('\n\n');
    const warnings: string[] = [];
    if (promptMode !== 'default') warnings.push('governance.promptModeUnsupported');
    if (department.status !== 'resolved') warnings.push('governance.departmentUnavailable');
    if (!instruction) warnings.push('governance.noInstruction');
    if (
      policies.some(
        (policy) =>
          policy.scope === 'employee' &&
          policy.settings.systemPrompt !== undefined &&
          (read(employee, 'about') ?? null) !== policy.settings.systemPrompt,
      )
    ) {
      warnings.push('governance.employeePromptChanged');
    }
    if (policies.some((policy) => policy.settings.maxMonthlyTokens != null || policy.settings.maxMonthlyCost != null)) {
      warnings.push('governance.observedQuotaOnly');
    }
    return {
      userId,
      employeeUsername,
      departmentId: department.departmentId,
      departmentStatus: department.status,
      instruction,
      policies,
      promptMode,
      warnings,
      managed: Boolean(binding),
      originalPrompt,
      projectedPrompt,
      nativePromptHash,
      conflict,
    };
  }

  async activePolicies(
    userId: number,
    employeeUsername: string,
    departmentId: string | number | null,
    transaction?: Transaction,
    modelKey?: string,
    includeAllModels = false,
  ): Promise<ActivePolicy[]> {
    const targets = [
      { scope: 'employee', scopeId: employeeUsername },
      { scope: 'user', scopeId: String(userId) },
    ];
    if (departmentId != null) targets.splice(1, 0, { scope: 'department', scopeId: String(departmentId) });
    const rows = await this.db.getRepository('agentGovernancePolicies').find({
      filter: { $or: targets, currentVersionId: { $ne: null } },
      transaction,
    });
    const versions = this.db.getRepository('agentGovernancePolicyVersions');
    const result: ActivePolicy[] = [];
    for (const row of rows) {
      const selector = read(row, 'employeeUsername');
      if (selector && selector !== employeeUsername) continue;
      const policyModel = read(row, 'modelKey');
      if (policyModel && !includeAllModels && policyModel !== modelKey) continue;
      const versionId = idValue(read(row, 'currentVersionId'), 'Version id');
      const version = await versions.findOne({ filterByTk: versionId, transaction });
      if (
        !version ||
        read(version, 'status') !== 'published' ||
        Number(read(version, 'policyId')) !== Number(read(row, 'id'))
      ) {
        throw new Error('Published governance policy is unavailable.');
      }
      const scope = policyScope(read(row, 'scope'));
      result.push({
        id: idValue(read(row, 'id'), 'Policy id'),
        scope,
        scopeId: String(read(row, 'scopeId')),
        employeeUsername: typeof selector === 'string' ? selector : null,
        modelKey: typeof policyModel === 'string' ? policyModel : null,
        version: idValue(read(version, 'version'), 'Version'),
        versionId,
        settings: safeSettings(read(version, 'settings'), scope),
      });
    }
    const order: Record<GovernanceScope, number> = { employee: 0, department: 1, user: 2 };
    return result.sort((a, b) => order[a.scope] - order[b.scope] || a.id - b.id);
  }

  async apply(input: { userId: unknown; employeeUsername: unknown }, actorId: number) {
    return this.db.sequelize.transaction(async (transaction: Transaction) => {
      const userId = idValue(input.userId, 'User id');
      const employeeUsername = requiredText(input.employeeUsername, 'Employee', 100);
      await this.db.getRepository('users').findOne({ filterByTk: userId, transaction, lock: transaction.LOCK.UPDATE });
      const preview = await this.preview({ userId, employeeUsername }, transaction);
      if (preview.promptMode !== 'default')
        throw new Error('Managed instructions require the default system prompt mode.');
      if (!preview.instruction) throw new Error('No published instruction applies to this user and employee.');
      const natives = this.db.getRepository('usersAiEmployees');
      const bindings = this.db.getRepository('agentGovernancePromptBindings');
      const filter = { userId, aiEmployee: employeeUsername };
      const existing = await natives.findOne({ filter, transaction, lock: transaction.LOCK.UPDATE });
      const binding = await bindings.findOne({
        filter: { userId, employeeUsername },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (binding) {
        const currentPrompt = read(existing, 'prompt');
        const currentHash = createHash('sha256')
          .update(typeof currentPrompt === 'string' ? currentPrompt : '')
          .digest('hex');
        if (!existing || currentHash !== read(binding, 'contentHash')) {
          throw new Error('Managed prompt changed outside governance. Review it before applying.');
        }
      }
      const originalPrompt = binding ? read(binding, 'originalPrompt') : read(existing, 'prompt');
      const originalRowExisted = binding ? Boolean(read(binding, 'originalRowExisted')) : Boolean(existing);
      const projectedPrompt = [preview.instruction, typeof originalPrompt === 'string' ? originalPrompt : null]
        .filter(Boolean)
        .join('\n\n');
      await managedWrites.run(true, async () => {
        if (existing) await natives.update({ filter, values: { prompt: projectedPrompt }, transaction });
        else await natives.create({ values: { ...filter, prompt: projectedPrompt, sort: null }, transaction });
      });
      const values = {
        userId,
        employeeUsername,
        originalPrompt: typeof originalPrompt === 'string' ? originalPrompt : null,
        originalRowExisted,
        contentHash: createHash('sha256').update(projectedPrompt).digest('hex'),
        policyVersions: preview.policies
          .filter((policy) => policy.settings.instruction?.trim())
          .map((policy) => ({ id: policy.id, versionId: policy.versionId })),
        departmentId: preview.departmentId == null ? null : String(preview.departmentId),
        appliedById: actorId,
        appliedAt: new Date(),
      };
      if (binding)
        await bindings.update({ filterByTk: idValue(read(binding, 'id'), 'Binding id'), values, transaction });
      else await bindings.create({ values, transaction });
      await this.audit(
        { action: 'apply', actorId, userId, employeeUsername, departmentId: preview.departmentId },
        transaction,
      );
      return { ...preview, managed: true, projectedPrompt };
    });
  }

  async restore(input: { userId: unknown; employeeUsername: unknown }, actorId: number) {
    return this.db.sequelize.transaction(async (transaction: Transaction) => {
      const userId = idValue(input.userId, 'User id');
      const employeeUsername = requiredText(input.employeeUsername, 'Employee', 100);
      await this.db.getRepository('users').findOne({ filterByTk: userId, transaction, lock: transaction.LOCK.UPDATE });
      const bindings = this.db.getRepository('agentGovernancePromptBindings');
      const binding = await bindings.findOne({
        filter: { userId, employeeUsername },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!binding) return { restored: false };
      const natives = this.db.getRepository('usersAiEmployees');
      const filter = { userId, aiEmployee: employeeUsername };
      const existing = await natives.findOne({ filter, transaction, lock: transaction.LOCK.UPDATE });
      if (!existing) {
        await bindings.destroy({ filterByTk: idValue(read(binding, 'id'), 'Binding id'), transaction });
        await this.audit(
          { action: 'restoreOrphan', actorId, userId, employeeUsername, departmentId: read(binding, 'departmentId') },
          transaction,
        );
        return { restored: false, orphaned: true };
      }
      const current = read(existing, 'prompt');
      const hash = createHash('sha256')
        .update(typeof current === 'string' ? current : '')
        .digest('hex');
      if (hash !== read(binding, 'contentHash'))
        throw new Error('Managed prompt changed outside governance. Review it before restoring.');
      await managedWrites.run(true, async () => {
        if (read(binding, 'originalRowExisted')) {
          await natives.update({ filter, values: { prompt: read(binding, 'originalPrompt') ?? null }, transaction });
        } else {
          // Preserve any settings added to the association after projection, including fields from other plugins.
          const ignored = new Set(['id', 'userId', 'aiEmployee', 'prompt', 'createdAt', 'updatedAt']);
          const additionalValues = Object.entries(plain(existing)).some(
            ([key, value]) => !ignored.has(key) && value != null,
          );
          if (additionalValues) await natives.update({ filter, values: { prompt: null }, transaction });
          else await natives.destroy({ filter, transaction });
        }
      });
      await bindings.destroy({ filterByTk: idValue(read(binding, 'id'), 'Binding id'), transaction });
      await this.audit(
        { action: 'restore', actorId, userId, employeeUsername, departmentId: read(binding, 'departmentId') },
        transaction,
      );
      return { restored: true };
    });
  }

  async release(input: { userId: unknown; employeeUsername: unknown; expectedHash: unknown }, actorId: number) {
    return this.db.sequelize.transaction(async (transaction: Transaction) => {
      const userId = idValue(input.userId, 'User id');
      const employeeUsername = requiredText(input.employeeUsername, 'Employee', 100);
      await this.db.getRepository('users').findOne({ filterByTk: userId, transaction, lock: transaction.LOCK.UPDATE });
      const bindings = this.db.getRepository('agentGovernancePromptBindings');
      const binding = await bindings.findOne({
        filter: { userId, employeeUsername },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!binding) return { released: false };
      const native = await this.db.getRepository('usersAiEmployees').findOne({
        filter: { userId, aiEmployee: employeeUsername },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      const current = read(native, 'prompt');
      const actualHash = native
        ? createHash('sha256')
            .update(typeof current === 'string' ? current : '')
            .digest('hex')
        : null;
      if (input.expectedHash !== actualHash)
        throw new Error('The native instruction changed. Refresh before releasing it.');
      await bindings.destroy({ filterByTk: idValue(read(binding, 'id'), 'Binding id'), transaction });
      await this.audit(
        { action: 'release', actorId, userId, employeeUsername, departmentId: read(binding, 'departmentId') },
        transaction,
      );
      return { released: true };
    });
  }

  private async audit(values: Record<string, unknown>, transaction: Transaction) {
    await this.db.getRepository('agentGovernanceAuditEvents').create({ values, transaction });
  }
}
