import { render, screen } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import { FormField, FormInput, getFormFieldA11yProps } from './FormField';

expect.extend(toHaveNoViolations);

describe('FormField (#678)', () => {
  it('associates the error message with the control for screen readers', () => {
    render(
      <FormField id="email" label="Email address" error="Email address: enter a valid email.">
        <FormInput fieldId="email" type="email" error="Email address: enter a valid email." />
      </FormField>,
    );

    const input = screen.getByLabelText('Email address');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAttribute('aria-describedby', 'email-error');
    expect(screen.getByRole('alert')).toHaveTextContent('Email address: enter a valid email.');
    expect(screen.getByRole('alert')).toHaveAttribute('id', 'email-error');
  });

  it('marks the field invalid without relying on colour alone', () => {
    const { container } = render(
      <FormField id="handle" label="Telegram handle" error="Telegram handle: invalid format.">
        <FormInput fieldId="handle" error="Telegram handle: invalid format." />
      </FormField>,
    );

    expect(container.querySelector('.form-field--invalid')).toBeTruthy();
    expect(container.querySelector('[data-invalid="true"]')).toBeTruthy();
    expect(container.querySelector('.form-field__error-icon')).toHaveTextContent('!');
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('exposes a11y props that name the affected field', () => {
    expect(getFormFieldA11yProps('name', 'Name: required')).toEqual({
      id: 'name',
      'aria-invalid': true,
      'aria-describedby': 'name-error',
    });
  });

  it('has no accessibility violations when showing an error', async () => {
    const { container } = render(
      <FormField id="body" label="Body" error="Body: enter template content.">
        <FormInput fieldId="body" error="Body: enter template content." />
      </FormField>,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
