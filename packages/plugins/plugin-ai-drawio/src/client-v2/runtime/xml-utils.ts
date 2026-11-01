/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

export interface DiagramOperation {
  operation: 'add' | 'update' | 'delete';
  cell_id: string;
  new_xml?: string;
}

function parse(xml: string) {
  const document = new DOMParser().parseFromString(xml, 'application/xml');
  if (document.querySelector('parsererror') || document.doctype) throw new Error('Invalid diagram XML');
  return document;
}

export function wrapWithMxFile(xml: string) {
  const source = xml.trim().replace(/^<\?xml[^>]*\?>\s*/, '');
  let document: Document;
  if (source.startsWith('<mxfile')) document = parse(source);
  else if (source.startsWith('<mxGraphModel')) document = parse(`<mxfile><diagram>${source}</diagram></mxfile>`);
  else {
    const root = source.startsWith('<root') ? source : `<root>${source}</root>`;
    document = parse(`<mxfile><diagram><mxGraphModel>${root}</mxGraphModel></diagram></mxfile>`);
  }
  const root = document.querySelector('mxGraphModel > root');
  if (!root) throw new Error('Only uncompressed draw.io XML is supported');
  for (const [id, parent] of [
    ['0', undefined],
    ['1', '0'],
  ] as const) {
    if (!Array.from(root.querySelectorAll('mxCell')).some((cell) => cell.getAttribute('id') === id)) {
      const cell = document.createElement('mxCell');
      cell.setAttribute('id', id);
      if (parent) cell.setAttribute('parent', parent);
      const zero = Array.from(root.querySelectorAll('mxCell')).find((cell) => cell.getAttribute('id') === '0');
      root.insertBefore(cell, parent ? zero?.nextSibling || null : root.firstChild);
    }
  }
  return new XMLSerializer().serializeToString(document);
}

export function isMxCellXmlComplete(xml: string) {
  try {
    wrapWithMxFile(xml);
    return true;
  } catch {
    return false;
  }
}

export function applyDiagramOperations(xml: string, operations: DiagramOperation[]) {
  const document = parse(wrapWithMxFile(xml));
  const root = document.querySelector('mxGraphModel > root');
  if (!root) throw new Error('Only uncompressed draw.io XML is supported');
  const errors: { type: string; cellId: string; message: string }[] = [];
  for (const operation of operations) {
    try {
      if (['0', '1'].includes(operation.cell_id)) throw new Error('Root cells cannot be changed');
      const cells = Array.from(root.querySelectorAll('mxCell'));
      const existing = cells.find((cell) => cell.getAttribute('id') === operation.cell_id);
      if (operation.operation === 'delete') {
        if (!existing) throw new Error('Cell not found');
        const removed = new Set<string | null>([operation.cell_id]);
        let previous = -1;
        while (previous !== removed.size) {
          previous = removed.size;
          for (const cell of cells)
            if (['parent', 'source', 'target'].some((key) => removed.has(cell.getAttribute(key))))
              removed.add(cell.getAttribute('id'));
        }
        for (const cell of cells) if (removed.has(cell.getAttribute('id'))) cell.remove();
      } else {
        if (!['add', 'update'].includes(operation.operation)) throw new Error('Unsupported operation');
        const replacement = parse(operation.new_xml || '').documentElement;
        if (replacement.tagName !== 'mxCell' || replacement.getAttribute('id') !== operation.cell_id)
          throw new Error('Cell ID does not match');
        if (operation.operation === 'add') {
          if (existing) throw new Error('Cell already exists');
          root.appendChild(document.importNode(replacement, true));
        } else {
          if (!existing) throw new Error('Cell not found');
          existing.replaceWith(document.importNode(replacement, true));
        }
      }
    } catch (error) {
      errors.push({
        type: operation.operation,
        cellId: operation.cell_id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { result: errors.length ? xml : new XMLSerializer().serializeToString(document), errors };
}
