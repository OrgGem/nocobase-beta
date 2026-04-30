// Phase 2: tool-call shared state.
// `partialXml` accumulates fragments when display_diagram returns truncated
// and the LLM uses append_diagram to continue. Lives at module scope because
// AI tool invocations are stateless across calls.

let partialXml = '';

export function getPartialXml(): string {
  return partialXml;
}

export function setPartialXml(xml: string) {
  partialXml = xml;
}

export function appendPartialXml(xml: string) {
  partialXml += xml;
}

export function resetPartialXml() {
  partialXml = '';
}
