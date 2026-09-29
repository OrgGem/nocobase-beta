import { BaseInterface, Repository } from '@nocobase/database';

export class VietnamRegionInterface extends BaseInterface {
  async toValue(str: string, ctx?: any): Promise<any> {
    if (!str) {
      return null;
    }
    const { field } = ctx;
    const items = str.split('/').map((item) => item.trim());
    const repository = field.database.getRepository(field.target) as Repository;

    const instances = await repository.find({
      filter: {
        name: items,
      },
    });

    for (let i = 0; i < items.length; i++) {
      const instance = instances.find((item) => item.name === items[i] && item.level === i + 1);
      if (!instance) {
        throw new Error(`vietnam region "${items[i]}" does not exist`);
      }
      items[i] = instance.get('code');
    }

    return items;
  }

  toString(value: any, ctx?: any) {
    const values = (Array.isArray(value) ? value : [value])
      .filter((item) => item?.name != null)
      .sort((a, b) => {
        const levelDiff = (a.level || 0) - (b.level || 0);
        if (levelDiff !== 0) {
          return levelDiff;
        }
        return String(a.name).localeCompare(String(b.name), 'vi');
      });

    return values.map((item) => item.name).join('/');
  }
}
