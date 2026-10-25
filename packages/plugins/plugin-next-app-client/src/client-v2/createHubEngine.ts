/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { createBlockScopedEngine, FlowEngineContext, type FlowEngine } from '@nocobase/flow-engine';
import type { HubRouteRepository } from './HubRouteRepository';

export function createHubEngine(parent: FlowEngine, repository: HubRouteRepository) {
  const engine = createBlockScopedEngine(parent);
  // Keep context local explicitly: the scoped proxy delegates backing fields to the parent engine.
  const context = new FlowEngineContext(engine);
  context.addDelegate(parent.context);
  Object.defineProperty(engine, 'context', { value: context, configurable: true });
  context.defineProperty('routeRepository', { value: repository });
  return engine;
}
