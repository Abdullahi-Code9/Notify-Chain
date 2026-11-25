import { NotificationStatus } from '../types/scheduled-notification';

const ALLOWED_TRANSITIONS: Readonly<Record<NotificationStatus, readonly NotificationStatus[]>> = {
  [NotificationStatus.PENDING]: [NotificationStatus.PROCESSING, NotificationStatus.CANCELLED, NotificationStatus.EXPIRED, NotificationStatus.AWAITING_INTERVENTION],
  [NotificationStatus.PROCESSING]: [NotificationStatus.PENDING, NotificationStatus.COMPLETED, NotificationStatus.FAILED, NotificationStatus.DEAD_LETTERED, NotificationStatus.EXPIRED],
  [NotificationStatus.COMPLETED]: [],
  [NotificationStatus.FAILED]: [NotificationStatus.PENDING],
  [NotificationStatus.DEAD_LETTERED]: [NotificationStatus.PENDING],
  [NotificationStatus.CANCELLED]: [],
  [NotificationStatus.EXPIRED]: [],
  [NotificationStatus.AWAITING_INTERVENTION]: [NotificationStatus.PENDING, NotificationStatus.EXPIRED],
};

export function canTransitionScheduleStatus(from: NotificationStatus, to: NotificationStatus): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertScheduleTransition(from: NotificationStatus, to: NotificationStatus): void {
  if (!canTransitionScheduleStatus(from, to)) {
    throw new Error(`Invalid schedule status transition: ${from} -> ${to}`);
  }
}

export function canModifyScheduleStatus(status: NotificationStatus): boolean {
  return status === NotificationStatus.PENDING;
}
