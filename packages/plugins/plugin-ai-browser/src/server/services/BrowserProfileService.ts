import type { Application } from '@nocobase/server';

/**
 * BrowserProfileService
 *
 * CRUD operations for browser profiles.
 * Profiles store launch options, auth cookies, localStorage, default policies.
 */
export class BrowserProfileService {
  private app: Application;

  constructor(app: Application) {
    (this as any).app = app;
  }

  async createProfile(params: {
    name: string;
    description?: string;
    driver?: string;
    launchOptions?: Record<string, any>;
    defaultPolicy?: Record<string, any>;
    ownerId: number;
  }): Promise<any> {
    const repo = (this as any).app.db.getRepository('aiBrowserProfiles');
    return repo.create({
      values: {
        name: params.name,
        description: params.description || '',
        driver: params.driver || 'playwright-browserless',
        launchOptions: params.launchOptions || {},
        defaultPolicy: params.defaultPolicy || {},
        ownerId: params.ownerId,
        enabled: true,
      },
    });
  }

  async getProfile(profileId: string): Promise<any> {
    const repo = (this as any).app.db.getRepository('aiBrowserProfiles');
    return repo.findById(profileId);
  }

  async listProfiles(ownerId?: number): Promise<any[]> {
    const repo = (this as any).app.db.getRepository('aiBrowserProfiles');
    const filter: any = { enabled: true };
    if (ownerId) filter.ownerId = ownerId;
    return repo.find({ filter, sort: ['-createdAt'] });
  }

  async updateProfile(profileId: string, values: Record<string, any>): Promise<void> {
    const repo = (this as any).app.db.getRepository('aiBrowserProfiles');
    await repo.update({ filterByTk: profileId, values });
  }

  async deleteProfile(profileId: string): Promise<void> {
    const repo = (this as any).app.db.getRepository('aiBrowserProfiles');
    await repo.update({
      filterByTk: profileId,
      values: { enabled: false },
    });
  }
}
