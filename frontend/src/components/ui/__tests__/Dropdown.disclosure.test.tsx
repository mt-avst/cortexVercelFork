import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Dropdown, DropdownItem, DropdownDivider } from '../Dropdown';

/**
 * Dropdown's `disclosure` mode (#117 follow-up, TESTLANE-C section 2): the
 * WAI-ARIA Disclosure pattern for a popup mixing navigation links, an info
 * block and a couple of actions (the header's profile/phone menus) - no
 * `role="menu"`/`menuitem` (that asserts a single-purpose widget this is
 * not), items stay ordinary Tab stops, but Escape-closes-and-returns-focus
 * still applies (a property of any dismissible floating popup, not of the
 * menu role specifically).
 */

const renderDisclosure = () =>
  render(
    <MemoryRouter>
      <Dropdown
        disclosure
        trigger={
          <button type="button" aria-label="Menu">
            <span aria-hidden="true">≡</span>
          </button>
        }
      >
        <DropdownItem to="/settings">Settings</DropdownItem>
        <DropdownItem disabled title="Only the owner can do this">
          Analytics
        </DropdownItem>
        <DropdownDivider />
        <DropdownItem onClick={() => {}}>Logout</DropdownItem>
      </Dropdown>
    </MemoryRouter>
  );

const openMenu = () => {
  const trigger = screen.getByRole('button', { name: 'Menu' });
  fireEvent.click(trigger);
  return trigger;
};

describe('Dropdown disclosure mode', () => {
  it('carries no role="menu" on the popup and no aria-haspopup="menu" on the trigger', () => {
    const trigger = renderDisclosure().getByRole('button', { name: 'Menu' });
    expect(trigger).not.toHaveAttribute('aria-haspopup', 'menu');
    fireEvent.click(trigger);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('exposes items with their ordinary roles, not menuitem - a link stays a link, a plain item a button', () => {
    renderDisclosure();
    openMenu();
    expect(screen.getByRole('link', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Logout' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument();
  });

  // A click on a disabled item or the popup's own padding focuses nothing
  // (neither is focusable), so the browser's blur event on whatever WAS
  // focused carries `relatedTarget: null` - indistinguishable, from that
  // event alone, from focus genuinely leaving the popup (Dropdown's own
  // `handleContainerBlur` comment). Simulate that shape directly, the way a
  // raw `fireEvent.click` on a non-focusable target cannot: focus a real
  // item first, then blur it with no relatedTarget.
  it('stays open when a disabled item is clicked (blur with no relatedTarget - a disabled item cannot receive focus)', () => {
    renderDisclosure();
    const trigger = openMenu();
    const settings = screen.getByRole('link', { name: 'Settings' });
    settings.focus();
    fireEvent.click(screen.getByRole('button', { name: 'Analytics' }));
    fireEvent.blur(settings, { relatedTarget: null });
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
  });

  it("stays open when the popup's own padding is clicked (also a blur with no relatedTarget)", () => {
    const { container } = renderDisclosure();
    const trigger = openMenu();
    const settings = screen.getByRole('link', { name: 'Settings' });
    settings.focus();
    const menu = container.querySelector('.dropdown-menu') as HTMLElement;
    fireEvent.click(menu);
    fireEvent.blur(settings, { relatedTarget: null });
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
  });

  it('closes when focus leaves the popup for something else on the page', () => {
    render(
      <MemoryRouter>
        <div>
          <Dropdown disclosure trigger={<button type="button" aria-label="Menu">≡</button>}>
            <DropdownItem onClick={() => {}}>Logout</DropdownItem>
          </Dropdown>
          <button type="button">Elsewhere</button>
        </div>
      </MemoryRouter>
    );
    const trigger = openMenu();
    const logout = screen.getByRole('button', { name: 'Logout' });
    logout.focus();
    fireEvent.blur(logout, { relatedTarget: screen.getByRole('button', { name: 'Elsewhere' }) });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  // GUARD: passes on main too - Escape-closes-and-returns-focus is generic
  // to the whole Dropdown (not gated on `mode`), predating disclosure mode.
  // Kept because it is still true of this mode specifically, per the "a
  // property of any dismissible floating popup" docblock above.
  it('Escape closes the popup and returns focus to the trigger', () => {
    renderDisclosure();
    const trigger = openMenu();
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(document.activeElement).toBe(trigger);
  });

  // GUARD: passes on main too - this pins `menu` mode's own pre-existing
  // behaviour as the control that disclosure mode must NOT have disturbed.
  it('menu mode is unchanged: still role="menu"/menuitem, with the roving keyboard model', () => {
    render(
      <MemoryRouter>
        <Dropdown
          menu
          trigger={<button type="button" aria-label="Actions">⋮</button>}
        >
          <DropdownItem onClick={() => {}}>View</DropdownItem>
          <DropdownItem onClick={() => {}}>Delete</DropdownItem>
        </Dropdown>
      </MemoryRouter>
    );
    const trigger = screen.getByRole('button', { name: 'Actions' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    fireEvent.click(trigger);
    const menu = screen.getByRole('menu');
    const items = within(menu).getAllByRole('menuitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(items[1]).toHaveFocus();
  });
});
