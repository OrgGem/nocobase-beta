// SPDX-License-Identifier: Apache-2.0

import { Op, literal, type ModelStatic } from 'sequelize';
import {
  isPureAscii,
  quoteAnsiStringLiteral,
  quoteIdentifier,
  quoteQualifiedIdentifier,
  quoteUnicodeStringLiteral,
} from '../security/sql-quote';

export type FullTextSearchMode = 'auto' | 'off';

export interface MssqlOperatorIntrospector {
  hasFTSIndex(tableName: string, columnName: string): boolean;
  isAnsiStringColumn?(tableName: string, columnName: string): boolean;
}

export interface MssqlOperatorContext {
  db?: {
    getFieldByPath?: (fieldPath: string) => { type?: string } | undefined;
  };
  model?: ModelStatic<never> & {
    name?: string;
    tableName?: string;
    rawAttributes?: Record<string, { field?: string }>;
    associations?: Record<string, { target?: ModelStatic<never> }>;
  };
  fieldName?: string;
  fullName?: string;
  fieldPath?: string;
}

export interface ResolvedOperatorTarget {
  tableName: string;
  columnName: string;
  qualifier: string;
}

/**
 * Escapes T-SQL LIKE wildcards (`[`, `%`, `_`). SQL Server does not treat `\` as an escape
 * character unless an explicit `ESCAPE` clause is emitted, whereas `[` starts a character class.
 */
