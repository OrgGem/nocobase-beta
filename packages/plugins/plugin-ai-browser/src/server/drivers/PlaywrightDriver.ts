import { IBrowserDriver, BrowserDriverSession, BrowserTaskResult, BrowserDriverSessionOptions } from './IBrowserDriver';
type Browser = import('playwright-core').Browser;
type BrowserContext = import('playwright-core').BrowserContext;
type Page = import('playwright-core').Page;

function getChromium() {
  return require('playwright' + '-core').chromium;
}
import { randomUUID } from 'crypto';

interface ActiveSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  sessionData: BrowserDriverSession;
}

type BrowserlessTargetInfo = {
  targetId?: string;
  browserWSEndpoint?: string;
  browserId?: string;
};

export class PlaywrightDriver implements IBrowserDriver {
  readonly name = 'playwright-browserless';
  private cdpUrl: string;
  private liveUrl: string;
  private sessionsUrl: string;
  private activeSessions = new Map<string, ActiveSession>();

  constructor() {
    this.cdpUrl = process.env.AI_BROWSER_CDP_URL || 'ws://browser:3000';
    this.liveUrl = this.normalizeConfiguredLiveUrl(process.env.AI_BROWSER_LIVE_URL || this.deriveLiveUrl(this.cdpUrl));
    this.sessionsUrl = process.env.AI_BROWSER_SESSIONS_URL || this.deriveSessionsUrl(this.cdpUrl);
  }

