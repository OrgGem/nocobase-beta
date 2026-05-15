/**
 * Browser Driver Interface
 *
 * Adapter pattern: all browser engines implement this interface.
 * MVP uses PlaywrightDriver against browserless; later add BrowserbaseDriver, etc.
 */

export interface BrowserDriverSessionOptions {
  /** Start URL to navigate to */
  startUrl?: string;
  /** Profile ID for auth state / cookies */
  profileId?: string;
  /** Launch options (headless, viewport, proxy, etc.) */
  launchOptions?: Record<string, any>;
  /** Policy constraints */
  policy?: BrowserPolicy;
  /** Extra metadata for the driver */
  metadata?: Record<string, any>;
}

export interface BrowserPolicy {
  allowedDomains?: string[];
  deniedDomains?: string[];
  maxDurationSeconds?: number;
  idleTimeoutSeconds?: number;
  maxTabs?: number;
  allowDownloads?: boolean;
  allowFormSubmit?: boolean;
  allowLogin?: boolean;
  allowDestructiveActions?: boolean;
}

export interface BrowserDriverSession {
  /** External session ID from the driver */
  externalSessionId: string;
  /** Live URL for readonly viewer (VNC / noVNC / etc.) */
  liveUrl?: string;
  /** WebSocket debug URL (hidden from regular users) */
  debugUrl?: string;
  /** Current status */
  status: 'created' | 'running' | 'completed' | 'failed' | 'stopped';
}

export interface BrowserTaskResult {
  success: boolean;
  /** Extracted data if any */
  data?: any;
  /** Final URL after task completion */
  finalUrl?: string;
  /** Screenshot paths */
  screenshots?: string[];
  /** Downloaded file paths */
  artifacts?: string[];
  /** Error message if failed */
  error?: string;
  /** Duration in milliseconds */
  durationMs?: number;
  /** Steps that were executed */
  steps?: BrowserStepEvent[];
}

export interface BrowserStepEvent {
  index: number;
  actionType: string;
  description: string;
  url?: string;
  selector?: string;
  inputValue?: string;
  result?: any;
  screenshotPath?: string;
  error?: string;
  durationMs?: number;
  timestamp: string;
}

export interface IBrowserDriver {
  /** Driver name identifier */
  readonly name: string;

  /**
   * Create a new browser session.
   */
  createSession(options: BrowserDriverSessionOptions): Promise<BrowserDriverSession>;

  /**
   * Run a task in the given session.
   */
  runTask(externalSessionId: string, task: string, options?: Record<string, any>): Promise<BrowserTaskResult>;

  /**
   * Stop / destroy a session.
   */
  stopSession(externalSessionId: string): Promise<void>;

  /**
   * Get current session status.
   */
  getSessionStatus(externalSessionId: string): Promise<BrowserDriverSession | null>;

  /**
   * Take a screenshot of the current page.
   */
  takeScreenshot(externalSessionId: string): Promise<string | null>;

  /**
   * Get the current URL of the browser.
   */
  getCurrentUrl(externalSessionId: string): Promise<string | null>;

  /**
   * Health check for the driver backend.
   */
  healthCheck(): Promise<boolean>;

  /**
   * Cleanup / dispose driver resources.
   */
  dispose(): Promise<void>;

  // ==========================================================================
  // Granular Browser Actions (for AI Employee-Driven mode)
  // ==========================================================================
  
  navigate(externalSessionId: string, url: string): Promise<void>;
  click(externalSessionId: string, selector: string): Promise<void>;
  type(externalSessionId: string, selector: string, text: string): Promise<void>;
  scroll(externalSessionId: string, direction: 'up' | 'down' | 'bottom' | 'top'): Promise<void>;
  extractDOM(externalSessionId: string, selector?: string): Promise<string>;
  waitFor(externalSessionId: string, selector: string, timeoutMs?: number): Promise<boolean>;
}
