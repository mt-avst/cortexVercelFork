import React, { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import { Link, useLocation } from 'react-router-dom';

export interface DropdownProps {
  trigger: React.ReactNode;
  children: React.ReactNode;
  align?: 'start' | 'end';
  className?: string;
  /** Extra classes for the menu surface itself (positioning, theming). */
  menuClassName?: string;
  /**
   * Opt in to the strict WAI-ARIA menu-button keyboard model: aria-haspopup="menu",
   * focus moves to the first item on open, a roving tabindex with Up/Down/Home/End,
   * and Tab closes. Use ONLY when every popup child is a menuitem (e.g. the admin
   * row-action kebab). The default (off) leaves items as ordinary Tab stops, which
   * is what a popup mixing menuitems with links (e.g. the header nav) needs - the
   * roving model navigates only [role="menuitem"] and would strand those links.
   */
  menu?: boolean;
}

/**
 * Marks an element that a dropdown menu must not open over - the site feedback
 * footer, which sits above the page content in the stacking order, so a menu
 * hanging into it is painted underneath and cannot be clicked. Put it on any
 * such element: `<footer data-dropdown-boundary>`.
 */
export const DROPDOWN_BOUNDARY_ATTRIBUTE = 'data-dropdown-boundary';

export type DropdownPlacement = 'bottom' | 'top';

/**
 * Where a menu opens: below its trigger unless that would run past
 * `bottomLimit` (the viewport bottom, or a boundary's top edge if one is in
 * view) AND there is more room above. A menu too tall for either side opens
 * on the roomier one. Pure, so the collision rule is unit-testable apart from
 * layout.
 */
export interface MenuPlacementInput {
  triggerTop: number;
  triggerBottom: number;
  /** The menu's full content height, unclamped. */
  menuHeight: number;
  bottomLimit: number;
  topLimit?: number;
  gap?: number;
}

export const chooseMenuPlacement = ({
  triggerTop,
  triggerBottom,
  menuHeight,
  bottomLimit,
  topLimit = 0,
  gap = 4,
}: MenuPlacementInput): DropdownPlacement => {
  const roomBelow = bottomLimit - triggerBottom - gap;
  const roomAbove = triggerTop - topLimit - gap;
  if (menuHeight <= roomBelow) return 'bottom';
  return roomAbove > roomBelow ? 'top' : 'bottom';
};

/**
 * The placement plus, when the menu fits on NEITHER side, a max-height equal
 * to the room on the chosen side (the menu then scrolls inside itself rather
 * than running off screen or under the footer). Null when it fits.
 */
export const chooseMenuLayout = (
  input: MenuPlacementInput
): { placement: DropdownPlacement; maxHeight: number | null } => {
  const { triggerTop, triggerBottom, menuHeight, bottomLimit, topLimit = 0, gap = 4 } = input;
  const placement = chooseMenuPlacement(input);
  const room = placement === 'bottom' ? bottomLimit - triggerBottom - gap : triggerTop - topLimit - gap;
  return { placement, maxHeight: menuHeight > room ? Math.max(0, Math.floor(room)) : null };
};

/** The viewport bottom, or the top of the highest boundary element in view. */
const measureBottomLimit = (): number => {
  let limit = window.innerHeight;
  document.querySelectorAll<HTMLElement>(`[${DROPDOWN_BOUNDARY_ATTRIBUTE}]`).forEach((el) => {
    const top = el.getBoundingClientRect().top;
    if (top > 0 && top < limit) limit = top;
  });
  return limit;
};

export interface DropdownItemProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  as?: 'button' | 'link';
  href?: string;
  /**
   * An in-app route: renders a router <Link role="menuitem">, so the item
   * navigates without a reload and a modifier-click opens a new tab. Takes
   * precedence over `as`/`href`. A disabled item stays a button (a link
   * cannot be disabled).
   */
  to?: string;
  icon?: React.ReactNode;
}

export interface DropdownDividerProps {
  className?: string;
}

