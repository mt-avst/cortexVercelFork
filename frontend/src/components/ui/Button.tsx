import React from 'react';

export type ButtonVariant = 
  | 'primary' 
  | 'secondary' 
  | 'outline-primary' 
  | 'outline-secondary'
  | 'outline-danger'
  | 'danger' 
  | 'success' 
  | 'warning'
  | 'link'
  | 'glass';

export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  fullWidth?: boolean;
  as?: 'button' | 'a';
  href?: string;
}

const variantClasses: Record<ButtonVariant, string> = {
  primary: 'btn-primary',
  secondary: 'btn-secondary',
  'outline-primary': 'btn-outline-primary',
  'outline-secondary': 'btn-outline-secondary',
  'outline-danger': 'btn-outline-danger',
  danger: 'btn-danger',
  success: 'btn-success',
  warning: 'btn-warning',
  link: 'btn-link',
  glass: 'btn-glass',
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: 'btn-sm',
  md: '',
  lg: 'btn-lg',
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      children,
      variant = 'primary',
      size = 'md',
      loading = false,
      fullWidth = false,
      disabled,
      className = '',
      as = 'button',
      href,
      type = 'button',
      ...props
    },
    ref
  ) => {
    const classes = [
      'btn',
      variantClasses[variant],
      sizeClasses[size],
      fullWidth ? 'w-full' : '',
      loading ? 'loading' : '',
      className,
    ]
      .filter(Boolean)
      .join(' ');

    const isDisabled = disabled || loading;

    if (as === 'a' && href) {
      return (
        <a
          href={href}
          className={classes}
          aria-disabled={isDisabled}
          {...(props as React.AnchorHTMLAttributes<HTMLAnchorElement>)}
        >
          {loading && <span className="spinner-border spinner-border-sm me-2" aria-hidden="true" />}
          {children}
        </a>
      );
    }

    return (
      <button
        ref={ref}
        type={type}
        className={classes}
        disabled={isDisabled}
        aria-busy={loading}
        {...props}
      >
        {loading && <span className="spinner-border spinner-border-sm me-2" aria-hidden="true" />}
        {children}
      </button>
    );
  }
);

Button.displayName = 'Button';

export default Button;

