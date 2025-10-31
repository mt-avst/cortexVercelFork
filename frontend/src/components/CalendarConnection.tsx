import React, { useState, useEffect } from 'react';
import { 
  getCalendarConnectionStatus, 
  getCalendarConnectUrl, 
  disconnectCalendar 
} from '../api/client';

interface CalendarConnectionProps {
  onStatusChange?: (connected: boolean) => void;
}

const CalendarConnection: React.FC<CalendarConnectionProps> = ({ onStatusChange }) => {
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [connectedAt, setConnectedAt] = useState<string | null>(null);

  useEffect(() => {
    checkStatus();
  }, []);

  const checkStatus = async () => {
    try {
      setLoading(true);
      const status = await getCalendarConnectionStatus();
      setConnected(status.connected);
      setConnectedAt(status.connectedAt);
      onStatusChange?.(status.connected);
    } catch (error: any) {
      console.error('Error checking calendar status:', error);
      setConnected(false);
      onStatusChange?.(false);
    } finally {
      setLoading(false);
    }
  };

  const handleConnect = async () => {
    try {
      setConnecting(true);
      const { authUrl } = await getCalendarConnectUrl();
      // Redirect to OAuth URL
      window.location.href = authUrl;
    } catch (error: any) {
      console.error('Error initiating calendar connection:', error);
      alert('Failed to connect calendar. Please try again.');
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    if (!window.confirm('Are you sure you want to disconnect your calendar? You will no longer see calendar conflicts when booking sessions.')) {
      return;
    }

    try {
      await disconnectCalendar();
      setConnected(false);
      setConnectedAt(null);
      onStatusChange?.(false);
    } catch (error: any) {
      console.error('Error disconnecting calendar:', error);
      alert('Failed to disconnect calendar. Please try again.');
    }
  };

  if (loading) {
    return (
      <div className="d-flex align-items-center">
        <div className="spinner-border spinner-border-sm me-2" role="status">
          <span className="visually-hidden">Loading...</span>
        </div>
        <span className="text-muted">Checking calendar...</span>
      </div>
    );
  }

  return (
    <div className="calendar-connection">
      {connected ? (
        <div>
          <div className="d-flex align-items-center gap-2 mb-2">
            <i className="bi bi-check-circle-fill text-success"></i>
            <span className="text-success fw-bold">Calendar connected</span>
          </div>
          {connectedAt && (
            <small className="text-muted d-block mb-2">
              Connected {new Date(connectedAt).toLocaleDateString()}
            </small>
          )}
          <button
            className="btn btn-sm btn-outline-secondary"
            onClick={handleDisconnect}
          >
            <i className="bi bi-x-circle me-1"></i>
            Disconnect
          </button>
        </div>
      ) : (
        <div>
          <button
            className="btn btn-sm btn-primary"
            onClick={handleConnect}
            disabled={connecting}
          >
            {connecting ? (
              <>
                <span className="spinner-border spinner-border-sm me-2" />
                Connecting...
              </>
            ) : (
              <>
                <i className="bi bi-calendar-plus me-2"></i>
                Connect Google Calendar
              </>
            )}
          </button>
          <small className="d-block text-muted mt-2">
            <i className="bi bi-info-circle me-1"></i>
            Connect to see your calendar conflicts when booking sessions
          </small>
        </div>
      )}
    </div>
  );
};

export default CalendarConnection;

