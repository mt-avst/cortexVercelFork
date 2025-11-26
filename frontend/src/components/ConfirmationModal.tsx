import React, { memo, useEffect, useCallback, useMemo } from 'react';

interface ConfirmationModalProps {
  show: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmText?: string;
  cancelText?: string;
  variant?: 'danger' | 'warning' | 'primary';
  onConfirm: () => void;
  onCancel: () => void;
  renderCustomContent?: () => React.ReactNode;
}

const BUTTON_CLASS_MAP = {
  danger: 'btn-danger',
  warning: 'btn-warning',
  primary: 'btn-primary'
} as const;

/**
 * ConfirmationModal Component
 * Displays an accessible confirmation dialog with focus trap.
 * Wrapped in React.memo for performance optimization.
 */
const ConfirmationModal: React.FC<ConfirmationModalProps> = memo(({
  show,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  confirmText,
  cancelText,
  variant = 'danger',
  onConfirm,
  onCancel,
  renderCustomContent
}) => {
  const finalConfirmText = confirmText || confirmLabel;
  const finalCancelText = cancelText || cancelLabel;
  const buttonClass = useMemo(() => BUTTON_CLASS_MAP[variant] || 'btn-danger', [variant]);

  // Focus trap effect - must be before any conditional returns
  useEffect(() => {
    if (!show) return;
    
    const modal = document.querySelector('.modal.show');
    if (!modal) return;
    
    const focusableElements = modal.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    const firstElement = focusableElements[0] as HTMLElement;
    const lastElement = focusableElements[focusableElements.length - 1] as HTMLElement;
    
    // Focus first element
    firstElement?.focus();
    
    const handleTabKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      
      if (e.shiftKey) {
        if (document.activeElement === firstElement) {
          e.preventDefault();
          lastElement?.focus();
        }
      } else {
        if (document.activeElement === lastElement) {
          e.preventDefault();
          firstElement?.focus();
        }
      }
    };
    
    modal.addEventListener('keydown', handleTabKey as EventListener);
    
    return () => {
      modal.removeEventListener('keydown', handleTabKey as EventListener);
    };
  }, [show]);

  // Handle backdrop click
  const handleBackdropClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onCancel();
    }
  }, [onCancel]);

  if (!show) return null;

  return (
    <div 
      className="modal show d-block" 
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
      aria-describedby="modal-message"
      tabIndex={-1}
      style={{ backgroundColor: 'rgba(0, 0, 0, 0.7)' }}
      onClick={handleBackdropClick}
    >
      <div className="modal-dialog modal-dialog-centered">
        <div className="modal-content confirmation-modal-content">
          <div className="modal-header border-0 confirmation-modal-header">
            <h5 className="modal-title confirmation-modal-title" id="modal-title">{title}</h5>
            <button 
              type="button" 
              className="btn-close btn-close-white" 
              onClick={onCancel}
              aria-label="Close modal"
            />
          </div>
          <div className="modal-body confirmation-modal-body">
            <p className="mb-0 confirmation-modal-message" id="modal-message">{message}</p>
            {renderCustomContent && renderCustomContent()}
          </div>
          <div className="modal-footer border-0 confirmation-modal-footer">
            <button 
              type="button" 
              className="btn btn-secondary" 
              onClick={onCancel}
            >
              {finalCancelText}
            </button>
            <button 
              type="button" 
              className={`btn ${buttonClass}`} 
              onClick={onConfirm}
            >
              {finalConfirmText}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
});

ConfirmationModal.displayName = 'ConfirmationModal';

export default ConfirmationModal;
