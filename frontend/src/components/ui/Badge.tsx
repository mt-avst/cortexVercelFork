import React from 'react';

export type BadgeVariant = 
  | 'default'
  | 'success' 
  | 'warning' 
  | 'danger' 
  | 'info'
  | 'secondary';

export type BadgeSize = 'sm' | 'md' | 'lg';

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
  size?: BadgeSize;
  pill?: boolean;
}

const variantClasses: Record<BadgeVariant, string> = {
  default: 'badge',
  success: 'badge badge-success',
  warning: 'badge badge-warning',
  danger: 'badge badge-danger',
  info: 'badge badge-info',
  secondary: 'badge badge-secondary',
};

const sizeClasses: Record<BadgeSize, string> = {
  sm: 'text-xs',
  md: '',
  lg: 'text-sm px-3 py-1',
};

export const Badge = React.forwardRef<HTMLSpanElement, BadgeProps>(
  ({ children, variant = 'default', size = 'md', pill = true, className = '', ...props }, ref) => {
    const classes = [
      variantClasses[variant],
      sizeClasses[size],
      pill ? 'rounded-full' : 'rounded',
      className,
    ]
      .filter(Boolean)
      .join(' ');

    return (
      <span ref={ref} className={classes} {...props}>
        {children}
      </span>
    );
  }
);

Badge.displayName = 'Badge';

// Lozenge variant - smaller, pill-shaped badges
export interface LozengeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
}

export const Lozenge = React.forwardRef<HTMLSpanElement, LozengeProps>(
  ({ children, variant = 'default', className = '', ...props }, ref) => {
    const variantClass = variant !== 'default' ? `badge-${variant}` : '';
    
    return (
      <span ref={ref} className={`lozenge ${variantClass} ${className}`} {...props}>
        {children}
      </span>
    );
  }
);

Lozenge.displayName = 'Lozenge';

// Status Badge - for displaying opportunity status
export type StatusType = 'published' | 'draft' | 'closed';

export interface StatusBadgeProps extends Omit<BadgeProps, 'variant'> {
  status: StatusType;
}

const statusVariantMap: Record<StatusType, BadgeVariant> = {
  published: 'success',
  draft: 'warning',
  closed: 'secondary',
};

export const StatusBadge = React.forwardRef<HTMLSpanElement, StatusBadgeProps>(
  ({ status, children, ...props }, ref) => {
    return (
      <Badge ref={ref} variant={statusVariantMap[status]} {...props}>
        {children || status.charAt(0).toUpperCase() + status.slice(1)}
      </Badge>
    );
  }
);

StatusBadge.displayName = 'StatusBadge';

export default Badge;

