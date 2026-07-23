import { actionData, ApiEnvelope } from '../../client-v2/pages/shared';

describe('Microsoft Graph gateway response envelope', () => {
  it('unwraps the NocoBase action layer before reading plugin data', () => {
    const response = {
      data: {
        data: [{ id: 1 }],
        meta: { page: 1, pageSize: 20, count: 1, totalPage: 1 },
      } satisfies ApiEnvelope<Array<{ id: number }>>,
    };

    const envelope = actionData(response);

    expect(envelope.data).toEqual([{ id: 1 }]);
    expect(envelope.meta?.count).toBe(1);
  });

  it('unwraps an OpenAPI document without treating the action wrapper as the document', () => {
    const document = actionData({ data: { paths: { '/api/example': {} } } });

    expect(Object.keys(document.paths)).toEqual(['/api/example']);
  });
});
