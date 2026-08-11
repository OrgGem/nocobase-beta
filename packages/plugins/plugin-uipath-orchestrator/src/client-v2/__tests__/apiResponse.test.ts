import { getActionResponseBody, getListRows } from '../utils/apiResponse';
import { selectInitialFolder } from '../utils/folderSelection';

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

describe('UiPath initial folder selection', () => {
  const folders = [
    { folderId: 10, folderKey: 'first', fullyQualifiedName: 'Shared/First' },
    { folderId: 20, folderKey: 'default', fullyQualifiedName: 'Shared/Default' },
  ];

  it('uses the configured default folder when it exists', () => {
    expect(selectInitialFolder({ id: 1, defaultFolderKey: 'default' }, folders)?.folderId).toBe(20);
  });

  it('falls back to the first folder when no valid default is configured', () => {
    expect(selectInitialFolder({ id: 1, defaultFolderId: 999 }, folders)?.folderId).toBe(10);
  });
});
