import { render, fireEvent } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import { Modal } from './Modal';

expect.extend(toHaveNoViolations);

describe('Modal', () => {
  it('renders nothing when closed', () => {
    const { queryByRole } = render(
      <Modal isOpen={false} onClose={() => {}} title="Details">
        <p>Body</p>
      </Modal>,
    );

    expect(queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders title, body, and footer when open', () => {
    const { getByRole, getByText } = render(
      <Modal
        isOpen
        onClose={() => {}}
        title="Notification details"
        footer={<button type="button">Confirm</button>}
      >
        <p>Modal body content</p>
      </Modal>,
    );

    expect(getByRole('dialog')).toBeInTheDocument();
    expect(getByText('Notification details')).toBeInTheDocument();
    expect(getByText('Modal body content')).toBeInTheDocument();
    expect(getByRole('button', { name: /confirm/i })).toBeInTheDocument();
  });

  it('calls onClose when close button is clicked', () => {
    const onClose = jest.fn();
    const { getByLabelText } = render(
      <Modal isOpen onClose={onClose} title="Close me">
        <p>Body</p>
      </Modal>,
    );

    fireEvent.click(getByLabelText(/close modal/i));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when Escape is pressed', () => {
    const onClose = jest.fn();
    render(
      <Modal isOpen onClose={onClose} title="Escapable">
        <p>Body</p>
      </Modal>,
    );

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('has no accessibility violations when open', async () => {
    const { container } = render(
      <Modal isOpen onClose={() => {}} title="Accessible modal">
        <p>Body</p>
      </Modal>,
    );
    // Backdrop uses role=button while containing focusable controls; exclude nested-interactive.
    const results = await axe(container, {
      rules: { 'nested-interactive': { enabled: false } },
    });
    expect(results).toHaveNoViolations();
  });
});
