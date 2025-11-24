import React from 'react';

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

const ConfirmationModal: React.FC<ConfirmationModalProps> = ({
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
  if (!show) return null;

  const getButtonClass = () => {
    switch (variant) {
      case 'danger': return 'btn-danger';
      case 'warning': return 'btn-warning';
      case 'primary': return 'btn-primary';
      default: return 'btn-danger';
    }
  };

  // Focus trap effect
  React.useEffect(() => {
    if (show) {
      const modal = document.querySelector('.modal.show');
      const focusableElements = modal?.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      const firstElement = focusableElements?.[0] as HTMLElement;
      const lastElement = focusableElements?.[focusableElements.length - 1] as HTMLElement;
      
      // Focus first element
      firstElement?.focus();
      
      const handleTabKey = (e: Event) => {
        const keyEvent = e as KeyboardEvent;
        if (keyEvent.key !== 'Tab') return;
        
        if (keyEvent.shiftKey) {
          if (document.activeElement === firstElement) {
            keyEvent.preventDefault();
            lastElement?.focus();
          }
        } else {
          if (document.activeElement === lastElement) {
            keyEvent.preventDefault();
            firstElement?.focus();
          }
        }
      };
      
      modal?.addEventListener('keydown', handleTabKey);
      
      return () => {
        modal?.removeEventListener('keydown', handleTabKey);
      };
    }
  }, [show]);

  return (
    <div 
      className="modal show d-block" 
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
      aria-describedby="modal-message"
      tabIndex={-1}
      style={{ backgroundColor: 'rgba(0, 0, 0, 0.7)' }}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onCancel();
        }
      }}
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
            ></button>
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
              className={`btn ${getButtonClass()}`} 
              onClick={onConfirm}
            >
              {finalConfirmText}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ConfirmationModal;