  private deriveLiveUrl(cdpUrl: string) {
    try {
      const parsed = new URL(cdpUrl);
      if (['browser', 'browserless'].includes(parsed.hostname)) {
        return '/ai-browser-live/';
      }
    } catch {
      // Fall through to simple scheme conversion for legacy values.
    }
    return cdpUrl.replace(/^ws:\/\//, 'http://').replace(/^wss:\/\//, 'https://');
  }

  private normalizeConfiguredLiveUrl(url: string) {
    return url.replace(/\/debugger\/?$/, '/');
  }

  private deriveSessionsUrl(cdpUrl: string) {
    try {
      const parsed = new URL(cdpUrl);
      parsed.protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:';
      parsed.pathname = '/sessions';
      parsed.search = '';
      parsed.hash = '';
      return parsed.toString();
    } catch {
      return 'http://browser:3000/sessions';
    }
  }

  private withTrackingId(url: string, trackingId: string) {
    try {
      const parsed = new URL(url);
      parsed.searchParams.set('id', trackingId);
      return parsed.toString();
    } catch {
      const separator = url.includes('?') ? '&' : '?';
      return `${url}${separator}id=${encodeURIComponent(trackingId)}`;
    }
  }

  private toPublicBrowserlessUrl(url: string) {
    const publicBase = this.liveUrl.replace(/\/debugger\/?$/, '/').replace(/\/$/, '');
    try {
      const parsed = new URL(url, 'http://browserless');
      return `${publicBase}${parsed.pathname}${parsed.search}${parsed.hash}`;
    } catch {
      return url;
    }
  }

  private toPublicDevtoolsUrl(session: any) {
    const wsUrl = session?.webSocketDebuggerUrl;
    if (wsUrl) {
      try {
        const parsed = new URL(wsUrl);
        const protocolParam = parsed.protocol === 'wss:' ? 'wss' : 'ws';
        return `/ai-browser-live/devtools/inspector.html?${protocolParam}=__AI_BROWSER_HOST__${parsed.pathname}`;
      } catch {
        // Fall back to devtoolsFrontendUrl normalization below.
      }
    }

    const devtoolsUrl = session?.devtoolsFrontendUrl || session?.devtoolsUrl;
    return devtoolsUrl ? this.toPublicBrowserlessUrl(devtoolsUrl) : null;
  }

  private normalizeBrowserlessWsUrl(url?: string | null) {
    if (!url) return null;
    try {
      const source = new URL(url);
      const cdp = new URL(this.cdpUrl);
      if (['0.0.0.0', '127.0.0.1', 'localhost'].includes(source.hostname)) {
        source.hostname = cdp.hostname;
      }
      if (!source.port && cdp.port) {
        source.port = cdp.port;
      }
      return source.toString();
    } catch {
      return url;
    }
  }

  private async getTargetId(page: Page) {
    const cdpSession = await page.context().newCDPSession(page);
    try {
      const targetInfo = await cdpSession.send('Target.getTargetInfo');
      return targetInfo?.targetInfo?.targetId;
    } finally {
      await cdpSession.detach().catch(() => {});
    }
  }

  private async getBrowserlessTargetInfo(trackingId: string, page: Page): Promise<BrowserlessTargetInfo> {
    const targetId = await this.getTargetId(page).catch(() => undefined);

    try {
      const response = await fetch(this.withTrackingId(this.sessionsUrl, trackingId));
      if (!response.ok) return { targetId };
      const sessions = await response.json();
      if (!Array.isArray(sessions)) return { targetId };
      const pageUrl = page.url();
      const session =
        sessions.find((item: any) => targetId && item.id === targetId && item.type === 'page') ||
        sessions.find((item: any) => item.trackingId === trackingId && item.type === 'page') ||
        sessions.find((item: any) => item.url === pageUrl && item.type === 'page') ||
        sessions.find((item: any) => item.type === 'page');

      return {
        targetId,
        browserWSEndpoint: this.normalizeBrowserlessWsUrl(session?.browserWSEndpoint),
        browserId: session?.browserId,
      };
    } catch {
      return { targetId };
    }
  }

  private async getSessionLiveUrl(trackingId: string, page: Page, targetInfo?: BrowserlessTargetInfo) {
    try {
      const cdpSession = await page.context().newCDPSession(page);
      const liveSession = await (cdpSession.send as any)('Browserless.liveURL', {
        interactive: false,
        resizable: false,
        quality: 70,
        showBrowserInterface: false,
      });
      await cdpSession.detach().catch(() => {});

      if (liveSession?.liveURL) {
        return this.toPublicBrowserlessUrl(liveSession.liveURL);
      }
    } catch {
      // Browserless.liveURL is not available on every Browserless deployment.
    }

    try {
      const targetId = targetInfo?.targetId || (await this.getTargetId(page));
      
      if (targetId) {
        return `/ai-browser-live/devtools/inspector.html?ws=__AI_BROWSER_HOST__/devtools/page/${targetId}`;
      }
    } catch {
      // Fall through to sessions API if CDP fails
    }

    try {
      const response = await fetch(this.withTrackingId(this.sessionsUrl, trackingId));
      if (!response.ok) return null;
      const sessions = await response.json();
      if (!Array.isArray(sessions)) return null;
      const pageUrl = page.url();
      const session =
        sessions.find((item: any) => targetInfo?.targetId && item.id === targetInfo.targetId && item.type === 'page') ||
        sessions.find((item: any) => item.trackingId === trackingId && item.type === 'page') ||
        sessions.find((item: any) => item.trackingId === trackingId) ||
        sessions.find((item: any) => item.url === pageUrl && item.type === 'page') ||
        sessions.find((item: any) => item.type === 'page');
      return this.toPublicDevtoolsUrl(session);
    } catch {
      return null;
    }
  }

  async createSession(options: BrowserDriverSessionOptions): Promise<BrowserDriverSession> {
    const externalSessionId = randomUUID();
    
    // Connect to browserless via CDP
    const browser = await getChromium().connectOverCDP(this.withTrackingId(this.cdpUrl, externalSessionId));
    
    // Create isolated context for this session
    const contextOptions: any = {
      viewport: { width: 1920, height: 1080 },
      ignoreHTTPSErrors: true,
      locale: 'en-US',
      colorScheme: 'light',
    };
    
    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();

    if (options.startUrl) {
      try {
        await page.goto(options.startUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      } catch (err) {
        console.warn(`[PlaywrightDriver] page.goto failed for ${options.startUrl}, but creating session anyway.`, err);
      }
    }

    const targetInfo = await this.getBrowserlessTargetInfo(externalSessionId, page);
    const sessionLiveUrl =
      (await this.getSessionLiveUrl(externalSessionId, page, targetInfo)) || this.withTrackingId(this.liveUrl, externalSessionId);

    const sessionData: BrowserDriverSession = {
      externalSessionId,
      status: 'running',
      liveUrl: sessionLiveUrl,
      debugUrl: targetInfo.browserWSEndpoint || this.cdpUrl,
      ...(targetInfo as any),
    };

    this.activeSessions.set(externalSessionId, {
      browser,
      context,
      page,
      sessionData,
    });

    return sessionData;
  }

  async runTask(externalSessionId: string, task: string, options?: Record<string, any>): Promise<BrowserTaskResult> {
    // Deprecated in Solution B: We don't run single monolithic tasks via the driver anymore.
    // The driver is now purely for granular actions controlled by the NocoBase AI Employee.
    throw new Error('runTask is not supported in PlaywrightDriver. Use granular actions instead.');
  }

  async stopSession(externalSessionId: string): Promise<void> {
    const session = this.activeSessions.get(externalSessionId);
    if (session) {
      await session.context.close().catch(() => {});
      await session.browser.close().catch(() => {});
      session.sessionData.status = 'stopped';
      this.activeSessions.delete(externalSessionId);
    }
  }

  async getSessionStatus(externalSessionId: string): Promise<BrowserDriverSession | null> {
    const session = this.activeSessions.get(externalSessionId);
    if (!session) return null;
    
    // Verify if the browser is actually still connected
    if (!session.browser.isConnected()) {
      session.sessionData.status = 'stopped';
      this.activeSessions.delete(externalSessionId);
      return null;
    }
    
    return session.sessionData;
  }

  async takeScreenshot(externalSessionId: string): Promise<string | null> {
    const session = this.activeSessions.get(externalSessionId);
    if (!session) return null;
    const buffer = await session.page.screenshot({ type: 'jpeg', quality: 60 });
    return buffer.toString('base64');
  }

  async getCurrentUrl(externalSessionId: string): Promise<string | null> {
    const session = this.activeSessions.get(externalSessionId);
    return session ? session.page.url() : null;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const browser = await getChromium().connectOverCDP(this.cdpUrl);
      await browser.close();
      return true;
    } catch {
      return false;
    }
  }

  async dispose(): Promise<void> {
    for (const [id, session] of this.activeSessions.entries()) {
      await this.stopSession(id);
    }
  }

  // ==========================================================================
  // Granular Browser Actions
  // ==========================================================================

  private getPage(externalSessionId: string): Page {
    const session = this.activeSessions.get(externalSessionId);
    if (!session) throw new Error(`Session ${externalSessionId} not found`);
    return session.page;
  }

  async ensureSession(
    externalSessionId: string,
    options?: { debugUrl?: string; targetId?: string; browserWSEndpoint?: string },
  ): Promise<BrowserDriverSession | null> {
    const existing = await this.getSessionStatus(externalSessionId);
    if (existing) return existing;

    const reconnectUrl = options?.browserWSEndpoint || options?.debugUrl;
    if (!reconnectUrl) return null;

    try {
      const browser = await getChromium().connectOverCDP(reconnectUrl);
      let page: Page | undefined;
      let context: BrowserContext | undefined;

      for (const candidateContext of browser.contexts()) {
        for (const candidatePage of candidateContext.pages()) {
          if (options?.targetId) {
            const candidateTargetId = await this.getTargetId(candidatePage).catch(() => undefined);
            if (candidateTargetId !== options.targetId) {
              continue;
            }
          }
          page = candidatePage;
          context = candidateContext;
          break;
        }
        if (page) break;
      }

      context = context || browser.contexts()[0] || (await browser.newContext());
      page = page || context.pages()[0] || (await context.newPage());

      const targetInfo = await this.getBrowserlessTargetInfo(externalSessionId, page);
      const sessionData: BrowserDriverSession = {
        externalSessionId,
        status: 'running',
        liveUrl: (await this.getSessionLiveUrl(externalSessionId, page, targetInfo)) || this.withTrackingId(this.liveUrl, externalSessionId),
        debugUrl: targetInfo.browserWSEndpoint || reconnectUrl,
        ...(targetInfo as any),
      };

      this.activeSessions.set(externalSessionId, {
        browser,
        context,
        page,
        sessionData,
      });

      return sessionData;
    } catch {
      return null;
    }
  }

  async navigate(externalSessionId: string, url: string): Promise<void> {
    const page = this.getPage(externalSessionId);
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (err) {
      console.warn(`[PlaywrightDriver] navigate failed for ${url}.`, err);
      throw err; // For granular action, we probably want the tool to know it failed
    }
  }

  async click(externalSessionId: string, selector: string): Promise<void> {
    const page = this.getPage(externalSessionId);
    await this.locator(page, selector).click({ timeout: 10000 });
    await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(500);
  }

  async type(externalSessionId: string, selector: string, text: string): Promise<void> {
    const page = this.getPage(externalSessionId);
    await this.locator(page, selector).fill(text, { timeout: 10000 });
    await page.waitForTimeout(300);
  }

  async scroll(externalSessionId: string, direction: 'up' | 'down' | 'bottom' | 'top'): Promise<void> {
    const page = this.getPage(externalSessionId);
    if (direction === 'bottom') {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    } else if (direction === 'top') {
      await page.evaluate(() => window.scrollTo(0, 0));
    } else if (direction === 'down') {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight));
    } else if (direction === 'up') {
      await page.evaluate(() => window.scrollBy(0, -window.innerHeight));
    }
    // wait for scroll rendering
    await page.waitForTimeout(500);
  }

  async extractDOM(externalSessionId: string, selector?: string): Promise<string> {
    const page = this.getPage(externalSessionId);
    if (selector) {
      const locator = this.locator(page, selector).first();
      return await locator.innerText({ timeout: 5000 }).catch(async () => locator.innerHTML({ timeout: 5000 }));
    }

    return await page.evaluate(() => {
      const clean = (value: string | null | undefined, max = 180) =>
        String(value || '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, max);

      const cssEscape = (value: string) => {
        const css = (window as any).CSS;
        if (css?.escape) return css.escape(value);
        return value.replace(/["\\#.:,[\]()>+~*^$|=\s]/g, '\\$&');
      };

      const shortSelector = (el: Element) => {
        const id = el.getAttribute('id');
        if (id) return `#${cssEscape(id)}`;

        for (const attr of ['data-testid', 'data-test', 'data-cy', 'aria-label', 'name', 'placeholder']) {
          const value = el.getAttribute(attr);
          if (value) return `${el.tagName.toLowerCase()}[${attr}="${value.replace(/"/g, '\\"')}"]`;
        }

        const parts: string[] = [];
        let current: Element | null = el;
        while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 4) {
          let part = current.tagName.toLowerCase();
          const parent = current.parentElement;
          if (parent) {
            const sameTag = Array.from(parent.children).filter((child) => child.tagName === current!.tagName);
            if (sameTag.length > 1) {
              part += `:nth-of-type(${sameTag.indexOf(current) + 1})`;
            }
          }
          parts.unshift(part);
          current = parent;
        }
        return parts.join(' > ');
      };

      const labelFor = (el: Element) => {
        const id = el.getAttribute('id');
        if (id) {
          const label = document.querySelector(`label[for="${cssEscape(id)}"]`);
          if (label) return clean(label.textContent);
        }
        const parentLabel = el.closest('label');
        return parentLabel ? clean(parentLabel.textContent) : '';
      };

      const isVisible = (el: Element) => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      };

      const candidates = Array.from(
        document.querySelectorAll(
          [
            'a[href]',
            'button',
            'input',
            'textarea',
            'select',
            '[role="button"]',
            '[role="link"]',
            '[role="textbox"]',
            '[contenteditable="true"]',
            '[tabindex]:not([tabindex="-1"])',
          ].join(','),
        ),
      )
        .filter(isVisible)
        .slice(0, 120)
        .map((el, index) => {
          const tag = el.tagName.toLowerCase();
          const role = el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'button' ? 'button' : '');
          const text = clean(el.textContent || (el as HTMLInputElement).value);
          const aria = clean(el.getAttribute('aria-label'));
          const placeholder = clean(el.getAttribute('placeholder'));
          const label = labelFor(el);
          const testId =
            el.getAttribute('data-testid') || el.getAttribute('data-test') || el.getAttribute('data-cy') || '';
          const selector = shortSelector(el);
          const textSelector = text && text.length <= 80 ? `text=${text}` : '';
          const roleSelector = role && (aria || text || label) ? `role=${role}[name="${aria || label || text}"]` : '';
          return {
            index,
            tag,
            role,
            text,
            label,
            aria,
            placeholder,
            href: clean(el.getAttribute('href'), 220),
            selector,
            textSelector,
            roleSelector,
            testId,
          };
        });

      const bodyText = clean(document.body?.innerText || '', 3000);
      return JSON.stringify(
        {
          title: document.title,
          url: location.href,
          bodyText,
          interactiveElements: candidates,
        },
        null,
        2,
      );
    });
  }

  async waitFor(externalSessionId: string, selector: string, timeoutMs: number = 10000): Promise<boolean> {
    const page = this.getPage(externalSessionId);
    try {
      await this.locator(page, selector).waitFor({ state: 'visible', timeout: timeoutMs });
      return true;
    } catch {
      return false;
    }
  }

  private locator(page: Page, selector: string) {
    const trimmed = String(selector || '').trim();
    const roleMatch = trimmed.match(/^role=([a-zA-Z0-9_-]+)\[name=["'](.+)["']\]$/);
    if (roleMatch) {
      return page.getByRole(roleMatch[1] as any, { name: roleMatch[2] }).first();
    }
    if (trimmed.startsWith('text=')) {
      return page.getByText(trimmed.slice(5)).first();
    }
    if (trimmed.startsWith('testid=')) {
      return page.getByTestId(trimmed.slice(7)).first();
    }
    return page.locator(trimmed).first();
  }
}
