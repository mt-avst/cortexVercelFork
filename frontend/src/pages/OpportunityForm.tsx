import React, { useState, useEffect } from 'react';
import { useNavigate, useParams, Navigate } from 'react-router-dom';

import { useAuth } from '../contexts/AuthContext';
import { useTheme } from '../contexts/ThemeContext';
import { createOpportunity, updateOpportunity, getOpportunity, getSessions } from '../api/client';
import { logger } from '../utils/logger';
import AdminSessionManager from '../components/AdminSessionManager';
import SlowNeuralBackground from '../components/SlowNeuralBackground';
import { BasicInfoTab, ContentDetailsTab, ExternalLinkTab, FirstHandStudyTab } from '../components/OpportunityForm';
import {
  DEFAULT_CONSENT_TEXT,
  type InlineStudy as InlineStudyPayload,
  type InlineStudyStep
} from '../shared/firsthand/inline-study';

import { CreateOpportunityRequest, UpdateOpportunityRequest, Opportunity, Session } from '../api/types';
import { ArrowLeft, TrendingUp, UserCircle, AlertTriangle, CheckCircle, LayoutGrid, Save, ArrowRight } from 'lucide-react';

/**
 * Unmoderated studies run with logged-in Cortex users, so an external
 * participant type is not representable. Kept in sync (character-for-character)
 * with the authoritative backend rule in routes/opportunities.ts.
 */
export const UNMODERATED_EXTERNAL_PARTICIPANT_ERROR =
  'Unmoderated studies cannot use an external participant type; participants must be logged-in Cortex users';

/**
 * When the opportunity type changes, some fields (and therefore their
 * validation errors) no longer apply. Return a copy of `errors` with any stale
 * type-conditional error removed so it cannot linger on a now-hidden field
 * (blocking submit or resurfacing if the user switches back).
 */
export const clearTypeConditionalErrors = (
  errors: Record<string, string>,
  newType: string
): Record<string, string> => {
  const next = { ...errors };
  // External link only applies to poll/survey/question.
  if (!['poll', 'survey', 'question'].includes(newType)) {
    delete next.external_link_optional;
  }
  // A study - linked or authored inline - only applies to unmoderated.
  if (newType !== 'unmoderated') {
    delete next.firsthand_study_id;
    delete next.inline_study_consent_text;
    Object.keys(next)
      .filter((key) => key.startsWith('inline_study_steps'))
      .forEach((key) => delete next[key]);
  }
  // The unmoderated + external participant (M2) rule only applies to
  // unmoderated, and switching to unmoderated coerces an external participant
  // type back to 'any', so this error is stale after any type change.
  delete next.participant_type_required;
  return next;
};

