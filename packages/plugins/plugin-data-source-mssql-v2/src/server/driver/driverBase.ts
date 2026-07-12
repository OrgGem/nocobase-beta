/**
 * Base driver implementation — shared across all database engine drivers.
 *
 * Adapted from dbgate-tools/src/driverBase.ts (GPL-3.0)
 * Original: https://github.com/dbgate/dbgate
 *
 * Simplified for NocoBase plugin use:
 *   - Removed query-splitter and sqltree dependencies
 *   - Removed SqlDumper generation
 *   - Kept analyser delegation methods
 */

import type { EngineDriver, DatabaseHandle, DatabaseInfo, NamedObjectInfo } from '../types';

export const driverBaseMethods = {
  analyserClass: null as any,

  /**
   * Run full database analysis (introspection).
   */
  async analyseFull(this: EngineDriver, pool: DatabaseHandle, version?: any): Promise<DatabaseInfo> {
    const analyser = new this.analyserClass(pool, this, version);
    return analyser.fullAnalysis();
  },

  /**
   * Analyse a single database object (table, view, etc.).
   */
  async analyseSingleObject(
    this: EngineDriver,
    pool: DatabaseHandle,
    name: NamedObjectInfo,
    typeField: keyof DatabaseInfo = 'tables',
  ): Promise<any> {
    const analyser = new this.analyserClass(pool, this);
    return analyser.singleObjectAnalysis(name, typeField);
  },

  /**
   * Analyse a single table.
   */
  async analyseSingleTable(this: EngineDriver, pool: DatabaseHandle, name: NamedObjectInfo): Promise<any> {
    return this.analyseSingleObject(pool, name, 'tables');
  },

  /**
   * Incremental analysis (delegates to full if not supported).
   */
  async analyseIncremental(
    this: EngineDriver,
    pool: DatabaseHandle,
    structure: DatabaseInfo,
    version?: any,
  ): Promise<DatabaseInfo | null> {
    const analyser = new this.analyserClass(pool, this, version);
    return analyser.incrementalAnalysis(structure);
  },
};