export const Dropdown: React.FC<DropdownProps> = ({
  trigger,
  children,
  align = 'end',
  className = '',
  menuClassName = '',
  menu = false
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [placement, setPlacement] = useState<DropdownPlacement>('bottom');
  const [maxHeight, setMaxHeight] = useState<number | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const location = useLocation();

  // The focusable menu items, in DOM order, disabled ones excluded. Read from
  // the DOM rather than the React children so dividers, headers and arbitrary
  // wrappers do not have to be understood here - a menuitem is whatever carries
  // role="menuitem", which DropdownItem sets. Managing focus imperatively is the
  // WAI-ARIA menu-button pattern (items are not in the Tab sequence; the menu
  // owns arrow navigation).
  const menuItems = useCallback(
    (): HTMLElement[] =>
      Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? []),
    []
  );

  const focusItemAt = useCallback((items: HTMLElement[], index: number) => {
    items.forEach((el, i) => {
      // Roving tabindex: the focused item is the single Tab stop while open.
      el.tabIndex = i === index ? 0 : -1;
    });
    items[index]?.focus();
  }, []);

  // On open, move focus into the menu (first item). On close, the Escape and
  // item-click paths return focus to the trigger themselves.
  useEffect(() => {
    if (!isOpen || !menu) return;
    const items = menuItems();
    if (items.length > 0) focusItemAt(items, 0);
  }, [isOpen, menu, menuItems, focusItemAt]);

  // Collision flip-up. Measured before paint (layout effect), so a menu that
  // must open upward is never drawn downward first, and again whenever the
  // window resizes while it is open. Reset on close, so every open starts from
  // 'bottom' and measures afresh from where the trigger is now. The larger of
  // scrollHeight and offsetHeight: a clamped menu's scrollHeight is still its
  // full content height, and offsetHeight covers an unclamped one wherever
  // scrollHeight is not laid out.
  const measurePlacement = useCallback(() => {
    const trigger = dropdownRef.current;
    const menuEl = menuRef.current;
    if (!trigger || !menuEl) return;
    const rect = trigger.getBoundingClientRect();
    const layout = chooseMenuLayout({
      triggerTop: rect.top,
      triggerBottom: rect.bottom,
      menuHeight: Math.max(menuEl.scrollHeight, menuEl.offsetHeight),
      bottomLimit: measureBottomLimit(),
    });
    setPlacement(layout.placement);
    setMaxHeight(layout.maxHeight);
  }, []);

  useLayoutEffect(() => {
    if (!isOpen) {
      setPlacement('bottom');
      setMaxHeight(null);
      return;
    }
    measurePlacement();
    window.addEventListener('resize', measurePlacement);
    return () => window.removeEventListener('resize', measurePlacement);
  }, [isOpen, measurePlacement]);

  // Close on route change (e.g., when clicking a Link inside the dropdown)
  useEffect(() => {
    setIsOpen(false);
  }, [location.pathname]);

  // Close on outside click
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  // Return focus to the trigger on close. triggerRef is only wired to the
  // fallback <button>; when a trigger element is passed (the common case - the
  // Header and the admin kebab both do) it is cloned, not the ref target, so
  // focus the `.dropdown-toggle` inside the container, which both branches carry.
  const focusTrigger = useCallback(() => {
    const el =
      triggerRef.current ??
      dropdownRef.current?.querySelector<HTMLElement>('.dropdown-toggle') ??
      null;
    el?.focus();
  }, []);

  // Close on escape key
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && isOpen) {
        setIsOpen(false);
        focusTrigger();
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, focusTrigger]);

  const handleToggle = useCallback(() => {
    setIsOpen(prev => !prev);
  }, []);

  const handleKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handleToggle();
    }
    if (event.key === 'ArrowDown' && !isOpen) {
      event.preventDefault();
      setIsOpen(true);
    }
  }, [isOpen, handleToggle]);

  // Arrow-key roving within the open menu (WAI-ARIA menu-button). Escape is
  // handled by the global effect above (close + return focus to the trigger);
  // Enter activates the focused item natively (a <button> or a link), and
  // Space is handled below.
  const handleMenuKeyDown = useCallback((event: React.KeyboardEvent) => {
    const items = menuItems();
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLElement);
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        focusItemAt(items, current < 0 ? 0 : (current + 1) % items.length);
        break;
      case 'ArrowUp':
        event.preventDefault();
        focusItemAt(items, current <= 0 ? items.length - 1 : current - 1);
        break;
      case 'Home':
        event.preventDefault();
        focusItemAt(items, 0);
        break;
      case 'End':
        event.preventDefault();
        focusItemAt(items, items.length - 1);
        break;
      case ' ': {
        // Space activates the focused item. A <button> does that natively, but
        // a link item (`to`) does not - Space on a link scrolls the page. So
        // take Space over for both: no scroll, and exactly one activation
        // (preventing the default also stops the button's own keyup click).
        event.preventDefault();
        const focused = document.activeElement as HTMLElement | null;
        if (focused && items.includes(focused)) focused.click();
        break;
      }
      case 'Tab':
        // Tab leaves the menu: close it and let focus move on naturally.
        setIsOpen(false);
        break;
      default:
        break;
    }
  }, [menuItems, focusItemAt]);

  return (
    <div ref={dropdownRef} className={`dropdown ${className}`}>
      {React.isValidElement(trigger) ? (
        React.cloneElement(trigger as React.ReactElement<Record<string, unknown>>, {
          // Compose, don't clobber: a trigger may carry its own onClick (e.g. the
          // admin kebab stops the row-click from firing) that must still run.
          onClick: (event: React.MouseEvent) => {
            (trigger as React.ReactElement<{ onClick?: (e: React.MouseEvent) => void }>).props.onClick?.(event);
            handleToggle();
          },
          // Compose, don't clobber, like onClick above - a trigger's own key
          // handler must still run.
          onKeyDown: (event: React.KeyboardEvent) => {
            (trigger as React.ReactElement<{ onKeyDown?: (e: React.KeyboardEvent) => void }>).props.onKeyDown?.(event);
            handleKeyDown(event);
          },
          'aria-expanded': isOpen,
          'aria-haspopup': menu ? 'menu' : 'true',
          className: `${(trigger as React.ReactElement<{ className?: string }>).props.className || ''} dropdown-toggle`.trim(),
        })
      ) : (
        <button
          ref={triggerRef}
          type="button"
          className="dropdown-toggle"
          onClick={handleToggle}
          onKeyDown={handleKeyDown}
          aria-expanded={isOpen}
          aria-haspopup={menu ? 'menu' : 'true'}
        >
          {trigger}
        </button>
      )}

      {isOpen && (
        <div
          ref={menuRef}
          className={`dropdown-menu show ${align === 'end' ? 'dropdown-menu-end' : ''} ${
            placement === 'top' ? 'dropdown-menu--up' : ''
          } ${menuClassName}`.replace(/\s+/g, ' ').trim()}
          data-placement={placement}
          style={maxHeight === null ? undefined : { maxHeight, overflowY: 'auto' }}
          role="menu"
          onKeyDown={menu ? handleMenuKeyDown : undefined}
        >
          {React.Children.map(children, child => {
            if (React.isValidElement(child)) {
              // Pass close handler to items
              const childElement = child as React.ReactElement<{ onClick?: (e: React.MouseEvent) => void }>;
              return React.cloneElement(childElement, {
                onClick: (e: React.MouseEvent) => {
                  const originalOnClick = childElement.props.onClick;
                  if (originalOnClick) {
                    originalOnClick(e);
                  }
                  // Don't close if it's a divider or non-interactive element
                  if (child.type !== DropdownDivider) {
                    setIsOpen(false);
                  }
                }
              });
            }
            return child;
          })}
        </div>
      )}
    </div>
  );
};

