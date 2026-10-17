/**
 * Stress Test Suite for NotifyChain Notification Processing
 * 
 * These tests evaluate the system's behavior under sustained, high-volume notification traffic.
 * They measure throughput, latency, resource utilization, and system stability.
 * 
 * Test Categories:
 * 1. High-Volume Concurrent Processing
 * 2. Sustained Load Over Time
 * 3. Burst Traffic Handling
 * 4. Resource Utilization Monitoring
 * 5. System Stability Under Load
 */

import { EventProcessingQueue, EventProcessor, Priority } from '../services/event-processing-queue';
import { DiscordNotificationService } from '../services/discord-notification';
import { NotificationDeduplicator } from '../services/notification-deduplicator';
import { NotificationFixtureBuilder } from '../test-utils/notification-fixture-builder';
import * as StellarSDK from '@stellar/stellar-sdk';
import logger from '../utils/logger';

// Mock logger to prevent console spam during stress tests
jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// Mock webhook sender to avoid actual network calls
jest.mock('../services/webhook-sender', () => ({
  sendWebhook: jest.fn().mockResolvedValue({ ok: true }),
}));

describe('Stress Test Suite: Notification Processing', () => {
  // Helper function to generate metrics report
  const generateMetricsReport = (
    testName: string,
    eventCount: number,
    startTime: number,
    endTime: number,
    successCount: number,
    failureCount: number,
    latencies: number[],
    memoryUsage?: { before: NodeJS.MemoryUsage; after: NodeJS.MemoryUsage }
  ) => {
    const totalTimeMs = endTime - startTime;
    const throughput = (eventCount / totalTimeMs) * 1000;
    const avgLatency = latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;
    const p50 = calculatePercentile(latencies, 50);
    const p95 = calculatePercentile(latencies, 95);
    const p99 = calculatePercentile(latencies, 99);
    const minLatency = latencies.length > 0 ? Math.min(...latencies) : 0;
    const maxLatency = latencies.length > 0 ? Math.max(...latencies) : 0;

    const report = {
      testName,
      eventCount,
      successCount,
      failureCount,
      totalTimeMs,
      throughput: parseFloat(throughput.toFixed(2)),
      latency: {
        min: parseFloat(minLatency.toFixed(2)),
        max: parseFloat(maxLatency.toFixed(2)),
        avg: parseFloat(avgLatency.toFixed(2)),
        p50: parseFloat(p50.toFixed(2)),
        p95: parseFloat(p95.toFixed(2)),
        p99: parseFloat(p99.toFixed(2)),
      },
      memoryUsage: memoryUsage
        ? {
            before: {
              heapUsed: formatBytes(memoryUsage.before.heapUsed),
              heapTotal: formatBytes(memoryUsage.before.heapTotal),
              rss: formatBytes(memoryUsage.before.rss),
            },
            after: {
              heapUsed: formatBytes(memoryUsage.after.heapUsed),
              heapTotal: formatBytes(memoryUsage.after.heapTotal),
              rss: formatBytes(memoryUsage.after.rss),
            },
            delta: {
              heapUsed: formatBytes(memoryUsage.after.heapUsed - memoryUsage.before.heapUsed),
              heapTotal: formatBytes(memoryUsage.after.heapTotal - memoryUsage.before.heapTotal),
              rss: formatBytes(memoryUsage.after.rss - memoryUsage.before.rss),
            },
          }
        : undefined,
    };

    // Log to console for visibility
    console.log('\n' + '='.repeat(80));
    console.log(`STRESS TEST REPORT: ${testName}`);
    console.log('='.repeat(80));
    console.log(`Events Processed:     ${eventCount}`);
    console.log(`Success Count:        ${successCount}`);
    console.log(`Failure Count:        ${failureCount}`);
    console.log(`Total Time:           ${totalTimeMs}ms`);
    console.log(`Throughput:           ${throughput.toFixed(2)} events/second`);
    console.log(`\nLatency Statistics:`);
    console.log(`  Min:                ${minLatency.toFixed(2)}ms`);
    console.log(`  Max:                ${maxLatency.toFixed(2)}ms`);
    console.log(`  Avg:                ${avgLatency.toFixed(2)}ms`);
    console.log(`  P50 (Median):       ${p50.toFixed(2)}ms`);
    console.log(`  P95:                ${p95.toFixed(2)}ms`);
    console.log(`  P99:                ${p99.toFixed(2)}ms`);

    if (memoryUsage) {
      console.log(`\nMemory Usage:`);
      console.log(`  Before - Heap:      ${report.memoryUsage!.before.heapUsed}`);
      console.log(`  After - Heap:       ${report.memoryUsage!.after.heapUsed}`);
      console.log(`  Delta - Heap:       ${report.memoryUsage!.delta.heapUsed}`);
      console.log(`  Before - RSS:       ${report.memoryUsage!.before.rss}`);
      console.log(`  After - RSS:        ${report.memoryUsage!.after.rss}`);
      console.log(`  Delta - RSS:        ${report.memoryUsage!.delta.rss}`);
    }
    console.log('='.repeat(80) + '\n');

    return report;
  };

  const calculatePercentile = (values: number[], percentile: number): number => {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.ceil((percentile / 100) * sorted.length) - 1;
    return sorted[index];
  };

  const formatBytes = (bytes: number): string => {
    const mb = bytes / (1024 * 1024);
    return `${mb.toFixed(2)} MB`;
  };

  describe('1. High-Volume Concurrent Processing', () => {
    it('should handle 1,000 concurrent events with high throughput', async () => {
      const eventCount = 1000;
      const processedIds: string[] = [];
      const latencies: number[] = [];

      const processor: EventProcessor = jest.fn().mockImplementation(async (event) => {
        const start = Date.now();
        // Simulate minimal processing time
        await new Promise((resolve) => setTimeout(resolve, Math.random() * 2));
        processedIds.push(event.id);
        latencies.push(Date.now() - start);
        return true;
      });

      const queue = new EventProcessingQueue(processor, {
        baseDelayMs: 0,
        pollIntervalMs: 5,
        maxConcurrency: 50,
        maxRetries: 3,
      });

      const contractConfig = NotificationFixtureBuilder.aContractConfig().build();
      const memoryBefore = process.memoryUsage();
      const startTime = Date.now();

      // Enqueue all events
      for (let i = 0; i < eventCount; i++) {
        const event = NotificationFixtureBuilder.aStellarEvent()
          .withId(`stress-1k-${i}`)
          .build();
        queue.enqueue(event, contractConfig, `req-${i}`, Priority.Medium);
      }

      queue.start();

      // Wait for completion
      while (processedIds.length < eventCount) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      const endTime = Date.now();
      const memoryAfter = process.memoryUsage();
      queue.stop();

      const report = generateMetricsReport(
        '1,000 Concurrent Events',
        eventCount,
        startTime,
        endTime,
        processedIds.length,
        eventCount - processedIds.length,
        latencies,
        { before: memoryBefore, after: memoryAfter }
      );

      expect(processedIds.length).toBe(eventCount);
      expect(report.throughput).toBeGreaterThan(50); // At least 50 events/sec
      expect(report.latency.p95).toBeLessThan(100); // P95 latency under 100ms
    }, 60000);

    it('should handle 5,000 events with sustained throughput', async () => {
      const eventCount = 5000;
      const processedIds: string[] = [];
      const latencies: number[] = [];

      const processor: EventProcessor = jest.fn().mockImplementation(async (event) => {
        const start = Date.now();
        await new Promise((resolve) => setTimeout(resolve, Math.random() * 1));
        processedIds.push(event.id);
        latencies.push(Date.now() - start);
        return true;
      });

      const queue = new EventProcessingQueue(processor, {
        baseDelayMs: 0,
        pollIntervalMs: 5,
        maxConcurrency: 100,
        maxRetries: 3,
      });

      const contractConfig = NotificationFixtureBuilder.aContractConfig().build();
      const memoryBefore = process.memoryUsage();
      const startTime = Date.now();

      // Enqueue events in batches to simulate realistic load
      for (let i = 0; i < eventCount; i++) {
        const event = NotificationFixtureBuilder.aStellarEvent()
          .withId(`stress-5k-${i}`)
          .build();
        queue.enqueue(event, contractConfig, `req-${i}`, Priority.Medium);
      }

      queue.start();

      while (processedIds.length < eventCount) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      const endTime = Date.now();
      const memoryAfter = process.memoryUsage();
      queue.stop();

      const report = generateMetricsReport(
        '5,000 Events Sustained Load',
        eventCount,
        startTime,
        endTime,
        processedIds.length,
        eventCount - processedIds.length,
        latencies,
        { before: memoryBefore, after: memoryAfter }
      );

      expect(processedIds.length).toBe(eventCount);
      expect(report.throughput).toBeGreaterThan(100);
      expect(report.latency.p99).toBeLessThan(200);
    }, 120000);
  });

  describe('2. Sustained Load Over Time', () => {
    it('should maintain stability processing 10,000 events', async () => {
      const eventCount = 10000;
      const processedIds: string[] = [];
      const latencies: number[] = [];
      let failureCount = 0;

      const processor: EventProcessor = jest.fn().mockImplementation(async (event) => {
        const start = Date.now();
        await new Promise((resolve) => setTimeout(resolve, Math.random() * 1));
        processedIds.push(event.id);
        latencies.push(Date.now() - start);
        return true;
      });

      const queue = new EventProcessingQueue(processor, {
        baseDelayMs: 0,
        pollIntervalMs: 5,
        maxConcurrency: 100,
        maxRetries: 3,
      });

      const contractConfig = NotificationFixtureBuilder.aContractConfig().build();
      const memoryBefore = process.memoryUsage();
      const startTime = Date.now();

      for (let i = 0; i < eventCount; i++) {
        const event = NotificationFixtureBuilder.aStellarEvent()
          .withId(`stress-10k-${i}`)
          .build();
        queue.enqueue(event, contractConfig, `req-${i}`, Priority.Medium);
      }

      queue.start();

      // Monitor progress
      const progressInterval = setInterval(() => {
        const progress = ((processedIds.length / eventCount) * 100).toFixed(2);
        console.log(`Progress: ${processedIds.length}/${eventCount} (${progress}%)`);
      }, 5000);

      while (processedIds.length < eventCount) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      clearInterval(progressInterval);
      const endTime = Date.now();
      const memoryAfter = process.memoryUsage();
      queue.stop();

      const report = generateMetricsReport(
        '10,000 Events - System Stability',
        eventCount,
        startTime,
        endTime,
        processedIds.length,
        failureCount,
        latencies,
        { before: memoryBefore, after: memoryAfter }
      );

      expect(processedIds.length).toBe(eventCount);
      expect(report.throughput).toBeGreaterThan(100);
      expect(report.latency.avg).toBeLessThan(50);
      
      // Check memory doesn't grow excessively (less than 200MB increase)
      const memoryIncreaseMB = (memoryAfter.heapUsed - memoryBefore.heapUsed) / (1024 * 1024);
      expect(memoryIncreaseMB).toBeLessThan(200);
    }, 240000);
  });

  describe('3. Burst Traffic Handling', () => {
    it('should handle burst of 2,000 events followed by idle period', async () => {
      const burstSize = 2000;
      const processedIds: string[] = [];
      const latencies: number[] = [];

      const processor: EventProcessor = jest.fn().mockImplementation(async (event) => {
        const start = Date.now();
        await new Promise((resolve) => setTimeout(resolve, Math.random() * 2));
        processedIds.push(event.id);
        latencies.push(Date.now() - start);
        return true;
      });

      const queue = new EventProcessingQueue(processor, {
        baseDelayMs: 0,
        pollIntervalMs: 5,
        maxConcurrency: 75,
        maxRetries: 3,
      });

      const contractConfig = NotificationFixtureBuilder.aContractConfig().build();
      const memoryBefore = process.memoryUsage();

      queue.start();

      // First burst
      console.log('Sending first burst of 2000 events...');
      const startTime = Date.now();

      for (let i = 0; i < burstSize; i++) {
        const event = NotificationFixtureBuilder.aStellarEvent()
          .withId(`burst-1-${i}`)
          .build();
        queue.enqueue(event, contractConfig, `req-burst-1-${i}`, Priority.High);
      }

      while (processedIds.length < burstSize) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      const burstEndTime = Date.now();

      // Idle period
      console.log('Waiting idle period (2 seconds)...');
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Second burst
      console.log('Sending second burst of 2000 events...');
      const secondBurstStart = Date.now();

      for (let i = 0; i < burstSize; i++) {
        const event = NotificationFixtureBuilder.aStellarEvent()
          .withId(`burst-2-${i}`)
          .build();
        queue.enqueue(event, contractConfig, `req-burst-2-${i}`, Priority.High);
      }

      while (processedIds.length < burstSize * 2) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      const endTime = Date.now();
      const memoryAfter = process.memoryUsage();
      queue.stop();

      const report = generateMetricsReport(
        'Burst Traffic (2x2000 events)',
        burstSize * 2,
        startTime,
        endTime,
        processedIds.length,
        0,
        latencies,
        { before: memoryBefore, after: memoryAfter }
      );

      console.log(`First burst time: ${burstEndTime - startTime}ms`);
      console.log(`Second burst time: ${endTime - secondBurstStart}ms`);

      expect(processedIds.length).toBe(burstSize * 2);
      expect(report.throughput).toBeGreaterThan(75);
    }, 120000);
  });

  describe('4. Priority Queue Under Load', () => {
    it('should prioritize high-priority events under heavy load', async () => {
      const highPriorityCount = 500;
      const mediumPriorityCount = 1000;
      const lowPriorityCount = 500;
      const totalCount = highPriorityCount + mediumPriorityCount + lowPriorityCount;

      const processedEvents: Array<{ id: string; priority: Priority; processedAt: number }> = [];
      const latencies: number[] = [];

      const processor: EventProcessor = jest.fn().mockImplementation(async (event) => {
        const start = Date.now();
        await new Promise((resolve) => setTimeout(resolve, Math.random() * 5));
        const priority = event.id.includes('high') ? Priority.High : 
                        event.id.includes('medium') ? Priority.Medium : Priority.Low;
        processedEvents.push({ id: event.id, priority, processedAt: Date.now() });
        latencies.push(Date.now() - start);
        return true;
      });

      const queue = new EventProcessingQueue(processor, {
        baseDelayMs: 0,
        pollIntervalMs: 5,
        maxConcurrency: 50,
        maxRetries: 3,
      });

      const contractConfig = NotificationFixtureBuilder.aContractConfig().build();
      const memoryBefore = process.memoryUsage();
      const startTime = Date.now();

      queue.start();

      // Enqueue mixed priorities
      for (let i = 0; i < lowPriorityCount; i++) {
        const event = NotificationFixtureBuilder.aStellarEvent()
          .withId(`priority-low-${i}`)
          .build();
        queue.enqueue(event, contractConfig, `req-low-${i}`, Priority.Low);
      }

      for (let i = 0; i < mediumPriorityCount; i++) {
        const event = NotificationFixtureBuilder.aStellarEvent()
          .withId(`priority-medium-${i}`)
          .build();
        queue.enqueue(event, contractConfig, `req-medium-${i}`, Priority.Medium);
      }

      for (let i = 0; i < highPriorityCount; i++) {
        const event = NotificationFixtureBuilder.aStellarEvent()
          .withId(`priority-high-${i}`)
          .build();
        queue.enqueue(event, contractConfig, `req-high-${i}`, Priority.High);
      }

      while (processedEvents.length < totalCount) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      const endTime = Date.now();
      const memoryAfter = process.memoryUsage();
      queue.stop();

      // Analyze priority processing
      const firstBatch = processedEvents.slice(0, 500);
      const highPriorityInFirstBatch = firstBatch.filter((e) => e.priority === Priority.High).length;

      const report = generateMetricsReport(
        'Priority Queue Under Load',
        totalCount,
        startTime,
        endTime,
        processedEvents.length,
        0,
        latencies,
        { before: memoryBefore, after: memoryAfter }
      );

      console.log(`\nPriority Analysis:`);
      console.log(`  High-priority in first 500: ${highPriorityInFirstBatch} / 500 (${((highPriorityInFirstBatch / 500) * 100).toFixed(2)}%)`);

      expect(processedEvents.length).toBe(totalCount);
      // High-priority events should dominate the first batch
      expect(highPriorityInFirstBatch).toBeGreaterThan(250);
    }, 180000);
  });

  describe('5. Deduplication Under Heavy Load', () => {
    it('should efficiently deduplicate 3,000 events with 50% duplicates', async () => {
      const uniqueEventCount = 1500;
      const totalEventCount = 3000; // 50% duplicates

      const processedIds: string[] = [];
      const latencies: number[] = [];

      const processor: EventProcessor = jest.fn().mockImplementation(async (event) => {
        const start = Date.now();
        await new Promise((resolve) => setTimeout(resolve, Math.random() * 1));
        processedIds.push(event.id);
        latencies.push(Date.now() - start);
        return true;
      });

      const queue = new EventProcessingQueue(processor, {
        baseDelayMs: 0,
        pollIntervalMs: 5,
        maxConcurrency: 75,
        maxRetries: 3,
      });

      const contractConfig = NotificationFixtureBuilder.aContractConfig().build();
      const memoryBefore = process.memoryUsage();
      const startTime = Date.now();

      queue.start();

      // Enqueue events with duplicates
      for (let i = 0; i < totalEventCount; i++) {
        // Create duplicate by reusing IDs
        const eventId = `dedup-${i % uniqueEventCount}`;
        const event = NotificationFixtureBuilder.aStellarEvent()
          .withId(eventId)
          .build();
        queue.enqueue(event, contractConfig, `req-${i}`, Priority.Medium);
      }

      // Wait for unique events to process
      while (processedIds.length < uniqueEventCount) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      // Small delay to ensure no extras are processed
      await new Promise((resolve) => setTimeout(resolve, 1000));

      const endTime = Date.now();
      const memoryAfter = process.memoryUsage();
      queue.stop();

      const report = generateMetricsReport(
        'Deduplication Test (3000 events, 1500 unique)',
        totalEventCount,
        startTime,
        endTime,
        processedIds.length,
        0,
        latencies,
        { before: memoryBefore, after: memoryAfter }
      );

      console.log(`\nDeduplication Efficiency:`);
      console.log(`  Total Enqueued:     ${totalEventCount}`);
      console.log(`  Unique Events:      ${uniqueEventCount}`);
      console.log(`  Actually Processed: ${processedIds.length}`);
      console.log(`  Duplicates Blocked: ${totalEventCount - processedIds.length}`);

      expect(processedIds.length).toBe(uniqueEventCount);
      expect(processor).toHaveBeenCalledTimes(uniqueEventCount);
    }, 120000);
  });

  describe('6. Discord Notification Service Under Load', () => {
    it('should handle 500 Discord notifications with deduplication', async () => {
      const eventCount = 500;
      const successCount = { value: 0 };
      const latencies: number[] = [];

      const discordConfig = {
        webhookUrl: 'https://discord.com/api/webhooks/test/token',
        webhookId: 'test-webhook',
        deduplicationWindowMs: 60000,
        deduplicationMaxSize: 1000,
        retryCount: 2,
        backoffBaseSeconds: 1,
        timeoutMs: 5000,
      };

      const service = new DiscordNotificationService(discordConfig);
      const contractConfig = NotificationFixtureBuilder.aContractConfig().build();

      const memoryBefore = process.memoryUsage();
      const startTime = Date.now();

      // Process notifications concurrently
      const promises = [];
      for (let i = 0; i < eventCount; i++) {
        const event = NotificationFixtureBuilder.aStellarEvent()
          .withId(`discord-stress-${i}`)
          .build();

        const promise = (async () => {
          const notifStart = Date.now();
          const result = await service.sendEventNotification(event, contractConfig, `req-${i}`);
          latencies.push(Date.now() - notifStart);
          if (result) successCount.value++;
        })();

        promises.push(promise);
      }

      await Promise.all(promises);

      const endTime = Date.now();
      const memoryAfter = process.memoryUsage();

      const report = generateMetricsReport(
        'Discord Notification Service Load',
        eventCount,
        startTime,
        endTime,
        successCount.value,
        eventCount - successCount.value,
        latencies,
        { before: memoryBefore, after: memoryAfter }
      );

      const metrics = service.getMetrics();
      console.log(`\nDiscord Service Metrics:`);
      console.log(`  Total Sent:         ${metrics.totalSent}`);
      console.log(`  Duplicates Skipped: ${metrics.duplicatesSkipped}`);

      expect(successCount.value).toBe(eventCount);
      expect(report.throughput).toBeGreaterThan(50);
    }, 120000);
  });

  describe('7. Error Recovery Under Stress', () => {
    it('should gracefully handle failures and retry under load', async () => {
      const eventCount = 1000;
      const processedIds: string[] = [];
      const latencies: number[] = [];
      let failureCount = 0;
      let retryCount = 0;

      // Simulate 20% failure rate on first attempt
      const processor: EventProcessor = jest.fn().mockImplementation(async (event) => {
        const start = Date.now();
        await new Promise((resolve) => setTimeout(resolve, Math.random() * 2));
        
        // Simulate failures on every 5th event (first attempt only)
        if (event.id.endsWith('5') && !processedIds.includes(event.id)) {
          retryCount++;
          latencies.push(Date.now() - start);
          return false; // Will retry
        }

        processedIds.push(event.id);
        latencies.push(Date.now() - start);
        return true;
      });

      const queue = new EventProcessingQueue(processor, {
        baseDelayMs: 100,
        pollIntervalMs: 10,
        maxConcurrency: 50,
        maxRetries: 3,
      });

      const contractConfig = NotificationFixtureBuilder.aContractConfig().build();
      const memoryBefore = process.memoryUsage();
      const startTime = Date.now();

      for (let i = 0; i < eventCount; i++) {
        const event = NotificationFixtureBuilder.aStellarEvent()
          .withId(`error-recovery-${i}`)
          .build();
        queue.enqueue(event, contractConfig, `req-${i}`, Priority.Medium);
      }

      queue.start();

      // Wait longer to account for retries
      while (processedIds.length < eventCount) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        
        // Add timeout protection
        if (Date.now() - startTime > 180000) { // 3 minutes max
          break;
        }
      }

      const endTime = Date.now();
      const memoryAfter = process.memoryUsage();
      queue.stop();

      const report = generateMetricsReport(
        'Error Recovery Under Load',
        eventCount,
        startTime,
        endTime,
        processedIds.length,
        failureCount,
        latencies,
        { before: memoryBefore, after: memoryAfter }
      );

      console.log(`\nError Recovery Statistics:`);
      console.log(`  Initial Failures:   ${retryCount}`);
      console.log(`  Successful Retries: ${processedIds.length - (eventCount - retryCount)}`);
      console.log(`  Final Success Rate: ${((processedIds.length / eventCount) * 100).toFixed(2)}%`);

      expect(processedIds.length).toBeGreaterThanOrEqual(eventCount * 0.95); // At least 95% success
      expect(retryCount).toBeGreaterThan(0); // Verify retries occurred
    }, 180000);
  });
});
