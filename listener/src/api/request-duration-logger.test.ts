import { EventEmitter } from 'events';
import { Request, Response, NextFunction } from 'express';
import { createRequestDurationLogger } from './request-duration-logger';

describe('API Request Duration Logging (Issue #687)', () => {
  test('measures request duration and logs structured metadata on finish', (done) => {
    const mockLogger = {
      info: jest.fn((msg: string, meta?: Record<string, unknown>) => {
        expect(msg).toContain('HTTP GET /api/v1/health 200');
        expect(meta?.method).toBe('GET');
        expect(meta?.path).toBe('/api/v1/health');
        expect(meta?.statusCode).toBe(200);
        expect(meta?.durationMs).toBeGreaterThanOrEqual(0);
        expect(meta?.requestId).toBe('req-12345');
        done();
      }),
    };

    const middleware = createRequestDurationLogger(mockLogger);

    const req = {
      method: 'GET',
      originalUrl: '/api/v1/health',
      headers: { 'x-request-id': 'req-12345' },
      ip: '127.0.0.1',
    } as unknown as Request;

    const resEmitter = new EventEmitter();
    const res = Object.assign(resEmitter, {
      statusCode: 200,
      getHeader: jest.fn().mockReturnValue('128'),
    }) as unknown as Response;

    const next = jest.fn() as NextFunction;

    middleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);

    // Simulate completion
    setTimeout(() => {
      resEmitter.emit('finish');
    }, 10);
  });

  test('redacts sensitive secrets in query strings before logging', (done) => {
    const secret = 'SCZANGBA5YHTNYVVV4C3U252E2B6P6IRKD45DCAHSKV2U2B6P6IRKD45';
    const mockLogger = {
      info: jest.fn((msg: string, meta?: Record<string, unknown>) => {
        expect(msg).not.toContain(secret);
        expect(meta?.path).not.toContain(secret);
        expect(meta?.path).toContain('S[REDACTED_STELLAR_SECRET_KEY]');
        done();
      }),
    };

    const middleware = createRequestDurationLogger(mockLogger);

    const req = {
      method: 'GET',
      originalUrl: `/api/v1/export?token=${secret}`,
      headers: {},
    } as unknown as Request;

    const resEmitter = new EventEmitter();
    const res = Object.assign(resEmitter, {
      statusCode: 200,
      getHeader: jest.fn(),
    }) as unknown as Response;

    middleware(req, res, jest.fn());
    resEmitter.emit('finish');
  });
});
