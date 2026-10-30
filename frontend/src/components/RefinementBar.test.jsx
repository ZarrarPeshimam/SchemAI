import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import RefinementBar from './RefinementBar';

afterEach(() => vi.restoreAllMocks());

describe('RefinementBar', () => {
  it('the submit button text is exactly its label: the icon is an aria-hidden SVG that contributes no visible text', () => {
    render(<RefinementBar onRefine={vi.fn()} />);
    const button = screen.getByRole('button', { name: /update schema/i });
    expect(button.textContent).toBe('Update Schema');
    expect(button.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(document.body.textContent).not.toMatch(/svg/i);
  });

  it('shows the busy label while refining, again with no stray "svg" text', () => {
    render(<RefinementBar onRefine={vi.fn()} isRefining />);
    const button = screen.getByRole('button', { name: /updating schema/i });
    expect(button.textContent).toBe('Updating…');
    expect(document.body.textContent).not.toMatch(/svg/i);
  });

  it('rendering and typing do not write debug logs (the old per-render log looked like a render loop)', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    render(<RefinementBar onRefine={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Refinement instruction'), { target: { value: 'Add a date_of_birth attribute' } });
    expect(log).not.toHaveBeenCalled();
  });

  it('submits the typed instruction once and clears the input when the change was accepted', async () => {
    const onRefine = vi.fn().mockResolvedValue(true);
    render(<RefinementBar onRefine={onRefine} />);
    const input = screen.getByLabelText('Refinement instruction');
    fireEvent.change(input, { target: { value: 'Add a date_of_birth attribute of type DATE to Customer. It should be nullable.' } });
    fireEvent.click(screen.getByRole('button', { name: /update schema/i }));
    await vi.waitFor(() => expect(input.value).toBe(''));
    expect(onRefine).toHaveBeenCalledTimes(1);
    expect(onRefine).toHaveBeenCalledWith('Add a date_of_birth attribute of type DATE to Customer. It should be nullable.');
  });
});
