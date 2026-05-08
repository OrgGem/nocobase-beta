/**
 * Module-level store that maps diagram titles to their results.
 *
 * The invoke handler for display_diagram / display_model_diagram stores
 * the diagramId here after creating (or locating) the diagram record.
 * The DrawioDiagramCard UI component reads from this store to render
 * the appropriate button / status.
 *
 * Lives at module scope because tool invoke and UI card rendering happen
 * in the same browser tab but at different points in time.
 */

export type DiagramResult = {
  diagramId: string;
  title?: string;
  /** True when the diagram was applied directly to an already-open drawio block */
  appliedDirectly: boolean;
};

// Keyed by diagram title for easy lookup from the card component
const storeByTitle = new Map<string, DiagramResult>();

export function setDiagramResult(result: DiagramResult) {
  if (result.title) {
    storeByTitle.set(result.title, result);
  }
}

export function getDiagramResultByTitle(title: string): DiagramResult | undefined {
  return storeByTitle.get(title);
}

export function clearDiagramResults() {
  storeByTitle.clear();
}
