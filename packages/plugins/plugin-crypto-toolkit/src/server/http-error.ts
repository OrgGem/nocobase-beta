// The error-handler middleware renders status from `err.statusCode` and the body
// from `err.message`/`err.code`; setting `ctx.status` and then throwing a plain
// Error would be overwritten to 500, so validation failures must be thrown as
// typed errors carrying the intended status.
export class CryptoToolkitHttpError extends Error {
  statusCode: number;
  code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'CryptoToolkitHttpError';
    this.statusCode = statusCode;
    this.code = code;
  }
}
