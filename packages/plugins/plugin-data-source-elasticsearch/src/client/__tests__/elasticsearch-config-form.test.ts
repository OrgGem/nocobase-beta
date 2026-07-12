import { toCollectionOptions } from '../components/ElasticsearchConfigForm';

describe('ElasticsearchConfigForm helpers', () => {
  it('normalizes wrapped and unwrapped collection option payloads', () => {
    expect(toCollectionOptions({ data: { data: [{ name: 'sample_products' }] } })).toEqual([
      { label: 'sample_products', value: 'sample_products' },
    ]);

    expect(toCollectionOptions({ data: ['sample_logs'] })).toEqual([{ label: 'sample_logs', value: 'sample_logs' }]);
  });
});
