import React from 'react';

interface ConfirmationModalProps {
  show: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'danger' | 'warning' | 'primary';
  onConfirm: () => void;
  onCancel: () => void;
}

const ConfirmationModal: React.FC<ConfirmationModalProps> = ({
  show,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'danger',
  onConfirm,
  onCancel
}) => {
  if (!show) return null;

  const getButtonClass = () => {
    switch (variant) {
      case 'danger': return 'btn-danger';
      case 'warning': return 'btn-warning';
      case 'primary': return 'btn-primary';
      default: return 'btn-danger';
    }
  };

  return (
    <div 
      className="modal show d-block" 
      tabIndex={-1}
      style={{ backgroundColor: 'rgba(0, 0, 0, 0.5)' }}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onCancel();
        }
      }}
    >
      <div className="modal-dialog modal-dialog-centered">
        <div className="modal-content">
          <div className="modal-header border-0" style={{ backgroundColor: 'white' }}>
            <h5 className="modal-title" style={{ color: '#000000' }}>{title}</h5>
            <button 
              type="button" 
              className="btn-close" 
              onClick={onCancel}
              aria-label="Close"
            ></button>
          </div>
          <div className="modal-body" style={{ backgroundColor: 'white' }}>
            <p className="mb-0" style={{ color: '#000000' }}>{message}</p>
          </div>
          <div className="modal-footer border-0">
            <button 
              type="button" 
              className="btn btn-secondary" 
              onClick={onCancel}
            >
              {cancelLabel}
            </button>
            <button 
              type="button" 
              className={`btn ${getButtonClass()}`} 
              onClick={onConfirm}
            >
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ConfirmationModal;

