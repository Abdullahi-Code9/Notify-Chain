import { NotificationStatus } from '../types/scheduled-notification';
import { canModifyScheduleStatus, canTransitionScheduleStatus } from './schedule-state-machine';

describe('schedule state machine', () => {
  it('allows modifications only while pending', () => {
    expect(canModifyScheduleStatus(NotificationStatus.PENDING)).toBe(true);
    for (const status of [
      NotificationStatus.PROCESSING,
      NotificationStatus.COMPLETED,
      NotificationStatus.FAILED,
      NotificationStatus.DEAD_LETTERED,
      NotificationStatus.CANCELLED,
      NotificationStatus.EXPIRED,
      NotificationStatus.AWAITING_INTERVENTION,
    ]) {
      expect(canModifyScheduleStatus(status)).toBe(false);
    }
  });

  it('allows intervention schedules to execute or expire, but not be modified', () => {
    expect(canTransitionScheduleStatus(NotificationStatus.AWAITING_INTERVENTION, NotificationStatus.PENDING)).toBe(true);
    expect(canTransitionScheduleStatus(NotificationStatus.AWAITING_INTERVENTION, NotificationStatus.EXPIRED)).toBe(true);
    expect(canTransitionScheduleStatus(NotificationStatus.AWAITING_INTERVENTION, NotificationStatus.COMPLETED)).toBe(false);
  });

  it('does not allow terminal schedules to transition back to pending', () => {
    for (const status of [NotificationStatus.COMPLETED, NotificationStatus.CANCELLED, NotificationStatus.EXPIRED]) {
      expect(canTransitionScheduleStatus(status, NotificationStatus.PENDING)).toBe(false);
    }
  });
});
