/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { NAMESPACE } from '../../constants';

type TranslationValues = Record<string, string | number>;
type TranslationContext = { [key: string]: unknown };

export class PostgresValidationError extends Error {
  readonly status: number;
  readonly statusCode: number;

  constructor(
    public readonly key: string,
    public readonly values: TranslationValues = {},
    status = 400,
  ) {
    super(key.replace(/{{\s*(\w+)\s*}}/g, (_match, name: string) => String(values[name] ?? '')));
    this.name = 'PostgresValidationError';
    this.status = status;
    this.statusCode = status;
  }
}

export function translateError(ctx: TranslationContext, error: PostgresValidationError): string {
  if (typeof ctx.t !== 'function') return error.message;
  return ctx.t(error.key, { ns: NAMESPACE, ...error.values });
}

export function translate(ctx: TranslationContext, key: string, values: TranslationValues = {}): string {
  return translateError(ctx, new PostgresValidationError(key, values));
}
