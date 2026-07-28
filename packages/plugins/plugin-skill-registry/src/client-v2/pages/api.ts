export type NocoBaseListBody<T> = {
  data: T[];
};

export type NocoBaseResponse<T> = {
  data?: T;
};

export function unwrapRecords<T>(payload: NocoBaseResponse<NocoBaseListBody<T>> | undefined): T[] {
  const body = payload?.data;
  return body && Array.isArray(body.data) ? body.data : [];
}
