import type { Meta, StoryObj } from '@storybook/react';
import { EventCard } from './EventCard';
import { sampleEvent, sampleSystemEvent, sampleWithdrawalEvent } from '../stories/fixtures/events';

const meta: Meta<typeof EventCard> = {
  title: 'Components/EventCard',
  component: EventCard,
  tags: ['autodocs'],
  args: {
    event: sampleEvent,
    variant: 'compact',
    isLoading: false,
  },
};

export default meta;
type Story = StoryObj<typeof EventCard>;

export const Compact: Story = {};

export const Expanded: Story = {
  args: {
    variant: 'expanded',
  },
};

export const LoadingCompact: Story = {
  args: {
    isLoading: true,
    event: undefined,
  },
};

export const LoadingExpanded: Story = {
  args: {
    variant: 'expanded',
    isLoading: true,
    event: undefined,
  },
};

export const SystemEvent: Story = {
  args: {
    event: sampleSystemEvent,
  },
};

export const WithdrawalEvent: Story = {
  args: {
    event: sampleWithdrawalEvent,
    variant: 'expanded',
  },
};

export const Clickable: Story = {
  args: {
    onClick: () => undefined,
  },
};
