import React, { useState, useEffect } from 'react';
import { Navigate, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { getOpportunities, deleteOpportunity, duplicateOpportunity } from '../api/client';
import { Opportunity } from '../api/types';
import { formatOpportunityType, getTypeBadgeClass } from '../utils/opportunityUtils';

const Admin: React.FC = () => {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
  const [loadingOpportunities, setLoadingOpportunities] = useState(true);
  const [error, setError] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [openDropdownId, setOpenDropdownId] = useState<string | null>(null);

  const loadOpportunities = async () => {
    try {
      setLoadingOpportunities(true);
      setError('');
      const params = statusFilter ? { status: statusFilter } : {};
      const data = await getOpportunities(params);
      setOpportunities(data);
    } catch (err) {
      console.error('Error loading opportunities:', err);
      setError('Failed to load opportunities');
    } finally {
      setLoadingOpportunities(false);
    }
  };

  useEffect(() => {
    if (user?.role === 'researcher_admin') {
      loadOpportunities();
    }
  }, [user, statusFilter]);

  // Refresh opportunities when returning from editing
  useEffect(() => {
    if (location.state?.refresh && user?.role === 'researcher_admin') {
      loadOpportunities();
      // Clear the refresh state to prevent unnecessary re-renders
      navigate(location.pathname, { replace: true, state: {} });
    }
  }, [location.state, user, navigate, location.pathname]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest('.dropdown')) {
        closeDropdown();
      }
    };

    if (openDropdownId) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [openDropdownId]);

  const handleDelete = async (id: string, title: string) => {
    if (!window.confirm(`Are you sure you want to delete "${title}"? This action cannot be undone.`)) {
      return;
    }

    try {
      await deleteOpportunity(id);
      await loadOpportunities();
    } catch (err) {
      console.error('Error deleting opportunity:', err);
      setError('Failed to delete opportunity');
    }
  };

  const handleDuplicate = async (id: string) => {
    try {
      await duplicateOpportunity(id);
      await loadOpportunities();
    } catch (err) {
      console.error('Error duplicating opportunity:', err);
      setError('Failed to duplicate opportunity');
    }
  };

  const toggleDropdown = (id: string) => {
    setOpenDropdownId(openDropdownId === id ? null : id);
  };

  const closeDropdown = () => {
    setOpenDropdownId(null);
  };

  const getStatusBadgeClass = (status: string) => {
    switch (status) {
      case 'published': return 'badge bg-success';
      case 'draft': return 'badge bg-warning';
      case 'closed': return 'badge bg-secondary';
      default: return 'badge bg-secondary';
    }
  };

  if (loading) {
    return <div className="card text-center">Loading...</div>;
  }

  if (!user) {
    return <Navigate to="/" replace />;
  }

  if (user.role !== 'researcher_admin') {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="container mt-4">
      <div className="row">
        <div className="col-12">
          <div className="card">
            <div className="card-header d-flex justify-content-between align-items-center" style={{ marginBottom: '2rem' }}>
              <h1 className="h3 mb-0">Admin Dashboard</h1>
              <button 
                className="btn btn-primary"
                onClick={() => navigate('/admin/opportunities/new')}
              >
                Create Opportunity
              </button>
            </div>
            
            <div className="card-body">
              {/* Status Filter */}
              <div className="row mb-4">
                <div className="col-md-4">
                  <select
                    id="statusFilter"
                    className="form-select"
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value)}
                    style={{ 
                      fontSize: '1.1em', 
                      padding: '0.75rem 1rem',
                      height: 'auto',
                      minHeight: '2.5rem'
                    }}
                  >
                    <option value="">All Statuses</option>
                    <option value="draft">Draft</option>
                    <option value="published">Published</option>
                    <option value="closed">Closed</option>
                  </select>
                </div>
              </div>

              {/* Error State */}
              {error && (
                <div className="alert alert-danger" role="alert">
                  {error}
                  <button 
                    className="btn btn-sm btn-outline-danger ms-2"
                    onClick={loadOpportunities}
                  >
                    Retry
                  </button>
                </div>
              )}

              {/* Loading State */}
              {loadingOpportunities && (
                <div className="text-center py-4">
                  <div className="spinner-border" role="status">
                    <span className="visually-hidden">Loading...</span>
                  </div>
                  <p className="mt-2">Loading opportunities...</p>
                </div>
              )}

              {/* Empty State */}
              {!loadingOpportunities && !error && opportunities.length === 0 && (
                <div className="text-center py-5">
                  <h4>No opportunities found</h4>
                  <p className="text-muted">
                    {statusFilter ? 'No opportunities match the current filter.' : 'Create your first opportunity to get started.'}
                  </p>
                  <button 
                    className="btn btn-primary"
                    onClick={() => navigate('/admin/opportunities/new')}
                  >
                    Create Opportunity
                  </button>
                </div>
              )}

              {/* Opportunities Table */}
              {!loadingOpportunities && !error && opportunities.length > 0 && (
                <div className="table-responsive">
                  <table className="table table-hover table-striped">
                    <thead className="table-light">
                      <tr>
                        <th>Title</th>
                        <th>Type</th>
                        <th>Participants</th>
                        <th>Status</th>
                        <th>Sessions</th>
                        <th>Total Slots</th>
                        <th>Remaining</th>
                        <th>Duration</th>
                        <th>Created</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {opportunities.map((opportunity) => (
                        <tr key={opportunity.id}>
                          <td>
                            <div>
                              <strong>{opportunity.title}</strong>
                              <br />
                              <small className="text-muted">{opportunity.purpose_one_liner}</small>
                            </div>
                          </td>
                          <td>
                            <span className={getTypeBadgeClass(opportunity.type)}>
                              {formatOpportunityType(opportunity.type)}
                            </span>
                          </td>
                          <td>
                            <span className="badge bg-secondary">
                              {(() => {
                                switch (opportunity.participant_type_required) {
                                  case 'any': return '👥 Any';
                                  case 'internal': return '🏢 Internal';
                                  case 'external': return '🌐 External';
                                  case 'specific': return '🎯 Specific';
                                  default: return '👥 Any';
                                }
                              })()}
                            </span>
                          </td>
                          <td>
                            <span className={getStatusBadgeClass(opportunity.status)}>
                              {opportunity.status}
                            </span>
                            {opportunity.status === 'closed' && (
                              <span className="badge bg-dark ms-1">Auto-closed</span>
                            )}
                          </td>
                          <td>
                            {opportunity.type === 'test' ? (
                              opportunity.sessions?.length || 0
                            ) : (
                              <span className="text-muted">-</span>
                            )}
                          </td>
                          <td>
                            {opportunity.type === 'test' ? (
                              opportunity.sessions?.reduce((sum, s) => sum + s.capacity, 0) || 0
                            ) : (
                              <span className="text-muted">-</span>
                            )}
                          </td>
                          <td>
                            {opportunity.type === 'test' ? (
                              <span className={`badge ${(opportunity.sessions?.reduce((sum, s) => sum + s.remaining, 0) || 0) > 0 ? 'bg-success' : 'bg-danger'}`}>
                                {opportunity.sessions?.reduce((sum, s) => sum + s.remaining, 0) || 0}
                              </span>
                            ) : (
                              <span className="text-muted">-</span>
                            )}
                          </td>
                          <td>{opportunity.default_duration_minutes} min</td>
                          <td>
                            <small className="text-muted">
                              {new Date(opportunity.created_at).toLocaleDateString()}
                            </small>
                          </td>
                          <td>
                            <div className="dropdown">
                              <button
                                className="btn btn-outline-secondary btn-sm"
                                type="button"
                                onClick={() => toggleDropdown(opportunity.id)}
                                aria-expanded={openDropdownId === opportunity.id}
                                title="Actions"
                                style={{ fontSize: '16px', fontWeight: 'bold', padding: '4px 8px' }}
                              >
                                ⋮
                              </button>
                              {openDropdownId === opportunity.id && (
                                <div 
                                  className="dropdown-menu show" 
                                  style={{ 
                                    position: 'absolute', 
                                    zIndex: 1000,
                                    minWidth: '120px',
                                    display: 'flex',
                                    flexDirection: 'column',
                                    width: 'auto'
                                  }}
                                >
                                  <button
                                    className="dropdown-item"
                                    onClick={() => {
                                      navigate(`/opportunities/${opportunity.id}`);
                                      closeDropdown();
                                    }}
                                    style={{ width: '100%', textAlign: 'left', padding: '8px 16px' }}
                                  >
                                    View
                                  </button>
                                  <button
                                    className="dropdown-item"
                                    onClick={() => {
                                      navigate(`/admin/opportunities/${opportunity.id}/edit`);
                                      closeDropdown();
                                    }}
                                    style={{ width: '100%', textAlign: 'left', padding: '8px 16px' }}
                                  >
                                    Edit
                                  </button>
                                  <button
                                    className="dropdown-item"
                                    onClick={() => {
                                      handleDuplicate(opportunity.id);
                                      closeDropdown();
                                    }}
                                    style={{ width: '100%', textAlign: 'left', padding: '8px 16px' }}
                                  >
                                    Copy
                                  </button>
                                  <div className="dropdown-divider"></div>
                                  <button
                                    className="dropdown-item text-danger"
                                    onClick={() => {
                                      handleDelete(opportunity.id, opportunity.title);
                                      closeDropdown();
                                    }}
                                    style={{ width: '100%', textAlign: 'left', padding: '8px 16px' }}
                                  >
                                    Delete
                                  </button>
                                </div>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Admin;
