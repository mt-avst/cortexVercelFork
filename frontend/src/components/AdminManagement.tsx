import React, { useState, useEffect } from 'react';
import { getAdmins, getAdminRequests, approveAdminRequest, denyAdminRequest, revokeAdminAccess } from '../api/client';
import { User, AdminRequest } from '../api/types';
import ConfirmationModal from './ConfirmationModal';
import { AlertTriangle, Users, History, ListChecks, XCircle, CheckCircle } from 'lucide-react';

const AdminManagement: React.FC = () => {
  const [admins, setAdmins] = useState<User[]>([]);
  const [requests, setRequests] = useState<AdminRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>('');
  const [activeTab, setActiveTab] = useState<'admins' | 'pending' | 'history'>('admins');
  const [revokeConfirm, setRevokeConfirm] = useState<{ show: boolean; admin: User | null }>({ show: false, admin: null });
  const [denyConfirm, setDenyConfirm] = useState<{ show: boolean; request: AdminRequest | null; notes: string }>({ show: false, request: null, notes: '' });
  const [processing, setProcessing] = useState<string | null>(null);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      setLoading(true);
      setError('');
      const [adminsResult, requestsResult] = await Promise.all([
        getAdmins(),
        getAdminRequests()
      ]);
      setAdmins(adminsResult.admins);
      setRequests(requestsResult.requests);
    } catch (err: unknown) {
      const axiosError = err as { response?: { data?: { error?: string } }; message?: string };
      setError(axiosError.response?.data?.error || axiosError.message || 'Failed to load admin data');
    } finally {
      setLoading(false);
    }
  };

  const handleApprove = async (requestId: string) => {
    try {
      setProcessing(requestId);
      await approveAdminRequest(requestId);
      await loadData();
      setActiveTab('admins'); // Switch to admins tab to see the newly approved admin
    } catch (err: unknown) {
      const axiosError = err as { response?: { data?: { error?: string } }; message?: string };
      alert(axiosError.response?.data?.error || axiosError.message || 'Failed to approve request');
    } finally {
      setProcessing(null);
    }
  };

  const handleDeny = async (requestId: string, notes?: string) => {
    try {
      setProcessing(requestId);
      await denyAdminRequest(requestId, notes);
      await loadData();
    } catch (err: unknown) {
      const axiosError = err as { response?: { data?: { error?: string } }; message?: string };
      alert(axiosError.response?.data?.error || axiosError.message || 'Failed to deny request');
    } finally {
      setProcessing(null);
      setDenyConfirm({ show: false, request: null, notes: '' });
    }
  };

  const handleRevoke = async (adminId: string) => {
    try {
      setProcessing(adminId);
      await revokeAdminAccess(adminId);
      await loadData();
    } catch (err: unknown) {
      const axiosError = err as { response?: { data?: { error?: string } }; message?: string };
      alert(axiosError.response?.data?.error || axiosError.message || 'Failed to revoke admin access');
    } finally {
      setProcessing(null);
      setRevokeConfirm({ show: false, admin: null });
    }
  };

  const pendingRequests = requests.filter(r => r.status === 'pending');
  const historyRequests = requests.filter(r => r.status !== 'pending');

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  if (loading) {
    return (
      <div className="text-center py-4">
        <div className="spinner-border" role="status" style={{ borderColor: 'var(--brand-headline)', borderRightColor: 'transparent' }}>
          <span className="visually-hidden">Loading...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="alert alert-danger">
        <AlertTriangle size={18} className="me-2" />
        {error}
        <button className="btn btn-sm btn-outline-danger ms-3" onClick={loadData}>
          Retry
        </button>
      </div>
    );
  }

  return (
    <>
      <style>
        {`
          .admin-management .nav-tabs {
            border-bottom: 1px solid var(--border-card);
            margin-bottom: 1.5rem;
            display: flex;
            flex-wrap: wrap;
            gap: 0.5rem;
          }
          .admin-management .nav-item {
            flex: 1;
            min-width: 0;
          }
          .admin-management .nav-link {
            color: var(--text-muted);
            border: none;
            border-bottom: 2px solid transparent;
            padding: 0.75rem 1rem;
            white-space: nowrap;
            width: 100%;
            text-align: center;
            background-color: transparent;
            transition: all 0.2s ease-in-out;
          }
          .admin-management .nav-link:hover {
            color: var(--text-primary);
            border-bottom-color: var(--brand-headline);
            background-color: var(--bg-hover);
          }
          .admin-management .nav-link.active {
            color: var(--brand-headline);
            border-bottom-color: var(--brand-headline);
            background-color: transparent;
            font-weight: 600;
          }
          
          /* Table styling - match Settings/Admin dashboard */
          .admin-management .table-responsive {
            border-radius: var(--card-radius);
            overflow-x: auto;
            -webkit-overflow-scrolling: touch;
            max-width: 100%;
          }
          .admin-management table {
            color: var(--text-primary);
            background-color: transparent;
            margin-bottom: 0;
            width: 100%;
          }
          .admin-management table thead {
            background-color: var(--bg-table-header);
            border-bottom: 1px solid var(--border-card);
          }
          .admin-management table thead th {
            color: var(--text-primary);
            background-color: var(--bg-table-header);
            border: none;
            border-bottom: 1px solid var(--border-card);
            padding: 0.75rem 1rem;
            font-weight: 600;
            white-space: nowrap;
          }
          .admin-management table tbody {
            background-color: transparent;
          }
          .admin-management table tbody tr {
            background-color: transparent;
            border-bottom: 1px solid var(--border-table-row);
            transition: background-color 0.2s ease-in-out;
          }
          .admin-management table tbody tr:hover {
            background-color: var(--bg-hover);
          }
          .admin-management table tbody td {
            color: var(--text-primary);
            background-color: transparent;
            border: none;
            padding: 0.75rem 1rem;
            vertical-align: middle;
          }
          .admin-management table tbody td.text-center {
            text-align: center;
          }
          .admin-management table tbody td.text-muted {
            color: var(--text-muted);
          }
          
          /* Badge styling */
          .admin-management .badge {
            padding: 0.35em 0.65em;
            font-size: 0.85em;
            font-weight: 500;
            border-radius: var(--tag-radius);
            white-space: nowrap;
          }
          .admin-management .badge.bg-primary {
            background-color: #007bff !important;
          }
          .admin-management .badge.bg-danger {
            background-color: #dc3545 !important;
          }
          .admin-management .badge.bg-success {
            background-color: #28a745 !important;
          }
          .admin-management .badge.bg-secondary {
            background-color: #6c757d !important;
          }
          
          /* Button styling */
          .admin-management .btn-sm {
            padding: 0.375rem 0.75rem;
            font-size: 0.875rem;
            border-radius: var(--tag-radius);
            white-space: nowrap;
          }
          .admin-management .btn-group {
            display: flex;
            gap: 0.5rem;
            flex-wrap: wrap;
          }
          .admin-management .btn-group .btn {
            flex: 1;
            min-width: auto;
          }
          
          /* Alert styling */
          .admin-management .alert {
            background-color: var(--bg-hover);
            border: 1px solid var(--border-card);
            border-radius: var(--card-radius);
            color: var(--text-primary);
          }
          .admin-management .alert-danger {
            border-color: rgba(244, 67, 54, 0.3);
          }
          .admin-management .alert .btn-outline-danger {
            border-color: rgba(244, 67, 54, 0.5);
            color: var(--text-primary);
          }
          .admin-management .alert .btn-outline-danger:hover {
            background-color: rgba(244, 67, 54, 0.2);
            border-color: rgba(244, 67, 54, 0.7);
          }
          
          /* Responsive adjustments */
          @media (max-width: 768px) {
            .admin-management .nav-tabs {
              flex-direction: column;
            }
            .admin-management .nav-item {
              width: 100%;
            }
            .admin-management .nav-link {
              padding: 0.5rem 1rem;
              font-size: 0.9rem;
            }
            .admin-management .table-responsive {
              max-height: 500px;
            }
            .admin-management table {
              font-size: 0.9rem;
            }
            .admin-management table thead th,
            .admin-management table tbody td {
              padding: 0.5rem 0.75rem;
            }
            .admin-management .btn-group {
              flex-direction: column;
            }
            .admin-management .btn-group .btn {
              width: 100%;
            }
            .admin-management .badge {
              font-size: 0.75em;
              padding: 0.25em 0.5em;
            }
          }
          
          @media (max-width: 576px) {
            .admin-management table {
              font-size: 0.85rem;
            }
            .admin-management table thead th,
            .admin-management table tbody td {
              padding: 0.5rem;
            }
          }
        `}
      </style>
      <div className="admin-management">
        <ul className="nav nav-tabs" role="tablist">
          <li className="nav-item" role="presentation">
            <button
              className={`nav-link ${activeTab === 'admins' ? 'active' : ''}`}
              onClick={() => setActiveTab('admins')}
              type="button"
            >
              <Users size={16} className="me-2" />
              All Admins ({admins.length})
            </button>
          </li>
          <li className="nav-item" role="presentation">
            <button
              className={`nav-link ${activeTab === 'pending' ? 'active' : ''}`}
              onClick={() => setActiveTab('pending')}
              type="button"
            >
              <History size={16} className="me-2" />
              Pending Requests ({pendingRequests.length})
            </button>
          </li>
          <li className="nav-item" role="presentation">
            <button
              className={`nav-link ${activeTab === 'history' ? 'active' : ''}`}
              onClick={() => setActiveTab('history')}
              type="button"
            >
              <ListChecks size={16} className="me-2" />
              History ({historyRequests.length})
            </button>
          </li>
        </ul>

        <div className="tab-content">
          {activeTab === 'admins' && (
            <div className="tab-pane active">
              <div className="table-responsive" style={{ maxHeight: '600px', overflowY: 'auto' }}>
                <table className="table table-hover">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Email</th>
                      <th>Role</th>
                      <th>Created</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {admins.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="text-center text-muted py-4" style={{ color: 'var(--text-muted)' }}>
                          No admins found
                        </td>
                      </tr>
                    ) : (
                      admins.map((admin) => (
                        <tr key={admin.id}>
                          <td style={{ whiteSpace: 'nowrap' }}>{admin.name}</td>
                          <td style={{ wordBreak: 'break-word', maxWidth: '200px' }}>{admin.email}</td>
                          <td>
                            <span className={`badge ${admin.role === 'superadmin' ? 'bg-danger' : 'bg-primary'}`}>
                              {admin.role === 'superadmin' ? 'Superadmin' : 'Admin'}
                            </span>
                          </td>
                          <td>{formatDate(admin.created_at)}</td>
                          <td>
                            {admin.role !== 'superadmin' && (
                              <button
                                className="btn btn-sm btn-outline-danger"
                                onClick={() => setRevokeConfirm({ show: true, admin })}
                                disabled={processing === admin.id}
                              >
                                <XCircle size={14} className="me-1" />
                                Revoke
                              </button>
                            )}
                            {admin.role === 'superadmin' && (
                              <span className="text-muted small" style={{ color: 'var(--text-muted)' }}>Cannot revoke</span>
                            )}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {activeTab === 'pending' && (
            <div className="tab-pane active">
              <div className="table-responsive" style={{ maxHeight: '600px', overflowY: 'auto' }}>
                <table className="table table-hover">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Email</th>
                      <th>Current Role</th>
                      <th>Requesting</th>
                      <th>Requested</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pendingRequests.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="text-center text-muted py-4" style={{ color: 'var(--text-muted)' }}>
                          No pending requests
                        </td>
                      </tr>
                    ) : (
                      pendingRequests.map((request) => (
                        <tr key={request.id}>
                          <td style={{ whiteSpace: 'nowrap' }}>{request.name}</td>
                          <td style={{ wordBreak: 'break-word', maxWidth: '200px' }}>{request.email}</td>
                          <td>
                            <span className={`badge ${
                              request.current_role === 'superadmin' ? 'bg-danger' :
                              request.current_role === 'researcher_admin' ? 'bg-primary' :
                              'bg-secondary'
                            }`}>
                              {request.current_role === 'superadmin' ? 'Superadmin' :
                               request.current_role === 'researcher_admin' ? 'Admin' :
                               'User'}
                            </span>
                          </td>
                          <td>
                            <span className={`badge ${
                              request.requested_role === 'superadmin' ? 'bg-danger' : 'bg-primary'
                            }`}>
                              {request.requested_role === 'superadmin' ? 'Superadmin' : 'Admin'}
                            </span>
                          </td>
                          <td>{formatDate(request.requested_at)}</td>
                          <td>
                            <div className="btn-group" role="group" style={{ display: 'flex', gap: '0.5rem' }}>
                              <button
                                className="btn btn-sm btn-success"
                                onClick={() => handleApprove(request.id)}
                                disabled={processing === request.id}
                                style={{ 
                                  backgroundColor: processing === request.id ? 'rgba(40, 167, 69, 0.5)' : '#28a745',
                                  borderColor: '#28a745',
                                  color: '#fff'
                                }}
                              >
                                <CheckCircle size={14} className="me-1" />
                                Approve
                              </button>
                              <button
                                className="btn btn-sm btn-danger"
                                onClick={() => setDenyConfirm({ show: true, request, notes: '' })}
                                disabled={processing === request.id}
                                style={{ 
                                  backgroundColor: processing === request.id ? 'rgba(220, 53, 69, 0.5)' : '#dc3545',
                                  borderColor: '#dc3545',
                                  color: '#fff'
                                }}
                              >
                                <XCircle size={14} className="me-1" />
                                Deny
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {activeTab === 'history' && (
            <div className="tab-pane active">
              <div className="table-responsive" style={{ maxHeight: '600px', overflowY: 'auto' }}>
                <table className="table table-hover">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Email</th>
                      <th>Requested Role</th>
                      <th>Requested</th>
                      <th>Status</th>
                      <th>Reviewed</th>
                      <th>Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {historyRequests.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="text-center text-muted py-4" style={{ color: 'var(--text-muted)' }}>
                          No history
                        </td>
                      </tr>
                    ) : (
                      historyRequests.map((request) => (
                        <tr key={request.id}>
                          <td style={{ whiteSpace: 'nowrap' }}>{request.name}</td>
                          <td style={{ wordBreak: 'break-word', maxWidth: '200px' }}>{request.email}</td>
                          <td>
                            <span className={`badge ${
                              request.requested_role === 'superadmin' ? 'bg-danger' : 'bg-primary'
                            }`}>
                              {request.requested_role === 'superadmin' ? 'Superadmin' : 'Admin'}
                            </span>
                          </td>
                          <td>{formatDate(request.requested_at)}</td>
                          <td>
                            <span className={`badge ${request.status === 'approved' ? 'bg-success' : 'bg-danger'}`}>
                              {request.status === 'approved' ? 'Approved' : 'Denied'}
                            </span>
                          </td>
                          <td style={{ color: request.reviewed_at ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                            {request.reviewed_at ? formatDate(request.reviewed_at) : '-'}
                          </td>
                          <td style={{ color: request.notes ? 'var(--text-primary)' : 'var(--text-muted)', maxWidth: '200px', wordBreak: 'break-word' }}>
                            {request.notes || '-'}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>

      <ConfirmationModal
        show={revokeConfirm.show}
        title="Revoke Admin Access"
        message={`Are you sure you want to revoke admin access for ${revokeConfirm.admin?.name} (${revokeConfirm.admin?.email})?`}
        confirmText="Revoke"
        cancelText="Cancel"
        onConfirm={() => revokeConfirm.admin && handleRevoke(revokeConfirm.admin.id)}
        onCancel={() => setRevokeConfirm({ show: false, admin: null })}
        variant="danger"
      />

      <ConfirmationModal
        show={denyConfirm.show}
        title="Deny Admin Request"
        message={`Are you sure you want to deny the admin request from ${denyConfirm.request?.name} (${denyConfirm.request?.email})?`}
        confirmText="Deny"
        cancelText="Cancel"
        onConfirm={() => denyConfirm.request && handleDeny(denyConfirm.request.id, denyConfirm.notes || undefined)}
        onCancel={() => setDenyConfirm({ show: false, request: null, notes: '' })}
        variant="danger"
        renderCustomContent={() => (
          <div className="mb-3">
            <label htmlFor="denyNotes" className="form-label">Notes (optional)</label>
            <textarea
              id="denyNotes"
              className="form-control"
              rows={3}
              value={denyConfirm.notes}
              onChange={(e) => setDenyConfirm({ ...denyConfirm, notes: e.target.value })}
              placeholder="Add notes about why this request was denied..."
            />
          </div>
        )}
      />
    </>
  );
};

export default AdminManagement;

