/**
 * Benchmark Utilities for Stress Testing
 * 
 * Provides utilities for measuring and reporting performance metrics
 * during stress tests including throughput, latency, and resource utilization.
 */

export interface BenchmarkMetrics {
  testName: string;
  eventCount: number;
  successCount: number;
  failureCount: number;
  totalTimeMs: number;
  throughput: number;
  latency: LatencyMetrics;
  memoryUsage?: MemoryMetrics;
  cpuUsage?: CPUMetrics;
}

export interface LatencyMetrics {
  min: number;
  max: number;
  avg: number;
  p50: number;
  p95: number;
  p99: number;
}

export interface MemoryMetrics {
  before: {
    heapUsed: string;
    heapTotal: string;
    rss: string;
    external: string;
  };
  after: {
    heapUsed: string;
    heapTotal: string;
    rss: string;
    external: string;
  };
  delta: {
    heapUsed: string;
    heapTotal: string;
    rss: string;
    external: string;
  };
}

export interface CPUMetrics {
  user: number;
  system: number;
}

export class BenchmarkCollector {
  private startTime: number = 0;
  private endTime: number = 0;
  private latencies: number[] = [];
  private successCount: number = 0;
  private failureCount: number = 0;
  private memoryBefore?: NodeJS.MemoryUsage;
  private memoryAfter?: NodeJS.MemoryUsage;
  private cpuBefore?: NodeJS.CpuUsage;
  private cpuAfter?: NodeJS.CpuUsage;

  constructor(private testName: string, private eventCount: number) {}

  start(): void {
    this.startTime = Date.now();
    this.memoryBefore = process.memoryUsage();
    this.cpuBefore = process.cpuUsage();
  }

  end(): void {
    this.endTime = Date.now();
    this.memoryAfter = process.memoryUsage();
    this.cpuAfter = process.cpuUsage();
  }

  recordLatency(latencyMs: number): void {
    this.latencies.push(latencyMs);
  }

  recordSuccess(): void {
    this.successCount++;
  }

  recordFailure(): void {
    this.failureCount++;
  }

  getMetrics(): BenchmarkMetrics {
    const totalTimeMs = this.endTime - this.startTime;
    const throughput = (this.eventCount / totalTimeMs) * 1000;

    return {
      testName: this.testName,
      eventCount: this.eventCount,
      successCount: this.successCount,
      failureCount: this.failureCount,
      totalTimeMs,
      throughput: parseFloat(throughput.toFixed(2)),
      latency: this.calculateLatencyMetrics(),
      memoryUsage: this.calculateMemoryMetrics(),
      cpuUsage: this.calculateCPUMetrics(),
    };
  }

  private calculateLatencyMetrics(): LatencyMetrics {
    if (this.latencies.length === 0) {
      return { min: 0, max: 0, avg: 0, p50: 0, p95: 0, p99: 0 };
    }

    const sorted = [...this.latencies].sort((a, b) => a - b);
    const sum = sorted.reduce((acc, val) => acc + val, 0);

    return {
      min: parseFloat(sorted[0].toFixed(2)),
      max: parseFloat(sorted[sorted.length - 1].toFixed(2)),
      avg: parseFloat((sum / sorted.length).toFixed(2)),
      p50: parseFloat(this.percentile(sorted, 50).toFixed(2)),
      p95: parseFloat(this.percentile(sorted, 95).toFixed(2)),
      p99: parseFloat(this.percentile(sorted, 99).toFixed(2)),
    };
  }

  private percentile(sorted: number[], p: number): number {
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
  }

  private calculateMemoryMetrics(): MemoryMetrics | undefined {
    if (!this.memoryBefore || !this.memoryAfter) {
      return undefined;
    }

    return {
      before: {
        heapUsed: formatBytes(this.memoryBefore.heapUsed),
        heapTotal: formatBytes(this.memoryBefore.heapTotal),
        rss: formatBytes(this.memoryBefore.rss),
        external: formatBytes(this.memoryBefore.external),
      },
      after: {
        heapUsed: formatBytes(this.memoryAfter.heapUsed),
        heapTotal: formatBytes(this.memoryAfter.heapTotal),
        rss: formatBytes(this.memoryAfter.rss),
        external: formatBytes(this.memoryAfter.external),
      },
      delta: {
        heapUsed: formatBytes(this.memoryAfter.heapUsed - this.memoryBefore.heapUsed),
        heapTotal: formatBytes(this.memoryAfter.heapTotal - this.memoryBefore.heapTotal),
        rss: formatBytes(this.memoryAfter.rss - this.memoryBefore.rss),
        external: formatBytes(this.memoryAfter.external - this.memoryBefore.external),
      },
    };
  }

