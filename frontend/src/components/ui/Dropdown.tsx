import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useLocation } from 'react-router-dom';

export interface DropdownProps {
  trigger: React.ReactNode;
  children: React.ReactNode;
  align?: 'start' | 'end';
  className?: string;
}

export interface DropdownItemProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  as?: 'button' | 'link';
  href?: string;
  icon?: React.ReactNode;
}

export interface DropdownDividerProps {
  className?: string;
}

export const Dropdown: React.FC<DropdownProps> = ({ 
  trigger, 
  children, 
  align = 'end',
  className = '' 
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const location = useLocation();

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

  // Close on escape key
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && isOpen) {
        setIsOpen(false);
        triggerRef.current?.focus();
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen]);

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

  return (
    <div ref={dropdownRef} className={`dropdown ${className}`}>
      {React.isValidElement(trigger) ? (
        React.cloneElement(trigger as React.ReactElement<any>, {
          ref: triggerRef,
          onClick: handleToggle,
          onKeyDown: handleKeyDown,
          'aria-expanded': isOpen,
          'aria-haspopup': 'true',
          className: `${(trigger as React.ReactElement<any>).props.className || ''} dropdown-toggle`.trim(),
        })
      ) : (
        <button
          ref={triggerRef}
          type="button"
          className="dropdown-toggle"
          onClick={handleToggle}
          onKeyDown={handleKeyDown}
          aria-expanded={isOpen}
          aria-haspopup="true"
        >
          {trigger}
        </button>
      )}
      
      {isOpen && (
        <div 
          className={`dropdown-menu show ${align === 'end' ? 'dropdown-menu-end' : ''}`}
          role="menu"
        >
          {React.Children.map(children, child => {
            if (React.isValidElement(child)) {
              // Pass close handler to items
              return React.cloneElement(child as React.ReactElement<any>, {
                onClick: (e: React.MouseEvent) => {
                  const originalOnClick = (child as React.ReactElement<any>).props.onClick;
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
  ({ children, as = 'button', href, icon, className = '', onClick, ...props }, ref) => {
    const classes = `dropdown-item ${className}`.trim();

    if (as === 'link' && href) {
      return (
        <a 
          href={href} 
          className={classes} 
          role="menuitem"
          onClick={onClick as any}
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

