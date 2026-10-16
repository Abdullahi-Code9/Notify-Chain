/**
 * Error Types for Dashboard API Error Handling
 * 
 * This module provides typed error classes to distinguish between different
 * types of failures in API requests:
 * - Network failures (connection issues, DNS failures)
 * - Server errors (5xx responses)
 * - Client errors (4xx responses)
 * - Timeout errors (request took too long)
 * - Validation errors (invalid response format)
 */

/**
 * Base class for all API-related errors.
 * Extends Error with additional context about the request.
 */
export abstract class ApiError extends Error {
  /**
   * Timestamp when the error occurred
   */
  public readonly timestamp: number;

  /**
   * Optional URL that was being accessed when the error occurred
   */
  public readonly url?: string;

  /**
   * Whether this error type is typically recoverable with a retry
   */
  public abstract readonly isRetryable: boolean;

  constructor(message: string, url?: string) {
    super(message);
    this.name = this.constructor.name;
    this.timestamp = Date.now();
    this.url = url;
    
    // Maintains proper stack trace for where our error was thrown (only available on V8)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  /**
   * Returns a user-friendly error message suitable for display
   */
  public abstract getUserMessage(): string;
}

/**
 * Network failure - connection could not be established
 * Examples: DNS lookup failed, connection refused, network offline
 */
export class NetworkError extends ApiError {
  public readonly isRetryable = true;

  constructor(message: string, url?: string, public readonly cause?: Error) {
    super(message, url);
  }

  public getUserMessage(): string {
    return 'Unable to connect to the server. Please check your internet connection and try again.';
  }
}

/**
 * Server error - server responded with 5xx status code
 * Examples: 500 Internal Server Error, 502 Bad Gateway, 503 Service Unavailable
 */
export class ServerError extends ApiError {
  public readonly isRetryable = true;

  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly statusText: string,
    url?: string
  ) {
    super(message, url);
  }

  public getUserMessage(): string {
    return `Server error (${this.statusCode}). The service is experiencing issues. Please try again later.`;
  }
}

/**
 * Client error - server responded with 4xx status code
 * Examples: 400 Bad Request, 401 Unauthorized, 404 Not Found
 */
export class ClientError extends ApiError {
  public readonly isRetryable = false;

  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly statusText: string,
    url?: string
  ) {
    super(message, url);
  }

  public getUserMessage(): string {
    switch (this.statusCode) {
      case 400:
        return 'Invalid request. Please check your input and try again.';
      case 401:
        return 'Authentication required. Please log in and try again.';
      case 403:
        return 'Access denied. You do not have permission to access this resource.';
      case 404:
        return 'Resource not found. The requested data may have been removed.';
      case 429:
        return 'Too many requests. Please wait a moment before trying again.';
      default:
        return `Request failed (${this.statusCode}). Please try again.`;
    }
  }
}

/**
 * Timeout error - request took too long to complete
 */
export class TimeoutError extends ApiError {
  public readonly isRetryable = true;

  constructor(
    message: string,
    public readonly timeoutMs: number,
    url?: string
  ) {
    super(message, url);
  }

  public getUserMessage(): string {
    return 'Request timed out. The server is taking too long to respond. Please try again.';
  }
}

/**
 * Validation error - response format is invalid or unexpected
 * Examples: Invalid JSON, missing required fields, type mismatches
 */
export class ValidationError extends ApiError {
  public readonly isRetryable = false;

  constructor(
    message: string,
    url?: string,
    public readonly validationDetails?: unknown
  ) {
    super(message, url);
  }

  public getUserMessage(): string {
    return 'Received invalid data from the server. Please refresh the page or contact support if the issue persists.';
  }
}

/**
 * Type guard to check if an error is an ApiError
 */
export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

/**
 * Type guard to check if an error is retryable
 */
export function isRetryableError(error: unknown): boolean {
  return isApiError(error) && error.isRetryable;
}

/**
 * Get a user-friendly error message from any error type
 */
export function getUserErrorMessage(error: unknown): string {
  if (isApiError(error)) {
    return error.getUserMessage();
  }
  
  if (error instanceof Error) {
    return error.message;
  }
  
  return 'An unexpected error occurred. Please try again.';
}

/**
 * Error state for UI components
 */
export interface ErrorState {
  type: 'network' | 'server' | 'client' | 'timeout' | 'validation' | 'unknown';
  message: string;
  userMessage: string;
  isRetryable: boolean;
  timestamp: number;
  url?: string;
}

/**
 * Convert any error to an ErrorState for UI rendering
 */
export function toErrorState(error: unknown, url?: string): ErrorState {
  if (error instanceof NetworkError) {
    return {
      type: 'network',
      message: error.message,
      userMessage: error.getUserMessage(),
      isRetryable: error.isRetryable,
      timestamp: error.timestamp,
      url: error.url || url,
    };
  }
  
  if (error instanceof ServerError) {
    return {
      type: 'server',
      message: error.message,
      userMessage: error.getUserMessage(),
      isRetryable: error.isRetryable,
      timestamp: error.timestamp,
      url: error.url || url,
    };
  }
  
  if (error instanceof ClientError) {
    return {
      type: 'client',
      message: error.message,
      userMessage: error.getUserMessage(),
      isRetryable: error.isRetryable,
      timestamp: error.timestamp,
      url: error.url || url,
    };
  }
  
  if (error instanceof TimeoutError) {
    return {
      type: 'timeout',
      message: error.message,
      userMessage: error.getUserMessage(),
      isRetryable: error.isRetryable,
      timestamp: error.timestamp,
      url: error.url || url,
    };
  }
  
  if (error instanceof ValidationError) {
    return {
      type: 'validation',
      message: error.message,
      userMessage: error.getUserMessage(),
      isRetryable: error.isRetryable,
      timestamp: error.timestamp,
      url: error.url || url,
    };
  }
  
  // Fallback for unknown error types
  const message = error instanceof Error ? error.message : 'An unexpected error occurred';
  return {
    type: 'unknown',
    message,
    userMessage: 'An unexpected error occurred. Please try again.',
    isRetryable: true,
    timestamp: Date.now(),
    url,
  };
}
