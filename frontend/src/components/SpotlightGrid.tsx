import React, { useRef, useCallback, memo } from 'react';
import { motion, type Variants } from 'framer-motion';

interface SpotlightGridProps {
  children: React.ReactNode;
  className?: string;
}

interface SpotlightCardProps {
  children: React.ReactNode;
  index: number;
  className?: string;
  style?: React.CSSProperties;
  onClick?: () => void;
  onKeyDown?: (e: React.KeyboardEvent) => void;
  tabIndex?: number;
  role?: string;
  'aria-label'?: string;
  isFeatured?: boolean;
}

/**
 * SpotlightGrid - Container that provides the grid layout
 * Handles the overall grid structure for spotlight cards
 */
export const SpotlightGrid = memo<SpotlightGridProps>(({ children, className = '' }) => {
  return (
    <div className={`spotlight-grid bento-grid ${className}`}>
      {children}
    </div>
  );
});

SpotlightGrid.displayName = 'SpotlightGrid';

/**
 * SpotlightCard - Individual card with mouse-tracking border glow
 * Creates the "flashlight" effect where borders illuminate based on cursor position
 */
export const SpotlightCard = memo<SpotlightCardProps>(({
  children,
  index,
  className = '',
  style,
  onClick,
  onKeyDown,
  tabIndex,
  role,
  'aria-label': ariaLabel,
  isFeatured = false
}) => {
  const cardRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);
  const pendingRef = useRef<{ x: number; y: number } | null>(null);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!cardRef.current) return;
    const rect = cardRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    pendingRef.current = { x, y };
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const el = cardRef.current;
      const pending = pendingRef.current;
      if (el && pending) {
        el.style.setProperty('--spotlight-x', `${pending.x}px`);
        el.style.setProperty('--spotlight-y', `${pending.y}px`);
        el.style.setProperty('--spotlight-opacity', '1');
        pendingRef.current = null;
      }
    });
  }, []);

  const handleMouseLeave = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    pendingRef.current = null;
    if (!cardRef.current) return;
    cardRef.current.style.setProperty('--spotlight-opacity', '0');
  }, []);

  return (
    <motion.div
      ref={cardRef}
      className={`spotlight-card ${isFeatured ? 'spotlight-card-featured' : ''} card card-clickable ${className}`}
      style={{
        '--spotlight-x': '0px',
        '--spotlight-y': '0px',
        '--spotlight-opacity': '0',
        ...style
      } as React.CSSProperties}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      onClick={onClick}
      onKeyDown={onKeyDown}
      tabIndex={tabIndex}
      role={role}
      aria-label={ariaLabel}
      initial={{ opacity: 0, y: 24, scale: 0.96 }}
      animate={{ 
        opacity: 1, 
        y: 0, 
        scale: 1,
        transition: {
          type: 'spring',
          damping: 25,
          stiffness: 200,
          delay: index * 0.08
        }
      }}
      whileHover={{ 
        y: -6,
        transition: { duration: 0.2, ease: 'easeOut' }
      }}
    >
      {/* Spotlight border gradient overlay */}
      <div className="spotlight-border" aria-hidden="true" />
      
      {/* Inner glow effect */}
      <div className="spotlight-glow" aria-hidden="true" />
      
      {/* Card content */}
      <div className="spotlight-card-content">
        {children}
      </div>
    </motion.div>
  );
});

SpotlightCard.displayName = 'SpotlightCard';

export default SpotlightGrid;

