import http from 'http';
import logger from '../utils/logger';
import { sendErr, ErrorCode } from '../utils/response';
import { ValidationError } from '../utils/validation';

export class ApiError extends Error {
  public readonly statusCode: number;
  public readonly errorCode: string;
  public readonly details?: unknown;

  constructor(
    message: string,
    statusCode: number,
    errorCode: string = ErrorCode.INTERNAL_ERROR,
    details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.errorCode = errorCode;
    this.details = details;
  }

  static badRequest(message: string, details?: unknown): ApiError {
    return new ApiError(message, 400, ErrorCode.BAD_REQUEST, details);
  }

  static unauthorized(message: string): ApiError {
    return new ApiError(message, 401, ErrorCode.UNAUTHORIZED);
  }

  static notFound(message: string): ApiError {
    return new ApiError(message, 404, ErrorCode.NOT_FOUND);
  }

  static conflict(message: string): ApiError {
    return new ApiError(message, 409, ErrorCode.CONFLICT);
  }

  static unprocessable(message: string, details?: unknown): ApiError {
    return new ApiError(message, 422, ErrorCode.UNPROCESSABLE, details);
  }

  static payloadTooLarge(message: string, details?: unknown): ApiError {
    return new ApiError(message, 413, ErrorCode.PAYLOAD_TOO_LARGE, details);
  }

  static unsupportedMediaType(message: string, details?: unknown): ApiError {
    return new ApiError(message, 415, ErrorCode.UNSUPPORTED_MEDIA_TYPE, details);
  }

  static rateLimited(message: string): ApiError {
    return new ApiError(message, 429, ErrorCode.RATE_LIMITED);
  }

  static serviceUnavailable(message: string): ApiError {
    return new ApiError(message, 503, ErrorCode.SERVICE_UNAVAILABLE);
  }

  static internal(message: string, details?: unknown): ApiError {
    return new ApiError(message, 500, ErrorCode.INTERNAL_ERROR, details);
  }
}

export function handleApiError(
  res: http.ServerResponse,
  error: unknown,
  requestId?: string,
  correlationId?: string,
): void {
  if (error instanceof ApiError) {
    logger.error('API error', {
      requestId,
      correlationId,
      statusCode: error.statusCode,
      errorCode: error.errorCode,
      message: error.message,
    });
    sendErr(res, error.statusCode, error.message, error.errorCode, error.details);
    return;
  }

  if (error instanceof ValidationError) {
    logger.warn('Validation error', {
      requestId,
      correlationId,
      issues: error.issues,
    });
    sendErr(
      res,
      400,
      `Validation failed: ${error.message}`,
      ErrorCode.BAD_REQUEST,
      error.issues
    );
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  logger.error('Unhandled API error', {
    requestId,
    correlationId,
    error,
  });
  sendErr(res, 500, message, ErrorCode.INTERNAL_ERROR);
}

export function wrapAsyncHandler(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => Promise<void>,
): (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => void {
  return (req: http.IncomingMessage, res: http.ServerResponse, url: URL): void => {
    handler(req, res, url).catch((error: unknown) => {
      handleApiError(res, error);
    });
  };
}
