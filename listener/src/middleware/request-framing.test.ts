import { validateRequestFraming } from './request-framing';

function request(method: string, headers: Record<string, string | string[] | undefined>) {
  return {
    method,
    headers: { ...headers },
    destroy: jest.fn(),
  } as any;
}

function response() {
  const res: any = {
    headersSent: false,
    writeHead: jest.fn((status: number) => {
      res.statusCode = status;
    }),
    end: jest.fn(),
  };
  return res;
}

describe('HTTP request framing validation (#1208)', () => {
  it.each([
    ['conflicting framing headers', { 'content-length': '5', 'transfer-encoding': 'chunked' }],
    ['conflicting repeated content lengths', { 'content-length': ['5', '6'] }],
    ['malformed content length', { 'content-length': '5abc' }],
    ['negative content length', { 'content-length': '-1' }],
    ['unsupported transfer coding', { 'transfer-encoding': 'gzip, chunked' }],
    ['multiple transfer encodings', { 'transfer-encoding': ['chunked', 'chunked'] }],
  ])('rejects %s', (_name, headers) => {
    const req = request('POST', headers);
    const res = response();

    const result = validateRequestFraming(req, res);

    expect(result.allowed).toBe(false);
    expect(res.statusCode).toBe(400);
    expect(req.destroy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(res.end.mock.calls[0][0]).reason).toBe(result.reason);
  });

  it('accepts a normal fixed-length request and canonicalizes the header', () => {
    const req = request('POST', { 'content-length': ' 12 ' });
    const res = response();

    expect(validateRequestFraming(req, res)).toEqual({ allowed: true });
    expect(req.headers['content-length']).toBe('12');
    expect(req.destroy).not.toHaveBeenCalled();
  });

  it('accepts identical repeated content-length values', () => {
    const req = request('PUT', { 'content-length': ['7', ' 7 '] });
    expect(validateRequestFraming(req, response())).toEqual({ allowed: true });
    expect(req.headers['content-length']).toBe('7');
  });

  it('accepts a chunked request and removes any declared length', () => {
    const req = request('POST', { 'transfer-encoding': 'Chunked', 'content-length': undefined });
    expect(validateRequestFraming(req, response())).toEqual({ allowed: true });
    expect(req.headers['transfer-encoding']).toBe('chunked');
    expect(req.headers['content-length']).toBeUndefined();
  });

  it('does not apply body framing rules to bodyless methods', () => {
    const req = request('GET', { 'content-length': '3', 'transfer-encoding': 'chunked' });
    expect(validateRequestFraming(req, response())).toEqual({ allowed: true });
    expect(req.destroy).not.toHaveBeenCalled();
  });
});
