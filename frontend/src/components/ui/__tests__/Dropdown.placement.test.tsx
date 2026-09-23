import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Dropdown, DropdownItem, chooseMenuPlacement, chooseMenuLayout, DROPDOWN_BOUNDARY_ATTRIBUTE } from '../Dropdown';

/**
 * Collision flip-up (Admin table Step 2, item 9). A menu opens below its
 * trigger unless that would run past the viewport bottom or the top of a
 * `[data-dropdown-boundary]` element (the site feedback footer, which is
 * painted above the page and would swallow the menu's lower items) AND there
 * is more room above. With no more room above than below it stays down.
 *
 * The pure rule is tested with literal geometry; the component arm fakes the
 * layout jsdom does not have (getBoundingClientRect, offsetHeight,
 * innerHeight) and reads `data-placement` off the rendered menu.
 */

describe('chooseMenuPlacement', () => {
  it('opens down when the menu fits below the trigger', () => {
    expect(
      chooseMenuPlacement({ triggerTop: 100, triggerBottom: 130, menuHeight: 200, bottomLimit: 800 })
    ).toBe('bottom');
  });

  it('opens up when the menu would run past the viewport bottom and there is more room above', () => {
    // Below: 800 - 730 - 4 = 66. Above: 700 - 0 - 4 = 696.
    expect(
      chooseMenuPlacement({ triggerTop: 700, triggerBottom: 730, menuHeight: 200, bottomLimit: 800 })
    ).toBe('top');
  });

  it("opens up when the menu would run into a boundary's top edge, though the viewport has room", () => {
    // The same trigger, the same 1000px viewport: the only difference is the
    // footer's top at 600 standing in as the bottom limit.
    const trigger = { triggerTop: 500, triggerBottom: 530, menuHeight: 200 };
    expect(chooseMenuPlacement({ ...trigger, bottomLimit: 1000 })).toBe('bottom');
    expect(chooseMenuPlacement({ ...trigger, bottomLimit: 600 })).toBe('top');
  });

  it('stays down when neither side fits and the two have equal room (the tie goes to bottom)', () => {
    // Below: 838 - 434 - 4 = 400. Above: 404 - 0 - 4 = 400. Menu 500 fits neither.
    expect(
      chooseMenuPlacement({ triggerTop: 404, triggerBottom: 434, menuHeight: 500, bottomLimit: 838 })
    ).toBe('bottom');
  });

  it('opens on the roomier side when the menu fits neither', () => {
    // Below 300, above 500, menu 600: up. Mirror it: down.
    expect(
      chooseMenuPlacement({ triggerTop: 504, triggerBottom: 534, menuHeight: 600, bottomLimit: 838 })
    ).toBe('top');
    expect(
      chooseMenuPlacement({ triggerTop: 304, triggerBottom: 334, menuHeight: 600, bottomLimit: 838 })
    ).toBe('bottom');
  });

  it('keeps a 4px gap between trigger and menu: an exact fit including the gap opens down, one pixel more flips', () => {
    // Below: 800 - 530 - 4 = 266 exactly.
    const at = { triggerTop: 500, triggerBottom: 530, bottomLimit: 800 };
    expect(chooseMenuPlacement({ ...at, menuHeight: 266 })).toBe('bottom');
    expect(chooseMenuPlacement({ ...at, menuHeight: 267 })).toBe('top');
  });

  it('measures the room above from topLimit when given one', () => {
    // Above: 500 - 300 - 4 = 196; below: 800 - 530 - 4 = 266. Menu 400 fits
    // neither, and below is now the roomier side.
    expect(
      chooseMenuPlacement({ triggerTop: 500, triggerBottom: 530, menuHeight: 400, bottomLimit: 800, topLimit: 300 })
    ).toBe('bottom');
    // Control: without the top limit, above (496) is roomier.
    expect(
      chooseMenuPlacement({ triggerTop: 500, triggerBottom: 530, menuHeight: 400, bottomLimit: 800 })
    ).toBe('top');
  });
});