const OpportunityForm: React.FC<{ allowUserSubmission?: boolean }> = ({ allowUserSubmission = false }) => {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const { user, loading } = useAuth();
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const isEdit = Boolean(id);

  const [formData, setFormData] = useState({
    type: '' as 'test' | 'interview' | 'poll' | 'survey' | 'question' | 'unmoderated' | '',
    title: '',
    purpose_one_liner: '',
    description_optional: '',
    product_optional: '',
    meeting_location_optional: '',
    default_duration_minutes: 30,
    external_link_optional: '',
    participant_type_required: 'any' as 'any' | 'internal' | 'external' | 'specific',
    participant_type_specific_details: '',
    status: allowUserSubmission ? 'draft' as const : 'draft' as 'draft' | 'published',
    display_width: 'single' as 'single' | 'double',
    start_date: '' as string | undefined,
    end_date: '' as string | undefined,
    firsthand_study_id: '' as string | undefined,
    // Unmoderated study authored inline. The backend creates and launches the
    // study from these on save, so a study is not a separate errand.
    inline_study_consent_text: DEFAULT_CONSENT_TEXT as string,
    inline_study_steps: [] as InlineStudyStep[],
    reuse_existing_study: false
  });

  const [loadingOpportunity, setLoadingOpportunity] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>('');
  const [successMessage, setSuccessMessage] = useState<string>('');
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

    if (formData.type === 'unmoderated') {
      tabs.push({ id: 3, title: 'Study Tasks', description: 'What the participant does' });
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
        firsthand_study_id: opportunity.firsthand_study_id || '',
        participant_type_required: opportunity.participant_type_required || 'any',
        participant_type_specific_details: opportunity.participant_type_specific_details || '',
        status: opportunity.status === 'closed' ? 'draft' : opportunity.status,
        display_width: opportunity.display_width || 'single',
        start_date: opportunity.start_date || '',
        end_date: opportunity.end_date || '',
        // Editing always points at the study that already exists; its script is
        // edited in the studies area, so the inline author stays closed.
        inline_study_consent_text: DEFAULT_CONSENT_TEXT,
        inline_study_steps: [],
        reuse_existing_study: true
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
        firsthand_study_id: opportunity.firsthand_study_id || '',
        participant_type_required: opportunity.participant_type_required || 'any' as const,
        participant_type_specific_details: opportunity.participant_type_specific_details || '',
        status: opportunity.status === 'closed' ? 'draft' as const : opportunity.status as 'draft' | 'published',
        display_width: opportunity.display_width || 'single' as 'single' | 'double',
        start_date: opportunity.start_date || '',
        end_date: opportunity.end_date || '',
        inline_study_consent_text: DEFAULT_CONSENT_TEXT,
        inline_study_steps: [] as InlineStudyStep[],
        reuse_existing_study: true
      };
      setOriginalFormData(originalData);

      // Load sessions - always try to load fresh sessions from API when editing
      // The opportunity object might have stale session data
      try {
        logger.debug('EDIT MODE - Loading sessions for opportunity', {
          opportunityId: opportunity.id,
          opportunitySessionsCount: opportunity.sessions?.length || 0,
          willCallAPI: true
        });

        // IMPORTANT: Always request ALL sessions including past ones when editing
        const sessions = await getSessions(opportunity.id, { include_past: true });

        logger.debug('EDIT MODE - Loaded opportunity sessions from API', {
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
          logger.debug('API returned no sessions, using sessions from opportunity object', {
            opportunityId: opportunity.id,
            sessionsCount: opportunity.sessions.length
          });
          setSessions(opportunity.sessions);
        } else {
          logger.debug('No sessions found for opportunity', { opportunityId: opportunity.id });
          setSessions([]);
        }
      } catch (sessionError: unknown) {
        const axiosError = sessionError as { response?: { data?: unknown; status?: number } };
        logger.error('Error loading sessions', {
          error: sessionError instanceof Error ? sessionError : undefined,
          errorMessage: sessionError instanceof Error ? sessionError.message : String(sessionError),
          response: axiosError.response?.data,
          status: axiosError.response?.status
        });

        // Fallback to sessions from opportunity object if API fails
        if (opportunity.sessions && opportunity.sessions.length > 0) {
          logger.debug('Using sessions from opportunity object as fallback', {
            opportunityId: opportunity.id,
            sessionsCount: opportunity.sessions.length
          });
          setSessions(opportunity.sessions);
        } else {
          setSessions([]);
        }
      }
    } catch (err: unknown) {
      const axiosError = err as { response?: { status?: number; data?: { error?: string } } };
      if (axiosError.response?.status === 404) {
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

    // Only validate meeting location and duration for test and interview type opportunities
    if (formData.type === 'test' || formData.type === 'interview') {
      if (!formData.meeting_location_optional || !formData.meeting_location_optional.trim()) {
        errors.meeting_location_optional = 'Meeting location is required for tests and interviews';
      }
      if (formData.default_duration_minutes < 5 || formData.default_duration_minutes > 240) {
        errors.default_duration_minutes = 'Duration must be between 5 and 240 minutes';
      }
    }

    if (formData.status === 'published' && formData.type === 'unmoderated') {
      if (formData.reuse_existing_study || isEdit) {
        if (!formData.firsthand_study_id?.trim()) {
          errors.firsthand_study_id = 'Select a launched study, or untick the reuse box and write the tasks here';
        }
      } else if (formData.inline_study_steps.length === 0) {
        // Named against the thing the author does, not the object model. The
        // backend rejects the same state with an equivalent message.
        errors.inline_study_steps = 'Add at least one task before publishing';
      }
    } else if (formData.status === 'published' && ['poll', 'survey', 'question'].includes(formData.type)) {
      if (!formData.external_link_optional?.trim()) {
        errors.external_link_optional = 'External link is required for published polls, surveys, and questions';
      } else {
        try {
          new URL(formData.external_link_optional);
        } catch {
          errors.external_link_optional = 'External link must be a valid URL';
        }
      }
    }

    // Task content is checked whenever tasks exist, not only at publish: the
    // backend contract rejects an empty prompt or a one-option choice on every
    // save, so a draft with a half-written task would fail server-side with a
    // far less useful message.
    if (formData.type === 'unmoderated' && !formData.reuse_existing_study && !isEdit) {
      formData.inline_study_steps.forEach((step, index) => {
        if (!step.prompt.trim()) {
          errors[`inline_study_steps.${index}.prompt`] = 'Add what the participant should see';
        }
        if (step.type === 'single_choice') {
          const filled = (step.options ?? []).filter((option) => option.trim()).length;
          if (filled < 2) {
            errors[`inline_study_steps.${index}.options`] = 'A choice task needs at least two options';
          }
        }
      });

      if (
        formData.inline_study_steps.length > 0 &&
        !formData.inline_study_consent_text.trim()
      ) {
        errors.inline_study_consent_text = 'Consent text is required';
      }
    }

    // Unmoderated studies run with logged-in Cortex users, so an external
    // participant type is not representable.
    if (formData.type === 'unmoderated' && formData.participant_type_required === 'external') {
      errors.participant_type_required = UNMODERATED_EXTERNAL_PARTICIPANT_ERROR;
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
  const validateField = (fieldName: string, value: string | number | boolean | undefined) => {
    const fieldErrors: Record<string, string> = { ...validationErrors };
    const stringValue = typeof value === 'string' ? value : '';
    const numValue = typeof value === 'number' ? value : 0;

    switch (fieldName) {
      case 'title':
        if (!stringValue.trim()) {
          fieldErrors.title = 'Title is required';
        } else if (stringValue.trim().length < 4) {
          fieldErrors.title = 'Title must be at least 4 characters';
        } else if (stringValue.trim().length > 140) {
          fieldErrors.title = 'Title must be no more than 140 characters';
        } else {
          delete fieldErrors.title;
        }
        break;
      case 'purpose_one_liner':
        if (!stringValue.trim()) {
          fieldErrors.purpose_one_liner = 'Purpose is required';
        } else if (stringValue.trim().length < 10) {
          fieldErrors.purpose_one_liner = 'Purpose must be at least 10 characters';
        } else if (stringValue.trim().length > 180) {
          fieldErrors.purpose_one_liner = 'Purpose must be no more than 180 characters';
        } else {
          delete fieldErrors.purpose_one_liner;
        }
        break;
      case 'meeting_location_optional':
        if (!stringValue.trim()) {
          fieldErrors.meeting_location_optional = 'Meeting location is required';
        } else {
          delete fieldErrors.meeting_location_optional;
        }
        break;
      case 'default_duration_minutes':
        if (formData.type === 'test' || formData.type === 'interview') {
          if (numValue < 5 || numValue > 240) {
            fieldErrors.default_duration_minutes = 'Duration must be between 5 and 240 minutes';
          } else {
            delete fieldErrors.default_duration_minutes;
          }
        }
        break;
      case 'external_link_optional': {
        if (formData.status === 'published' && ['poll', 'survey', 'question'].includes(formData.type)) {
          if (!stringValue.trim()) {
            fieldErrors.external_link_optional = 'External link is required for published polls, surveys, and questions';
          } else {
            try {
              new URL(stringValue);
              delete fieldErrors.external_link_optional;
            } catch {
              fieldErrors.external_link_optional = 'External link must be a valid URL';
            }
          }
        } else {
          delete fieldErrors.external_link_optional;
        }
        break;
      }
      case 'participant_type_specific_details':
        if (formData.participant_type_required === 'specific') {
          if (!stringValue.trim()) {
            fieldErrors.participant_type_specific_details = 'Specific participant criteria is required when "Specific" is selected';
          } else if (stringValue.trim().length < 10) {
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
      (formData.meeting_location_optional || '').trim() !== (originalFormData.meeting_location_optional || '').trim() ||
      formData.default_duration_minutes !== originalFormData.default_duration_minutes ||
      formData.external_link_optional.trim() !== originalFormData.external_link_optional.trim() ||
      (formData.firsthand_study_id || '') !== (originalFormData.firsthand_study_id || '') ||
      formData.participant_type_required !== originalFormData.participant_type_required ||
      formData.participant_type_specific_details.trim() !== originalFormData.participant_type_specific_details.trim() ||
      formData.status !== originalFormData.status ||
      formData.display_width !== originalFormData.display_width ||
      sessions.some(session => session.id.startsWith('temp-session-'))
    );
  };

  const handleSubmit = async (e?: React.FormEvent, skipNavigation = false): Promise<string | undefined> => {
    logger.debug('handleSubmit called', { isEdit, opportunityId, skipNavigation });

    if (e) {
      e.preventDefault();
    }

    // Prevent double-clicks - return early if already saving
    if (saving) {
      logger.debug('Already saving, ignoring duplicate click');
      return undefined;
    }

    if (!validateForm()) {
      logger.error('Validation errors', { validationErrors });
      return undefined;
    }

    try {
      setSaving(true);
      setError('');
      setSuccessMessage('');

      // inline_study is not on the shared CreateOpportunityRequest: shared/types
      // is flattened into one file when copied here, so it cannot import the
      // inline-study contract. Added at the call site instead.
      const data: Partial<CreateOpportunityRequest & {
        display_width?: 'single' | 'double';
        inline_study?: InlineStudyPayload;
      }> = {
        type: formData.type as CreateOpportunityRequest['type'],
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

      // Include start_date, end_date, and firsthand_study_id for external link / unmoderated types
      if (['poll', 'survey', 'question', 'unmoderated'].includes(formData.type)) {
        data.start_date = formData.start_date || undefined;
        data.end_date = formData.end_date || undefined;
      }

      if (formData.type === 'unmoderated') {
        data.firsthand_study_id = formData.firsthand_study_id?.trim() || undefined;

        // Send the authored study only when creating and not reusing. Editing
        // keeps pointing at the existing study, whose script is edited in the
        // studies area; sending both would be ambiguous, and the backend
        // ignores inline_study whenever an id is present.
        const authoringInline =
          !isEdit && !formData.reuse_existing_study && formData.inline_study_steps.length > 0;

        if (authoringInline) {
          data.inline_study = {
            consent_text: formData.inline_study_consent_text.trim(),
            estimated_duration_minutes: formData.default_duration_minutes || undefined,
            steps: formData.inline_study_steps.map((step) => ({
              type: step.type,
              prompt: step.prompt.trim(),
              // Blank rows are UI scaffolding, not content: drop them so a
              // trailing empty option cannot fail the contract's min(1).
              ...(step.type === 'single_choice'
                ? { options: (step.options ?? []).map((o) => o.trim()).filter(Boolean) }
                : {})
            }))
          };
        }
      }

      // Only superadmins can set display_width
      if (user?.role === 'superadmin') {
        data.display_width = formData.display_width;
      }


      let savedOpportunity: Opportunity;
      if (isEdit && id) {
        savedOpportunity = await updateOpportunity(id, data as UpdateOpportunityRequest);

        // Save any temporary sessions that were created during editing (only for test and interview types)
        if (formData.type === 'test' || formData.type === 'interview') {
          const tempSessions = sessions.filter(session => session.id.startsWith('temp-session-'));
          logger.debug('EDIT MODE - Checking for temporary sessions', {
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

              logger.debug('EDIT MODE - Creating sessions', { count: sessionData.length });
              const { createSessions } = await import('../api/client');
              await createSessions(savedOpportunity.id, sessionData);

              // Reload sessions to get the real IDs
              const updatedOpportunity = await getOpportunity(savedOpportunity.id);
              logger.debug('EDIT MODE - Updated opportunity sessions', { count: updatedOpportunity.sessions?.length || 0 });
              setSessions(updatedOpportunity.sessions || []);
            } catch (sessionError: unknown) {
              logger.error('Error saving sessions', {
                error: sessionError instanceof Error ? sessionError : undefined,
                errorMessage: sessionError instanceof Error ? sessionError.message : String(sessionError)
              });
              setError('Opportunity updated but failed to save sessions. Please add them manually.');
            }
          } else {
            logger.debug('EDIT MODE - No temporary sessions to save');
          }
        }
      } else {
        savedOpportunity = await createOpportunity(data as CreateOpportunityRequest);
        setOpportunityId(savedOpportunity.id);

        logger.debug('CREATE MODE - Opportunity created');

        // For types that use external links (no sessions), show success then auto-navigate
        if (['poll', 'survey', 'question', 'unmoderated'].includes(formData.type)) {
          const isDraft = formData.status === 'draft';
          setSuccessMessage(
            isDraft
              ? '⚠️ Study created as DRAFT - Not visible to users yet. Change status to Published to make it visible.'
              : 'Opportunity created successfully!'
          );
          // Auto-navigate to admin dashboard after a brief delay so the user sees the success message
          setTimeout(() => {
            navigate('/admin', { state: { refresh: true, timestamp: Date.now() } });
          }, isDraft ? 3000 : 1500); // Longer delay for draft warning
          return savedOpportunity.id;
        }

        // For test/interview types, AdminSessionManager will handle session creation
        // Return the opportunity ID so AdminSessionManager can create sessions
        return savedOpportunity.id;
      }

      // Update original form data after successful save
      if (isEdit) {
        setOriginalFormData({ ...formData });
        // Show success message for edit mode
        const isDraft = formData.status === 'draft';
        setSuccessMessage(
          isDraft
            ? '⚠️ Changes saved as DRAFT - Not visible to users yet. Change status to Published to make it visible.'
            : 'Changes saved successfully!'
        );
        // Clear success message after timeout (longer for draft warnings)
        setTimeout(() => setSuccessMessage(''), isDraft ? 3000 : 1500);
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
          // For admin, show success message briefly then navigate to admin dashboard
          const isDraft = formData.status === 'draft';
          setSuccessMessage(
            isDraft
              ? `⚠️ Study ${isEdit ? 'updated' : 'created'} as DRAFT - Not visible to users yet. Change status to Published to make it visible.`
              : (isEdit ? 'Opportunity updated successfully!' : 'Opportunity created successfully!')
          );
          // Brief delay to show success feedback before navigation (longer for draft warnings)
          await new Promise(resolve => setTimeout(resolve, isDraft ? 3000 : 1500));
          navigate('/admin', { state: { refresh: true, timestamp: Date.now(), message: isEdit ? 'Opportunity updated!' : 'Opportunity created!' } });
        }
      }

      return savedOpportunity?.id;

    } catch (err: unknown) {
      const axiosError = err as { response?: { data?: { error?: string } } };
      setError(axiosError.response?.data?.error || 'Failed to save opportunity');
    } finally {
      setSaving(false);
    }
  };

  /**
   * Steps are an array, which handleInputChange's scalar signature cannot
   * carry. Kept separate rather than widening that signature so the existing
   * type-change coercions there stay readable.
   */
  const handleStepsChange = (steps: InlineStudyStep[]) => {
    setFormData(prev => ({ ...prev, inline_study_steps: steps }));
    setValidationErrors(prev => {
      // Drop every per-step error on any structural change: indices shift when
      // a step is added, removed or moved, so a kept error would point at the
      // wrong task.
      const next = { ...prev };
      Object.keys(next)
        .filter(key => key.startsWith('inline_study_steps'))
        .forEach(key => delete next[key]);
      return next;
    });
  };

  const handleInputChange = (field: string, value: string | number | boolean | undefined) => {
    setFormData(prev => {
      // Unmoderated is FirstHand-only and runs with logged-in Cortex users, so
      // drop any external link and coerce an 'external' participant type when
      // the type switches to unmoderated (a stale value must not persist).
      if (field === 'type' && value === 'unmoderated') {
        return {
          ...prev,
          type: 'unmoderated' as const,
          external_link_optional: '',
          participant_type_required:
            prev.participant_type_required === 'external' ? 'any' : prev.participant_type_required,
        };
      }
      return { ...prev, [field]: value };
    });

    // Clear validation error for this field immediately when typing
    if (validationErrors[field]) {
      setValidationErrors(prev => {
        const newErrors = { ...prev };
        delete newErrors[field];
        return newErrors;
      });
    }
    // A type change can hide type-specific fields (external link, FirstHand
    // study, the external participant option); drop any stale errors left on
    // fields that no longer apply to the new type.
    if (field === 'type') {
      setValidationErrors(prev => clearTypeConditionalErrors(prev, String(value ?? '')));
    }
  };

  const handleBlur = (field: string, value: string | number | boolean | undefined) => {
    // Validate field on blur
    validateField(field, value);
  };

  const handleCancel = () => {
    navigate('/admin', { state: { refresh: true } });
  };

  // Show loading spinner while checking authentication
  if (loading) {
    return (
      <div className="d-flex justify-content-center align-items-center min-h-50vh" aria-busy="true" aria-live="polite">
        <h1 className="visually-hidden">Create Opportunity</h1>
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
  if (!loading && user && user.role !== 'researcher_admin' && user.role !== 'superadmin' && !allowUserSubmission) {
    return <Navigate to="/" replace />;
  }

  // Show loading spinner while loading opportunity for edit
  if (isEdit && loadingOpportunity) {
    return (
      <div className="d-flex justify-content-center align-items-center min-h-50vh" aria-busy="true" aria-live="polite">
        <h1 className="visually-hidden">Edit Opportunity</h1>
        <div className="spinner-border text-primary" role="status" aria-label="Loading opportunity">
          <span className="visually-hidden">Loading opportunity...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="admin-page-bg">
      {/* Theme-aware Background: Dark Mode gets neural particles */}
      {isDark && <SlowNeuralBackground />}

      <div className="container-fluid py-4 opportunity-form min-h-100vh">
        <div className="row justify-content-center">
          <div className="col-12 col-xl-10">
            {/* Back button */}
            <button
              className="btn btn-outline-secondary mb-3"
              onClick={() => allowUserSubmission ? navigate('/') : navigate('/admin')}
            >
              <ArrowLeft size={16} className="me-1" />
              {allowUserSubmission ? 'Back to Home' : 'Back to Admin Dashboard'}
            </button>

          <div className="card shadow-sm border-0">
            <div className="card-header border-0 py-4">
              <div className="d-flex align-items-center justify-content-between">
                <div>
                  <h1 className="mb-1 form-title form-title-lg">
                    {isEdit ? 'Edit Opportunity' : 'Create New Opportunity'}
                  </h1>
                  <p className="mb-0 form-subtitle form-subtitle-md">
                    {isEdit ? 'Update study details and sessions' : 'Set up a new Cortex research study'}
                  </p>
                </div>
                <div className="d-flex align-items-center gap-3">
                  {/* Analytics button - only for polls, surveys, and unmoderated tests in edit mode */}
                  {isEdit && id && (formData.type === 'poll' || formData.type === 'survey' || formData.type === 'unmoderated') && (
                    <button
                      className="btn btn-outline-primary btn-sm text-sm"
                      onClick={() => navigate(`/admin/opportunities/${id}/analytics`)}
                    >
                      <TrendingUp size={14} className="me-1" />
                      Analytics
                    </button>
                  )}
                  <div className="form-user-info form-user-info-text">
                    <UserCircle size={16} className="me-1" />
                    {user?.name || 'Unknown User'}
                  </div>
                </div>
              </div>
            </div>

            <div className="card-body p-0">
              {error && (
                <div className="alert alert-danger mx-4 mt-4 mb-0" role="alert">
                  <AlertTriangle size={18} className="me-2" />
                  {error}
                </div>
              )}

              {successMessage && (
                <div
                  className={`alert ${successMessage.includes('DRAFT') ? 'alert-warning' : 'alert-success'} d-flex justify-content-between align-items-center mx-4 mt-4 mb-0`}
                  role="alert"
                  aria-live="polite"
                >
                  <div>
                    {successMessage.includes('DRAFT') ? (
                      <AlertTriangle size={18} className="me-2" aria-hidden="true" />
                    ) : (
                      <CheckCircle size={18} className="me-2" aria-hidden="true" />
                    )}
                    {successMessage}
                  </div>
                  <button
                    type="button"
                    className={`btn btn-sm ${successMessage.includes('DRAFT') ? 'btn-outline-warning' : 'btn-outline-success'}`}
                    onClick={() => navigate('/admin', { state: { refresh: true, timestamp: Date.now() } })}
                  >
                    Return to Dashboard
                  </button>
                </div>
              )}

              <form onSubmit={handleSubmit}>
                {/* Tab Navigation */}
                <div className="border-bottom">
                  <nav className="nav nav-tabs border-0 nav-tabs-form">
                    {tabs.map((tab) => (
                      <button
                        key={tab.id}
                        type="button"
                        className={`nav-link border-0 py-3 px-4 opportunity-form-tab ${
                          activeTab === tab.id ? 'active fw-bold' : 'fw-semibold'
                        }`}
                        onClick={() => setActiveTab(tab.id)}
                      >
                        <div className="text-center">
                          <div className={`tab-title tab-title-dynamic ${activeTab === tab.id ? 'active' : ''}`}>
                            {tab.title}
                          </div>
                          <small className={`tab-description tab-description-dynamic ${activeTab === tab.id ? 'active' : ''}`}>
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

                      {/* Display Width Setting - Superadmin Only */}
                      {user?.role === 'superadmin' && (
                        <div className="form-section mb-4 display-settings-section" style={{
                          paddingTop: '1.5rem',
                          marginTop: '1rem'
                        }}>
                          <div className="d-flex align-items-center mb-3">
                            <div>
                              <h3 className="h5 mb-1 section-title" style={{ fontSize: '1.2rem', fontWeight: '600' }}>
                                <LayoutGrid size={18} className="me-2 section-icon" />
                                Display Settings
                              </h3>
                              <p className="mb-0 section-description" style={{ fontSize: '0.875rem' }}>
                                Control how this study appears on the user home page (Superadmin only)
                              </p>
                            </div>
                          </div>

                          <div className="row g-3">
                            <div className="col-md-6">
                              <div className="form-group">
                                <label htmlFor="display_width" className="form-label mb-2" style={{ fontSize: '1rem', fontWeight: '600' }}>
                                  Pod Display Width
                                </label>
                                <div id="display_width-help" className="form-text mb-2" style={{ fontSize: '0.875rem' }}>
                                  Double-width pods are more prominent on the user home page
                                </div>
                                <select
                                  id="display_width"
                                  className="form-select"
                                  style={{ fontSize: '1.04rem', padding: '0.64rem 0.8rem', height: 'auto', maxWidth: '300px' }}
                                  value={formData.display_width}
                                  onChange={(e) => handleInputChange('display_width', e.target.value)}
                                  aria-describedby="display_width-help"
                                >
                                  <option value="single">📦 Single Width - Standard display</option>
                                  <option value="double">📦📦 Double Width - Featured display</option>
                                </select>
                              </div>
                            </div>
                          </div>
                        </div>
                      )}

                      {/* Navigation Buttons for Tab 1 */}
                      <div className="border-top mt-4 pt-4">
                        <div className="d-flex justify-content-between align-items-center gap-2">
                          <div style={{ flex: 1 }}></div>
                          {isEdit && hasChanges() && (
                            <button
                              type="button"
                              className="btn btn-success px-5 py-2 fw-semibold"
                              onClick={() => handleSubmit()}
                              disabled={saving || !!successMessage}
                              style={{ fontSize: '0.95rem' }}
                            >
                              {saving ? (
                                <>
                                  <span className="spinner-border spinner-border-sm me-2" role="status" aria-label="Saving" aria-hidden="true"></span>
                                  Saving...
                                </>
                              ) : (
                                <>
                                  <Save size={16} className="me-2" />
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
                              const errors: Record<string, string> = {};

                              if (!formData.type) {
                                errors.type = 'Please select a research study type';
                              }
                              if (!formData.title.trim()) {
                                errors.title = 'Title is required';
                              } else if (formData.title.trim().length < 4) {
                                errors.title = 'Title must be at least 4 characters';
                              }
                              if (!formData.purpose_one_liner.trim()) {
                                errors.purpose_one_liner = 'Purpose is required';
                              } else if (formData.purpose_one_liner.trim().length < 10) {
                                errors.purpose_one_liner = 'Purpose must be at least 10 characters';
                              }
                              // Only require meeting location for test/interview types
                              if ((formData.type === 'test' || formData.type === 'interview') && !formData.meeting_location_optional?.trim()) {
                                errors.meeting_location_optional = 'Meeting location is required for tests and interviews';
                              }

                              if (Object.keys(errors).length > 0) {
                                setValidationErrors(errors);
                                // Show error message
                                setError('Please fill in all required fields: ' + Object.values(errors).join(', '));
                                // Scroll to top to see errors
                                window.scrollTo({ top: 0, behavior: 'smooth' });
                                return;
                              }

                              setError('');
                              setActiveTab(2);
                            }}
                            style={{ fontSize: '0.95rem' }}
                          >
                            Continue to Details
                            <ArrowRight size={16} className="ms-2" />
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
                            <ArrowLeft size={16} className="me-2" />
                            Back
                          </button>
                          {isEdit && hasChanges() && (
                            <button
                              type="button"
                              className="btn btn-success px-5 py-2 fw-semibold"
                              onClick={() => handleSubmit()}
                              disabled={saving || !!successMessage}
                              style={{ fontSize: '0.95rem' }}
                            >
                              {saving ? (
                                <>
                                  <span className="spinner-border spinner-border-sm me-2" role="status" aria-label="Saving" aria-hidden="true"></span>
                                  Saving...
                                </>
                              ) : (
                                <>
                                  <Save size={16} className="me-2" />
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
                              : formData.type === 'unmoderated'
                              ? 'Continue to Study Setup'
                              : formData.type === 'poll' || formData.type === 'survey' || formData.type === 'question'
                              ? 'Continue to Link Setup'
                              : 'Continue'}
                            <ArrowRight size={16} className="ms-2" />
                          </button>
                        </div>
                      </div>
                    </>
                  )}

                  {/* FirstHand Study Tab - only for unmoderated */}
                  {activeTab === 3 && formData.type === 'unmoderated' && (
                    <>
                      <FirstHandStudyTab
                        formData={formData}
                        validationErrors={validationErrors}
                        handleInputChange={handleInputChange}
                        handleStepsChange={handleStepsChange}
                        isEdit={isEdit}
                      />

                      {/* Navigation Buttons for FirstHand Study Tab */}
                      <div className="border-top mt-4 pt-4">
                        <div className="d-flex justify-content-between align-items-center gap-2">
                          <button
                            type="button"
                            className="btn btn-outline-secondary px-5 py-2 fw-semibold"
                            onClick={() => setActiveTab(2)}
                            style={{ fontSize: '0.95rem' }}
                          >
                            <ArrowLeft size={16} className="me-2" />
                            Back
                          </button>
                          {isEdit && hasChanges() && (
                            <button
                              type="button"
                              className="btn btn-success px-5 py-2 fw-semibold"
                              onClick={() => handleSubmit()}
                              disabled={saving || !!successMessage}
                              style={{ fontSize: '0.95rem' }}
                            >
                              {saving ? (
                                <>
                                  <span className="spinner-border spinner-border-sm me-2" role="status" aria-label="Saving" aria-hidden="true"></span>
                                  Saving...
                                </>
                              ) : (
                                <>
                                  <Save size={16} className="me-2" />
                                  Save Changes
                                </>
                              )}
                            </button>
                          )}
                          <button
                            type="button"
                            className="btn btn-success px-5 py-2 fw-semibold"
                            onClick={() => handleSubmit()}
                            disabled={saving || !!successMessage}
                            style={{ fontSize: '0.95rem' }}
                          >
                            {saving ? (
                              <>
                                <span className="spinner-border spinner-border-sm me-2" role="status" aria-label="Creating" aria-hidden="true"></span>
                                {isEdit ? 'Updating...' : 'Creating...'}
                              </>
                            ) : (
                              <>
                                <CheckCircle size={16} className="me-2" />
                                {isEdit ? 'Update Opportunity' : 'Create Opportunity'}
                              </>
                            )}
                          </button>
                        </div>
                      </div>
                    </>
                  )}

                  {/* External Link Tab - for polls, surveys, and questions (not unmoderated) */}
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
                            <ArrowLeft size={16} className="me-2" />
                            Back
                          </button>
                          {isEdit && hasChanges() && (
                            <button
                              type="button"
                              className="btn btn-success px-5 py-2 fw-semibold"
                              onClick={() => handleSubmit()}
                              disabled={saving || !!successMessage}
                              style={{ fontSize: '0.95rem' }}
                            >
                              {saving ? (
                                <>
                                  <span className="spinner-border spinner-border-sm me-2" role="status" aria-label="Saving" aria-hidden="true"></span>
                                  Saving...
                                </>
                              ) : (
                                <>
                                  <Save size={16} className="me-2" />
                                  Save Changes
                                </>
                              )}
                            </button>
                          )}
                          <button
                            type="button"
                            className="btn btn-success px-5 py-2 fw-semibold"
                            onClick={() => handleSubmit()}
                            disabled={saving || !!successMessage}
                            style={{ fontSize: '0.95rem' }}
                          >
                            {saving ? (
                              <>
                                <span className="spinner-border spinner-border-sm me-2" role="status" aria-label="Creating" aria-hidden="true"></span>
                                {isEdit ? 'Updating...' : 'Creating...'}
                              </>
                            ) : (
                              <>
                                <CheckCircle size={16} className="me-2" />
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
                            <h2 className="h4 mb-1 section-title" style={{ fontSize: '1.5rem', lineHeight: '1.3', fontWeight: '600' }}>Session Management</h2>
                            <p className="mb-0 section-description" style={{ fontSize: '0.95rem' }}>
                              Create time slots for participants to book
                            </p>
                          </div>
                        </div>

                        {isEdit && !opportunityId && !loadingOpportunity && error ? (
                          <div className="alert alert-warning" role="alert">
                            <AlertTriangle size={18} className="me-2" />
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
                            onNavigate={(path) => {
                              const isDraft = formData.status === 'draft';
                              navigate(path, {
                                state: {
                                  refresh: true,
                                  timestamp: Date.now(),
                                  message: isDraft
                                    ? '⚠️ Study created as DRAFT - Not visible to users yet. Change status to Published to make it visible.'
                                    : 'Opportunity created successfully!'
                                }
                              });
                            }}
                            isDraft={formData.status === 'draft'}
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
    </div>
  );
};

export default OpportunityForm;
