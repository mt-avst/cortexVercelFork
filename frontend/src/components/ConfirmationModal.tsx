import React, { memo, useEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useTheme } from '../contexts/ThemeContext';

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
  const { isDarkMode } = useTheme();
  const finalConfirmText = confirmText || confirmLabel;
  const finalCancelText = cancelText || cancelLabel;
  const buttonClass = useMemo(() => BUTTON_CLASS_MAP[variant] || 'btn-danger', [variant]);
  
  // Theme-aware inline styles to ensure proper display
  const modalContentStyle: React.CSSProperties = isDarkMode ? {
    backgroundColor: 'rgba(10, 9, 26, 0.95)',
    border: '1px solid rgba(255, 255, 255, 0.1)',
    boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)',
    backdropFilter: 'blur(16px)',
    borderRadius: '16px'
  } : {
    backgroundColor: '#FFFFFF',
    border: '1px solid rgba(0, 0, 0, 0.1)',
    boxShadow: '0 8px 32px rgba(0, 0, 0, 0.15)',
    backdropFilter: 'blur(16px)',
    borderRadius: '16px'
  };

  const modalHeaderStyle: React.CSSProperties = isDarkMode ? {
    backgroundColor: 'transparent',
    borderBottom: '1px solid rgba(255, 255, 255, 0.1)'
  } : {
    backgroundColor: '#FFFFFF',
    borderBottom: '1px solid rgba(0, 0, 0, 0.1)'
  };

  const modalBodyStyle: React.CSSProperties = isDarkMode ? {
    backgroundColor: 'transparent'
  } : {
    backgroundColor: '#FFFFFF'
  };

  const modalFooterStyle: React.CSSProperties = isDarkMode ? {
    backgroundColor: 'transparent',
    borderTop: '1px solid rgba(255, 255, 255, 0.1)'
  } : {
    backgroundColor: '#FFFFFF',
    borderTop: '1px solid rgba(0, 0, 0, 0.1)'
  };

  const titleStyle: React.CSSProperties = {
    color: isDarkMode ? '#FFFFFF' : '#1A1A1A'
  };

  const messageStyle: React.CSSProperties = {
    color: isDarkMode ? 'rgba(255, 255, 255, 0.85)' : '#374151'
  };

  const cancelBtnStyle: React.CSSProperties = isDarkMode ? {
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    borderColor: 'rgba(255, 255, 255, 0.2)',
    color: '#FFFFFF'
  } : {
    backgroundColor: 'rgba(0, 0, 0, 0.05)',
    borderColor: 'rgba(0, 0, 0, 0.15)',
    color: '#374151'
  };

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

  const modalContent = (
    <div 
      className="modal show d-block" 
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
      aria-describedby="modal-message"
      tabIndex={-1}
      style={{ 
        backgroundColor: 'rgba(0, 0, 0, 0.7)',
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        zIndex: 1050,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center'
      }}
      onClick={handleBackdropClick}
    >
      <div className="modal-dialog modal-dialog-centered" style={{ margin: 'auto', maxWidth: '500px', width: '100%' }}>
        <div className="modal-content confirmation-modal-content" style={modalContentStyle}>
          <div className="modal-header border-0 confirmation-modal-header" style={modalHeaderStyle}>
            <h5 className="modal-title confirmation-modal-title" id="modal-title" style={titleStyle}>{title}</h5>
            <button 
              type="button" 
              className={`btn-close ${isDarkMode ? 'btn-close-white' : ''}`}
              onClick={onCancel}
              aria-label="Close modal"
            />
          </div>
          <div className="modal-body confirmation-modal-body" style={modalBodyStyle}>
            <p className="mb-0 confirmation-modal-message" id="modal-message" style={messageStyle}>{message}</p>
            {renderCustomContent && renderCustomContent()}
          </div>
          <div className="modal-footer border-0 confirmation-modal-footer" style={modalFooterStyle}>
            <button 
              type="button" 
              className="btn btn-secondary confirmation-modal-cancel-btn" 
              style={cancelBtnStyle}
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

  // Use portal to render modal at document body level
  return createPortal(modalContent, document.body);
});

ConfirmationModal.displayName = 'ConfirmationModal';

export default ConfirmationModal;
