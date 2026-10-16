import type { Meta, StoryObj } from '@storybook/react';
import { NotificationSummaryCards } from './NotificationSummaryCards';
import type { NotificationSummaryMetrics } from '../types/notificationSummary';

const healthySummary: NotificationSummaryMetrics = {
  delivered: 1842,
  pending: 217,
  failed: 83,
  total: 2142,
  deliveredRate: 85.9,
};

const degradedSummary: NotificationSummaryMetrics = {
  delivered: 410,
  pending: 184,
  failed: 230,
  total: 828,
  deliveredRate: 49.5,
};

const emptySummary: NotificationSummaryMetrics = {
  delivered: 0,
  pending: 0,
  failed: 0,
  total: 0,
  deliveredRate: 0,
};

const meta: Meta<typeof NotificationSummaryCards> = {
  title: 'Components/NotificationSummaryCards',
  component: NotificationSummaryCards,
  args: {
    summary: healthySummary,
    isLoading: false,
  },
  parameters: {
    layout: 'centered',
  },
};

export default meta;
type Story = StoryObj<typeof NotificationSummaryCards>;

export const Healthy: Story = {};

export const Degraded: Story = {
  args: {
    summary: degradedSummary,
  },
};

export const Empty: Story = {
  args: {
    summary: emptySummary,
  },
};

export const Loading: Story = {
  args: {
    isLoading: true,
  },
};
