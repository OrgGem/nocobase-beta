export class ApimError extends Error {
  public readonly code: string;
  public readonly httpStatus: number;

  constructor(code: string, message: string, httpStatus = 500) {
    super(message);
    this.name = 'ApimError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}
