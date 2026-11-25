import {
  CURRENT_WEBHOOK_PAYLOAD_VERSION,
  SUPPORTED_WEBHOOK_PAYLOAD_VERSIONS,
  WEBHOOK_PAYLOAD_VERSION_FIELD,
  WEBHOOK_PAYLOAD_VERSION_HEADER,
  WEBHOOK_PAYLOAD_VERSIONS,
  compareWebhookPayloadVersions,
  isSupportedWebhookPayloadVersion,
  parseWebhookPayloadVersion,
  stampWebhookPayloadVersion,
  validateWebhookPayloadForVersion,
} from './webhook-payload-version';

describe('webhook payload versioning', () => {
  describe('parseWebhookPayloadVersion', () => {
    it('parses a MAJOR.MINOR string', () => {
      expect(parseWebhookPayloadVersion('1.0')).toEqual({ major: 1, minor: 0 });
      expect(parseWebhookPayloadVersion('2.7')).toEqual({ major: 2, minor: 7 });
    });

    it('treats a bare integer as MAJOR.0', () => {
      expect(parseWebhookPayloadVersion(1)).toEqual({ major: 1, minor: 0 });
      expect(parseWebhookPayloadVersion('3')).toEqual({ major: 3, minor: 0 });
    });

    it('returns null for unparseable values', () => {
      expect(parseWebhookPayloadVersion('v1')).toBeNull();
      expect(parseWebhookPayloadVersion('1.0.0')).toBeNull();
      expect(parseWebhookPayloadVersion('')).toBeNull();
      expect(parseWebhookPayloadVersion(undefined)).toBeNull();
      expect(parseWebhookPayloadVersion(null)).toBeNull();
      expect(parseWebhookPayloadVersion({})).toBeNull();
    });
  });

  describe('compareWebhookPayloadVersions', () => {
    it('orders versions by major then minor', () => {
      expect(compareWebhookPayloadVersions('1.0', '1.1')).toBe(-1);
      expect(compareWebhookPayloadVersions('1.2', '1.1')).toBe(1);
      expect(compareWebhookPayloadVersions('2.0', '1.9')).toBe(1);
      expect(compareWebhookPayloadVersions('1.0', '1.0')).toBe(0);
    });

    it('throws on invalid input', () => {
      expect(() => compareWebhookPayloadVersions('nope', '1.0')).toThrow(/invalid webhook payload versions/i);
    });
  });

  describe('isSupportedWebhookPayloadVersion', () => {
    it('accepts every registered version', () => {
      for (const version of SUPPORTED_WEBHOOK_PAYLOAD_VERSIONS) {
        expect(isSupportedWebhookPayloadVersion(version)).toBe(true);
      }
    });

    it('rejects unregistered or malformed versions', () => {
      expect(isSupportedWebhookPayloadVersion('9.9')).toBe(false);
      expect(isSupportedWebhookPayloadVersion('v1')).toBe(false);
      expect(isSupportedWebhookPayloadVersion(undefined)).toBe(false);
    });
  });

  describe('stampWebhookPayloadVersion', () => {
    it('stamps the current version by default without mutating the input', () => {
      const input = { eventId: 'evt-1', message: 'hello' };
      const { payload, headers } = stampWebhookPayloadVersion(input);

      expect(payload[WEBHOOK_PAYLOAD_VERSION_FIELD]).toBe(CURRENT_WEBHOOK_PAYLOAD_VERSION);
      expect(payload.eventId).toBe('evt-1');
      expect(headers[WEBHOOK_PAYLOAD_VERSION_HEADER]).toBe(CURRENT_WEBHOOK_PAYLOAD_VERSION);
      // Original object untouched.
      expect(input).toEqual({ eventId: 'evt-1', message: 'hello' });
    });

    it('normalises a bare-integer version to MAJOR.MINOR', () => {
      const { payload, headers } = stampWebhookPayloadVersion({}, '1');
      expect(payload[WEBHOOK_PAYLOAD_VERSION_FIELD]).toBe('1.0');
      expect(headers[WEBHOOK_PAYLOAD_VERSION_HEADER]).toBe('1.0');
    });

    it('throws for an unsupported version', () => {
      expect(() => stampWebhookPayloadVersion({}, '9.9')).toThrow(
        /Unsupported webhook payload version/,
      );
    });
  });

  describe('validateWebhookPayloadForVersion', () => {
    it('accepts a representative v1.0 payload', () => {
      const payload = {
        schemaVersion: '1.0',
        eventId: 'evt-1',
        contractAddress: 'CABC',
        message: 'TaskCreated',
      };

      const result = validateWebhookPayloadForVersion(payload, '1.0');
      expect(result.valid).toBe(true);
      expect(result.missingFields).toEqual([]);
      expect(result.errors).toEqual([]);
    });

    it('reports missing required fields', () => {
      const result = validateWebhookPayloadForVersion({ eventId: 'evt-1' }, '1.0');
      expect(result.valid).toBe(false);
      expect(result.missingFields).toContain(WEBHOOK_PAYLOAD_VERSION_FIELD);
      expect(result.errors.join(' ')).toMatch(/missing required field/i);
    });

    it('flags fields outside the documented contract', () => {
      const payload = { schemaVersion: '1.0', notARealField: true };
      const result = validateWebhookPayloadForVersion(payload, '1.0');
      expect(result.unknownFields).toEqual(['notARealField']);
      // Unknown fields do not invalidate the payload — consumers must ignore them.
      expect(result.valid).toBe(true);
    });

    it('rejects an undocumented version', () => {
      const result = validateWebhookPayloadForVersion({ schemaVersion: '2.0' }, '2.0');
      expect(result.valid).toBe(false);
      expect(result.errors.join(' ')).toMatch(/No documented contract/);
    });

    it('documents schemaVersion as a required field for every version', () => {
      for (const spec of Object.values(WEBHOOK_PAYLOAD_VERSIONS)) {
        expect(spec.requiredFields).toContain(WEBHOOK_PAYLOAD_VERSION_FIELD);
      }
    });
  });
});
