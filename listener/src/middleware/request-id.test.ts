import { IncomingMessage, ServerResponse } from 'http';
import { applyRequestIdMiddleware } from './request-id';

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

describe('request-id middleware (#686)', () => {
  it('assigns a request id and exposes it on the response', () => {
    const res = makeRes();
    const { requestId, correlationId } = applyRequestIdMiddleware(makeReq(), res);
    expect(requestId).toBeTruthy();
    expect(correlationId).toBeTruthy();
    expect(res.getHeader('X-Request-Id')).toBe(requestId);
    expect(res.getHeader('X-Correlation-Id')).toBe(correlationId);
  });

  it('reuses only validated client-supplied request ids', () => {
    const valid = applyRequestIdMiddleware(
      makeReq({ 'x-request-id': 'valid-client-id' }),
      makeRes(),
    );
    expect(valid.requestId).toBe('valid-client-id');
    expect(valid.requestIdReused).toBe(true);

    const invalid = applyRequestIdMiddleware(
      makeReq({ 'x-request-id': '!!' }),
      makeRes(),
    );
    expect(invalid.requestId).not.toBe('!!');
    expect(invalid.requestIdReused).toBe(false);
  });
});
