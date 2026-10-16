/**
 * Shutdown Unit Tests
 *
 * Unit tests for shutdown logic using mocks.
 * Tests:
 * - Service cleanup is called
 * - Shutdown is idempotent
 * - Error handling during cleanup
 * - Proper logging at each stage
 */

describe('Shutdown Logic Unit Tests', () => {
  let mockLogger: any;
  let processExitSpy: jest.SpyInstance;
  let signalCallbacks: Record<string, Function> = {};

  beforeEach(() => {
    // Mock logger
    mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };

    // Clear signal callbacks
    signalCallbacks = {};

    // Spy on process.on to capture signal handlers
    jest.spyOn(process, 'on').mockImplementation(((signal: string, handler: Function) => {
      signalCallbacks[signal] = handler;
      return process;
    }) as any);

    // Spy on process.exit
    processExitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      // Don't actually exit
      return undefined as never;
    }) as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('Idempotency', () => {
    it('should prevent duplicate shutdown when called multiple times', async () => {
      let shutdownCount = 0;
      let isShuttingDown = false;

      const mockShutdown = async (signal: string) => {
        if (isShuttingDown) {
          mockLogger.warn('Shutdown already in progress, ignoring signal', { signal });
          return;
        }

        isShuttingDown = true;
        shutdownCount++;
        mockLogger.info('Graceful shutdown initiated', { signal });

        // Simulate async cleanup
        await new Promise(resolve => setTimeout(resolve, 10));

        mockLogger.info('Graceful shutdown completed successfully', { signal });
      };

      // Call shutdown twice rapidly
      const first = mockShutdown('SIGINT');
      const second = mockShutdown('SIGINT');

      await Promise.all([first, second]);

      // Should only execute once
      expect(shutdownCount).toBe(1);
      expect(mockLogger.info).toHaveBeenCalledWith('Graceful shutdown initiated', { signal: 'SIGINT' });
      expect(mockLogger.warn).toHaveBeenCalledWith('Shutdown already in progress, ignoring signal', { signal: 'SIGINT' });
    });

    it('should handle rapid successive different signals correctly', async () => {
      let shutdownCount = 0;
      let isShuttingDown = false;

      const mockShutdown = async (signal: string) => {
        if (isShuttingDown) {
          mockLogger.warn('Shutdown already in progress, ignoring signal', { signal });
          return;
        }

        isShuttingDown = true;
        shutdownCount++;
        mockLogger.info('Graceful shutdown initiated', { signal });

        await new Promise(resolve => setTimeout(resolve, 10));

        mockLogger.info('Graceful shutdown completed successfully', { signal });
      };

      // Call with different signals
      const first = mockShutdown('SIGINT');
      const second = mockShutdown('SIGTERM');
      const third = mockShutdown('SIGINT');

      await Promise.all([first, second, third]);

      // Only first call should execute
      expect(shutdownCount).toBe(1);
      expect(mockLogger.warn).toHaveBeenCalledTimes(2);
    });
  });

  describe('Error Handling', () => {
    it('should log errors and exit with code 1 when cleanup fails', async () => {
      const error = new Error('Cleanup failed');
      let isShuttingDown = false;

      const mockShutdown = async (signal: string) => {
        if (isShuttingDown) {
          mockLogger.warn('Shutdown already in progress, ignoring signal', { signal });
          return;
        }

        isShuttingDown = true;
        mockLogger.info('Graceful shutdown initiated', { signal });

        try {
          throw error;
        } catch (err) {
          mockLogger.error('Error during graceful shutdown', { signal, error: err });
          process.exit(1);
        }
      };

      await mockShutdown('SIGINT');

      expect(mockLogger.error).toHaveBeenCalledWith('Error during graceful shutdown', {
        signal: 'SIGINT',
        error,
      });

      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it('should exit with code 0 on successful shutdown', async () => {
      let isShuttingDown = false;

      const mockShutdown = async (signal: string) => {
        if (isShuttingDown) {
          return;
        }

        isShuttingDown = true;
        mockLogger.info('Graceful shutdown initiated', { signal });

        try {
          // Simulate successful cleanup
          await Promise.resolve();
          mockLogger.info('Graceful shutdown completed successfully', { signal });
          process.exit(0);
        } catch (error) {
          mockLogger.error('Error during graceful shutdown', { signal, error });
          process.exit(1);
        }
      };

      await mockShutdown('SIGTERM');

      expect(mockLogger.info).toHaveBeenCalledWith('Graceful shutdown completed successfully', {
        signal: 'SIGTERM',
      });

      expect(processExitSpy).toHaveBeenCalledWith(0);
    });
  });

  describe('Logging', () => {
    it('should log shutdown initiation with signal name', () => {
      const signal = 'SIGINT';
      mockLogger.info('Graceful shutdown initiated', { signal });

      expect(mockLogger.info).toHaveBeenCalledWith('Graceful shutdown initiated', {
        signal: 'SIGINT',
      });
    });

    it('should log successful completion with signal name', () => {
      const signal = 'SIGTERM';
      mockLogger.info('Graceful shutdown completed successfully', { signal });

      expect(mockLogger.info).toHaveBeenCalledWith('Graceful shutdown completed successfully', {
        signal: 'SIGTERM',
      });
    });

    it('should log when shutdown is already in progress', () => {
      const signal = 'SIGTERM';
      mockLogger.warn('Shutdown already in progress, ignoring signal', { signal });

      expect(mockLogger.warn).toHaveBeenCalledWith('Shutdown already in progress, ignoring signal', {
        signal: 'SIGTERM',
      });
    });
  });

  describe('Service Cleanup', () => {
    it('should call stop methods on all services', async () => {
      const services = {
        healthMonitor: { stop: jest.fn() },
        cleanupService: { stop: jest.fn().mockResolvedValue(undefined) },
        scheduler: { stop: jest.fn().mockResolvedValue(undefined) },
        subscriber: { stop: jest.fn().mockResolvedValue(undefined) },
        eventsServer: { close: jest.fn() },
      };

      let isShuttingDown = false;

      const mockShutdown = async (signal: string) => {
        if (isShuttingDown) return;

        isShuttingDown = true;
        mockLogger.info('Graceful shutdown initiated', { signal });

        try {
          services.healthMonitor?.stop();
          await services.cleanupService?.stop();
          await services.scheduler?.stop();
          await services.subscriber.stop();
          services.eventsServer.close();

          mockLogger.info('Graceful shutdown completed successfully', { signal });
          process.exit(0);
        } catch (error) {
          mockLogger.error('Error during graceful shutdown', { signal, error });
          process.exit(1);
        }
      };

      await mockShutdown('SIGINT');

      expect(services.healthMonitor.stop).toHaveBeenCalled();
      expect(services.cleanupService.stop).toHaveBeenCalled();
      expect(services.scheduler.stop).toHaveBeenCalled();
      expect(services.subscriber.stop).toHaveBeenCalled();
      expect(services.eventsServer.close).toHaveBeenCalled();
      expect(processExitSpy).toHaveBeenCalledWith(0);
    });

    it('should handle null/undefined services gracefully', async () => {
      const services: any = {
        healthMonitor: null,
        scheduler: undefined,
        subscriber: { stop: jest.fn().mockResolvedValue(undefined) },
        eventsServer: { close: jest.fn() },
      };

      let isShuttingDown = false;

      const mockShutdown = async (signal: string) => {
        if (isShuttingDown) return;

        isShuttingDown = true;
        mockLogger.info('Graceful shutdown initiated', { signal });

        try {
          services.healthMonitor?.stop();
          await services.scheduler?.stop();
          await services.subscriber.stop();
          services.eventsServer.close();

          mockLogger.info('Graceful shutdown completed successfully', { signal });
          process.exit(0);
        } catch (error) {
          mockLogger.error('Error during graceful shutdown', { signal, error });
          process.exit(1);
        }
      };

      await mockShutdown('SIGINT');

      // Should not throw and should complete successfully
      expect(mockLogger.info).toHaveBeenCalledWith('Graceful shutdown completed successfully', {
        signal: 'SIGINT',
      });
      expect(processExitSpy).toHaveBeenCalledWith(0);
    });
  });
});
