import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getPool } from '../../db';
import { createErrorResponse, createSafeErrorResponse } from '../../utils/errors';
import { requireAuth } from '../../utils/auth';
import { logger } from '../../utils/logger';

function escapeCsvField(field: string | null | undefined): string {
  if (field === null || field === undefined) return '';
  const str = String(field);
  if (str.includes(',') || str.includes('\n') || str.includes('"')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * GET /api/admin/export/bookings
 * Export all bookings (admin-only) as CSV. researcher_admin sees only their opportunities.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json(createErrorResponse('Method not allowed'));
  }

  try {
    const user = requireAuth(req);
    if (user.role !== 'researcher_admin' && user.role !== 'superadmin') {
      return res.status(403).json(createErrorResponse('Admin access required'));
    }

    const filterOwnerId = user.role === 'superadmin' ? null : user.id;
    const pool = getPool();

    const result = await pool.query(
      `SELECT
        o.title AS opportunity_title,
        o.type AS opportunity_type,
        s.start_time AS session_start,
        s.end_time AS session_end,
        u.name AS participant_name,
        u.email AS participant_email,
        b.status AS booking_status,
        b.created_at AS booked_at
       FROM bookings b
       JOIN sessions s ON b.session_id = s.id
       JOIN opportunities o ON s.opportunity_id = o.id
       JOIN users u ON b.user_id = u.id
       WHERE ($1::uuid IS NULL OR o.owner_user_id = $1)
       ORDER BY s.start_time DESC, b.created_at DESC`,
      [filterOwnerId]
    );

    const headers = [
      'Opportunity',
      'Type',
      'Session start',
      'Session end',
      'Participant name',
      'Participant email',
      'Status',
      'Booked at',
    ];
    const rows = (result.rows || []).map((row: Record<string, unknown>) => [
      escapeCsvField(String(row.opportunity_title ?? '')),
      escapeCsvField(String(row.opportunity_type ?? '')),
      row.session_start ? new Date(row.session_start as Date).toISOString() : '',
      row.session_end ? new Date(row.session_end as Date).toISOString() : '',
      escapeCsvField(String(row.participant_name ?? '')),
      escapeCsvField(String(row.participant_email ?? '')),
      escapeCsvField(String(row.booking_status ?? '')),
      row.booked_at ? new Date(row.booked_at as Date).toISOString() : '',
    ]);

    const csvContent = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="bookings-export-${new Date().toISOString().split('T')[0]}.csv"`
    );
    return res.status(200).send(csvContent);
  } catch (error: unknown) {
    if (error && typeof error === 'object' && 'status' in error && (error as { status: number }).status === 401) {
      return res.status(401).json(
        createErrorResponse(
          typeof error === 'object' && 'error' in error ? String((error as { error: string }).error) : 'Not authenticated'
        )
      );
    }
    logger.error('Error exporting bookings', {
      errorMessage: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return res.status(500).json(createSafeErrorResponse(error, { userMessage: 'Failed to export bookings' }));
  }
}
