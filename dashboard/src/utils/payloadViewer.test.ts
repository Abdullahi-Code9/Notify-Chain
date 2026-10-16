import { formatPayloadPreview, formatRawPayload, sanitizePayload } from './payloadViewer';

describe('formatRawPayload with unknown payload shapes (issue #612)', () => {
  it('pretty-prints object payloads the dashboard has never seen', () => {
    const result = formatRawPayload({ weird_field: 42, nested: { ok: true } });

    expect(result.isValidJson).toBe(true);
    expect(result.formatted).toContain('"weird_field": 42');
    expect(() => JSON.parse(result.formatted)).not.toThrow();
  });

  it('pretty-prints JSON encoded as a string', () => {
    const result = formatRawPayload('{"weird_field":42}');

    expect(result.isValidJson).toBe(true);
    expect(JSON.parse(result.formatted)).toEqual({ weird_field: 42 });
  });

  it('returns plain text for non-JSON payloads without throwing', () => {
    const result = formatRawPayload('not-json-at-all');

    expect(result.isValidJson).toBe(false);
    expect(result.formatted).toBe('not-json-at-all');
  });

  it('does not throw on circular payloads and stays stringifiable', () => {
    const circular: Record<string, unknown> = { name: 'loop' };
    circular.self = circular;

    let result: ReturnType<typeof formatRawPayload> | undefined;
    expect(() => {
      result = formatRawPayload(circular);
    }).not.toThrow();

    expect(result!.formatted).toContain('loop');
    expect(result!.formatted).toContain('[Circular]');
  });

  it('does not throw on values JSON cannot serialise', () => {
    expect(() => formatRawPayload({ big: BigInt(1) })).not.toThrow();
  });

  it('handles null and undefined payloads', () => {
    expect(formatRawPayload(null).formatted).toBe('null');
    expect(formatRawPayload(undefined).formatted).toBe('null');
  });
});

describe('sanitizePayload circular guard', () => {
  it('replaces circular references instead of recursing forever', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    const sanitized = sanitizePayload(circular) as Record<string, unknown>;

    expect(sanitized.self).toBe('[Circular]');
  });

  it('keeps repeated non-circular references in sibling fields', () => {
    const shared = { id: 1 };

    const sanitized = sanitizePayload({ a: shared, b: shared }) as Record<string, unknown>;

    expect(sanitized.a).toEqual({ id: 1 });
    expect(sanitized.b).toEqual({ id: 1 });
  });
});

describe('formatPayloadPreview (issue #612)', () => {
  it('renders object payloads as a single inspectable line', () => {
    const { preview, full, truncated } = formatPayloadPreview({ weird_field: 42 });

    expect(preview).toBe('{ "weird_field": 42 }');
    expect(preview).not.toContain('\n');
    expect(full).toContain('"weird_field": 42');
    expect(truncated).toBe(false);
  });

  it('truncates long payloads for the inline preview but keeps the full payload', () => {
    const longValue = 'x'.repeat(500);
    const { preview, full, truncated } = formatPayloadPreview(longValue, 20);

    expect(truncated).toBe(true);
    expect(preview.length).toBe(20);
    expect(preview.endsWith('…')).toBe(true);
    expect(full).toBe(longValue);
  });

  it('never throws and always returns a string for arbitrary values', () => {
    const values: unknown[] = [
      undefined,
      null,
      0,
      '',
      [],
      {},
      ['a', { b: 1 }],
      'plain text',
    ];

    for (const value of values) {
      let result: ReturnType<typeof formatPayloadPreview> | undefined;
      expect(() => {
        result = formatPayloadPreview(value);
      }).not.toThrow();
      expect(typeof result!.preview).toBe('string');
      expect(result!.preview.length).toBeGreaterThan(0);
    }
  });
});