describe('chooseMenuLayout: the clamp when the menu fits on neither side', () => {
  it('does not clamp a menu that fits below', () => {
    expect(
      chooseMenuLayout({ triggerTop: 100, triggerBottom: 130, menuHeight: 200, bottomLimit: 800 })
    ).toEqual({ placement: 'bottom', maxHeight: null });
  });

  it('does not clamp a menu that flips up and fits above', () => {
    expect(
      chooseMenuLayout({ triggerTop: 700, triggerBottom: 730, menuHeight: 200, bottomLimit: 800 })
    ).toEqual({ placement: 'top', maxHeight: null });
  });

  it('clamps to the room on the roomier side, minus the 4px gap', () => {
    // Above 504 - 4 = 500, below 838 - 534 - 4 = 300: up, clamped to 500.
    expect(
      chooseMenuLayout({ triggerTop: 504, triggerBottom: 534, menuHeight: 600, bottomLimit: 838 })
    ).toEqual({ placement: 'top', maxHeight: 500 });
    // Mirror: down, clamped to 500.
    expect(
      chooseMenuLayout({ triggerTop: 304, triggerBottom: 334, menuHeight: 600, bottomLimit: 838 })
    ).toEqual({ placement: 'bottom', maxHeight: 500 });
  });

  it('floors a fractional room and never goes below 0', () => {
    expect(
      chooseMenuLayout({ triggerTop: 304.6, triggerBottom: 334.6, menuHeight: 600, bottomLimit: 838.9 }).maxHeight
    ).toBe(500);
    expect(
      chooseMenuLayout({ triggerTop: 0, triggerBottom: 900, menuHeight: 600, bottomLimit: 800 }).maxHeight
    ).toBe(0);
  });
});

