import { getActionResponseBody, getListRows } from '../utils/apiResponse';

describe('UiPath API response helpers', () => {
  it('unwraps NocoBase action envelopes from api.request responses', () => {
    const response = {
      data: {
        data: {
          status: 'healthy',
          latencyMs: 123,
        },
      },
    };

    expect(getActionResponseBody(response)).toEqual({ status: 'healthy', latencyMs: 123 });
  });

  it('reads rows from nested custom action list envelopes', () => {
    const response = {
      data: {
        data: {
          data: [{ Id: 1 }, { Id: 2 }],
          count: 2,
        },
      },
    };

    expect(getListRows(response)).toEqual([{ Id: 1 }, { Id: 2 }]);
  });
});
