import React from 'react';
import { Info, XCircle, CheckCircle, PlusCircle } from 'lucide-react';

interface FormActionsProps {
  isEdit: boolean;
  saving: boolean;
  onCancel: () => void;
  onSubmit: () => void;
  hideUpdateButton?: boolean; // Hide update button when sessions are being managed
}

const FormActions: React.FC<FormActionsProps> = ({
  isEdit,
  saving,
  onCancel,
  onSubmit,
  hideUpdateButton = false
}) => {
  return (
    <div className="border-top" style={{ paddingTop: '3rem', marginTop: '3rem', position: 'relative' }}>
      <div style={{ display: 'flex', alignItems: 'center', width: '100%' }}>
        <div className="text-muted d-flex align-items-center" style={{ fontSize: '0.9rem' }}>
          <Info size={18} className="me-2" />
          <span>
            {isEdit ? 'Changes will be saved immediately' : 'Opportunity will be created and you can add sessions'}
          </span>
        </div>
        
        <div style={{ 
          display: 'flex', 
          gap: '1rem', 
          position: 'absolute', 
          right: '0', 
          top: '50%', 
          transform: 'translateY(-50%)' 
        }}>
          <button
            type="button"
            className="btn btn-outline-secondary px-4 py-2 fw-semibold"
            onClick={onCancel}
            disabled={saving}
            style={{ fontSize: '0.95rem' }}
          >
            <XCircle size={16} className="me-2" />
            Cancel
          </button>
          
          {!hideUpdateButton && (
            <button
              type="submit"
              className="btn btn-primary px-5 py-2 fw-bold"
              disabled={saving}
              onClick={onSubmit}
              style={{ fontSize: '0.95rem' }}
            >
              {saving ? (
                <>
                  <span className="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>
                  Saving...
                </>
              ) : (
                <>
                  {isEdit ? <CheckCircle size={16} className="me-2" /> : <PlusCircle size={16} className="me-2" />}
                  {isEdit ? 'Update Opportunity' : 'Create Opportunity'}
                </>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default FormActions;
