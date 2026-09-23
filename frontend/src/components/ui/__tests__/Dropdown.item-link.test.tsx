import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { Dropdown, DropdownItem } from '../Dropdown';

/**
 * DropdownItem `to` (Admin table Step 2, MR B fix round): an item that goes
 * to a page is a router link, so it navigates in-app and a modifier-click
 * can open a new tab. A disabled item stays a button - a link cannot be
 * disabled - and carries no href.
 */

const Where = () => <div data-testid="where">{useLocation().pathname}</div>;

const onCopy = vi.fn();

const renderMenu = () =>
  render(
    <MemoryRouter initialEntries={['/admin']}>
      <Dropdown
        menu
        trigger={
          <button type="button" aria-label="Actions">
            ⋮
          </button>
        }
      >
        <DropdownItem to="/admin/opportunities/o1/edit">Edit</DropdownItem>
        <DropdownItem to="/admin/opportunities/o1/analytics" disabled title="Only the owner can view analytics">
          Analytics
        </DropdownItem>
        <DropdownItem onClick={onCopy}>Copy</DropdownItem>
      </Dropdown>
      <Routes>
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>
  );

describe('DropdownItem with `to`', () => {
  it('renders a link menuitem to the route', () => {
    renderMenu();
    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
    const edit = within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Edit' });
    expect(edit.tagName).toBe('A');
    expect(edit).toHaveAttribute('href', '/admin/opportunities/o1/edit');
  });

  it('navigates in-app when chosen, and the menu closes', () => {
    renderMenu();
    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Edit' }));
    expect(screen.getByTestId('where')).toHaveTextContent('/admin/opportunities/o1/edit');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('stays a disabled button, with no href, when disabled', () => {
    renderMenu();
    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
    // Control: the same `to` without `disabled` is a link.
    expect(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Edit' }).tagName).toBe('A');
    const analytics = within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Analytics' });
    expect(analytics.tagName).toBe('BUTTON');
    expect(analytics).toBeDisabled();
    expect(analytics).not.toHaveAttribute('href');
    expect(analytics).toHaveAttribute('title', 'Only the owner can view analytics');
  });

  it('leaves the arrow keys roving across link and button items alike', () => {
    renderMenu();
    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
    const items = within(screen.getByRole('menu')).getAllByRole('menuitem');
    // Disabled Analytics is skipped: Edit (link) -> Copy (button).
    expect(items[0].tagName).toBe('A');
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0], { key: 'ArrowDown' });
    expect(document.activeElement).toHaveTextContent('Copy');
  });

  it('Space activates a link item - which a link does not do natively - and stops the page scrolling (round 3)', () => {
    renderMenu();
    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
    const edit = within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Edit' });
    expect(edit.tagName).toBe('A');
    const notPrevented = fireEvent.keyDown(edit, { key: ' ' });
    expect(notPrevented).toBe(false);
    expect(screen.getByTestId('where')).toHaveTextContent('/admin/opportunities/o1/edit');
  });

  it('Space activates a button item exactly once', () => {
    onCopy.mockClear();
    renderMenu();
    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
    const items = within(screen.getByRole('menu')).getAllByRole('menuitem');
    fireEvent.keyDown(items[0], { key: 'ArrowDown' });
    const copy = document.activeElement as HTMLElement;
    expect(copy).toHaveTextContent('Copy');
    const notPrevented = fireEvent.keyDown(copy, { key: ' ' });
    // Prevented, so the button's own keyup click cannot add a second one.
    expect(notPrevented).toBe(false);
    fireEvent.keyUp(copy, { key: ' ' });
    expect(onCopy).toHaveBeenCalledTimes(1);
  });
});
