import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { Modal } from './Modal';

const meta: Meta<typeof Modal> = {
  title: 'Components/Modal',
  component: Modal,
  tags: ['autodocs'],
  args: {
    isOpen: true,
    title: 'Preview notification',
    children: 'Modal body content for design review.',
    size: 'medium',
  },
  argTypes: {
    onClose: { action: 'closed' },
    size: {
      control: 'select',
      options: ['small', 'medium', 'large'],
    },
  },
};

export default meta;
type Story = StoryObj<typeof Modal>;

export const Medium: Story = {};

export const Small: Story = {
  args: {
    size: 'small',
    title: 'Confirm action',
    children: 'This is a compact confirmation dialog.',
  },
};

export const Large: Story = {
  args: {
    size: 'large',
    title: 'Notification template details',
    children:
      'Large modal variation for richer previews, variable editors, and payload inspection.',
  },
};

export const WithFooter: Story = {
  args: {
    title: 'Send preview',
    children: 'Review the rendered template before dispatching.',
    footer: (
      <>
        <button type="button" className="modal__button modal__button--secondary">
          Cancel
        </button>
        <button type="button" className="modal__button modal__button--primary">
          Send
        </button>
      </>
    ),
  },
};

export const Interactive: Story = {
  render: function InteractiveModal(args) {
    const [isOpen, setIsOpen] = useState(true);

    return (
      <div>
        <button
          type="button"
          className="modal__button modal__button--primary"
          onClick={() => setIsOpen(true)}
        >
          Open modal
        </button>
        <Modal {...args} isOpen={isOpen} onClose={() => setIsOpen(false)} />
      </div>
    );
  },
};
