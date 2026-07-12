/**
 * Make column names unique by appending incrementing suffixes.
 *
 * Adapted from dbgate-plugin-mssql/src/backend/makeUniqueColumnNames.js (GPL-3.0)
 * Original: https://github.com/dbgate/dbgate
 */

interface NamedColumn {
  columnName: string;
}

export function makeUniqueColumnNames(columns: NamedColumn[]): void {
  const usedNames = new Map<string, number>();

  for (const col of columns) {
    const baseName = col.columnName;
    const count = usedNames.get(baseName) || 0;
    if (count > 0) {
      col.columnName = `${baseName}${count}`;
      usedNames.set(baseName, count + 1);
    } else {
      usedNames.set(baseName, 1);
    }
  }

  // Second pass: handle newly created duplicates
  const finalNames = new Set<string>();
  for (const col of columns) {
    if (finalNames.has(col.columnName)) {
      let suffix = 2;
      while (finalNames.has(`${col.columnName}_${suffix}`)) {
        suffix++;
      }
      col.columnName = `${col.columnName}_${suffix}`;
    }
    finalNames.add(col.columnName);
  }
}
