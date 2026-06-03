import { useCallback, useEffect, useRef, useState } from 'react';

export interface RunEvent {
  id: string | number;
  runId: string | number;
  type: string;
  title: string;
  content?: string;
  status?: string;
  createdAt?: string;
  payload?: any;
}

export interface UseRunEventStreamResult {
  events: RunEvent[];
  isConnected: boolean;
  error: string | null;
}

/**
 * React hook that opens an SSE connection to receive real-time agent loop events.
 *
 * On reconnect (EventSource auto-reconnects), missed events should be fetched
 * from the REST endpoint by the caller if needed.
 */
export function useRunEventStream(runId: string | number | undefined): UseRunEventStreamResult {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  const cleanup = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    setIsConnected(false);
  }, []);

  useEffect(() => {
    if (!runId) return;

    cleanup();
    setEvents([]);
    setError(null);

    const baseUrl = (window as any).__nocobase_api_base_url__ || '';
    const url = `${baseUrl}/api/agentLoopEventsStream:stream?runId=${encodeURIComponent(String(runId))}`;
    const es = new EventSource(url);
    eventSourceRef.current = es;

    es.onopen = () => {
      setIsConnected(true);
      setError(null);
    };

    es.onmessage = (msg) => {
      try {
        const event: RunEvent = JSON.parse(msg.data);
        setEvents((prev) => [event, ...prev]);
      } catch {
        // ignore malformed events
      }
    };

    es.onerror = () => {
      setIsConnected(false);
      setError('SSE connection lost. Reconnecting...');
      // EventSource auto-reconnects
    };

    return cleanup;
  }, [runId, cleanup]);

  return { events, isConnected, error };
}