  private calculateCPUMetrics(): CPUMetrics | undefined {
    if (!this.cpuBefore || !this.cpuAfter) {
      return undefined;
    }

    return {
      user: this.cpuAfter.user - this.cpuBefore.user,
      system: this.cpuAfter.system - this.cpuBefore.system,
    };
  }
}

export function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(2)} MB`;
}

export function printBenchmarkReport(metrics: BenchmarkMetrics): void {
  console.log('\n' + '='.repeat(80));
  console.log(`BENCHMARK REPORT: ${metrics.testName}`);
  console.log('='.repeat(80));
  console.log(`Events Processed:     ${metrics.eventCount}`);
  console.log(`Success Count:        ${metrics.successCount}`);
  console.log(`Failure Count:        ${metrics.failureCount}`);
  console.log(`Total Time:           ${metrics.totalTimeMs}ms`);
  console.log(`Throughput:           ${metrics.throughput.toFixed(2)} events/second`);
  console.log(`\nLatency Statistics:`);
  console.log(`  Min:                ${metrics.latency.min}ms`);
  console.log(`  Max:                ${metrics.latency.max}ms`);
  console.log(`  Avg:                ${metrics.latency.avg}ms`);
  console.log(`  P50 (Median):       ${metrics.latency.p50}ms`);
  console.log(`  P95:                ${metrics.latency.p95}ms`);
  console.log(`  P99:                ${metrics.latency.p99}ms`);

  if (metrics.memoryUsage) {
    console.log(`\nMemory Usage:`);
    console.log(`  Before - Heap:      ${metrics.memoryUsage.before.heapUsed}`);
    console.log(`  After - Heap:       ${metrics.memoryUsage.after.heapUsed}`);
    console.log(`  Delta - Heap:       ${metrics.memoryUsage.delta.heapUsed}`);
    console.log(`  Before - RSS:       ${metrics.memoryUsage.before.rss}`);
    console.log(`  After - RSS:        ${metrics.memoryUsage.after.rss}`);
    console.log(`  Delta - RSS:        ${metrics.memoryUsage.delta.rss}`);
  }

  if (metrics.cpuUsage) {
    console.log(`\nCPU Usage:`);
    console.log(`  User Time:          ${(metrics.cpuUsage.user / 1000).toFixed(2)}ms`);
    console.log(`  System Time:        ${(metrics.cpuUsage.system / 1000).toFixed(2)}ms`);
  }

  console.log('='.repeat(80) + '\n');
}

export function exportMetricsToJSON(metrics: BenchmarkMetrics[], outputPath: string): void {
  const fs = require('fs');
  const path = require('path');

  const report = {
    timestamp: new Date().toISOString(),
    summary: {
      totalTests: metrics.length,
      totalEvents: metrics.reduce((sum, m) => sum + m.eventCount, 0),
      totalSuccesses: metrics.reduce((sum, m) => sum + m.successCount, 0),
      totalFailures: metrics.reduce((sum, m) => sum + m.failureCount, 0),
      avgThroughput: metrics.reduce((sum, m) => sum + m.throughput, 0) / metrics.length,
    },
    tests: metrics,
  };

  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
  console.log(`\nBenchmark report exported to: ${outputPath}`);
}

export class ResourceMonitor {
  private intervalId?: ReturnType<typeof setInterval>;
  private samples: Array<{ timestamp: number; memory: NodeJS.MemoryUsage; cpu: NodeJS.CpuUsage }> = [];

  start(intervalMs: number = 1000): void {
    this.samples = [];
    this.intervalId = setInterval(() => {
      this.samples.push({
        timestamp: Date.now(),
        memory: process.memoryUsage(),
        cpu: process.cpuUsage(),
      });
    }, intervalMs);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
  }

  getReport(): {
    duration: number;
    sampleCount: number;
    memory: {
      peak: { heapUsed: string; rss: string };
      avg: { heapUsed: string; rss: string };
    };
  } | null {
    if (this.samples.length === 0) return null;

    const memoryValues = this.samples.map((s) => s.memory);
    const peakHeap = Math.max(...memoryValues.map((m) => m.heapUsed));
    const peakRss = Math.max(...memoryValues.map((m) => m.rss));
    const avgHeap = memoryValues.reduce((sum, m) => sum + m.heapUsed, 0) / memoryValues.length;
    const avgRss = memoryValues.reduce((sum, m) => sum + m.rss, 0) / memoryValues.length;

    return {
      duration: this.samples[this.samples.length - 1].timestamp - this.samples[0].timestamp,
      sampleCount: this.samples.length,
      memory: {
        peak: {
          heapUsed: formatBytes(peakHeap),
          rss: formatBytes(peakRss),
        },
        avg: {
          heapUsed: formatBytes(avgHeap),
          rss: formatBytes(avgRss),
        },
      },
    };
  }
}
