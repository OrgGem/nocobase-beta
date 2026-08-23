export const MAX_ROWS = 200;

const FORBIDDEN_WORDS = new Set([
  'INSERT',
  'UPDATE',
  'DELETE',
  'DROP',
  'ALTER',
  'TRUNCATE',
  'CREATE',
  'REPLACE',
  'MERGE',
  'GRANT',
  'REVOKE',
  'VACUUM',
  'ATTACH',
  'DETACH',
  'PRAGMA',
  'CALL',
  'EXEC',
  'EXECUTE',
  'SET',
  'BEGIN',
  'COMMIT',
  'ROLLBACK',
  'LOCK',
  'COPY',
  'RENAME',
  'INTO',
  'OUTFILE',
  'DUMPFILE',
]);

function stripLeadingComments(sql: string): string {
  let result = sql.replace(/^\s+/, '');
  for (;;) {
    if (result.startsWith('--')) {
      const newline = result.indexOf('\n');
      result = newline === -1 ? '' : result.slice(newline + 1).replace(/^\s+/, '');
    } else if (result.startsWith('/*')) {
      const end = result.indexOf('*/', 2);
      result = end === -1 ? '' : result.slice(end + 2).replace(/^\s+/, '');
    } else {
      return result;
    }
  }
}

function hasMultipleStatements(sql: string): boolean {
  let single = false;
  let double = false;
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    if (ch === "'" && !double) {
      if (single && sql[i + 1] === "'") {
        i += 1;
        continue;
      }
      single = !single;
    } else if (ch === '"' && !single) {
      double = !double;
    } else if (ch === ';' && !single && !double) {
      return true;
    }
  }
  return false;
}

function containsForbiddenWord(sql: string): { found: boolean; word?: string } {
  let single = false;
  let double = false;
  let backtick = false;
  let word = '';
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    if (single) {
      if (ch === "'") {
        if (sql[i + 1] === "'") i += 1;
        else single = false;
      }
      continue;
    }
    if (double) {
      if (ch === '"') double = false;
      continue;
    }
    if (backtick) {
      if (ch === '`') backtick = false;
      continue;
    }
    if (ch === "'") single = true;
    else if (ch === '"') double = true;
    else if (ch === '`') backtick = true;
    else if (/[A-Za-z_]/.test(ch)) word += ch;
    else {
      if (word && FORBIDDEN_WORDS.has(word.toUpperCase())) {
        return { found: true, word };
      }
      word = '';
    }
  }
  if (word && FORBIDDEN_WORDS.has(word.toUpperCase())) {
    return { found: true, word };
  }
  return { found: false };
}

export function assertSafeSelect(sql: unknown): string {
  if (typeof sql !== 'string') throw new Error('SQL must be a string');
  if (sql.includes('\0')) throw new Error('SQL must not contain null bytes');

  const statement = stripLeadingComments(sql.trim()).trim();
  if (!statement) throw new Error('SQL is required');

  if (hasMultipleStatements(statement.replace(/;+\s*$/, ''))) {
    throw new Error('Multiple statements are not allowed');
  }

  const firstToken = statement.match(/^[A-Za-z]+/)?.[0]?.toUpperCase();
  if (firstToken !== 'SELECT' && firstToken !== 'WITH') {
    throw new Error(`Only SELECT queries are allowed (got ${firstToken || 'nothing'})`);
  }

  const forbidden = containsForbiddenWord(statement);
  if (forbidden.found) {
    throw new Error(`Keyword "${forbidden.word}" is not allowed in read-only queries`);
  }

  return statement;
}

export function limitRows(sql: string): string {
  return `SELECT * FROM (${sql}) __dpm LIMIT ${MAX_ROWS}`;
}
