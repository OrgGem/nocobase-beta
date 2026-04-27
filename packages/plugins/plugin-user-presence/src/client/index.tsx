import { Plugin } from '@nocobase/client';

export class PluginUserPresenceClient extends Plugin {
  async load() {
    // Start sending presence heartbeats every 30s
    const sendHeartbeat = () => {
      if (this.app.ws && (this.app.ws as any).connected) {
        this.app.ws.send(JSON.stringify({
          type: 'comm',
          payload: {
            action: 'presence_heartbeat',
            data: { userId: (this.app as any).user?.id },
          },
        }));
      }
    };

    // Initial heartbeat after connection
    if (this.app.ws) {
      this.app.ws.on('open', sendHeartbeat);
    }

    // Periodic heartbeat
    setInterval(sendHeartbeat, 30000);
  }
}

export default PluginUserPresenceClient;
