type EventCallback = (event: any) => void;

class RunEventBusImpl {
  private listeners = new Map<string | number, Set<EventCallback>>();

  subscribe(runId: string | number, callback: EventCallback) {
    let set = this.listeners.get(runId);
    if (!set) {
      set = new Set();
      this.listeners.set(runId, set);
    }
    set.add(callback);
    return () => {
      set?.delete(callback);
      if (set?.size === 0) {
        this.listeners.delete(runId);
      }
    };
  }

  emit(runId: string | number, event: any) {
    const set = this.listeners.get(runId);
    if (!set) return;
    for (const callback of set) {
      try {
        callback(event);
      } catch {
        // ignore per-listener errors
      }
    }
  }

  listenerCount(runId: string | number): number {
    return this.listeners.get(runId)?.size || 0;
  }
}

let instance: RunEventBusImpl | null = null;

export function getRunEventBus(): RunEventBusImpl {
  if (!instance) {
    instance = new RunEventBusImpl();
  }
  return instance;
}
