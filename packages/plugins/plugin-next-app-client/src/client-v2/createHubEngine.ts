// SPDX-License-Identifier: Apache-2.0

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
