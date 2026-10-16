import { NotificationHealthMonitor } from './notification-health-monitor';

describe('NotificationHealthMonitor', () => {
  it('should include uptimeMs in the health report', () => {
    const mockNow = () => 1000;
    const mockGetUptimeMs = () => 5000;

    const monitor = new NotificationHealthMonitor(null, null, {
      now: mockNow,
      getUptimeMs: mockGetUptimeMs,
    });

    monitor.start();
    const report = monitor.getLastReport();

    expect(report).not.toBeNull();
    expect(report!.uptimeMs).toBe(5000);
    expect(report!.status).toBe('healthy');

    monitor.stop();
  });
});