describe('Dropdown flip-up, as rendered', () => {
  const MENU_HEIGHT = 200;
  let triggerRect = { top: 0, bottom: 0 };
  let menuHeight = MENU_HEIGHT;
  let boundaryTop: number | null = null;

  const rect = (top: number, bottom: number): DOMRect =>
    ({ top, bottom, left: 0, right: 0, width: 0, height: bottom - top, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;

  const fakeLayout = (innerHeight: number) => {
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(innerHeight);
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      if (this.hasAttribute(DROPDOWN_BOUNDARY_ATTRIBUTE) && boundaryTop !== null) {
        return rect(boundaryTop, boundaryTop + 80);
      }
      if (this.classList.contains('dropdown')) return rect(triggerRect.top, triggerRect.bottom);
      return rect(0, 0);
    });
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.getAttribute('role') === 'menu' ? menuHeight : 0;
    });
  };

  const renderMenu = (withBoundary: boolean) =>
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
          <DropdownItem onClick={() => {}}>Edit</DropdownItem>
          <DropdownItem onClick={() => {}}>Delete</DropdownItem>
        </Dropdown>
        {withBoundary && <footer data-dropdown-boundary="">Feedback</footer>}
      </MemoryRouter>
    );

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    boundaryTop = null;
    menuHeight = MENU_HEIGHT;
  });

  it('opens down, unflipped, with room below', () => {
    fakeLayout(900);
    triggerRect = { top: 100, bottom: 130 };
    renderMenu(false);
    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
    const menu = screen.getByRole('menu');
    expect(menu).toHaveAttribute('data-placement', 'bottom');
    expect(menu).not.toHaveClass('dropdown-menu--up');
  });

  it('flips up at the bottom of the viewport', () => {
    fakeLayout(900);
    triggerRect = { top: 800, bottom: 830 };
    renderMenu(false);
    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
    const menu = screen.getByRole('menu');
    expect(menu).toHaveAttribute('data-placement', 'top');
    expect(menu).toHaveClass('dropdown-menu--up');
  });

  it('flips up above a [data-dropdown-boundary] element that is in view, with the viewport clear', () => {
    fakeLayout(900);
    triggerRect = { top: 500, bottom: 530 };
    // Control: without the footer the same trigger opens down (900 - 534 = 366 >= 200).
    renderMenu(false);
    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
    expect(screen.getByRole('menu')).toHaveAttribute('data-placement', 'bottom');
    cleanup();

    boundaryTop = 600;
    renderMenu(true);
    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
    expect(screen.getByRole('menu')).toHaveAttribute('data-placement', 'top');
  });

  it('ignores a boundary that is scrolled above the viewport (top <= 0)', () => {
    fakeLayout(900);
    triggerRect = { top: 500, bottom: 530 };
    boundaryTop = -50;
    renderMenu(true);
    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
    expect(screen.getByRole('menu')).toHaveAttribute('data-placement', 'bottom');
  });

  it('measures afresh on every open: a trigger that moved into room opens down again', () => {
    fakeLayout(900);
    triggerRect = { top: 800, bottom: 830 };
    renderMenu(false);
    const trigger = screen.getByRole('button', { name: 'Actions' });
    fireEvent.click(trigger);
    expect(screen.getByRole('menu')).toHaveAttribute('data-placement', 'top');

    fireEvent.click(trigger); // close
    expect(screen.queryByRole('menu')).toBeNull();
    triggerRect = { top: 100, bottom: 130 };
    fireEvent.click(trigger);
    expect(screen.getByRole('menu')).toHaveAttribute('data-placement', 'bottom');
  });

  it('clamps a menu too tall for either side: max-height to the roomier side, scrolling inside', () => {
    fakeLayout(900);
    triggerRect = { top: 400, bottom: 430 };
    // Control arm: the same trigger with a menu that fits is not clamped, so
    // the clamp below is the rule firing, not a style every menu carries.
    renderMenu(false);
    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
    expect(screen.getByRole('menu')).toHaveAttribute('data-placement', 'bottom');
    expect(screen.getByRole('menu').style.maxHeight).toBe('');
    cleanup();

    // Above 400 - 4 = 396, below 900 - 430 - 4 = 466. A 600px menu fits
    // neither: down, clamped to 466.
    menuHeight = 600;
    renderMenu(false);
    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
    const menu = screen.getByRole('menu');
    expect(menu).toHaveAttribute('data-placement', 'bottom');
    expect(menu.style.maxHeight).toBe('466px');
    expect(menu.style.overflowY).toBe('auto');
  });

  it('re-measures when the window resizes while it is open', () => {
    fakeLayout(900);
    triggerRect = { top: 100, bottom: 130 };
    renderMenu(false);
    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
    expect(screen.getByRole('menu')).toHaveAttribute('data-placement', 'bottom');

    // The viewport shrinks under the open menu: 300 - 130 - 4 = 166 below, too
    // little for 200px, and above is 96 - so still down, but clamped to 166.
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(300);
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    const menu = screen.getByRole('menu');
    expect(menu).toHaveAttribute('data-placement', 'bottom');
    expect(menu.style.maxHeight).toBe('166px');

    // And the trigger moves low: now up.
    triggerRect = { top: 800, bottom: 830 };
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(900);
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(screen.getByRole('menu')).toHaveAttribute('data-placement', 'top');
    expect(screen.getByRole('menu').style.maxHeight).toBe('');
  });

  it('stops listening for resize once closed', () => {
    fakeLayout(900);
    triggerRect = { top: 100, bottom: 130 };
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    renderMenu(false);
    const trigger = screen.getByRole('button', { name: 'Actions' });
    fireEvent.click(trigger);
    const resizeAdds = add.mock.calls.filter(([type]) => type === 'resize');
    expect(resizeAdds).toHaveLength(1);
    fireEvent.click(trigger);
    expect(screen.queryByRole('menu')).toBeNull();
    const listener = resizeAdds[0][1];
    expect(remove.mock.calls.some(([type, fn]) => type === 'resize' && fn === listener)).toBe(true);
  });
});