export function escapeMssqlLike(value: unknown): string {
  const text = String(value);
  return text.replace(/\[/g, '[[]').replace(/[%_]/g, (ch) => `[${ch}]`);
}

const HAS_SEARCHABLE_CHAR_RE = /\p{L}|\p{N}/u;

/**
 * Converts a single user search string into a T-SQL CONTAINS() prefix expression.
 * Splits multi-word queries into `"word1*" AND "word2*"` so words match in any order.
 * Returns `null` when no searchable alphanumeric/Unicode token exists (e.g. punctuation-only input)
 * so the caller can fall back to `LIKE` instead of hitting SQL Server FTS syntax error Msg 7630.
 */
export function buildFtsPrefixTerm(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  // Replace FTS syntax characters (", *, (, )) with spaces before tokenizing so quotes/asterisks
  // inside words (e.g. `15"inch`, `foo*bar`) match SQL Server's word-breaker without Msg 7630.
  const tokens = trimmed
    .replace(/["*()]+/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 0 && HAS_SEARCHABLE_CHAR_RE.test(token));

  if (!tokens.length) {
    return null;
  }

  return tokens.map((token) => `"${token}*"`).join(' AND ');
}

/**
 * Builds a T-SQL CONTAINS() search condition for a string or string array. Returns `null` if any
 * input cannot be expressed safely as an FTS query, signaling a fallback to `LIKE`.
 */
export function buildFtsSearchCondition(value: unknown): string | null {
  if (typeof value === 'string') {
    return buildFtsPrefixTerm(value);
  }
  if (Array.isArray(value) && value.length > 0) {
    const terms: string[] = [];
    for (const item of value) {
      if (typeof item !== 'string') {
        return null;
      }
      const term = buildFtsPrefixTerm(item);
      if (!term) {
        return null;
      }
      terms.push(term.includes(' AND ') ? `(${term})` : term);
    }
    return terms.join(' OR ');
  }
  return null;
}

/**
 * Resolves the physical table name, physical column name, and SQL alias qualifier for an operator
 * invocation, walking association paths (e.g. `customer.fullName`) when filtering related tables.
 */
export function resolveOperatorTarget(ctx?: MssqlOperatorContext): ResolvedOperatorTarget {
  const fieldName = ctx?.fieldName ?? '';
  let model = ctx?.model;
  const associationPath: string[] = [];

  if (ctx?.fullName && model) {
    const parts = ctx.fullName.split('.');
    for (let i = 0; i < parts.length - 1; i++) {
      const assocName = parts[i];
      const nextTarget = model?.associations?.[assocName]?.target as MssqlOperatorContext['model'] | undefined;
      if (!nextTarget) {
        break;
      }
      associationPath.push(assocName);
      model = nextTarget;
    }
  }

  const rawAttr = model?.rawAttributes?.[fieldName];
  const columnName = rawAttr?.field || fieldName;
  const tableName = typeof model?.tableName === 'string' ? model.tableName : '';
  const qualifier = associationPath.length > 0 ? associationPath.join('->') : model?.name || '';

  return { tableName, columnName, qualifier };
}

function formatQualifiedColumn(target: ResolvedOperatorTarget): string {
  if (target.qualifier) {
    return quoteQualifiedIdentifier([target.qualifier, target.columnName]);
  }
  return quoteIdentifier(target.columnName);
}

function toSargableStringValue(value: unknown, useAnsi: boolean): unknown {
  if (useAnsi && typeof value === 'string' && isPureAscii(value)) {
    return literal(quoteAnsiStringLiteral(value));
  }
  return value;
}

function isStringField(ctx?: MssqlOperatorContext): boolean {
  if (!ctx?.fieldPath || !ctx.db?.getFieldByPath) {
    return false;
  }
  return ctx.db.getFieldByPath(ctx.fieldPath)?.type === 'string';
}

export function createMssqlOperators(
  introspector: MssqlOperatorIntrospector,
  getFtsMode: () => FullTextSearchMode = () => 'auto',
) {
  const shouldUseAnsi = (target: ResolvedOperatorTarget): boolean => {
    if (!target.tableName || !target.columnName) {
      return false;
    }
    return Boolean(introspector.isAnsiStringColumn?.(target.tableName, target.columnName));
  };

  const buildLikeClause = (
    value: unknown,
    ctx: MssqlOperatorContext,
    pattern: (escaped: string) => string,
    negate: boolean,
  ) => {
    if (value === null) {
      return negate ? { [Op.not]: null } : { [Op.is]: null };
    }
    const target = resolveOperatorTarget(ctx);
    const useAnsi = shouldUseAnsi(target);
    const op = negate ? Op.notLike : Op.like;

    if (Array.isArray(value)) {
      const items = value.map((item) => ({ [op]: toSargableStringValue(pattern(escapeMssqlLike(item)), useAnsi) }));
      return negate ? { [Op.and]: items } : { [Op.or]: items };
    }
    return { [op]: toSargableStringValue(pattern(escapeMssqlLike(value)), useAnsi) };
  };

  const buildIncludesClause = (value: unknown, ctx: MssqlOperatorContext) => {
    if (value === null) {
      return { [Op.is]: null };
    }
    const likeClause = buildLikeClause(value, ctx, (escaped) => `%${escaped}%`, false);
    const target = resolveOperatorTarget(ctx);
    if (
      getFtsMode() !== 'off' &&
      target.tableName &&
      target.columnName &&
      introspector.hasFTSIndex(target.tableName, target.columnName)
    ) {
      const ftsCondition = buildFtsSearchCondition(value);
      if (ftsCondition) {
        // Combine CONTAINS() (uses the FTS index to narrow candidates) with an exact LIKE post-filter
        // so multi-word ordering and punctuation match strictly with zero false positives.
        const containsLiteral = literal(
          `CONTAINS(${formatQualifiedColumn(target)}, ${quoteUnicodeStringLiteral(ftsCondition)})`,
        );
        return { [Op.and]: [containsLiteral, likeClause] };
      }
    }
    return likeClause;
  };

  return {
    $includes(value: unknown, ctx: MssqlOperatorContext) {
      return buildIncludesClause(value, ctx);
    },

    $notIncludes(value: unknown, ctx: MssqlOperatorContext) {
      // Never route $notIncludes through NOT (CONTAINS(...)): FTS is word-prefix based, so negated
      // CONTAINS() would falsely match infix substrings (e.g. 'foobar' for $notIncludes 'bar').
      return buildLikeClause(value, ctx, (escaped) => `%${escaped}%`, true);
    },

    $startsWith(value: unknown, ctx: MssqlOperatorContext) {
      return buildLikeClause(value, ctx, (escaped) => `${escaped}%`, false);
    },

    $notStartsWith(value: unknown, ctx: MssqlOperatorContext) {
      return buildLikeClause(value, ctx, (escaped) => `${escaped}%`, true);
    },

    $endWith(value: unknown, ctx: MssqlOperatorContext) {
      return buildLikeClause(value, ctx, (escaped) => `%${escaped}`, false);
    },

    $notEndWith(value: unknown, ctx: MssqlOperatorContext) {
      return buildLikeClause(value, ctx, (escaped) => `%${escaped}`, true);
    },

    $eq(value: unknown, ctx: MssqlOperatorContext) {
      const target = resolveOperatorTarget(ctx);
      const useAnsi = shouldUseAnsi(target);
      const coerceString = isStringField(ctx);

      if (Array.isArray(value)) {
        return {
          [Op.in]: value.map((item) => {
            const normalized = coerceString && typeof item !== 'string' ? String(item) : item;
            return toSargableStringValue(normalized, useAnsi);
          }),
        };
      }
      const normalized = coerceString && value !== null && typeof value !== 'string' ? String(value) : value;
      return { [Op.eq]: toSargableStringValue(normalized, useAnsi) };
    },

    $ne(value: unknown, ctx: MssqlOperatorContext) {
      const target = resolveOperatorTarget(ctx);
      const useAnsi = shouldUseAnsi(target);

      if (Array.isArray(value)) {
        return {
          [Op.notIn]: value.map((item) => toSargableStringValue(item, useAnsi)),
        };
      }
      if (value === null) {
        return { [Op.ne]: null };
      }
      return {
        [Op.or]: {
          [Op.ne]: toSargableStringValue(value, useAnsi),
          [Op.is]: null,
        },
      };
    },

    $in(value: unknown, ctx: MssqlOperatorContext) {
      const target = resolveOperatorTarget(ctx);
      const useAnsi = shouldUseAnsi(target);
      const items = value == null ? [] : Array.isArray(value) ? value : [value];
      return {
        [Op.in]: items.map((item) => toSargableStringValue(item, useAnsi)),
      };
    },

    $notIn(value: unknown, ctx: MssqlOperatorContext) {
      const target = resolveOperatorTarget(ctx);
      const useAnsi = shouldUseAnsi(target);
      const items = value == null ? [] : Array.isArray(value) ? value : [value];
      return {
        [Op.or]: {
          [Op.notIn]: items.map((item) => toSargableStringValue(item, useAnsi)),
          [Op.is]: null,
        },
      };
    },
  };
}
