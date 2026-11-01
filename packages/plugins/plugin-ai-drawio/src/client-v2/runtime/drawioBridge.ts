/**
 * This file is part of the NocoBase (R) project.
 * Copyright (c) 2020-2024 NocoBase Co., Ltd.
 * Authors: NocoBase Team.
 *
 * This project is dual-licensed under AGPL-3.0 and NocoBase Commercial License.
 * For more information, please refer to: https://www.nocobase.com/agreement.
 */

interface BridgeCallbacks {
  onInit?: () => void;
  onLoad?: (xml: string) => void;
  onSave?: (xml: string) => void;
  onAutosave?: (xml: string) => void;
}

export function buildDrawioEmbedUrl(baseUrl: string, options: { ui?: string } = {}) {
  const url = new URL(baseUrl, window.location.origin);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid draw.io editor URL');
  for (const [key, value] of Object.entries({
    embed: '1',
    proto: 'json',
    spin: '1',
    libraries: '1',
    noExitBtn: '1',
    ui: options.ui || 'kennedy',
  }))
    url.searchParams.set(key, value);
  return url.href;
}

/** https://www.drawio.com/docs/reference/embed-mode/ */
export class DrawioBridge {
  private iframe?: HTMLIFrameElement;
  private callbacks: BridgeCallbacks = {};
  private ready = false;
  private xml = '';
  private readonly origin: string;

  constructor({ baseUrl }: { baseUrl: string }) {
    this.origin = new URL(buildDrawioEmbedUrl(baseUrl)).origin;
  }

  private readonly onMessage = (event: MessageEvent) => {
    if (!this.iframe?.contentWindow || event.source !== this.iframe.contentWindow || event.origin !== this.origin)
      return;
    let payload: unknown;
    try {
      payload = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
    } catch {
      return;
    }
    if (!payload || typeof payload !== 'object' || !('event' in payload)) return;
    if (payload.event === 'init') {
      this.ready = true;
      this.load(this.xml);
      this.callbacks.onInit?.();
    } else if ('xml' in payload && typeof payload.xml === 'string') {
      this.xml = payload.xml;
      if (payload.event === 'load') this.callbacks.onLoad?.(payload.xml);
      if (payload.event === 'save') this.callbacks.onSave?.(payload.xml);
      if (payload.event === 'autosave') this.callbacks.onAutosave?.(payload.xml);
    }
  };

  attach(iframe: HTMLIFrameElement, callbacks: BridgeCallbacks, xml: string) {
    this.detach();
    this.iframe = iframe;
    this.callbacks = callbacks;
    this.xml = xml;
    window.addEventListener('message', this.onMessage);
  }

  load(xml: string) {
    this.xml = xml;
    if (this.ready)
      this.iframe?.contentWindow?.postMessage(JSON.stringify({ action: 'load', xml, autosave: 1 }), this.origin);
  }

  detach() {
    window.removeEventListener('message', this.onMessage);
    this.iframe = undefined;
    this.callbacks = {};
    this.ready = false;
  }
}
