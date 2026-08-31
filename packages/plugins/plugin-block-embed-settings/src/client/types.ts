import type { Application } from '@nocobase/client-v2';
import type React from 'react';

/** Option representing a plugin that can be embedded as a settings block. */
export interface EmbedSettingsPluginOption {
  value: string;
  label: string;
}

/** Option representing a single embeddable tab within a plugin's settings. */
export interface EmbedSettingsTabOption {
  value: string;
  label: string;
  componentLoader?: () => Promise<{ default: React.ComponentType<EmbedTabComponentProps> }>;
  Component?: React.ComponentType<EmbedTabComponentProps>;
  componentProps?: Record<string, unknown>;
}

/** Props passed to each embedded tab component. */
export interface EmbedTabComponentProps {
  dataSourceName?: string;
  collectionName?: string;
  embedded?: boolean;
  [key: string]: unknown;
}

/** A record in the embedAllowedPlugins collection. */
export interface AllowedPluginRecord {
  id: number;
  pluginName: string;
  title: string;
  enabled: boolean;
  createdAt?: string;
  updatedAt?: string;
}

/** Shape of the API list response for embedAllowedPlugins. */
export interface AllowedPluginsListResponse {
  data: {
    data: AllowedPluginRecord[];
    meta?: {
      count?: number;
      page?: number;
      pageSize?: number;
      totalPage?: number;
    };
  };
}

/** Props for EmbedSettingsBlock component. */
export interface EmbedSettingsBlockProps {
  pluginName?: string;
  enabledTabKeys?: string[];
  dataSourceName?: string;
  collectionName?: string;
}

/** Props for EmbedSettingsPluginSelect component. */
export interface EmbedSettingsPluginSelectProps {
  value?: string;
  onChange?: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  [key: string]: unknown;
}

/** Props for EmbedSettingsTabSelect component. */
export interface EmbedSettingsTabSelectProps {
  value?: string[];
  onChange?: (value: string[]) => void;
  disabled?: boolean;
  [key: string]: unknown;
}

/** Props for EmbedSettingsCollectionSelect component. */
export interface EmbedSettingsCollectionSelectProps {
  value?: string;
  onChange?: (value: string | undefined) => void;
  disabled?: boolean;
  placeholder?: string;
  [key: string]: unknown;
}

/** Data source entry from dataSourceManager. */
export interface DataSourceEntry {
  key: string;
  displayName?: string;
  getCollections?: () => CollectionEntry[];
}

/** Collection entry within a data source. */
export interface CollectionEntry {
  name: string;
  title?: string;
}

/** Return type of useEnabledEmbedSettingsPluginOptions hook. */
export interface EmbedSettingsPluginOptionsResult {
  loading: boolean;
  options: EmbedSettingsPluginOption[];
}

/** Plugin setting entry from pluginSettingsManager. */
export interface PluginSettingEntry {
  name: string;
  key?: string;
  title?: string | React.ReactNode;
  label?: string | React.ReactNode;
  Component?: React.ComponentType<EmbedTabComponentProps>;
  componentLoader?: () => Promise<{ default: React.ComponentType<EmbedTabComponentProps> }>;
  children?: PluginSettingEntry[];
  embedSettings?: EmbedSettingsMeta;
}

/** Metadata for embed settings configuration on a plugin setting. */
export interface EmbedSettingsMeta {
  requiresCollection?: boolean;
  tabs?: EmbedSettingsTabOption[] | ((setting: PluginSettingEntry) => EmbedSettingsTabOption[]);
}

/** Grouped option for collection select (data source level). */
export interface CollectionSelectGroupOption {
  label: string;
  options: CollectionSelectOption[];
}

/** Individual option for collection select. */
export interface CollectionSelectOption {
  label: string;
  value: string;
}
