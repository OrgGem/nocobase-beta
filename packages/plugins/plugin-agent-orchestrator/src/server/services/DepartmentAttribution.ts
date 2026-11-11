/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { Database } from '@nocobase/database';
import { literal } from 'sequelize';
import type { Transaction } from 'sequelize';
import { read } from '../utils/record-utils';

export type DepartmentResolution = {
  departmentId: string | number | null;
  status: 'resolved' | 'unassigned' | 'invalid_membership' | 'departments_unavailable';
};

/** Resolve the user's canonical main department without trusting a request-supplied department. */
export async function resolveUserDepartment(
  db: Database,
  userId: string | number,
  transaction?: Transaction,
): Promise<DepartmentResolution> {
  if (!db.hasCollection('users') || !db.hasCollection('departmentsUsers')) {
    return { departmentId: null, status: 'departments_unavailable' };
  }
  if (typeof userId === 'number' && !Number.isSafeInteger(userId)) {
    return { departmentId: null, status: 'invalid_membership' };
  }
  const users = db.getRepository('users');
  const memberships = db.getRepository('departmentsUsers');
  const mainDepartmentAttribute = users.model.rawAttributes.mainDepartmentId;
  if (!mainDepartmentAttribute) return { departmentId: null, status: 'departments_unavailable' };
  const mainDepartmentField = mainDepartmentAttribute.field || 'mainDepartmentId';
  const query = db.sequelize.getQueryInterface().queryGenerator as unknown as {
    quoteIdentifier: (value: string) => string;
  };
  const castType = ['mysql', 'mariadb'].includes(db.sequelize.getDialect()) ? 'CHAR' : 'TEXT';
  const user = await users.model.findOne({
    where: { id: userId },
    attributes: [[literal(`CAST(${query.quoteIdentifier(mainDepartmentField)} AS ${castType})`), 'mainDepartmentId']],
    transaction,
    raw: true,
  });
  const departmentId = read(user, 'mainDepartmentId');
  if (departmentId == null || departmentId === '') return { departmentId: null, status: 'unassigned' };
  if (typeof departmentId !== 'string' && typeof departmentId !== 'number') {
    return { departmentId: null, status: 'invalid_membership' };
  }
  const membership = await memberships.findOne({ filter: { userId, departmentId }, transaction });
  return membership ? { departmentId, status: 'resolved' } : { departmentId: null, status: 'invalid_membership' };
}
