import { afterEach, describe, expect, it } from 'vitest';
import {
  getActiveHandle,
  getHandleByDiagramId,
  registerActiveHandle,
  setActiveBlockUid,
  type DrawioActiveHandle,
} from '../lib/activeRegistry';

const unregisterHandlers: Array<() => void> = [];

afterEach(() => {
  for (const unregister of unregisterHandlers.splice(0)) {
    unregister();
  }
  setActiveBlockUid(null);
});

function registerHandle(overrides: Partial<DrawioActiveHandle> = {}) {
  const handle: DrawioActiveHandle = {
    blockUid: 'block-1',
    diagramId: 'diagram-1',
    getXml: () => '<mxfile />',
    setXml: () => undefined,
    persist: async () => undefined,
    load: () => undefined,
    ...overrides,
  };
  unregisterHandlers.push(registerActiveHandle(handle));
  return handle;
}

describe('active Draw.io registry', () => {
  it('looks up the active mounted editor by diagram id', () => {
    const handle = registerHandle({ diagramId: 'order-flow' });

    expect(getActiveHandle()).toBe(handle);
    expect(getHandleByDiagramId('order-flow')).toBe(handle);
    expect(getHandleByDiagramId('unknown')).toBeNull();
  });

  it('uses the current editor loader after an iframe bridge is replaced', () => {
    const firstBridgeLoads: string[] = [];
    const replacementBridgeLoads: string[] = [];
    let currentBridgeLoads = firstBridgeLoads;
    const handle = registerHandle({
      load: (xml) => currentBridgeLoads.push(xml),
    });

    currentBridgeLoads = replacementBridgeLoads;
    handle.load('<mxfile>updated</mxfile>');

    expect(firstBridgeLoads).toEqual([]);
    expect(replacementBridgeLoads).toEqual(['<mxfile>updated</mxfile>']);
  });
});
