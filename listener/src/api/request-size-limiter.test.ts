import { EventEmitter } from 'events';
import { Request, Response, NextFunction } from 'express';
import {
  createRequestSizeLimiter,
  DEFAULT_MAX_REQUEST_SIZE_BYTES,
} from './request-size-limiter';

describe('API Request Size Protection (Issue #688)', () => {
  const createMockReqRes = (contentLength?: string) => {
    const req = Object.assign(new EventEmitter(), {
      headers: contentLength ? { 'content-length': contentLength } : {},
      pause: jest.fn(),
    }) as unknown as Request;

    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    } as unknown as Response;

    const next = jest.fn() as NextFunction;

    return { req, res, next };
  };

  test('allows requests within size limits', () => {
    const middleware = createRequestSizeLimiter({ maxSizeBytes: 1024 });
    const { req, res, next } = createMockReqRes('500');

    middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  test('rejects oversized Content-Length header with 413 Payload Too Large', () => {
    const middleware = createRequestSizeLimiter({ maxSizeBytes: 1024 });
    const { req, res, next } = createMockReqRes('2048');

    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(413);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'PAYLOAD_TOO_LARGE',
        maxSizeBytes: 1024,
        declaredSizeBytes: 2048,
      })
    );
  });

  test('aborts stream when streaming chunked data exceeds limit', () => {
    const middleware = createRequestSizeLimiter({ maxSizeBytes: 100 });
    const { req, res, next } = createMockReqRes();

    middleware(req, res, next);
    expect(next).toHaveBeenCalled();

    // Emit chunks exceeding 100 bytes
    req.emit('data', Buffer.alloc(60));
    expect(res.status).not.toHaveBeenCalled();

    req.emit('data', Buffer.alloc(60)); // total = 120 > 100
    expect(res.status).toHaveBeenCalledWith(413);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'PAYLOAD_TOO_LARGE',
        receivedBytes: 120,
      })
    );
  });
});
