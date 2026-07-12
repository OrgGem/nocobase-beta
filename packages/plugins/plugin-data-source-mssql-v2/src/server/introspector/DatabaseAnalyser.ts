/**
 * Base Database Analyser class — provides full/introspection analysis framework.
 *
 * Adapted from dbgate-tools/src/DatabaseAnalyser.ts (GPL-3.0)
 * Original: https://github.com/dbgate/dbgate
 *
 * Simplified for NocoBase plugin use:
 *   - Removed incremental analysis / modification tracking
 *   - Removed content hash computation
 *   - Kept fullAnalysis, createEmptyStructure, PK/FK extraction
 *   - Removed pinomin logger (uses console)
 */

import _ from 'lodash';
import type {
  EngineDriver,
  DatabaseHandle,
  DatabaseInfo,
  NamedObjectInfo,
  PrimaryKeyInfo,
  ForeignKeyInfo,
  CollectionInfo,
  ColumnInfo,
  TableInfo,
  ViewInfo,
  ProcedureInfo,
  FunctionInfo,
  TriggerInfo,
} from '../types';

const STRUCTURE_FIELDS = ['tables', 'views', 'procedures', 'functions', 'triggers'] as const;

export class DatabaseAnalyser<TClient = any> {
  structure: DatabaseInfo | null = null;
  singleObjectFilter: {
    schemaName?: string;
    pureName: string;
    typeField: keyof DatabaseInfo;
  } | null = null;
  singleObjectId: number | null = null;
  startedTm: number = Date.now();
  analyseIdentifier: string = Math.random().toString().substring(2);

  constructor(
    public dbhan: DatabaseHandle<TClient>,
    public driver: EngineDriver,
    public version?: any,
  ) {}

  /**
   * Create the appropriate SQL query with template replacements.
   * Subclasses override this to look up SQL from their query modules.
   */
  createQuery(resFileName: string, _typeFields?: string[]): string {
    throw new Error(`Missing analyse query: ${resFileName}`);
  }

  /**
   * Execute an analysis query with template replacements.
   */
  async analyserQuery(
    key: string,
    typeFields?: string[],
  ): Promise<{ rows: any[]; columns: any[] }> {
    const sql = this.createQuery(key, typeFields);
    return this.driver.query(this.dbhan, sql);
  }

  /**
   * Subclasses must implement the main analysis logic.
   */
  async _runAnalysis(): Promise<DatabaseInfo> {
    return DatabaseAnalyser.createEmptyStructure();
  }

  /**
   * For single-object analysis, resolve the object ID.
   */
  async _computeSingleObjectId(): Promise<void> {
    const { schemaName, pureName } = this.singleObjectFilter!;
    const fullName = schemaName ? `[${schemaName}].[${pureName}]` : pureName;
    const resId = await this.driver.query(this.dbhan, `SELECT OBJECT_ID('${fullName}') AS id`);
    this.singleObjectId = resId.rows[0]?.id;
  }

  /**
   * Run full database analysis.
   */
  async fullAnalysis(): Promise<DatabaseInfo> {
    console.debug(`[MSSQL-V2] Performing full analysis (${this.analyseIdentifier})`);
    try {
      const result = await this._runAnalysis();
      return result;
    } catch (err) {
      console.error(`[MSSQL-V2] Error during full analysis:`, err);
      throw err;
    }
  }

  /**
   * Analyse a single database object.
   */
  async singleObjectAnalysis(
    name: NamedObjectInfo,
    typeField: keyof DatabaseInfo,
  ): Promise<any> {
    this.singleObjectFilter = { ...name, typeField };
    await this._computeSingleObjectId();
    const result = await this._runAnalysis();

    const items = result[typeField];
    if (!items || items.length === 0) return null;

    if (items.length === 1) return items[0];
    return (
      items.find(
        (x: any) =>
          x.pureName.toLowerCase() === name.pureName.toLowerCase() &&
          x.schemaName === name.schemaName,
      ) ||
      items.find((x: any) => x.pureName.toLowerCase() === name.pureName.toLowerCase()) ||
      null
    );
  }

  /**
   * Incremental analysis — delegates to full analysis if not supported.
   * Simplified version: just returns null (meaning "not implemented, do full").
   */
  async incrementalAnalysis(_structure: DatabaseInfo): Promise<DatabaseInfo | null> {
    return null;
  }

  // ---- Static helpers ----

  static createEmptyStructure(): DatabaseInfo {
    return {
      tables: [],
      views: [],
      procedures: [],
      functions: [],
      triggers: [],
    };
  }

  static extractPrimaryKeys(
    _table: any,
    pkColumnsRows: PrimaryKeyInfo[],
  ): { columns: { columnName: string }[]; constraintName?: string } {
    const columns = pkColumnsRows
      .filter((x) => x.objectId === _table.objectId)
      .map((x) => ({ columnName: x.columnName }));

    if (columns.length === 0) return { columns: [] };

    return {
      columns,
      constraintName: pkColumnsRows.find((x) => x.objectId === _table.objectId)?.constraintName,
    };
  }

  static extractForeignKeys(
    _table: any,
    fkColumnsRows: ForeignKeyInfo[],
  ): any[] {
    const tableFKs = fkColumnsRows.filter((x) => x.objectId === _table.objectId);
    const grouped = _.groupBy(tableFKs, 'constraintName');

    return Object.entries(grouped).map(([constraintName, rows]) => ({
      constraintName,
      columns: rows.map((r) => r.columnName),
      refSchemaName: rows[0].refSchemaName,
      refTableName: rows[0].refTableName,
      refColumns: rows.map((r) => r.refColumnName),
      updateAction: rows[0].updateAction,
      deleteAction: rows[0].deleteAction,
    }));
  }
}
