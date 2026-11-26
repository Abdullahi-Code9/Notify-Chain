import { NotificationAmplificationGuard, NotificationAmplificationError } from './notification-amplification-guard';
describe('notification amplification guard (#1260)', () => {
  it('throttles excessive delivery attempts per destination', () => {
    let now = 0;
    const g = new NotificationAmplificationGuard({ windowMs: 1000, maxPerDestination: 2, clock: () => now });
    g.check('dest', 'a'); g.check('dest', 'b');
    expect(() => g.check('dest', 'c')).toThrow(NotificationAmplificationError);
    expect(g.getMetrics().blockedCount).toBe(1);
  });
  it('blocks repeated equivalent requests and resumes after the window', () => {
    let now = 0;
    const g = new NotificationAmplificationGuard({ windowMs: 1000, maxPerDestination: 10, clock: () => now });
    g.check('dest', 'same');
    expect(() => g.check('dest', 'same')).toThrow(/equivalent/);
    now = 1001;
    expect(() => g.check('dest', 'same')).not.toThrow();
  });
  it('isolates destinations', () => {
    const g = new NotificationAmplificationGuard({ maxPerDestination: 1 });
    g.check('a', 'x');
    expect(() => g.check('b', 'y')).not.toThrow();
  });
});
