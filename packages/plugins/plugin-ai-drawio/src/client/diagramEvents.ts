export type DiagramXmlUpdatedEvent = {
  diagramId: string;
  xml: string;
  sourceBlockUid?: string;
};

type DiagramXmlUpdatedListener = (event: DiagramXmlUpdatedEvent) => void;

const listeners = new Set<DiagramXmlUpdatedListener>();

export function subscribeDiagramXmlUpdated(listener: DiagramXmlUpdatedListener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notifyDiagramXmlUpdated(event: DiagramXmlUpdatedEvent) {
  for (const listener of Array.from(listeners)) {
    listener(event);
  }
}
