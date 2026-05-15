import type { Application } from '@nocobase/server';
import type { BrowserPolicy } from '../drivers';

/**
 * BrowserPolicyService — validates URLs and actions against policy rules.
 */
export class BrowserPolicyService {
  private app: Application;
  constructor(app: Application) { (this as any).app = app; }

  async getDefaultPolicy(): Promise<BrowserPolicy> {
    try {
      const repo = (this as any).app.db.getRepository('aiBrowserConfig');
      const row = await repo.findOne({ filter: { key: 'defaultPolicy' } });
      if (row) return JSON.parse(row.get('value') as string);
    } catch {}
    return this.getConservativeDefaults();
  }

  async setDefaultPolicy(policy: BrowserPolicy): Promise<void> {
    const repo = (this as any).app.db.getRepository('aiBrowserConfig');
    const existing = await repo.findOne({ filter: { key: 'defaultPolicy' } });
    if (existing) {
      await repo.update({ filterByTk: 'defaultPolicy', values: { value: JSON.stringify(policy) } });
    } else {
      await repo.create({ values: { key: 'defaultPolicy', value: JSON.stringify(policy) } });
    }
  }

  private matchesDomain(hostname: string, pattern: string): boolean {
    const value = String(pattern || '').trim().toLowerCase();
    if (!value) return false;
    const host = hostname.toLowerCase();
    if (value === '*') return true;
    if (value.startsWith('*.')) {
      const suffix = value.slice(2);
      return host === suffix || host.endsWith(`.${suffix}`);
    }
    if (value.includes('*')) {
      const escaped = value.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      return new RegExp(`^${escaped}$`, 'i').test(host);
    }
    return host === value || host.endsWith(`.${value}`);
  }

  isUrlAllowed(url: string, policy: BrowserPolicy): boolean {
    try {
      const hostname = new URL(url).hostname;
      if (policy.deniedDomains?.length) {
        for (const d of policy.deniedDomains) {
          if (this.matchesDomain(hostname, d)) return false;
        }
      }
      if (policy.allowedDomains?.length) {
        return policy.allowedDomains.some((a) => this.matchesDomain(hostname, a));
      }
      return true;
    } catch { return false; }
  }

  isActionAllowed(actionType: string, policy: BrowserPolicy): { allowed: boolean; reason?: string } {
    if (!policy) return { allowed: true };
    if (!policy.allowDestructiveActions) {
      const destructive = ['delete', 'remove', 'cancel_subscription', 'close_account'];
      if (destructive.some((d) => actionType.toLowerCase().includes(d))) {
        return { allowed: false, reason: 'Destructive actions blocked by policy' };
      }
    }
    if (!policy.allowDownloads && actionType === 'download') return { allowed: false, reason: 'Downloads blocked' };
    if (!policy.allowFormSubmit && actionType === 'submit') return { allowed: false, reason: 'Form submit blocked' };
    return { allowed: true };
  }

  getConservativeDefaults(): BrowserPolicy {
    return {
      allowedDomains: [], deniedDomains: [], maxDurationSeconds: 600,
      idleTimeoutSeconds: 120,
      maxTabs: 3, allowDownloads: false, allowFormSubmit: true,
      allowLogin: false, allowDestructiveActions: false,
    };
  }
}
