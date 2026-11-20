import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { STATUS_CODES } from 'node:http';

import { ApiError, errorBody } from './api-error';

const HTTP_CODES: Record<number, string> = { 404: 'NOT_FOUND', 405: 'METHOD_NOT_ALLOWED' };

function send(
  res: Response,
  status: number,
  code: string,
  message: string,
  details?: unknown,
  headers?: Record<string, string>,
): void {
  if (headers) res.set(headers);
  res.status(status).json(errorBody(code, message, details));
}

/** Maps every exception to the shared error body. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Errors');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();

    if (exception instanceof ApiError) {
      send(res, exception.statusCode, exception.code, exception.message, exception.details, exception.headers);
      return;
    }
    if (exception instanceof HttpException) {
      // Framework errors such as an unknown route. Nest's own messages ("Cannot GET /x")
      // are replaced by the plain reason phrase.
      const status = exception.getStatus();
      send(res, status, HTTP_CODES[status] ?? 'HTTP_ERROR', STATUS_CODES[status] ?? 'Error');
      return;
    }
    this.logger.error(exception instanceof Error ? (exception.stack ?? exception.message) : String(exception));
    res.status(500).type('text/plain').send('Internal Server Error');
  }
}

/**
 * Express error middleware for failures raised before Nest's pipeline runs,
 * i.e. by the JSON body parser. Malformed JSON is a 422 like any other invalid body.
 */
export function bodyParserErrorHandler(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  const e = err as { type?: string; status?: number; statusCode?: number };
  if (e?.type === 'entity.parse.failed') {
    send(res, 422, 'VALIDATION_ERROR', 'Request is invalid.', [{ field: '', message: 'JSON decode error' }]);
    return;
  }
  const status = e?.status ?? e?.statusCode;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    send(res, status, HTTP_CODES[status] ?? 'HTTP_ERROR', STATUS_CODES[status] ?? 'Error');
    return;
  }
  next(err);
}
