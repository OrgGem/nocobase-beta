/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it, vi } from 'vitest';
import { DrawioBridge, buildDrawioEmbedUrl } from '../lib/drawioBridge';
import { applyDiagramOperations, isMxCellXmlComplete, wrapWithMxFile } from '../lib/xml-utils';
import * as v2Bridge from '../../client-v2/runtime/drawioBridge';
import * as v2Xml from '../../client-v2/runtime/xml-utils';

const cells = '<mxCell id="2" parent="1" vertex="1"/><mxCell id="3" parent="2" vertex="1"/>';

describe('legacy V1 runtime helper paths', () => {
  it('shares the maintained V2 helper implementations', () => {
    expect(DrawioBridge).toBe(v2Bridge.DrawioBridge);
    expect(buildDrawioEmbedUrl).toBe(v2Bridge.buildDrawioEmbedUrl);
    expect(applyDiagramOperations).toBe(v2Xml.applyDiagramOperations);
    expect(isMxCellXmlComplete).toBe(v2Xml.isMxCellXmlComplete);
    expect(wrapWithMxFile).toBe(v2Xml.wrapWithMxFile);
  });

  it('loads and saves through the embedded editor bridge using the V1 path', () => {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const post = vi.spyOn(iframe.contentWindow, 'postMessage');
    const onSave = vi.fn();
    const bridge = new DrawioBridge({ baseUrl: 'https://drawio.example/editor' });
    bridge.attach(iframe, { onSave }, cells);

    const receive = (event: string, xml?: string) => {
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: 'https://drawio.example',
          source: iframe.contentWindow,
          data: JSON.stringify({ event, ...(xml === undefined ? {} : { xml }) }),
        }),
      );
    };

    receive('init');
    expect(JSON.parse(post.mock.calls[0][0])).toMatchObject({ action: 'load', xml: cells, autosave: 1 });
    receive('save', '<mxfile />');
    expect(onSave).toHaveBeenCalledWith('<mxfile />');

    bridge.detach();
    receive('save', '<mxfile><late /></mxfile>');
    expect(onSave).toHaveBeenCalledTimes(1);
    iframe.remove();
  });

  it('wraps complete cell fragments and leaves the diagram unchanged on edit failure', () => {
    const xml = wrapWithMxFile(cells);
    expect(isMxCellXmlComplete(cells)).toBe(true);
    expect(isMxCellXmlComplete('<mxCell id="2"')).toBe(false);

    const failed = applyDiagramOperations(xml, [
      { operation: 'delete', cell_id: '2' },
      { operation: 'add', cell_id: '4', new_xml: '<mxCell id="5" />' },
    ]);
    expect(failed.errors).toHaveLength(1);
    expect(failed.result).toBe(xml);
  });
});