export const DropdownItem = React.forwardRef<HTMLButtonElement, DropdownItemProps>(
  ({ children, as = 'button', href, to, icon, className = '', onClick, ...props }, ref) => {
    const classes = `dropdown-item ${className}`.trim();

    if (to && !props.disabled) {
      return (
        <Link
          to={to}
          className={classes}
          role="menuitem"
          title={props.title}
          aria-label={props['aria-label']}
          onClick={onClick as unknown as React.MouseEventHandler<HTMLAnchorElement>}
        >
          {icon && <span className="me-2">{icon}</span>}
          {children}
        </Link>
      );
    }

    if (as === 'link' && href) {
      return (
        <a 
          href={href} 
          className={classes} 
          role="menuitem"
          onClick={onClick as unknown as React.MouseEventHandler<HTMLAnchorElement>}
        >
          {icon && <span className="me-2">{icon}</span>}
          {children}
        </a>
      );
    }

    return (
      <button
        ref={ref}
        type="button"
        className={classes}
        role="menuitem"
        onClick={onClick}
        {...props}
      >
        {icon && <span className="me-2">{icon}</span>}
        {children}
      </button>
    );
  }
);

DropdownItem.displayName = 'DropdownItem';

export const DropdownDivider: React.FC<DropdownDividerProps> = ({ className = '' }) => {
  return <hr className={`dropdown-divider ${className}`} role="separator" />;
};

// Header section for user info display
export interface DropdownHeaderProps extends React.HTMLAttributes<HTMLDivElement> {}

export const DropdownHeader: React.FC<DropdownHeaderProps> = ({ 
  children, 
  className = '', 
  ...props 
}) => {
  return (
    <div className={`dropdown-header px-3 py-2 ${className}`} {...props}>
      {children}
    </div>
  );
};

export default Dropdown;
