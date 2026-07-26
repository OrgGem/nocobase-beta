import { afterEach, describe, expect, it } from 'vitest';
import { registerActiveHandle, setActiveBlockUid } from '../lib/activeRegistry';
import { inspectDiagramTool } from '../tools/inspectDiagram';

let unregister: (() => void) | undefined;

afterEach(() => {
  unregister?.();
  unregister = undefined;
  setActiveBlockUid(null);
});

describe('inspect_active_diagram tool', () => {
  it('returns the active diagram id and live XML without a work context', async () => {
    unregister = registerActiveHandle({
      blockUid: 'block-1',
      diagramId: 'diagram-1',
      diagramTitle: 'Order flow',
      getXml: () => '<mxfile><diagram id="d1" /></mxfile>',
      setXml: () => undefined,
      persist: async () => undefined,
      load: () => undefined,
    });

    const invoke = inspectDiagramTool[1].invoke;
    if (!invoke) {
      throw new Error('inspect_active_diagram must expose an invoke handler');
    }
    const result = await invoke({} as never, {});

    expect(result).toEqual({
      status: 'success',
      content:
        'Title: Order flow\n' +
        'diagramId: diagram-1\n' +
        'Use this diagramId in edit_diagram or display_diagram when changing this canvas.\n\n' +
        'Current diagram XML (authoritative):\n```xml\n<mxfile><diagram id="d1" /></mxfile>\n```',
    });
  });
});
