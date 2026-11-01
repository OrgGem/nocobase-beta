/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

// Phase 2: tool-call shared state.
// `partialXml` accumulates fragments when display_diagram returns truncated
// and the LLM uses append_diagram to continue. Lives at module scope because
// AI tool invocations are stateless across calls.

let partialXml = '';
let partialInfo: { id?: string; title?: string } = {};

export function getPartialDiagramInfo() {
  return partialInfo;
}

export function getPartialXml(): string {
  return partialXml;
}

export function setPartialXml(xml: string, info: typeof partialInfo = {}) {
  partialXml = xml;
  partialInfo = info;
}

export function appendPartialXml(xml: string) {
  partialXml += xml;
}

export function resetPartialXml() {
  partialXml = '';
  partialInfo = {};
}
