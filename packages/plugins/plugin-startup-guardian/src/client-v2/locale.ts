// SPDX-License-Identifier: Apache-2.0

import { useFlowEngine } from '@nocobase/flow-engine';
// @ts-ignore package metadata is consumed by the build-time translation namespace.
import pkg from '../../package.json';

export function useT() {
  const engine = useFlowEngine();
  return (key: string) => engine.context.t(key, { ns: [pkg.name, 'client'] });
}
