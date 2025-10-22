import React, { useState, useEffect } from 'react';
import { useNavigate, useParams, Navigate } from 'react-router-dom';

import { useAuth } from '../contexts/AuthContext';
import { createOpportunity, updateOpportunity, getOpportunity } from '../api/client';
import AdminSessionManager from '../components/AdminSessionManager';
import { BasicInfoTab, ContentDetailsTab, ExternalLinkTab, FormActions } from '../components/OpportunityForm';

import { CreateOpportunityRequest, UpdateOpportunityRequest, Opportunity, Session } from '../api/types';

const OpportunityForm: React.FC = () => {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const { user, loading } = useAuth();
  const isEdit = Boolean(id);
  
  const [formData, setFormData] = useState({
    type: 'test' as 'test' | 'poll' | 'survey' | 'question',
    title: '',
    purpose_one_liner: '',
    description_optional: '',
    product_optional: '',
    default_duration_minutes: 30,
    external_link_optional: '',
    participant_type_required: 'any' as 'any' | 'internal' | 'external' | 'specific',
    participant_type_specific_details: '',
    status: 'draft' as 'draft' | 'published'
  });
  
  const [loadingOpportunity, setLoadingOpportunity] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>('');
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});
  const [sessions, setSessions] = useState<Session[]>([]);
  const [opportunityId, setOpportunityId] = useState<string>('');
  const [activeTab, setActiveTab] = useState<number>(1);

  // Define tabs based on opportunity type
  const getTabs = () => {
    const tabs = [
      { id: 1, title: 'Basic Information', description: 'Configure type and status' },
      { id: 2, title: 'Content & Details', description: 'Define opportunity content' }
    ];

    if (['poll', 'survey'].includes(formData.type)) {
      tabs.push({ id: 3, title: 'External Link', description: 'Configure external tool' });
    }

    if (formData.type === 'test' || formData.type === 'question') {
      tabs.push({ 
        id: 3, 
        title: 'Session Management', 
        description: 'Create time slots' 
      });
    }

    return tabs;
  };

  const tabs = getTabs();

  useEffect(() => {
    if (isEdit && id) {
      loadOpportunity();
    }
  }, [isEdit, id]);

  // Ensure activeTab is valid when opportunity type changes
  useEffect(() => {
    const tabs = getTabs();
    const maxTabId = Math.max(...tabs.map(tab => tab.id));
    if (activeTab > maxTabId) {
      setActiveTab(1);
    }
  }, [formData.type, activeTab]);

  const loadOpportunity = async () => {
    if (!id) return;
    
    try {
      setLoadingOpportunity(true);
      setError('');
      const opportunity = await getOpportunity(id);
      
      setFormData({
        type: opportunity.type,
        title: opportunity.title,
        purpose_one_liner: opportunity.purpose_one_liner,
        description_optional: opportunity.description_optional || '',
        product_optional: opportunity.product_optional || '',
        default_duration_minutes: opportunity.default_duration_minutes,
        external_link_optional: opportunity.external_link_optional || '',
        participant_type_required: opportunity.participant_type_required || 'any',
        participant_type_specific_details: opportunity.participant_type_specific_details || '',
        status: opportunity.status === 'closed' ? 'draft' : opportunity.status
      });
      
      setSessions(opportunity.sessions || []);
      setOpportunityId(opportunity.id);
    } catch (err) {
      console.error('Error loading opportunity:', err);
      setError('Failed to load opportunity');
    } finally {
      setLoadingOpportunity(false);
    }
  };

  const validateForm = (): boolean => {
    const errors: Record<string, string> = {};
    
    if (!formData.title.trim()) {
      errors.title = 'Title is required';
    } else if (formData.title.trim().length < 4) {
      errors.title = 'Title must be at least 4 characters';
    } else if (formData.title.trim().length > 140) {
      errors.title = 'Title must be no more than 140 characters';
    }
    
    if (!formData.purpose_one_liner.trim()) {
      errors.purpose_one_liner = 'Purpose is required';
    } else if (formData.purpose_one_liner.trim().length < 10) {
      errors.purpose_one_liner = 'Purpose must be at least 10 characters';
    } else if (formData.purpose_one_liner.trim().length > 180) {
      errors.purpose_one_liner = 'Purpose must be no more than 180 characters';
    }
    
    if (formData.default_duration_minutes < 5 || formData.default_duration_minutes > 240) {
      errors.default_duration_minutes = 'Duration must be between 5 and 240 minutes';
    }
    
    if (formData.status === 'published' && ['poll', 'survey'].includes(formData.type)) {
      if (!formData.external_link_optional.trim()) {
        errors.external_link_optional = 'External link is required for published polls and surveys';
      } else {
        try {
          new URL(formData.external_link_optional);
        } catch {
          errors.external_link_optional = 'External link must be a valid URL';
        }
      }
    }
    
    // Validate specific participant details when required
    if (formData.participant_type_required === 'specific') {
      if (!formData.participant_type_specific_details.trim()) {
        errors.participant_type_specific_details = 'Specific participant criteria is required when "Specific" is selected';
      } else if (formData.participant_type_specific_details.trim().length < 10) {
        errors.participant_type_specific_details = 'Specific participant criteria must be at least 10 characters';
      }
    }
    
    setValidationErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSubmit = async (e?: React.FormEvent) => {
    if (e) {
      e.preventDefault();
    }
    
    if (!validateForm()) {
      return;
    }
    
    try {
      setSaving(true);
      setError('');
      
      const data = {
        ...formData,
        title: formData.title.trim(),
        purpose_one_liner: formData.purpose_one_liner.trim(),
        description_optional: formData.description_optional.trim() || undefined,
        product_optional: formData.product_optional.trim() || undefined,
        external_link_optional: formData.external_link_optional.trim() || undefined,
        participant_type_specific_details: formData.participant_type_specific_details.trim() || undefined
      };
      
      
      let savedOpportunity: Opportunity;
      if (isEdit && id) {
        savedOpportunity = await updateOpportunity(id, data as UpdateOpportunityRequest);
        
        // Save any temporary sessions that were created during editing
        const tempSessions = sessions.filter(session => session.id.startsWith('temp-session-'));
        console.log('🟡 EDIT MODE - Checking for temporary sessions:', {
          totalSessions: sessions.length,
          tempSessions: tempSessions.length,
          tempSessionIds: tempSessions.map(s => s.id),
          opportunityId: savedOpportunity.id
        });
        
        if (tempSessions.length > 0) {
          try {
            const sessionData = tempSessions.map(session => ({
              start_time: session.start_time,
              end_time: session.end_time,
              capacity: session.capacity,
              location_or_meet_link_optional: session.location_or_meet_link_optional || ''
            }));
            
            console.log('🟡 EDIT MODE - Creating sessions:', sessionData);
            const { createSessions } = await import('../api/client');
            await createSessions(savedOpportunity.id, sessionData);
            
            // Reload sessions to get the real IDs
            const updatedOpportunity = await getOpportunity(savedOpportunity.id);
            console.log('🟡 EDIT MODE - Updated opportunity sessions:', updatedOpportunity.sessions?.length || 0);
            setSessions(updatedOpportunity.sessions || []);
          } catch (sessionError) {
            console.error('Error saving sessions:', sessionError);
            setError('Opportunity updated but failed to save sessions. Please add them manually.');
          }
        } else {
          console.log('🟡 EDIT MODE - No temporary sessions to save');
        }
      } else {
        savedOpportunity = await createOpportunity(data as CreateOpportunityRequest);
        setOpportunityId(savedOpportunity.id);
        
        // Save any temporary sessions that were created
        const tempSessions = sessions.filter(session => session.id.startsWith('temp-session-'));
        if (tempSessions.length > 0) {
          try {
            const sessionData = tempSessions.map(session => ({
              start_time: session.start_time,
              end_time: session.end_time,
              capacity: session.capacity,
              location_or_meet_link_optional: session.location_or_meet_link_optional || ''
            }));
            
            const { createSessions } = await import('../api/client');
            await createSessions(savedOpportunity.id, sessionData);
            
            // Reload sessions to get the real IDs
            const updatedOpportunity = await getOpportunity(savedOpportunity.id);
            setSessions(updatedOpportunity.sessions || []);
          } catch (sessionError) {
            console.error('Error saving sessions:', sessionError);
            setError('Opportunity created but failed to save sessions. Please add them manually.');
          }
        }
      }
      
      
      // Navigate to admin page after successful save
      navigate('/admin', { state: { refresh: true } });
      
    } catch (err: any) {
      console.error('Error saving opportunity:', err);
      setError(err.response?.data?.error || 'Failed to save opportunity');
    } finally {
      setSaving(false);
    }
  };

  const handleInputChange = (field: string, value: any) => {
    setFormData(prev => ({
      ...prev,
      [field]: value
    }));
    
    // Clear validation error for this field
    if (validationErrors[field]) {
      setValidationErrors(prev => {
        const newErrors = { ...prev };
        delete newErrors[field];
        return newErrors;
      });
    }
  };

  const handleCancel = () => {
    navigate('/admin', { state: { refresh: true } });
  };

  // Show loading spinner while checking authentication
  if (loading) {
    return (
      <div className="d-flex justify-content-center align-items-center" style={{ minHeight: '50vh' }}>
        <div className="spinner-border text-primary" role="status">
          <span className="visually-hidden">Loading...</span>
        </div>
      </div>
    );
  }

  // Redirect to login if not authenticated
  if (!user) {
    return <Navigate to="/auth/login" replace />;
  }

  // Redirect to home if not admin
  if (user.role !== 'researcher_admin') {
    return <Navigate to="/" replace />;
  }

  // Show loading spinner while loading opportunity for edit
  if (isEdit && loadingOpportunity) {
    return (
      <div className="d-flex justify-content-center align-items-center" style={{ minHeight: '50vh' }}>
        <div className="spinner-border text-primary" role="status">
          <span className="visually-hidden">Loading opportunity...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="container-fluid py-4">
      <div className="row justify-content-center">
        <div className="col-12 col-xl-10">
          <div className="card shadow-sm border-0" style={{ borderRadius: '12px' }}>
            <div className="card-header bg-white border-0 py-4" style={{ borderRadius: '12px 12px 0 0' }}>
              <div className="d-flex align-items-center justify-content-between">
                <div>
                  <h1 className="h3 mb-1 text-dark" style={{ fontSize: '1.75rem', fontWeight: 'bold' }}>
                    {isEdit ? 'Edit Opportunity' : 'Create New Opportunity'}
                  </h1>
                  <p className="text-muted mb-0" style={{ fontSize: '1rem' }}>
                    {isEdit ? 'Update opportunity details and sessions' : 'Set up a new research opportunity'}
                  </p>
                </div>
                <div className="d-flex align-items-center gap-3">
                  <div className="text-muted" style={{ fontSize: '0.9rem' }}>
                    <i className="bi bi-person-circle me-1"></i>
                    {user.name}
                  </div>
                </div>
              </div>
            </div>

            <div className="card-body p-0">
              {error && (
                <div className="alert alert-danger mx-4 mt-4 mb-0" role="alert">
                  <i className="bi bi-exclamation-triangle me-2"></i>
                  {error}
                </div>
              )}

              <form onSubmit={handleSubmit}>
                {/* Tab Navigation */}
                <div className="border-bottom">
                  <nav className="nav nav-tabs border-0" style={{ marginBottom: '-1px', display: 'flex' }}>
                    {tabs.map((tab) => (
                      <button
                        key={tab.id}
                        type="button"
                        className={`nav-link border-0 py-3 px-4 ${
                          activeTab === tab.id ? 'active text-primary fw-bold' : 'text-muted fw-semibold'
                        }`}
                        style={{
                          fontSize: activeTab === tab.id ? '1.1rem' : '0.95rem',
                          backgroundColor: activeTab === tab.id ? 'white' : 'transparent',
                          borderBottom: activeTab === tab.id ? '2px solid #0d6efd' : '2px solid transparent',
                          flex: '1',
                          width: '100%'
                        }}
                        onClick={() => setActiveTab(tab.id)}
                      >
                        <div className="text-center">
                          <div style={{ 
                            fontSize: activeTab === tab.id ? '1.1rem' : 'inherit',
                            fontWeight: activeTab === tab.id ? 'bold' : 'normal'
                          }}>
                            {tab.title}
                          </div>
                          <small 
                            className={activeTab === tab.id ? 'text-primary' : 'text-muted'} 
                            style={{ 
                              fontSize: activeTab === tab.id ? '0.9rem' : '0.8rem',
                              fontWeight: '400'
                            }}
                          >
                            {tab.description}
                          </small>
                        </div>
                      </button>
                    ))}
                  </nav>
                </div>

                {/* Tab Content */}
                <div className="tab-content p-4">
                  {/* Basic Information Tab */}
                  {activeTab === 1 && (
                    <BasicInfoTab
                      formData={formData}
                      validationErrors={validationErrors}
                      handleInputChange={handleInputChange}
                    />
                  )}

                  {/* Content & Details Tab */}
                  {activeTab === 2 && (
                    <ContentDetailsTab
                      formData={formData}
                      validationErrors={validationErrors}
                      handleInputChange={handleInputChange}
                    />
                  )}

                  {/* External Link Tab - Only for polls and surveys */}
                  {activeTab === 3 && ['poll', 'survey'].includes(formData.type) && (
                    <ExternalLinkTab
                      formData={formData}
                      validationErrors={validationErrors}
                      handleInputChange={handleInputChange}
                    />
                  )}

                  {/* Session Management - Only for Tests and Questions */}
                  {activeTab === 3 && (formData.type === 'test' || formData.type === 'question') && (
                    <div className="tab-pane active">
                      <div className="form-section mb-5">
                        <div className="d-flex align-items-center mb-4 pb-3" style={{ borderBottom: 'none' }}>
                          <div>
                            <h2 className="h4 mb-1 text-dark" style={{ fontSize: '1.5rem', lineHeight: '1.3', fontWeight: 'bold' }}>Session Management</h2>
                            <p className="text-muted mb-0" style={{ fontSize: '0.95rem' }}>
                              Create time slots for participants to book
                            </p>
                          </div>
                        </div>
                        
                        <AdminSessionManager
                          opportunityId={opportunityId}
                          sessions={sessions}
                          onSessionsChange={setSessions}
                          defaultDurationMinutes={formData.default_duration_minutes}
                          disabled={saving}
                          isTemporary={!opportunityId}
                        />
                      </div>
                    </div>
                  )}

                  {/* Form Actions - Only show on tab 3 */}
                  {activeTab === 3 && (
                    <FormActions
                      isEdit={isEdit}
                      saving={saving}
                      onCancel={handleCancel}
                      onSubmit={() => handleSubmit()}
                    />
                  )}
                </div>
              </form>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default OpportunityForm;