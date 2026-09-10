import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Dropdown, DropdownItem, DropdownDivider } from '../Dropdown';

/**
 * The shared Dropdown is a WAI-ARIA menu button (#117): the trigger announces
 * aria-haspopup="menu", the popup is role="menu" with role="menuitem" children,
 * and focus is managed with a roving tabindex driven by the arrow keys - items
 * are not individual Tab stops. These pin that model so a revert to the old
 * "group of plain buttons" (no menu keyboard model) fails here by name.
 */
const renderMenu = () =>
  render(
    <MemoryRouter>
      <Dropdown
        menu
        trigger={
          <button type="button" aria-label="Actions">
            <span aria-hidden="true">⋮</span>
          </button>
        }
      >
        <DropdownItem onClick={() => {}}>View</DropdownItem>
        <DropdownItem onClick={() => {}}>Edit</DropdownItem>
        <DropdownDivider />
        <DropdownItem onClick={() => {}}>Delete</DropdownItem>
      </Dropdown>
    </MemoryRouter>
  );

const openMenu = () => {
  const trigger = screen.getByRole('button', { name: 'Actions' });
  fireEvent.click(trigger);
  return trigger;
};

const items = () => within(screen.getByRole('menu')).getAllByRole('menuitem');

describe('Dropdown menu keyboard model (#117)', () => {
  it('the trigger announces a menu popup', () => {
    renderMenu();
    const trigger = screen.getByRole('button', { name: 'Actions' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
  });

  it('exposes items as menuitems inside a menu, dividers as separators', () => {
    renderMenu();
    openMenu();
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(items().map((el) => el.textContent)).toEqual(['View', 'Edit', 'Delete']);
    expect(within(screen.getByRole('menu')).getByRole('separator')).toBeInTheDocument();
  });

  it('moves focus to the first item on open, as the only Tab stop', () => {
    renderMenu();
    openMenu();
    const [view, edit, del] = items();
    expect(document.activeElement).toBe(view);
    // Roving tabindex: only the focused item is in the Tab sequence.
    expect(view).toHaveAttribute('tabindex', '0');
    expect(edit).toHaveAttribute('tabindex', '-1');
    expect(del).toHaveAttribute('tabindex', '-1');
  });

  it('ArrowDown/ArrowUp rove across items and wrap, skipping the divider', () => {
    renderMenu();
    openMenu();
    const [view, edit, del] = items();

    fireEvent.keyDown(view, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(edit);

    fireEvent.keyDown(edit, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(del); // divider is not a stop

    fireEvent.keyDown(del, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(view); // wraps to first

    fireEvent.keyDown(view, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(del); // wraps to last
  });

  it('Home and End jump to the first and last item', () => {
    renderMenu();
    openMenu();
    const [view, , del] = items();

    fireEvent.keyDown(view, { key: 'End' });
    expect(document.activeElement).toBe(del);

    fireEvent.keyDown(del, { key: 'Home' });
    expect(document.activeElement).toBe(view);
  });

  it('Escape closes the menu and returns focus to the trigger', () => {
    renderMenu();
    const trigger = openMenu();
    expect(screen.getByRole('menu')).toBeInTheDocument();

    fireEvent.keyDown(items()[0], { key: 'Escape' });

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(trigger);
  });
});

/**
 * The default (menu prop off) is the contract the header nav relies on: its
 * popup mixes menuitem buttons with real <a> links, so the roving menu model
 * (which navigates only [role="menuitem"] and closes on Tab) must NOT apply -
 * it would strand the links (#117 regression guard). Here the items stay
 * ordinary Tab stops and focus is not seized on open.
 */
describe('Dropdown default (non-menu) leaves items as ordinary Tab stops', () => {
  const renderNav = () =>
    render(
      <MemoryRouter>
        <Dropdown
          trigger={
            <button type="button" aria-label="Profile">
              Me
            </button>
          }
        >
          <a className="dropdown-item" href="/settings">Settings</a>
          <DropdownItem onClick={() => {}}>Log out</DropdownItem>
        </Dropdown>
      </MemoryRouter>
    );

  it('announces a generic popup, not a menu', () => {
    renderNav();
    expect(screen.getByRole('button', { name: 'Profile' })).toHaveAttribute('aria-haspopup', 'true');
  });

  it('does not seize focus to the first item on open, and keeps the link reachable', () => {
    renderNav();
    const trigger = screen.getByRole('button', { name: 'Profile' });
    fireEvent.click(trigger);

    // No roving menu model: focus is not seized into the popup on open (menu
    // mode would have moved it to the first menuitem).
    expect(screen.getByRole('menu').contains(document.activeElement)).toBe(false);
    // The link is not a [role="menuitem"], so it stays in the natural Tab order
    // (menu mode would have forced it to tabindex=-1 or skipped it entirely).
    const link = screen.getByRole('link', { name: 'Settings' });
    expect(link).toBeInTheDocument();
    expect(link).not.toHaveAttribute('tabindex', '-1');
  });
});
