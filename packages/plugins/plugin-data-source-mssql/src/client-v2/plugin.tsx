// SPDX-License-Identifier: Apache-2.0

import { Plugin, Application } from '@nocobase/client-v2';
import type PluginDataSourceManagerClientV2 from '@nocobase/plugin-data-source-manager/client-v2';
import { MssqlConfigForm } from './components/MssqlConfigForm';
import { MssqlDeleteCollection } from './MssqlDeleteCollection';
import { MssqlLoadTables } from './MssqlLoadTables';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isDataSourceManagerInstance(candidate: unknown): candidate is PluginDataSourceManagerClientV2 {
  return isRecord(candidate) && typeof candidate.registerType === 'function' && candidate.types instanceof Map;
}

function resolveDataSourceManager(app: Application): PluginDataSourceManagerClientV2 | undefined {
  const byPackage = app.pm.get<PluginDataSourceManagerClientV2>('@nocobase/plugin-data-source-manager');
  if (isDataSourceManagerInstance(byPackage)) {
    return byPackage;
  }
  const byAlias = app.pm.get<PluginDataSourceManagerClientV2>('data-source-manager');
  if (isDataSourceManagerInstance(byAlias)) {
    return byAlias;
  }
  const instances = (app.pm as unknown as { pluginInstances?: Map<unknown, unknown> }).pluginInstances;
  if (instances instanceof Map) {
    for (const instance of instances.values()) {
      if (isDataSourceManagerInstance(instance)) {
        return instance;
      }
    }
  }
  return undefined;
}

export class PluginDataSourceMssqlClient extends Plugin<Record<string, never>, Application> {
  async load() {
    const manager = resolveDataSourceManager(this.app);
    if (manager) {
      manager.registerType('mssql', {
        label: String(this.t('External MSSQL')),
        defaultValues: {
          options: {
            port: 1433,
            trustServerCertificate: true,
            addAllCollections: true,
            fullTextSearchMode: 'auto',
          },
        },
        SettingsForm: MssqlConfigForm,
        disableTestConnection: false,
        allowCollectionCreate: true,
        AddCollection: MssqlLoadTables,
        allowCollectionDeletion: true,
        DeleteCollection: MssqlDeleteCollection,
        disableAddFields: false,
        createFieldInterfaces: ({ collection }) => {
          if (collection?.view || collection?.template === 'view') {
            return { include: ['m2o'] };
          }
          return {
            groups: ['relation'],
            exclude: ['o2o', 'subTable', 'linkTo'],
          };
        },
        normalizeValues: (values) => {
          const { __mssqlPreserveLegacySelection, __mssqlBaseOptions, ...normalized } = values;
          const baseOptions = isRecord(__mssqlBaseOptions) ? { ...__mssqlBaseOptions } : {};
          const rawOptions = isRecord(values.options) ? values.options : {};
          const mergedOptions: Record<string, unknown> = { ...baseOptions };
          for (const [key, val] of Object.entries(rawOptions)) {
            if (val === undefined || val === null) {
              delete mergedOptions[key];
            } else {
              mergedOptions[key] = val;
            }
          }
          const addAllCollections = Boolean(rawOptions.addAllCollections ?? values.addAllCollections ?? true);
          mergedOptions.addAllCollections = addAllCollections;
          if (addAllCollections) {
            delete mergedOptions.selectedCollections;
            delete normalized.collections;
          } else if (__mssqlPreserveLegacySelection) {
            delete normalized.collections;
          } else if (Array.isArray(normalized.collections)) {
            const selected = [
              ...new Set(
                normalized.collections.filter((item): item is string => typeof item === 'string' && item.length > 0),
              ),
            ];
            normalized.collections = selected;
            mergedOptions.selectedCollections = selected;
          }
          return {
            ...normalized,
            options: mergedOptions,
          };
        },
      });
    }
  }
}

export default PluginDataSourceMssqlClient;
