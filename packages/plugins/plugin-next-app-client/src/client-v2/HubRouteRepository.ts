/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import type { APIClient } from '@nocobase/client-v2';
import { flattenRoutes, type HubRoute } from './routes';

/** Hub has its own route cache. It never replaces the application's Desktop route repository. */
export class HubRouteRepository {
  private routes: HubRoute[] = [];
  private loaded = false;
  private generation = 0;
  private pending?: Promise<HubRoute[]>;
  private listeners = new Set<() => void>();

  constructor(
    private api: Pick<APIClient, 'request'>,
    readonly appPath: string,
  ) {}

  listAccessible = () => this.routes;
  getSnapshot = () => this.routes;
  isAccessibleLoaded = () => this.loaded;
  getRouteBySchemaUid = (uid: string) => flattenRoutes(this.routes).find((route) => route.schemaUid === uid);
  getRouteById = (id: string | number) => flattenRoutes(this.routes).find((route) => String(route.id) === String(id));

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  clear() {
    this.generation++;
    this.pending = undefined;
    this.routes = [];
    this.loaded = false;
    this.listeners.forEach((listener) => listener());
  }

  ensureAccessibleLoaded = () => {
    if (this.loaded) return Promise.resolve(this.routes);
    return this.pending || this.refreshAccessible();
  };

  refreshAccessible = () => {
    const generation = ++this.generation;
    const request = this.api
      .request<{ data: HubRoute[] }>({
        url: 'nextAppRoutes:listAccessible',
        params: { tree: true, sort: 'sort', paginate: false, filter: { appPath: this.appPath } },
      })
      .then((response) => {
        if (generation !== this.generation) return [];
        this.routes = response.data.data || [];
        this.loaded = true;
        this.listeners.forEach((listener) => listener());
        return this.routes;
      })
      .catch((error) => {
        if (generation === this.generation) this.clear();
        throw error;
      })
      .finally(() => {
        if (this.pending === request) this.pending = undefined;
      });
    this.pending = request;
    return request;
  };
}
