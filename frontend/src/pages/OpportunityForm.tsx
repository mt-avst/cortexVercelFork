import React, { useState, useEffect } from 'react';
import { useNavigate, useParams, Navigate } from 'react-router-dom';

import { useAuth } from '../contexts/AuthContext';
import { createOpportunity, updateOpportunity, getOpportunity, getSessions } from '../api/client';
import AdminSessionManager from '../components/AdminSessionManager';
import { BasicInfoTab, ContentDetailsTab, ExternalLinkTab } from '../components/OpportunityForm';

import { CreateOpportunityRequest, UpdateOpportunityRequest, Opportunity, Session } from '../api/types';

const OpportunityForm: React.FC<{ allowUserSubmission?: boolean }> = ({ allowUserSubmission = false }) => {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const { user, loading } = useAuth();
  const isEdit = Boolean(id);
  
  const [formData, setFormData] = useState({
    type: '' as 'test' | 'interview' | 'poll' | 'survey' | 'question' | '',
    title: '',
    purpose_one_liner: '',
    description_optional: '',
    product_optional: '',
    meeting_location_optional: '',
    default_duration_minutes: 30,
    external_link_optional: '',
    participant_type_required: 'any' as 'any' | 'internal' | 'external' | 'specific',
    participant_type_specific_details: '',
    status: allowUserSubmission ? 'draft' as const : 'draft' as 'draft' | 'published'
  });
  
  const [loadingOpportunity, setLoadingOpportunity] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>('');
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});
  const [sessions, setSessions] = useState<Session[]>([]);
  const [opportunityId, setOpportunityId] = useState<string>('');
  const [activeTab, setActiveTab] = useState<number>(1);
  const [originalFormData, setOriginalFormData] = useState<typeof formData | null>(null);

  // Define tabs based on opportunity type
  const getTabs = () => {
    const tabs = [
      { id: 1, title: 'Basic Information', description: 'Configure type and status' },
      { id: 2, title: 'Content & Details', description: 'Define opportunity content' }
    ];

    if (['poll', 'survey', 'question'].includes(formData.type)) {
      tabs.push({ id: 3, title: 'External Link', description: 'Configure external tool' });
    }

    if (formData.type === 'test' || formData.type === 'interview') {
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

  // Set active tab when editing existing opportunity
  // Only user tests and interviews should go to tab 3 (Session Management)
  // All other types should go to tab 1 (Basic Information)
  useEffect(() => {
    if (isEdit && opportunityId && formData.type) {
      if (formData.type === 'test' || formData.type === 'interview') {
        setActiveTab(3); // Go to tab 3 (Session Management) for tests and interviews
      } else {
        setActiveTab(1); // Go to tab 1 (Basic Information) for all other types
      }
    }
  }, [isEdit, opportunityId, formData.type]);

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
        meeting_location_optional: opportunity.meeting_location_optional || '',
        default_duration_minutes: opportunity.default_duration_minutes,
        external_link_optional: opportunity.external_link_optional || '',
        participant_type_required: opportunity.participant_type_required || 'any',
        participant_type_specific_details: opportunity.participant_type_specific_details || '',
        status: opportunity.status === 'closed' ? 'draft' : opportunity.status
      });
      
      setOpportunityId(opportunity.id);
      
      // Store original form data for change detection
      const originalData = {
        type: opportunity.type,
        title: opportunity.title,
        purpose_one_liner: opportunity.purpose_one_liner,
        description_optional: opportunity.description_optional || '',
        product_optional: opportunity.product_optional || '',
        meeting_location_optional: opportunity.meeting_location_optional || '',
        default_duration_minutes: opportunity.default_duration_minutes,
        external_link_optional: opportunity.external_link_optional || '',
        participant_type_required: opportunity.participant_type_required || 'any' as const,
        participant_type_specific_details: opportunity.participant_type_specific_details || '',
        status: opportunity.status === 'closed' ? 'draft' as const : opportunity.status as 'draft' | 'published'
      };
      setOriginalFormData(originalData);
      
      // Load sessions - always try to load fresh sessions from API when editing
      // The opportunity object might have stale session data
      try {
        console.log('🔍 EDIT MODE - Loading sessions for opportunity:', {
          opportunityId: opportunity.id,
          opportunitySessionsCount: opportunity.sessions?.length || 0,
          willCallAPI: true
        });
        
        // IMPORTANT: Always request ALL sessions including past ones when editing
        const sessions = await getSessions(opportunity.id, { include_past: true });
        
        console.log('🔍 EDIT MODE - Loaded opportunity sessions from API:', {
          opportunityId: opportunity.id,
          sessionsCount: sessions.length,
          sessions: sessions.map(s => ({
            id: s.id,
            start_time: s.start_time,
            end_time: s.end_time,
            capacity: s.capacity,
            booked_count: s.booked_count,
            opportunity_id: s.opportunity_id
          })),
          opportunitySessionsCount: opportunity.sessions?.length || 0
        });
        
        if (sessions.length > 0) {
          setSessions(sessions);
        } else if (opportunity.sessions && opportunity.sessions.length > 0) {
          // Fallback to sessions from opportunity object if API returns empty but opportunity has sessions
          console.log('⚠️ API returned no sessions, using sessions from opportunity object:', {
            opportunityId: opportunity.id,
            sessionsCount: opportunity.sessions.length
          });
          setSessions(opportunity.sessions);
        } else {
          console.log('⚠️ No sessions found for opportunity:', opportunity.id);
          setSessions([]);
        }
      } catch (sessionError: any) {
        console.error('Error loading sessions:', sessionError);
        console.error('Session error details:', {
          message: sessionError.message,
          response: sessionError.response?.data,
          status: sessionError.response?.status
        });
        
        // Fallback to sessions from opportunity object if API fails
        if (opportunity.sessions && opportunity.sessions.length > 0) {
          console.log('⚠️ Using sessions from opportunity object as fallback:', {
            opportunityId: opportunity.id,
            sessionsCount: opportunity.sessions.length
          });
          setSessions(opportunity.sessions);
        } else {
          setSessions([]);
        }
      }
    } catch (err: any) {
      console.error('Error loading opportunity:', err);
      if (err.response?.status === 404) {
        setError('Opportunity not found. It may have been deleted or you may not have permission to edit it.');
      } else {
        setError('Failed to load opportunity');
      }
    } finally {
      setLoadingOpportunity(false);
    }
  };
  

  const validateForm = (): boolean => {
    const errors: Record<string, string> = {};
    
    // Validate research study type
    if (!formData.type) {
      errors.type = 'Please select a research study type';
    }
    
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
    
    // Validate meeting location (required)
    if (!formData.meeting_location_optional || !formData.meeting_location_optional.trim()) {
      errors.meeting_location_optional = 'Meeting location is required';
    }
    
    // Only validate duration for test and interview type opportunities
    if (formData.type === 'test' || formData.type === 'interview') {
      if (formData.default_duration_minutes < 5 || formData.default_duration_minutes > 240) {
        errors.default_duration_minutes = 'Duration must be between 5 and 240 minutes';
      }
    }
    
    if (formData.status === 'published' && ['poll', 'survey', 'question'].includes(formData.type)) {
      if (!formData.external_link_optional.trim()) {
        errors.external_link_optional = 'External link is required for published polls, surveys, and questions';
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

  // Validate single field
  const validateField = (fieldName: string, value: any) => {
    const fieldErrors: Record<string, string> = { ...validationErrors };
    
    switch (fieldName) {
      case 'title':
        if (!value.trim()) {
          fieldErrors.title = 'Title is required';
        } else if (value.trim().length < 4) {
          fieldErrors.title = 'Title must be at least 4 characters';
        } else if (value.trim().length > 140) {
          fieldErrors.title = 'Title must be no more than 140 characters';
        } else {
          delete fieldErrors.title;
        }
        break;
      case 'purpose_one_liner':
        if (!value.trim()) {
          fieldErrors.purpose_one_liner = 'Purpose is required';
        } else if (value.trim().length < 10) {
          fieldErrors.purpose_one_liner = 'Purpose must be at least 10 characters';
        } else if (value.trim().length > 180) {
          fieldErrors.purpose_one_liner = 'Purpose must be no more than 180 characters';
        } else {
          delete fieldErrors.purpose_one_liner;
        }
        break;
      case 'meeting_location_optional':
        if (!value || !value.trim()) {
          fieldErrors.meeting_location_optional = 'Meeting location is required';
        } else {
          delete fieldErrors.meeting_location_optional;
        }
        break;
      case 'default_duration_minutes':
        if (formData.type === 'test' || formData.type === 'interview') {
          if (value < 5 || value > 240) {
            fieldErrors.default_duration_minutes = 'Duration must be between 5 and 240 minutes';
          } else {
            delete fieldErrors.default_duration_minutes;
          }
        }
        break;
      case 'external_link_optional':
        if (formData.status === 'published' && ['poll', 'survey', 'question'].includes(formData.type)) {
          if (!value.trim()) {
            fieldErrors.external_link_optional = 'External link is required for published polls, surveys, and questions';
          } else {
            try {
              new URL(value);
              delete fieldErrors.external_link_optional;
            } catch {
              fieldErrors.external_link_optional = 'External link must be a valid URL';
            }
          }
        } else {
          delete fieldErrors.external_link_optional;
        }
        break;
      case 'participant_type_specific_details':
        if (formData.participant_type_required === 'specific') {
          if (!value.trim()) {
            fieldErrors.participant_type_specific_details = 'Specific participant criteria is required when "Specific" is selected';
          } else if (value.trim().length < 10) {
            fieldErrors.participant_type_specific_details = 'Specific participant criteria must be at least 10 characters';
          } else {
            delete fieldErrors.participant_type_specific_details;
          }
        } else {
          delete fieldErrors.participant_type_specific_details;
        }
        break;
    }
    
    setValidationErrors(fieldErrors);
  };

  // Check if form has been modified
  const hasChanges = (): boolean => {
    if (!isEdit || !originalFormData) return false;
    
    return (
      formData.type !== originalFormData.type ||
      formData.title.trim() !== originalFormData.title.trim() ||
      formData.purpose_one_liner.trim() !== originalFormData.purpose_one_liner.trim() ||
      formData.description_optional.trim() !== originalFormData.description_optional.trim() ||
      formData.product_optional.trim() !== originalFormData.product_optional.trim() ||
      formData.meeting_location_optional.trim() !== originalFormData.meeting_location_optional.trim() ||
      formData.default_duration_minutes !== originalFormData.default_duration_minutes ||
      formData.external_link_optional.trim() !== originalFormData.external_link_optional.trim() ||
      formData.participant_type_required !== originalFormData.participant_type_required ||
      formData.participant_type_specific_details.trim() !== originalFormData.participant_type_specific_details.trim() ||
      formData.status !== originalFormData.status ||
      sessions.some(session => session.id.startsWith('temp-session-'))
    );
  };

  const handleSubmit = async (e?: React.FormEvent, skipNavigation = false): Promise<string | undefined> => {
    console.log('🚀 handleSubmit called', { isEdit, opportunityId, formData, skipNavigation });
    
    if (e) {
      e.preventDefault();
    }
    
    if (!validateForm()) {
      console.error('Validation errors:', validationErrors);
      return undefined;
    }
    
    try {
      setSaving(true);
      setError('');
      
      const data: any = {
        type: formData.type,
        title: formData.title.trim(),
        purpose_one_liner: formData.purpose_one_liner.trim(),
        description_optional: formData.description_optional.trim() || undefined,
        product_optional: formData.product_optional.trim() || undefined,
        meeting_location_optional: formData.meeting_location_optional.trim(),
        external_link_optional: formData.external_link_optional.trim() || undefined,
        participant_type_required: formData.participant_type_required,
        participant_type_specific_details: formData.participant_type_specific_details.trim() || undefined,
        status: allowUserSubmission ? 'draft' : formData.status
      };
      
      // Only include default_duration_minutes for test and interview types
      if (formData.type === 'test' || formData.type === 'interview') {
        data.default_duration_minutes = formData.default_duration_minutes;
      }
      
      
      let savedOpportunity: Opportunity;
      if (isEdit && id) {
        savedOpportunity = await updateOpportunity(id, data as UpdateOpportunityRequest);
        
        // Save any temporary sessions that were created during editing (only for test and interview types)
        if (formData.type === 'test' || formData.type === 'interview') {
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
        }
      } else {
        savedOpportunity = await createOpportunity(data as CreateOpportunityRequest);
        setOpportunityId(savedOpportunity.id);
        
        // Note: Session creation is now handled by AdminSessionManager after opportunity is saved
        // This keeps the session creation logic in one place and ensures proper timing
        console.log('✅ CREATE MODE - Opportunity created, AdminSessionManager will handle session creation');
        
        // Return the opportunity ID so AdminSessionManager can create sessions
        return savedOpportunity.id;
      }
      
      // Update original form data after successful save
      if (isEdit) {
        setOriginalFormData({ ...formData });
      }
      
      // For edit mode, return the existing opportunity ID
      if (isEdit && savedOpportunity) {
        return savedOpportunity.id;
      }
      
      // Navigate after successful save
      if (!skipNavigation) {
        if (allowUserSubmission) {
          // For user submissions, navigate to home with success message
          navigate('/', { state: { message: 'Research request submitted successfully! It will be reviewed by an admin.' } });
        } else {
          // For admin, navigate to admin dashboard
          navigate('/admin', { state: { refresh: true, timestamp: Date.now() } });
        }
      }
      
      return savedOpportunity?.id;
      
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
    
    // Clear validation error for this field immediately when typing
    if (validationErrors[field]) {
      setValidationErrors(prev => {
        const newErrors = { ...prev };
        delete newErrors[field];
        return newErrors;
      });
    }
  };

  const handleBlur = (field: string, value: any) => {
    // Validate field on blur
    validateField(field, value);
  };

  const handleCancel = () => {
    navigate('/admin', { state: { refresh: true } });
  };

  // Show loading spinner while checking authentication
  if (loading) {
    return (
      <div className="d-flex justify-content-center align-items-center" style={{ minHeight: '50vh' }} aria-busy="true" aria-live="polite">
        <div className="spinner-border text-primary" role="status" aria-label="Loading">
          <span className="visually-hidden">Loading...</span>
        </div>
      </div>
    );
  }

  // Redirect to login if not authenticated
  if (!loading && !user) {
    return <Navigate to="/auth/login" replace />;
  }

  // Redirect to home if not admin (unless allowUserSubmission is true)
  if (!loading && user && user.role !== 'researcher_admin' && !allowUserSubmission) {
    return <Navigate to="/" replace />;
  }

  // Show loading spinner while loading opportunity for edit
  if (isEdit && loadingOpportunity) {
    return (
      <div className="d-flex justify-content-center align-items-center" style={{ minHeight: '50vh' }} aria-busy="true" aria-live="polite">
        <div className="spinner-border text-primary" role="status" aria-label="Loading opportunity">
          <span className="visually-hidden">Loading opportunity...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="container-fluid py-4" style={{ backgroundColor: '#0A091A', minHeight: '100vh' }}>
      <style>
        {`
          /* Opportunity Form dark theme styling */
          .opportunity-form .card {
            background-color: rgba(255, 255, 255, 0.05) !important;
            backdrop-filter: blur(16px);
            -webkit-backdrop-filter: blur(16px);
            border: 1px solid rgba(255, 255, 255, 0.1) !important;
            border-radius: 16px !important;
          }
          .opportunity-form .card-header {
            background-color: transparent !important;
            border-bottom: 1px solid rgba(255, 255, 255, 0.1) !important;
          }
          .opportunity-form .card-body {
            background-color: transparent !important;
          }
          .opportunity-form h1,
          .opportunity-form h2,
          .opportunity-form h3,
          .opportunity-form h4 {
            color: #E0E0E0 !important;
          }
          .opportunity-form .text-muted {
            color: rgba(224, 224, 224, 0.7) !important;
          }
          .opportunity-form .form-label,
          .opportunity-form label {
            color: #E0E0E0 !important;
          }
          .opportunity-form .form-control,
          .opportunity-form .form-select {
            background-color: rgba(255, 255, 255, 0.05) !important;
            border: 1px solid rgba(255, 255, 255, 0.1) !important;
            color: #E0E0E0 !important;
          }
          .opportunity-form .form-control:focus,
          .opportunity-form .form-select:focus {
            background-color: rgba(255, 255, 255, 0.08) !important;
            border-color: #FF4E50 !important;
            color: #E0E0E0 !important;
            box-shadow: 0 0 0 0.2rem rgba(255, 78, 80, 0.25) !important;
          }
          .opportunity-form .form-control::placeholder {
            color: rgba(224, 224, 224, 0.5) !important;
          }
          .opportunity-form .form-select option {
            background-color: #0A091A !important;
            color: #E0E0E0 !important;
          }
          .opportunity-form .nav-tabs .nav-link {
            color: #E0E0E0 !important;
            background-color: transparent !important;
            border-bottom-color: transparent !important;
          }
          .opportunity-form .nav-tabs .nav-link.active {
            background-color: rgba(255, 255, 255, 0.05) !important;
            border-bottom-color: #FF4E50 !important;
            color: #FF4E50 !important;
          }
          .opportunity-form .border-top,
          .opportunity-form .border-bottom {
            border-color: rgba(255, 255, 255, 0.1) !important;
          }
          .opportunity-form .btn-primary {
            background-color: #FF4E50 !important;
            border-color: #FF4E50 !important;
            color: #FFFFFF !important;
          }
          .opportunity-form .btn-primary:hover {
            background-color: #ff5e60 !important;
            border-color: #ff5e60 !important;
          }
          .opportunity-form .btn-success {
            background-color: #28a745 !important;
            border-color: #28a745 !important;
          }
          .opportunity-form .btn-outline-secondary {
            border-color: rgba(255, 255, 255, 0.2) !important;
            color: #E0E0E0 !important;
          }
          .opportunity-form .btn-outline-secondary:hover {
            background-color: rgba(255, 255, 255, 0.1) !important;
            border-color: rgba(255, 255, 255, 0.3) !important;
            color: #FFFFFF !important;
          }
          .opportunity-form .btn-outline-primary {
            border-color: #FF4E50 !important;
            color: #FF4E50 !important;
          }
          .opportunity-form .btn-outline-primary:hover {
            background-color: #FF4E50 !important;
            color: #FFFFFF !important;
          }
          .opportunity-form .alert {
            background-color: rgba(255, 255, 255, 0.05) !important;
            border-color: rgba(255, 255, 255, 0.1) !important;
            color: #E0E0E0 !important;
          }
        `}
      </style>
      <div className="row justify-content-center opportunity-form">
        <div className="col-12 col-xl-10">
          {/* Back button */}
          <button 
            className="btn btn-outline-secondary mb-3"
            onClick={() => allowUserSubmission ? navigate('/') : navigate('/admin')}
            style={{
              backgroundColor: 'transparent',
              borderColor: 'rgba(255, 255, 255, 0.2)',
              color: '#E0E0E0'
            }}
          >
            <i className="bi bi-arrow-left me-1"></i>
            {allowUserSubmission ? 'Back to Home' : 'Back to Admin Dashboard'}
          </button>
          
          <div className="card shadow-sm border-0">
            <div className="card-header border-0 py-4">
              <div className="d-flex align-items-center justify-content-between">
                <div>
                  <h1 className="mb-1" style={{ fontSize: '1.75rem', fontWeight: '600', color: '#E0E0E0' }}>
                    {isEdit ? 'Edit Opportunity' : 'Create New Opportunity'}
                  </h1>
                  <p className="mb-0" style={{ fontSize: '1rem', color: 'rgba(224, 224, 224, 0.7)' }}>
                    {isEdit ? 'Update opportunity details and sessions' : 'Set up a new AdaptaLabs activity'}
                  </p>
                </div>
                <div className="d-flex align-items-center gap-3">
                  {/* Analytics button - only for polls and surveys in edit mode */}
                  {isEdit && id && (formData.type === 'poll' || formData.type === 'survey') && (
                    <button
                      className="btn btn-outline-primary btn-sm"
                      onClick={() => navigate(`/admin/opportunities/${id}/analytics`)}
                      style={{ fontSize: '0.875rem' }}
                    >
                      <i className="bi bi-graph-up me-1"></i>
                      Analytics
                    </button>
                  )}
                  <div style={{ fontSize: '0.9rem', color: 'rgba(224, 224, 224, 0.7)' }}>
                    <i className="bi bi-person-circle me-1"></i>
                    {user?.name || 'Unknown User'}
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
                          activeTab === tab.id ? 'active fw-bold' : 'fw-semibold'
                        }`}
                        style={{
                          fontSize: activeTab === tab.id ? '1.1rem' : '0.95rem',
                          backgroundColor: activeTab === tab.id ? 'rgba(255, 255, 255, 0.05)' : 'transparent',
                          borderBottom: activeTab === tab.id ? '2px solid #FF4E50' : '2px solid transparent',
                          flex: '1',
                          width: '100%',
                          color: activeTab === tab.id ? '#FF4E50' : '#E0E0E0',
                          transition: 'all 0.2s ease-in-out'
                        }}
                        onClick={() => setActiveTab(tab.id)}
                      >
                        <div className="text-center">
                          <div style={{ 
                            fontSize: activeTab === tab.id ? '1.1rem' : 'inherit',
                            fontWeight: activeTab === tab.id ? '600' : '500'
                          }}>
                            {tab.title}
                          </div>
                          <small 
                            style={{ 
                              fontSize: activeTab === tab.id ? '0.9rem' : '0.8rem',
                              fontWeight: '400',
                              color: activeTab === tab.id ? 'rgba(255, 78, 80, 0.8)' : 'rgba(224, 224, 224, 0.7)'
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
                    <>
                      <BasicInfoTab
                        formData={formData}
                        validationErrors={validationErrors}
                        handleInputChange={handleInputChange}
                        handleBlur={handleBlur}
                        allowUserSubmission={allowUserSubmission}
                      />
                      {/* Navigation Buttons for Tab 1 */}
                      <div className="border-top mt-4 pt-4">
                        <div className="d-flex justify-content-between align-items-center gap-2">
                          <div style={{ flex: 1 }}></div>
                          {isEdit && hasChanges() && (
                            <button
                              type="button"
                              className="btn btn-success px-5 py-2 fw-semibold"
                              onClick={() => handleSubmit()}
                              disabled={saving}
                              style={{ fontSize: '0.95rem' }}
                            >
                              {saving ? (
                                <>
                                  <span className="spinner-border spinner-border-sm me-2" role="status" aria-label="Saving" aria-hidden="true"></span>
                                  Saving...
                                </>
                              ) : (
                                <>
                                  <i className="bi bi-save me-2"></i>
                                  Save Changes
                                </>
                              )}
                            </button>
                          )}
                          <button
                            type="button"
                            className="btn btn-primary px-5 py-2 fw-semibold"
                            onClick={() => {
                              // Validate basic info before continuing
                              if (!validateForm()) {
                                console.log('Validation failed:', validationErrors);
                                return;
                              }
                              setActiveTab(2);
                            }}
                            style={{ fontSize: '0.95rem' }}
                          >
                            Continue to Details
                            <i className="bi bi-arrow-right ms-2"></i>
                          </button>
                        </div>
                      </div>
                    </>
                  )}

                  {/* Content & Details Tab */}
                  {activeTab === 2 && (
                    <>
                      <ContentDetailsTab
                        formData={formData}
                        validationErrors={validationErrors}
                        handleInputChange={handleInputChange}
                        handleBlur={handleBlur}
                      />
                      {/* Navigation Buttons for Tab 2 */}
                      <div className="border-top mt-4 pt-4">
                        <div className="d-flex justify-content-between align-items-center gap-2">
                          <button
                            type="button"
                            className="btn btn-outline-secondary px-5 py-2 fw-semibold"
                            onClick={() => setActiveTab(1)}
                            style={{ fontSize: '0.95rem' }}
                          >
                            <i className="bi bi-arrow-left me-2"></i>
                            Back
                          </button>
                          {isEdit && hasChanges() && (
                            <button
                              type="button"
                              className="btn btn-success px-5 py-2 fw-semibold"
                              onClick={() => handleSubmit()}
                              disabled={saving}
                              style={{ fontSize: '0.95rem' }}
                            >
                              {saving ? (
                                <>
                                  <span className="spinner-border spinner-border-sm me-2" role="status" aria-label="Saving" aria-hidden="true"></span>
                                  Saving...
                                </>
                              ) : (
                                <>
                                  <i className="bi bi-save me-2"></i>
                                  Save Changes
                                </>
                              )}
                            </button>
                          )}
                          <button
                            type="button"
                            className="btn btn-primary px-5 py-2 fw-semibold"
                            onClick={() => {
                              // Determine next tab based on opportunity type
                              const tabs = getTabs();
                              const nextTab = tabs.find(tab => tab.id > 2)?.id || 2;
                              setActiveTab(nextTab);
                            }}
                            style={{ fontSize: '0.95rem' }}
                          >
                            {formData.type === 'test' || formData.type === 'interview' 
                              ? 'Continue to Session Setup' 
                              : formData.type === 'poll' || formData.type === 'survey' || formData.type === 'question'
                              ? 'Continue to Link Setup'
                              : 'Continue'}
                            <i className="bi bi-arrow-right ms-2"></i>
                          </button>
                        </div>
                      </div>
                    </>
                  )}

                  {/* External Link Tab - Only for polls, surveys, and questions */}
                  {activeTab === 3 && ['poll', 'survey', 'question'].includes(formData.type) && (
                    <>
                      <ExternalLinkTab
                        formData={formData}
                        validationErrors={validationErrors}
                        handleInputChange={handleInputChange}
                      />
                      
                      {/* Navigation Buttons for External Link Tab */}
                      <div className="border-top mt-4 pt-4">
                        <div className="d-flex justify-content-between align-items-center gap-2">
                          <button
                            type="button"
                            className="btn btn-outline-secondary px-5 py-2 fw-semibold"
                            onClick={() => setActiveTab(2)}
                            style={{ fontSize: '0.95rem' }}
                          >
                            <i className="bi bi-arrow-left me-2"></i>
                            Back
                          </button>
                          {isEdit && hasChanges() && (
                            <button
                              type="button"
                              className="btn btn-success px-5 py-2 fw-semibold"
                              onClick={() => handleSubmit()}
                              disabled={saving}
                              style={{ fontSize: '0.95rem' }}
                            >
                              {saving ? (
                                <>
                                  <span className="spinner-border spinner-border-sm me-2" role="status" aria-label="Saving" aria-hidden="true"></span>
                                  Saving...
                                </>
                              ) : (
                                <>
                                  <i className="bi bi-save me-2"></i>
                                  Save Changes
                                </>
                              )}
                            </button>
                          )}
                          <button
                            type="button"
                            className="btn btn-success px-5 py-2 fw-semibold"
                            onClick={() => handleSubmit()}
                            disabled={saving}
                            style={{ fontSize: '0.95rem' }}
                          >
                            {saving ? (
                              <>
                                <span className="spinner-border spinner-border-sm me-2" role="status" aria-label="Creating" aria-hidden="true"></span>
                                {isEdit ? 'Updating...' : 'Creating...'}
                              </>
                            ) : (
                              <>
                                <i className="bi bi-check-circle me-2"></i>
                                {isEdit ? 'Update Opportunity' : 'Create Opportunity'}
                              </>
                            )}
                          </button>
                        </div>
                      </div>
                    </>
                  )}

                  {/* Session Management - Only for Tests and Interviews */}
                  {activeTab === 3 && (formData.type === 'test' || formData.type === 'interview') && (
                    <>
                      <div className="form-section mb-5">
                        <div className="d-flex align-items-center mb-4 pb-3" style={{ borderBottom: 'none' }}>
                          <div>
                            <h2 className="h4 mb-1" style={{ fontSize: '1.5rem', lineHeight: '1.3', fontWeight: '600', color: '#E0E0E0' }}>Session Management</h2>
                            <p className="mb-0" style={{ fontSize: '0.95rem', color: 'rgba(224, 224, 224, 0.7)' }}>
                              Create time slots for participants to book
                            </p>
                          </div>
                        </div>
                        
                        {isEdit && !opportunityId && !loadingOpportunity && error ? (
                          <div className="alert alert-warning" role="alert">
                            <i className="bi bi-exclamation-triangle me-2"></i>
                            Cannot load session management. The opportunity may not exist or you may not have permission to edit it.
                          </div>
                        ) : (
                          <AdminSessionManager
                            opportunityId={opportunityId}
                            sessions={sessions}
                            onSessionsChange={setSessions}
                            defaultDurationMinutes={formData.default_duration_minutes}
                            disabled={saving || (isEdit && loadingOpportunity)}
                            isTemporary={!isEdit || !opportunityId}
                            onOpportunitySave={() => handleSubmit(undefined, true)}
                            onBack={() => setActiveTab(2)}
                            onNavigate={(path) => navigate(path, { state: { refresh: true, timestamp: Date.now() } })}
                          />
                        )}
                      </div>
                    </>
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