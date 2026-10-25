/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

import { describe, expect, it, vi } from 'vitest';
import { DrawioBridge, buildDrawioEmbedUrl } from '../runtime/drawioBridge';
import { applyDiagramOperations, isMxCellXmlComplete, wrapWithMxFile } from '../runtime/xml-utils';

const cells =
  '<mxCell id="2" parent="1" vertex="1"/><mxCell id="3" parent="2" vertex="1"/><mxCell id="4" parent="1" source="2" target="3" edge="1"/>';
describe('Drawio V2 XML and iframe runtime', () => {
  it('wraps complete cells and rejects truncated or compressed XML instead of corrupting the diagram', () => {
    expect(isMxCellXmlComplete(cells)).toBe(true);
    expect(wrapWithMxFile(cells)).toContain('<mxGraphModel>');
    expect(isMxCellXmlComplete('<mxCell id="2"')).toBe(false);
    expect(() => wrapWithMxFile('<mxfile><diagram>compressed</diagram></mxfile>')).toThrow('uncompressed');
  });
  it('deletes children and edges and leaves the original diagram unchanged if any operation fails', () => {
    const xml = wrapWithMxFile(cells);
    const deleted = applyDiagramOperations(xml, [{ operation: 'delete', cell_id: '2' }]);
    expect(deleted.errors).toEqual([]);
    expect(deleted.result).not.toContain('id="2"');
    expect(deleted.result).not.toContain('id="3"');
    expect(deleted.result).not.toContain('id="4"');
    const failed = applyDiagramOperations(xml, [
      { operation: 'delete', cell_id: '2' },
      { operation: 'add', cell_id: '5', new_xml: '<mxCell id="6"/>' },
    ]);
    expect(failed.errors).toHaveLength(1);
    expect(failed.result).toBe(xml);
  });
  it('loads only after the correct iframe/origin sends init and detaches cleanly', () => {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const post = vi.spyOn(iframe.contentWindow, 'postMessage');
    const onAutosave = vi.fn();
    const bridge = new DrawioBridge({ baseUrl: 'https://embed.diagrams.net' });
    bridge.attach(iframe, { onAutosave }, cells);
    const receive = (origin: string, source: Window, data: unknown) =>
      window.dispatchEvent(new MessageEvent('message', { origin, source, data: JSON.stringify(data) }));
    receive('https://untrusted.example', iframe.contentWindow, { event: 'init' });
    receive('https://embed.diagrams.net', window, { event: 'init' });
    expect(post).not.toHaveBeenCalled();
    receive('https://embed.diagrams.net', iframe.contentWindow, { event: 'init' });
    expect(JSON.parse(post.mock.calls[0][0])).toMatchObject({ action: 'load', xml: cells, autosave: 1 });
    receive('https://embed.diagrams.net', iframe.contentWindow, { event: 'autosave', xml: 'saved' });
    expect(onAutosave).toHaveBeenCalledWith('saved');
    bridge.detach();
    receive('https://embed.diagrams.net', iframe.contentWindow, { event: 'autosave', xml: 'late' });
    expect(onAutosave).toHaveBeenCalledTimes(1);
    iframe.remove();
  });
  it('preserves editor URL options and rejects executable URL schemes', () => {
    const url = new URL(buildDrawioEmbedUrl('https://drawio.example/editor?lang=vi', { ui: 'min' }));
    expect(url.searchParams.get('lang')).toBe('vi');
    expect(url.searchParams.get('proto')).toBe('json');
    expect(() => buildDrawioEmbedUrl('javascript:alert(1)')).toThrow();
  });
});
