/**
 * Module-level store for draw.io diagrams - SINGLE GLOBAL DIAGRAM.
 *
 * The plugin keeps exactly ONE diagram for the whole chat.
 * - First tool call creates the diagram and shows "Open Diagram" button
 * - Once opened, subsequent tool calls update the SAME canvas in place
 * - If user closes the canvas, next tool call shows the button again
 * - Data persists in localStorage for page refresh survival
 */

export type StoredDiagram = {
  id: string;
  title: string;
  xml: string;
};

export type DiagramState = {
  drawerOpen: boolean;
  diagram: StoredDiagram | null;
};

type Listener = (state: DiagramState) => void;

const STORAGE_KEY = 'ai-drawio:diagram';

function loadPersistedDiagram(): StoredDiagram | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const d = parsed as Partial<StoredDiagram>;
    if (typeof d.id === 'string' && typeof d.xml === 'string') {
      return { id: d.id, title: typeof d.title === 'string' ? d.title : 'Drawio Diagram', xml: d.xml };
    }
    return null;
  } catch {
    return null;
  }
}

function persist(diagram: StoredDiagram | null) {
  try {
    if (diagram) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(diagram));
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // localStorage full or unavailable — in-memory store still works.
  }
}

let state: DiagramState = {
  drawerOpen: false,
  diagram: loadPersistedDiagram(),
};

const listeners = new Set<Listener>();

function notify() {
  for (const listener of Array.from(listeners)) {
    listener(state);
  }
}

export function getDiagramState(): Readonly<DiagramState> {
  return state;
}

export function getDiagram(): StoredDiagram | null {
  return state.diagram;
}

/** Store (or update) the single global diagram. */
export function setDiagram(id: string, title: string, xml: string) {
  state = {
    ...state,
    diagram: { id, title, xml },
  };
  persist(state.diagram);
  notify();
}

export function setDiagramTitle(title: string) {
  if (!state.diagram || state.diagram.title === title) return;
  state = { ...state, diagram: { ...state.diagram, title } };
  persist(state.diagram);
  notify();
}

/** Recover the persisted diagram after a reload. */
export function restoreCurrentDiagram(): StoredDiagram | null {
  return loadPersistedDiagram();
}

/** Open/close the single shared drawer. */
export function setDrawerOpen(open: boolean) {
  if (open) {
    if (state.drawerOpen) return;
    state = { ...state, drawerOpen: true };
    notify();
  } else {
    if (!state.drawerOpen) return;
    state = { ...state, drawerOpen: false };
    notify();
  }
}

export function subscribeDiagramState(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
