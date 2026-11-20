/** One error shape for every failure: {"error": {"code", "message", "details"?}}. */

export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function unauthorized(message = 'Missing or invalid bearer token.'): ApiError {
  return new ApiError(401, 'UNAUTHORIZED', message, undefined, { 'WWW-Authenticate': 'Bearer' });
}

export function forbidden(message: string): ApiError {
  return new ApiError(403, 'FORBIDDEN', message);
}

export function notFound(code: string, message: string): ApiError {
  return new ApiError(404, code, message);
}

export interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

/** `details` is left out entirely when there are none. */
export function errorBody(code: string, message: string, details?: unknown): ErrorBody {
  const error: ErrorBody['error'] = { code, message };
  if (details !== undefined && details !== null) error.details = details;
  return { error };
}

export interface FieldError {
  field: string;
  message: string;
}

export function validationError(details: FieldError[], message = 'Request is invalid.'): ApiError {
  return new ApiError(422, 'VALIDATION_ERROR', message, details);
}
