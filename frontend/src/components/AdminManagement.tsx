import React, { useState, useEffect } from 'react';
import { getAdmins, getAdminRequests, approveAdminRequest, denyAdminRequest, revokeAdminAccess } from '../api/client';
import { User, AdminRequest } from '../api/types';
import ConfirmationModal from './ConfirmationModal';

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
    } catch (err: any) {
      console.error('Error loading admin data:', err);
      setError(err.response?.data?.error || err.message || 'Failed to load admin data');
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
    } catch (err: any) {
      console.error('Error approving request:', err);
      alert(err.response?.data?.error || err.message || 'Failed to approve request');
    } finally {
      setProcessing(null);
    }
  };

  const handleDeny = async (requestId: string, notes?: string) => {
    try {
      setProcessing(requestId);
      await denyAdminRequest(requestId, notes);
      await loadData();
    } catch (err: any) {
      console.error('Error denying request:', err);
      alert(err.response?.data?.error || err.message || 'Failed to deny request');
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
    } catch (err: any) {
      console.error('Error revoking admin:', err);
      alert(err.response?.data?.error || err.message || 'Failed to revoke admin access');
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
        <i className="bi bi-exclamation-triangle me-2"></i>
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
            border-bottom: 1px solid rgba(255, 255, 255, 0.1);
            margin-bottom: 1.5rem;
          }
          .admin-management .nav-link {
            color: var(--text-muted);
            border: none;
            border-bottom: 2px solid transparent;
            padding: 0.75rem 1.5rem;
          }
          .admin-management .nav-link:hover {
            color: var(--text-primary);
            border-bottom-color: rgba(255, 78, 80, 0.5);
          }
          .admin-management .nav-link.active {
            color: var(--brand-headline);
            border-bottom-color: var(--brand-headline);
            background-color: transparent;
          }
          .admin-management table {
            color: var(--text-primary);
          }
          .admin-management .badge {
            padding: 0.35em 0.65em;
            font-size: 0.85em;
          }
          .admin-management .btn-sm {
            padding: 0.25rem 0.75rem;
            font-size: 0.875rem;
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
              <i className="bi bi-people me-2"></i>
              All Admins ({admins.length})
            </button>
          </li>
          <li className="nav-item" role="presentation">
            <button
              className={`nav-link ${activeTab === 'pending' ? 'active' : ''}`}
              onClick={() => setActiveTab('pending')}
              type="button"
            >
              <i className="bi bi-clock-history me-2"></i>
              Pending Requests ({pendingRequests.length})
            </button>
          </li>
          <li className="nav-item" role="presentation">
            <button
              className={`nav-link ${activeTab === 'history' ? 'active' : ''}`}
              onClick={() => setActiveTab('history')}
              type="button"
            >
              <i className="bi bi-list-check me-2"></i>
              History ({historyRequests.length})
            </button>
          </li>
        </ul>

        <div className="tab-content">
          {activeTab === 'admins' && (
            <div className="tab-pane active">
              <div className="table-responsive">
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
                        <td colSpan={5} className="text-center text-muted py-4">
                          No admins found
                        </td>
                      </tr>
                    ) : (
                      admins.map((admin) => (
                        <tr key={admin.id}>
                          <td>{admin.name}</td>
                          <td>{admin.email}</td>
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
                                <i className="bi bi-x-circle me-1"></i>
                                Revoke
                              </button>
                            )}
                            {admin.role === 'superadmin' && (
                              <span className="text-muted small">Cannot revoke</span>
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
              <div className="table-responsive">
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
                        <td colSpan={6} className="text-center text-muted py-4">
                          No pending requests
                        </td>
                      </tr>
                    ) : (
                      pendingRequests.map((request) => (
                        <tr key={request.id}>
                          <td>{request.name}</td>
                          <td>{request.email}</td>
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
                            <div className="btn-group" role="group">
                              <button
                                className="btn btn-sm btn-success"
                                onClick={() => handleApprove(request.id)}
                                disabled={processing === request.id}
                              >
                                <i className="bi bi-check-circle me-1"></i>
                                Approve
                              </button>
                              <button
                                className="btn btn-sm btn-danger"
                                onClick={() => setDenyConfirm({ show: true, request, notes: '' })}
                                disabled={processing === request.id}
                              >
                                <i className="bi bi-x-circle me-1"></i>
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
              <div className="table-responsive">
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
                        <td colSpan={7} className="text-center text-muted py-4">
                          No history
                        </td>
                      </tr>
                    ) : (
                      historyRequests.map((request) => (
                        <tr key={request.id}>
                          <td>{request.name}</td>
                          <td>{request.email}</td>
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
                          <td>{request.reviewed_at ? formatDate(request.reviewed_at) : '-'}</td>
                          <td>{request.notes || '-'}</td>
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

