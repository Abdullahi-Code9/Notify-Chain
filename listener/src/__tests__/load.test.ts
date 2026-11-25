
import { xdr } from '@stellar/stellar-sdk';
import { EventProcessingQueue, EventProcessor } from '../services/event-processing-queue';
import { NotificationFixtureBuilder } from '../test-utils/notification-fixture-builder';

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

describe('Notification Processing Load Tests', () => {
  describe('EventProcessingQueue Throughput', () => {
    it('should handle 100 concurrent events efficiently', async () => {
      const eventCount = 100;
      const processedIds: string[] = [];
      
      const processor: EventProcessor = jest.fn().mockImplementation(async (event) => {
        processedIds.push(event.id);
        return true;
      });
      
      const queue = new EventProcessingQueue(processor, {
        baseDelayMs: 1,
        pollIntervalMs: 10,
        maxConcurrency: 10,
      });
      
      const contractConfig = NotificationFixtureBuilder.aContractConfig().build();
      
      const startTime = Date.now();
      
      // Enqueue 100 events
      for (let i = 0; i < eventCount; i++) {
        const event = NotificationFixtureBuilder.aStellarEvent()
          .withId(`load-test-event-${i}`)
          .build();
        queue.enqueue(event, contractConfig, `load-test-req-${i}`);
      }
      
      queue.start();
      
      // Wait for all events to process
      while (processedIds.length < eventCount) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      
      const endTime = Date.now();
      const totalTimeMs = endTime - startTime;
      const throughput = (eventCount / totalTimeMs) * 1000;
      
      queue.stop();
      
      expect(processor).toHaveBeenCalledTimes(eventCount);
      expect(processedIds.length).toBe(eventCount);
      
      // Log benchmark results
      console.log(`\n=== Load Test Results (${eventCount} events) ===`);
      console.log(`Total processing time: ${totalTimeMs}ms`);
      console.log(`Throughput: ${throughput.toFixed(2)} events/second`);
      console.log(`Average latency per event: ${(totalTimeMs / eventCount).toFixed(2)}ms\n`);
    }, 30000);
    
    it('should handle 500 events with maxConcurrency=20', async () => {
      const eventCount = 500;
      const processedIds: string[] = [];
      
      const processor: EventProcessor = jest.fn().mockImplementation(async (event) => {
        await new Promise(resolve => setTimeout(resolve, 1));
        processedIds.push(event.id);
        return true;
      });
      
      const queue = new EventProcessingQueue(processor, {
        baseDelayMs: 1,
        pollIntervalMs: 10,
        maxConcurrency: 20,
      });
      
      const contractConfig = NotificationFixtureBuilder.aContractConfig().build();
      
      const startTime = Date.now();
      
      for (let i = 0; i < eventCount; i++) {
        const event = NotificationFixtureBuilder.aStellarEvent()
          .withId(`load-test-500-event-${i}`)
          .build();
        queue.enqueue(event, contractConfig);
      }
      
      queue.start();
      
      while (processedIds.length < eventCount) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      
      const endTime = Date.now();
      const totalTimeMs = endTime - startTime;
      const throughput = (eventCount / totalTimeMs) * 1000;
      
      queue.stop();
      
      expect(processor).toHaveBeenCalledTimes(eventCount);
      
      console.log(`\n=== Load Test Results (${eventCount} events, maxConcurrency=20) ===`);
      console.log(`Total processing time: ${totalTimeMs}ms`);
      console.log(`Throughput: ${throughput.toFixed(2)} events/second`);
      console.log(`Average latency per event: ${(totalTimeMs / eventCount).toFixed(2)}ms\n`);
    }, 60000);
  });
});
