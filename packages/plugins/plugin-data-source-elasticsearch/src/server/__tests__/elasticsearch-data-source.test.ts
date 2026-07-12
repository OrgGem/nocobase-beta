import {
  getElasticsearchConnectionOptions,
  normalizeElasticsearchCollectionNames,
} from '../data-source/ElasticsearchDataSource';

describe('elasticsearch data source helpers', () => {
  it('normalizes selected collection names from strings and table rows', () => {
    expect(
      normalizeElasticsearchCollectionNames([
        'logs-2026',
        { name: 'products', selected: true },
        { name: 'ignored', selected: false },
        { value: 'events' },
        'logs-2026',
      ]),
    ).toEqual(['logs-2026', 'products', 'events']);
  });

  it('extracts nested connection options from datasource payloads', () => {
    expect(
      getElasticsearchConnectionOptions({
        key: 'elastic',
        options: {
          nodes: 'http://localhost:9200',
          indexPattern: 'sample-*',
        },
      }),
    ).toMatchObject({
      nodes: 'http://localhost:9200',
      indexPattern: 'sample-*',
    });
  });
});
