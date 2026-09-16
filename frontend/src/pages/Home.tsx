import React, { useState, useEffect, useMemo, useCallback, memo } from 'react';
import useDocumentTitle from '../hooks/useDocumentTitle';
import { useNavigate, useLocation } from 'react-router-dom';
import { getOpportunities, updateMyProfile } from '../api/client';
import { Opportunity } from '../api/types';
import { useAuth } from '../contexts/AuthContext';
import {
  filterOpportunitiesForPresentationListing,
  getParticipantFacingType,
  opportunityMatchesRoles,
  resolveActiveMatchRoles,
  sortByClosingSoonest,
} from '../utils/opportunityUtils';
import { logger } from '../utils/logger';
import Landing from './Landing';
import ErrorState from '../components/ErrorState';
import StudyFilters from '../components/StudyFilters';
import { OpportunityRow } from '../components/OpportunityRow';
import RoleProfilePanel from '../components/RoleProfilePanel';
import { CheckCircle, Inbox, Filter } from 'lucide-react';

// Per-viewer convenience only (a dismissed set-once prompt), never authoritative
// state - wrapped in try/catch because storage can be unavailable or throw.
const PROMPT_DISMISS_KEY = 'cortex.profileRolesPrompt.dismissed';
const readPromptDismissed = (): boolean => {
  try {
    return localStorage.getItem(PROMPT_DISMISS_KEY) === '1';
  } catch {
    return false;
  }
};


/**
 * Home Page Component
 * Displays the main landing page and opportunity listings.
 */
