export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const errors = {
  badRequest(message = '请求参数不合法', details?: unknown): HttpError {
    return new HttpError(400, 'BAD_REQUEST', message, details);
  },
  validation(details?: unknown, message = '请求参数校验失败'): HttpError {
    return new HttpError(400, 'VALIDATION_ERROR', message, details);
  },
  unauthorized(message = '请先登录'): HttpError {
    return new HttpError(401, 'UNAUTHORIZED', message);
  },
  forbidden(message = '权限不足'): HttpError {
    return new HttpError(403, 'FORBIDDEN', message);
  },
  notFound(message = '资源不存在'): HttpError {
    return new HttpError(404, 'NOT_FOUND', message);
  },
  conflict(message: string, details?: unknown): HttpError {
    return new HttpError(409, 'CONFLICT', message, details);
  },
  payloadTooLarge(message = '文件超过大小限制'): HttpError {
    return new HttpError(413, 'PAYLOAD_TOO_LARGE', message);
  },
  unsupported(message = '不支持的文件格式'): HttpError {
    return new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', message);
  },
  internal(message = '服务器内部错误'): HttpError {
    return new HttpError(500, 'INTERNAL_ERROR', message);
  },
};

export function sendJson(res: import('node:http').ServerResponse, requestId: string, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('content-length', Buffer.byteLength(body));
  res.setHeader('x-request-id', requestId);
  res.end(body);
}

export function sendError(res: import('node:http').ServerResponse, requestId: string, error: unknown): void {
  const httpError =
    error instanceof HttpError
      ? error
      : error instanceof SyntaxError
        ? errors.badRequest('请求体不是合法的 JSON')
        : errors.internal((error as Error)?.message || '服务器内部错误');
  if (!(error instanceof HttpError) && httpError.status >= 500) {
    console.error(`[error] ${requestId}`, error);
  }
  sendJson(res, requestId, httpError.status, {
    error: { code: httpError.code, message: httpError.message, details: httpError.details, requestId },
  });
}
