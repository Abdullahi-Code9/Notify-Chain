import { IncomingMessage, ServerResponse } from 'http';
import {
  generateRequestId,
  resolveCorrelationId,
  resolveRequestId,
  isValidRequestId,
  applyRequestContext,
} from './request-id';
import { applyRequestIdMiddleware } from '../middleware/request-id';

function makeReq(headers: Record<string, string | string[] | undefined> = {}): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

function makeRes(): ServerResponse {
  const headers: Record<string, string> = {};
  return {
    setHeader: (name: string, value: string) => {
      headers[name] = value;
    },
    getHeader: (name: string) => headers[name],
  } as unknown as ServerResponse;
}

describe('generateRequestId', () => {
  it('generates a short, unique id for each call', () => {
    const a = generateRequestId();
    const b = generateRequestId();
    expect(a).not.toEqual(b);
    expect(a.length).toBeGreaterThan(0);
  });
});

describe('isValidRequestId (#686)', () => {
  it('accepts printable token ids of reasonable length', () => {
    expect(isValidRequestId('a1b2c3d4')).toBe(true);
    expect(isValidRequestId('req-abc.def_01')).toBe(true);
    expect(isValidRequestId('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
  });

  it('rejects blank, short, oversized, or unsafe values', () => {
    expect(isValidRequestId('')).toBe(false);
    expect(isValidRequestId('short')).toBe(false);
    expect(isValidRequestId('has space!!')).toBe(false);
    expect(isValidRequestId('bad/id')).toBe(false);
    expect(isValidRequestId('x'.repeat(129))).toBe(false);
  });
});

describe('resolveRequestId (#686)', () => {
  it('reuses a validated client-supplied id', () => {
    expect(resolveRequestId('client-req-001')).toBe('client-req-001');
  });

  it('mints a new id when the client value is invalid', () => {
    const id = resolveRequestId('no');
    expect(isValidRequestId(id)).toBe(true);
    expect(id).not.toBe('no');
  });

  it('mints a new id when no header is present', () => {
    expect(isValidRequestId(resolveRequestId(undefined))).toBe(true);
  });
});

describe('resolveCorrelationId', () => {
  it('reuses an incoming header value', () => {
    expect(resolveCorrelationId('abc-123')).toBe('abc-123');
  });

  it('trims whitespace from an incoming header value', () => {
    expect(resolveCorrelationId('  abc-123  ')).toBe('abc-123');
  });

  it('uses the first value when the header is an array', () => {
    expect(resolveCorrelationId(['first', 'second'])).toBe('first');
  });

  it('generates a new id when no header is present', () => {
    const id = resolveCorrelationId(undefined);
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('generates a new id when the header is blank', () => {
    const id = resolveCorrelationId('   ');
    expect(id.trim().length).toBeGreaterThan(0);
  });

  it('rejects correlation ids containing control characters', () => {
    const id = resolveCorrelationId('bad\nid');
    expect(id).not.toBe('bad\nid');
  });
});

describe('applyRequestContext', () => {
  it('assigns a requestId to every request', () => {
    const res = makeRes();
    const { requestId: first } = applyRequestContext(makeReq(), res);
    const { requestId: second } = applyRequestContext(makeReq(), makeRes());
    expect(first).not.toEqual(second);
  });

  it('reuses a validated client X-Request-Id', () => {
    const res = makeRes();
    const { requestId, requestIdReused } = applyRequestContext(
      makeReq({ 'x-request-id': 'client-trace-42' }),
      res,
    );
    expect(requestId).toBe('client-trace-42');
    expect(requestIdReused).toBe(true);
    expect(res.getHeader('X-Request-Id')).toBe('client-trace-42');
  });

  it('ignores an invalid client X-Request-Id and mints a fresh one', () => {
    const res = makeRes();
    const { requestId, requestIdReused } = applyRequestContext(
      makeReq({ 'x-request-id': 'bad id!' }),
      res,
    );
    expect(requestIdReused).toBe(false);
    expect(requestId).not.toBe('bad id!');
    expect(res.getHeader('X-Request-Id')).toBe(requestId);
  });

  it('honours an incoming X-Correlation-Id header', () => {
    const res = makeRes();
    const { correlationId } = applyRequestContext(
      makeReq({ 'x-correlation-id': 'caller-supplied-id' }),
      res,
    );
    expect(correlationId).toBe('caller-supplied-id');
  });

  it('generates a correlationId when none is supplied', () => {
    const res = makeRes();
    const { correlationId } = applyRequestContext(makeReq(), res);
    expect(correlationId.length).toBeGreaterThan(0);
  });

  it('echoes requestId and correlationId back as response headers', () => {
    const res = makeRes();
    const { requestId, correlationId } = applyRequestContext(makeReq(), res);
    expect(res.getHeader('X-Request-Id')).toBe(requestId);
    expect(res.getHeader('X-Correlation-Id')).toBe(correlationId);
  });
});

describe('applyRequestIdMiddleware (#686)', () => {
  it('delegates to applyRequestContext', () => {
    const res = makeRes();
    const ctx = applyRequestIdMiddleware(makeReq({ 'x-request-id': 'mw-request-01' }), res);
    expect(ctx.requestId).toBe('mw-request-01');
    expect(res.getHeader('X-Request-Id')).toBe('mw-request-01');
  });
});
