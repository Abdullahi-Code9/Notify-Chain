import {
  IdempotencyKeyService,
  IdempotencyKeyReuseError,
  IDEMPOTENCY_HEADER,
  IDEMPOTENCY_HEADER_CAPITALIZED,
} from './idempotency-key-service';
import { IdempotencyKeyRepository } from './idempotency-key-repository';
import logger from '../utils/logger';

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

describe('IdempotencyKeyService', () => {
  let service: IdempotencyKeyService;
  let mockRepository: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRepository = {
      getCachedResponse: jest.fn(),
      validateRequestHash: jest.fn(),
      storeResponse: jest.fn(),
      cleanupExpiredKeys: jest.fn(),
      getStats: jest.fn(),
    };
    service = new IdempotencyKeyService(mockRepository as IdempotencyKeyRepository);
  });

  describe('extractKey header helper', () => {
    it('reads the lower-case idempotency-key header', () => {
      expect(
        IdempotencyKeyService.extractKey({ [IDEMPOTENCY_HEADER]: 'abc-123' })
      ).toBe('abc-123');
    });

    it('reads the capitalized Idempotency-Key header', () => {
      expect(
        IdempotencyKeyService.extractKey({ [IDEMPOTENCY_HEADER_CAPITALIZED]: 'abc-123' })
      ).toBe('abc-123');
    });

    it('returns null when neither header is present', () => {
      expect(IdempotencyKeyService.extractKey({})).toBeNull();
    });

    it('takes the first element when the header value is an array', () => {
      expect(
        IdempotencyKeyService.extractKey({ 'idempotency-key': ['first', 'second'] })
      ).toBe('first');
    });
  });

  describe('processWithIdempotency', () => {
    it('executes processor and caches response on first call', async () => {
      const idempotencyKey = 'test-key-123';
      const requestBody = { payload: 'test' };
      const processorResult = 42;

      mockRepository.getCachedResponse.mockResolvedValue(null);
      mockRepository.validateRequestHash.mockResolvedValue(true);
      mockRepository.storeResponse.mockResolvedValue(1);

      const processor = jest.fn().mockResolvedValue(processorResult);

      const result = await service.processWithIdempotency(
        idempotencyKey,
        requestBody,
        processor
      );

      expect(result.result).toBe(processorResult);
      expect(result.isDuplicate).toBe(false);
      expect(processor).toHaveBeenCalledTimes(1);
      expect(mockRepository.storeResponse).toHaveBeenCalled();
    });

    it('REPLAY TEST — returns cached result when the EXACT SAME request is replayed', async () => {
      // Simulate: client sends a signed request, network retries it.
      // The processor MUST NOT be called a second time and the original
      // response MUST be returned to avoid double-processing.
      const idempotencyKey = 'req-uuid-0001';
      const requestBody = { to: 'user-a', amount: 100, nonce: 7 };

      const firstCached = {
        notificationId: 99,
        isDuplicate: true,
        response: { id: 99, status: 'created' },
      };

      mockRepository.getCachedResponse.mockResolvedValue(firstCached);
      mockRepository.validateRequestHash.mockResolvedValue(true);

      const processor = jest.fn();
      const result = await service.processWithIdempotency(
        idempotencyKey,
        requestBody,
        processor
      );

      expect(result.isDuplicate).toBe(true);
      expect(result.result).toEqual(firstCached.response);
      expect(result.notificationId).toBe(99);
      expect(processor).not.toHaveBeenCalled(); // Critical: no double execution
    });

    it('REPLAY TEST — second attempt with same key+body never invokes side effect', async () => {
      // Same intent as above but more directly: the underlying storage
      // returns a cached response, so business logic is skipped entirely.
      const idempotencyKey = 'dedup-me';
      const body = { action: 'send', recipient: '0x1' };
      const sideEffect = jest.fn().mockResolvedValue({ id: 1 });

      // First call
      mockRepository.getCachedResponse.mockResolvedValueOnce(null);
      mockRepository.validateRequestHash.mockResolvedValue(true);
      mockRepository.storeResponse.mockResolvedValue(1);

      const first = await service.processWithIdempotency(idempotencyKey, body, sideEffect);
      expect(first.isDuplicate).toBe(false);
      expect(sideEffect).toHaveBeenCalledTimes(1);

      // Second call with identical inputs: processor is NOT run
      sideEffect.mockClear();
      mockRepository.getCachedResponse.mockResolvedValueOnce({
        notificationId: 1,
        isDuplicate: true,
        response: { id: 1 },
      });
      const second = await service.processWithIdempotency(idempotencyKey, body, sideEffect);
      expect(second.isDuplicate).toBe(true);
      expect(sideEffect).not.toHaveBeenCalled();
    });

    it('REPLAY ATTACK (body tamper) — throws 409 IdempotencyKeyReuseError when same key used with DIFFERENT body', async () => {
      // An attacker captures a request with idempotency-key=X, modifies the
      // body to a different payload, and re-submits with the same key.
      // This MUST be rejected with IdempotencyKeyReuseError (HTTP 409).
      const idempotencyKey = 'captured-key';
      const originalBody = { amount: 10, payee: 'alice' };
      const tamperedBody = { amount: 1_000_000, payee: 'attacker' };

      // First (original) call cached a successful result keyed by original hash
      mockRepository.getCachedResponse.mockResolvedValue({
        notificationId: 1,
        isDuplicate: true,
        response: { id: 1, status: 'ok' },
      });
      // Validate request hash fails: attacker sent DIFFERENT body under same key
      mockRepository.validateRequestHash.mockResolvedValue(false);

      const processor = jest.fn();

      const promise = service.processWithIdempotency(idempotencyKey, tamperedBody, processor);
      const err = (await promise.catch((e) => e)) as IdempotencyKeyReuseError;

      expect(err).toBeInstanceOf(IdempotencyKeyReuseError);
      expect(err.statusCode).toBe(409);
      expect(err.code).toBe('IDEMPOTENCY_KEY_MISMATCH');
      expect(processor).not.toHaveBeenCalled();
      expect((logger as any).warn).toHaveBeenCalled();
    });

    it('IdempotencyKeyReuseError also fires on expired-stored records with a different body', async () => {
      // Key exists in the store but cached response was expired; the repository
      // still returns the stored hash for validation — body mismatch is still
      // a hard 409 because the client violated the idempotency contract.
      mockRepository.getCachedResponse.mockResolvedValue(null);
      mockRepository.validateRequestHash.mockResolvedValue(false);

      const err = (await service
        .processWithIdempotency('k', { b: 1 }, jest.fn())
        .catch((e) => e)) as IdempotencyKeyReuseError;

      expect(err).toBeInstanceOf(IdempotencyKeyReuseError);
      expect(err.statusCode).toBe(409);
    });

    it('executes processor normally if no idempotency key provided', async () => {
      const requestBody = { payload: 'test' };
      const processorResult = 42;

      const processor = jest.fn().mockResolvedValue(processorResult);

      const result = await service.processWithIdempotency(
        undefined,
        requestBody,
        processor
      );

      expect(result.result).toBe(processorResult);
      expect(result.isDuplicate).toBe(false);
      expect(processor).toHaveBeenCalledTimes(1);
    });
  });

  describe('cleanupExpiredKeys', () => {
    it('calls repository cleanup method', async () => {
      mockRepository.cleanupExpiredKeys.mockResolvedValue(5);

      const count = await service.cleanupExpiredKeys();

      expect(count).toBe(5);
      expect(mockRepository.cleanupExpiredKeys).toHaveBeenCalledTimes(1);
    });
  });

  describe('getStatistics', () => {
    it('returns statistics from repository', async () => {
      const stats = {
        total: 100,
        processed: 95,
        expired: 5,
        oldestKey: 'old-key',
      };

      mockRepository.getStats.mockResolvedValue(stats);

      const result = await service.getStatistics();

      expect(result).toEqual(stats);
    });
  });
});
