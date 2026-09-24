import React, { useState, useEffect, useMemo, useCallback, memo } from 'react';
import useDocumentTitle from '../hooks/useDocumentTitle';
import { PARTICIPATE } from '@shared/pageNames';
import { useNavigate, useLocation } from 'react-router-dom';
import { getOpportunities } from '../api/client';
import { Opportunity } from '../api/types';
import { useAuth } from '../contexts/AuthContext';
import {
  deriveFacetOptions,
  EMPTY_FACET_SELECTION,
  facetSelectionCount,
  filterOpportunitiesForPresentationListing,
  opportunityMatchesQuery,
  opportunityPassesFacets,
  sortByClosingSoonest,
  type StudyFacetSelection,
} from '../utils/opportunityUtils';
import { useDebounce } from '../hooks/useDebounce';
import { logger } from '../utils/logger';
import Landing from './Landing';
import ErrorState from '../components/ErrorState';
import StudyFacets from '../components/StudyFacets';
import { OpportunityRow } from '../components/OpportunityRow';
import { CheckCircle, Inbox, Filter } from 'lucide-react';


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
  // Multi-select facets (phase 2): every axis narrows the already-loaded set.
  // Empty selection = the full list, exactly as before facets existed.
  const [facetSelection, setFacetSelection] = useState<StudyFacetSelection>(EMPTY_FACET_SELECTION);

  // Keyword search over title + purpose. The input is controlled on the raw
  // value (responsive typing); the list re-filters on the debounced value, so a
  // burst of keystrokes collapses to one pass over the loaded set.
  const [searchInput, setSearchInput] = useState('');
  const debouncedQuery = useDebounce(searchInput, 200);

  const { user } = useAuth();

  // Signed-out visitors on "/" get the Landing hero, not this browse view, so
  // their tab reads the brand; signed-in, it names the page they are on.
  useDocumentTitle(user ? `${PARTICIPATE} · Cortex` : 'Cortex');

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

  const safeOpportunities = useMemo(
    () => (Array.isArray(opportunities) ? opportunities : []),
    [opportunities]
  );

  // The facet options actually present across the loaded set.
  const facetOptions = useMemo(
    () => deriveFacetOptions(safeOpportunities),
    [safeOpportunities]
  );

  const activeFacetCount = facetSelectionCount(facetSelection);
  const trimmedQuery = debouncedQuery.trim();

  // Memoized filtered and sorted opportunities. The keyword search and the
  // facets both narrow the already-loaded set and are ANDed together (an empty
  // search or an empty axis imposes no constraint), so the list is exactly the
  // studies that match the query and pass every active facet axis.
  const filteredOpportunities = useMemo(() => {
    const narrowed = safeOpportunities.filter(
      (opp) =>
        (activeFacetCount === 0 || opportunityPassesFacets(opp, facetSelection)) &&
        opportunityMatchesQuery(opp, trimmedQuery)
    );

    // Closing soonest first. The list used to sort tests to the top and put the
    // study with "4 days left" twelfth, so it rendered urgency and then sorted
    // against it. The bento arrangement that followed - interleaving
    // double-width rows into a three-column grid - went with the grid.
    return sortByClosingSoonest(narrowed);
  }, [safeOpportunities, facetSelection, activeFacetCount, trimmedQuery]);

  // Clear both the facet selection and the search box in one action - the
  // no-match empty state and the panel's "Clear all" both use it.
  const clearAllFilters = useCallback(() => {
    setFacetSelection(EMPTY_FACET_SELECTION);
    setSearchInput('');
  }, []);

  // No cap notice: the list endpoint returns 413 above PUBLISHED_LIST_CAP rather
  // than a truncated page, so any list that renders is the whole published set and
  // the facets are always authoritative for it (see the constant's note).

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
                <h1 className="mb-3 cortex-page-title" style={{ fontSize: '3.25rem' }}>{PARTICIPATE}</h1>

              {/* Welcome text */}
              <div className="home-intro-text">
                <p className="home-intro-description text-gray-400">
                  Every action you take here strengthens our group, sparks new ideas and helps us to leverage all the talent and experience that we have across TAG
                </p>
                <p className="home-intro-tagline">
                  Together we turn <em>participation into progress</em>
                </p>
              </div>

              {/* Search + facet cluster, then the count line beneath it. The
                  search input reflects typing immediately; the list re-filters
                  on the debounced value. */}
              {!loading && !error && opportunities.length > 0 && (
                <>
                  <StudyFacets
                    options={facetOptions}
                    selection={facetSelection}
                    onChange={setFacetSelection}
                    query={searchInput}
                    onQueryChange={setSearchInput}
                  />

                  {/* Counts what is on screen; names the active search term and
                      filter count so a narrowed list never reads as the whole set.
                      aria-live so a screen-reader user hears the new count as a
                      search or filter narrows the list. */}
                  <p className="study-summary-line" aria-live="polite" aria-atomic="true">
                    {filteredOpportunities.length} active{' '}
                    {filteredOpportunities.length === 1 ? 'study' : 'studies'}
                    {trimmedQuery !== '' && (
                      <>
                        {' '}
                        · matching{' '}
                        <span className="study-summary-line__term">“{trimmedQuery}”</span>
                      </>
                    )}
                    {activeFacetCount > 0 &&
                      ` · ${activeFacetCount} ${activeFacetCount === 1 ? 'filter' : 'filters'}`}
                  </p>
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
                  <p className="mb-2">
                    {trimmedQuery !== ''
                      ? `Nothing matches “${trimmedQuery}”${activeFacetCount > 0 ? ' with the filters you’ve set' : ''}.`
                      : 'No studies match your filters.'}
                  </p>
                  <button className="btn btn-outline-primary mt-3" onClick={clearAllFilters}>
                    {trimmedQuery !== '' ? 'Clear search and filters' : 'Clear filters'}
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
                <ul className="opportunity-index" role="list">
                  {filteredOpportunities.map((opportunity: Opportunity) => (
                    <OpportunityRow
                      key={opportunity.id}
                      opportunity={opportunity}
                      role={user?.role}
                    />
                  ))}
                </ul>
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
