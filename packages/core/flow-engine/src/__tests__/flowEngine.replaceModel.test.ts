/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FlowEngine } from '../flowEngine';
import { FlowModel } from '../models';

describe('FlowEngine replaceModel event lifecycle', () => {
  let engine: FlowEngine;

  beforeEach(() => {
    engine = new FlowEngine();
    engine.registerModels({ FlowModel });
  });

  // Three-layer structure: root -> middle -> child.
  // middle is the parent of the replaced model; middle.parent (root) is accessed during
  // invalidateFlowCache/rerender in the replacement flow, so middle must itself have a parent.
  const createRootWithChild = () => {
    const root = engine.createModel({ uid: 'root', use: 'FlowModel' });
    const middle = engine.createModel({
      uid: 'middle',
      use: 'FlowModel',
      parentId: 'root',
      subKey: 'middle',
      subType: 'object',
    });
    const child = engine.createModel({
      uid: 'child',
      use: 'FlowModel',
      parentId: 'middle',
      subKey: 'child',
      subType: 'object',
    });
    return { root, middle, child };
  };

  it('delivers onSubModelReplaced to parent listeners after a successful replacement', async () => {
    const { middle, child } = createRootWithChild();

    const replacedSpy = vi.fn();
    const destroyedSpy = vi.fn();
    middle.emitter.on('onSubModelReplaced', replacedSpy);
    middle.emitter.on('onSubModelDestroyed', destroyedSpy);

    const newModel = await engine.replaceModel('child');

    // Replacement artifacts: old instance destroyed, new instance takes over the same uid
    expect(newModel).toBeTruthy();
    expect(newModel).not.toBe(child);
    expect(engine.getModel('child')).toBe(newModel);

    // The final event must reach parent subscribers (emitter already resumed on completion)
    expect(replacedSpy).toHaveBeenCalledTimes(1);
    expect(replacedSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        oldModel: child,
        newModel,
      }),
    );

    // Intermediate states stay paused: onSubModelDestroyed during destroy must not leak to subscribers
    expect(destroyedSpy).not.toHaveBeenCalled();
  });

  it('restores parent emitter to active state when replacement fails midway', async () => {
    const { middle } = createRootWithChild();

    vi.spyOn(engine, 'createModel').mockImplementationOnce(() => {
      throw new Error('create failed');
    });

    await expect(engine.replaceModel('child')).rejects.toThrow('create failed');

    // try/finally must restore event dispatch: emitter is no longer paused after the failure
    const probeSpy = vi.fn();
    middle.emitter.on('probe', probeSpy);
    middle.emitter.emit('probe', 'ok');
    expect(probeSpy).toHaveBeenCalledWith('ok');
  });
});
