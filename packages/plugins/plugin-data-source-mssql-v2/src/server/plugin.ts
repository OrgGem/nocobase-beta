/**
 * Plugin Data Source MSSQL V2 — Server Plugin
 *
 * Registers the 'mssql-v2' data source type with the NocoBase
 * DataSourceManager factory. Uses direct tedious driver (forked from dbgate).
 */

import { Plugin } from '@nocobase/server';
import { MssqlDataSource } from './data-source/MssqlDataSource';

export class PluginDataSourceMssqlV2Server extends Plugin {
  async beforeLoad() {
    this.app.dataSourceManager.factory.register('mssql-v2', MssqlDataSource);
  }

  async load() {
    // Register ACL snippet for access control
    this.app.acl.registerSnippet({
      name: 'pm.data-source-manager.mssql-v2',
      actions: ['dataSources:*'],
    });
  }
}

export default PluginDataSourceMssqlV2Server;