const Home: React.FC = memo(() => {
  const navigate = useNavigate();
  const location = useLocation();
  const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>('');
  const [showBookingSuccess, setShowBookingSuccess] = useState(false);
  const [selectedType, setSelectedType] = useState<string>('all');

  // The transient "browse as..." override: client state only, never persisted,
  // resets on reload (it is not seeded from storage). null -> matching falls back
  // to the saved profile.
  const [browseAs, setBrowseAs] = useState<string[] | null>(null);
  const [savingProfile, setSavingProfile] = useState(false);
  const [promptDismissed, setPromptDismissed] = useState<boolean>(readPromptDismissed);

  const { user, refreshAuth } = useAuth();

  // Stable identity: a fresh `?? []` each render would re-run the match memos
  // every time even when the profile is unchanged.
  const profileRoles = useMemo(() => user?.profile_roles ?? [], [user?.profile_roles]);

  const dismissPrompt = useCallback(() => {
    setPromptDismissed(true);
    try {
      localStorage.setItem(PROMPT_DISMISS_KEY, '1');
    } catch {
      // A per-viewer convenience; losing it just re-shows the prompt.
    }
  }, []);

  const saveProfile = useCallback(
    async (roles: string[] | null) => {
      setSavingProfile(true);
      try {
        await updateMyProfile(roles);
        // /api/me reads the profile fresh, so refreshing the auth user pulls the
        // stored roles back and re-runs matching with them.
        await refreshAuth();
      } catch (err: unknown) {
        logger.error('Failed to save the roles/skills profile', {
          component: 'Home',
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      } finally {
        setSavingProfile(false);
      }
    },
    [refreshAuth]
  );

  // Signed-out visitors on "/" get the Landing hero, not this browse view, so
  // their tab reads the brand; signed-in, it names the page they are on.
  useDocumentTitle(user ? 'Browse studies · Cortex' : 'Cortex');

  const presentationListing =
    import.meta.env.VITE_PRESENTATION_LISTING === 'true';

  // Load opportunities function - memoized to prevent recreation
  const loadOpportunities = useCallback(async () => {
    try {
      setLoading(true);
      setError('');
      // The participant Home lists only published studies (Decision 3). A
      // non-admin is scoped to published by the list route regardless, but an
      // admin viewing the participant Home would otherwise receive their own
      // drafts and closed studies too - the route returns every status to an
      // admin when none is named. Asking for 'published' keeps admins seeing
      // the same live list a participant does, and keeps the "N active studies"
      // count (which follows the rendered rows) honest as studies auto-close.
      const data = await getOpportunities({ status: 'published' });
      
      // Ensure data is an array and not HTML
      if (!Array.isArray(data)) {
        setOpportunities([]);
        if (typeof data === 'string' && (data as string).includes('<!doctype html>')) {
          setError('Backend API not available');
        } else {
          setError('Studies are temporarily unavailable. Please try again shortly.');
        }
      } else {
        const list = presentationListing
          ? filterOpportunitiesForPresentationListing(data)
          : data;
        setOpportunities(list);
      }
    } catch (err: unknown) {
      // "Temporarily unavailable, try again shortly" is a claim about the CAUSE,
      // and this catch also covers the filtering above it - so a bug in that
      // filter told every employee on the landing page to come back later,
      // forever, and left nothing behind to say otherwise.
      logger.error('Failed to load the opportunity listing', {
        component: 'Home',
        presentationListing,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      setError('Studies are temporarily unavailable. Please try again shortly.');
      setOpportunities([]); // Set empty array on error
    } finally {
      setLoading(false);
    }
  }, [presentationListing]);

  // Avoid empty "App Testing" view when presentation mode hides test-type studies
  useEffect(() => {
    if (presentationListing && selectedType === 'test') {
      setSelectedType('all');
    }
  }, [presentationListing, selectedType]);

  // Consolidated effect to load opportunities - prevents duplicate API calls
  useEffect(() => {
    // Only load if we're on the home page
    if (location.pathname !== '/') {
      return;
    }

    // Use a small delay to ensure component is fully mounted and navigation is complete
    // Also check if returning from admin to ensure fresh data
    const isReturningFromAdmin = document.referrer.includes('/admin');
    const delay = isReturningFromAdmin ? 150 : 50;

    const timer = setTimeout(() => {
      loadOpportunities();
    }, delay);

    return () => clearTimeout(timer);
    // loadOpportunities is memoised on presentationListing, so this also
    // reloads if that flips - which is correct, since it decides which studies
    // are filtered out of the response.
  }, [location.pathname, loadOpportunities]);


  // Check for booking success parameter and show banner
  useEffect(() => {
    const urlParams = new URLSearchParams(location.search);
    if (urlParams.get('bookingSuccess') === 'true') {
      setShowBookingSuccess(true);
      // Clean up URL parameter
      navigate('/', { replace: true });
    }
    
    // Check for OAuth error parameters
    const authError = urlParams.get('error');
    if (authError === 'google_auth_failed') {
      const errorDetails = urlParams.get('details') || 'Authentication failed';
      setError(`Login failed: ${decodeURIComponent(errorDetails)}. Please try again.`);
      // Clean up URL parameter
      navigate('/', { replace: true });
    }
  }, [location.search, navigate]);

  // Hide banner when location changes (navigation away)
  useEffect(() => {
    if (showBookingSuccess && location.pathname !== '/') {
      setShowBookingSuccess(false);
    }
  }, [location.pathname, showBookingSuccess]);

  // Memoized status badge class getter

  // Memoized filtered and sorted opportunities
  const filteredOpportunities = useMemo(() => {
    const safeOpportunities = Array.isArray(opportunities) ? opportunities : [];

    // Filter by type
    const filteredByType = selectedType === 'all'
      ? safeOpportunities
      : safeOpportunities.filter(opp => {
          const baseType = opp.type?.toLowerCase().replace(/published|draft|closed$/, '') || '';
          return baseType === selectedType.toLowerCase();
        });

    // Closing soonest first. The list used to sort tests to the top and put the
    // study with "4 days left" twelfth, so it rendered urgency and then sorted
    // against it. The bento arrangement that followed - interleaving
    // double-width rows into a three-column grid - went with the grid.
    return sortByClosingSoonest(filteredByType);
  }, [opportunities, selectedType]);

  // The active role set drives highlighting/sort: browse-as override, else saved
  // profile, else none. Matching is advisory - it partitions the ALREADY-FILTERED
  // list into a "For you" group and the rest, and never removes a study. With no
  // active roles, everything falls into `rest` and the view is exactly as before.
  const activeRoles = useMemo(
    () => resolveActiveMatchRoles(browseAs, profileRoles),
    [browseAs, profileRoles]
  );

  const { matched, rest } = useMemo(() => {
    if (activeRoles.length === 0) {
      return { matched: [] as Opportunity[], rest: filteredOpportunities };
    }
    const matchedList: Opportunity[] = [];
    const restList: Opportunity[] = [];
    for (const opp of filteredOpportunities) {
      (opportunityMatchesRoles(opp, activeRoles) ? matchedList : restList).push(opp);
    }
    return { matched: matchedList, rest: restList };
  }, [filteredOpportunities, activeRoles]);

  const hasMatches = matched.length > 0;

  return (
    <>
      {!user && (
        <div className="mb-4">
          <Landing />
        </div>
      )}
      {/* Success Banner */}
      {showBookingSuccess && (
        <div className="booking-success-banner">
          <div className="container">
            <div className="row">
              <div className="col-12">
                <div className="alert alert-success mb-0 text-center">
                  <CheckCircle size={18} className="me-2" />
                  Session booked. Thanks!
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
      
      {/* Cortex Section */}
      {user && (
        <div className="study-listing-page">
          <div className="container mt-4" style={{ position: 'relative', zIndex: 10 }}>
            <div className="row" style={{ marginBottom: 'var(--spacing-section)' }}>
              <div className="col-12">
                <h1 className="mb-3 cortex-page-title" style={{ fontSize: '3.25rem' }}>Browse studies</h1>

              {/* Welcome text */}
              <div className="home-intro-text">
                <p className="home-intro-description text-gray-400">
                  Every action you take here strengthens our group, sparks new ideas and helps us to leverage all the talent and experience that we have across TAG
                </p>
                <p className="home-intro-tagline">
                  Together we turn <em>participation into progress</em>
                </p>
              </div>

              {/* Roles/skills profile + transient "browse as" override. Rendered
                  once the listing has settled (not during load/error), and shown
                  regardless of the study count so a first-time visitor can set a
                  profile before any study advertises an audience. */}
              {!loading && !error && (
                <RoleProfilePanel
                  profileRoles={profileRoles}
                  onSaveProfile={saveProfile}
                  saving={savingProfile}
                  browseAs={browseAs}
                  onBrowseAsChange={setBrowseAs}
                  promptDismissed={promptDismissed}
                  onDismissPrompt={dismissPrompt}
                />
              )}

              {/* Study summary and type filter chips */}
              {!loading && !error && opportunities.length > 0 && (
                <>
                  {/* Counts what is on screen, and names the filter the way the
                      chip does. It read "12 active studies · Showing unmoderated"
                      over a two-row list, one line above a chip reading
                      "Recorded study". */}
                  <p className="study-summary-line">
                    {filteredOpportunities.length} active{' '}
                    {filteredOpportunities.length === 1 ? 'study' : 'studies'}
                    {selectedType !== 'all' &&
                      ` · ${getParticipantFacingType(selectedType)}`}
                  </p>
                  <StudyFilters 
                    currentFilter={selectedType} 
                    onFilterChange={setSelectedType} 
                  />
                </>
              )}
              
              {error && (
                <div className="mb-4">
                  <ErrorState
                    title="Failed to load studies"
                    message={error}
                    actionLabel="Reload Studies"
                    onAction={loadOpportunities}
                    icon="alert-triangle"
                  />
                </div>
              )}
              
              {!loading && !error && opportunities.length === 0 && (
                <div className="empty-state">
                  <Inbox size={48} className="empty-state-icon" />
                  <h4 className="empty-state-title">No studies available</h4>
                  <p className="mb-2">No Cortex activities available at the moment.</p>
                  <p className="empty-state-text">Check back later for new studies to participate!</p>
                </div>
              )}
              
              {!loading && !error && opportunities.length > 0 && filteredOpportunities.length === 0 && (
                <div className="empty-state">
                  <Filter size={48} className="empty-state-icon" />
                  <h4 className="empty-state-title">No studies found</h4>
                  <p className="mb-2">No studies match the selected filter.</p>
                  <button 
                    className="btn btn-outline-primary mt-3" 
                    onClick={() => setSelectedType('all')}
                  >
                    Show All Types
                  </button>
                </div>
              )}
              
              {/* Loading skeleton cards */}
              {loading && (
                <div className="row" aria-busy="true" aria-live="polite" aria-label="Loading studies">
                  {[...Array(6)].map((_, index) => (
                    <div key={index} className="col-md-6 col-lg-4 mb-4">
                      <div className="card h-100">
                        <div className="card-body d-flex flex-column">
                          <div className="mb-2">
                            <div className="badge bg-secondary" style={{ width: '80px', height: '24px' }}></div>
                          </div>
                          <div className="mb-3">
                            <div className="placeholder-glow">
                              <span className="placeholder col-11" style={{ height: '24px' }}></span>
                            </div>
                            <div className="placeholder-glow mt-2">
                              <span className="placeholder col-10" style={{ height: '16px' }}></span>
                            </div>
                          </div>
                          <div className="mt-auto">
                            <div className="placeholder-glow mb-2">
                              <span className="placeholder col-6" style={{ height: '14px' }}></span>
                            </div>
                            <div className="placeholder-glow">
                              <span className="placeholder col-12" style={{ height: '38px' }}></span>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              
              {/* A plain list. The motion.ul that was here staggered nothing:
                  staggerChildren only reaches motion children, these are plain
                  list items, and the parent had no `hidden` variant to animate
                  from. An inert animation wrapper reads as intent that is not
                  actually there. role="list" because `list-style: none` drops
                  the list semantics in Safari + VoiceOver. */}
              {!loading && !error && opportunities.length > 0 && filteredOpportunities.length > 0 && (
                <>
                  {/* "For you": the studies whose advertised audience matches the
                      active role set, lifted to the top. It never hides the rest -
                      every other study is in the list below. Absent when nothing
                      matches or no role set is active. */}
                  {hasMatches && (
                    <section className="opportunity-group" aria-label="Studies for you">
                      <h2 className="opportunity-group__heading">
                        For you
                        <span className="opportunity-group__count"> · {matched.length}</span>
                      </h2>
                      <ul className="opportunity-index" role="list">
                        {matched.map((opportunity: Opportunity) => (
                          <OpportunityRow
                            key={opportunity.id}
                            opportunity={opportunity}
                            role={user?.role}
                            matchesProfile
                          />
                        ))}
                      </ul>
                    </section>
                  )}

                  {rest.length > 0 && (
                    <section className="opportunity-group" aria-label={hasMatches ? 'All other studies' : 'Studies'}>
                      {hasMatches && (
                        <h2 className="opportunity-group__heading">More studies</h2>
                      )}
                      <ul className="opportunity-index" role="list">
                        {rest.map((opportunity: Opportunity) => (
                          <OpportunityRow
                            key={opportunity.id}
                            opportunity={opportunity}
                            role={user?.role}
                          />
                        ))}
                      </ul>
                    </section>
                  )}
                </>
              )}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
});

Home.displayName = 'Home';

export default Home;
