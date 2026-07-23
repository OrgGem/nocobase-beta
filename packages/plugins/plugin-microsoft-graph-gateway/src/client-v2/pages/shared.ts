export interface ApiEnvelope<T> {
  data: T;
  meta?: { page: number; pageSize: number; count: number; totalPage: number };
}
export interface ActionResponse<T> {
  data: T;
}
export function actionData<T>(response: ActionResponse<T>): T {
  return response.data;
}
export function errorMessage(error: unknown, fallback: string) {
  const value = error as { response?: { data?: { errors?: Array<{ message?: string }> } }; message?: string };
  return value.response?.data?.errors?.[0]?.message || value.message || fallback;
}
