import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getPool } from '../db';
import { createErrorResponse, getErrorMessage } from '../utils/errors';
import { requireAuth } from '../utils/auth';
import { logger } from '../utils/logger';

// Helper function to escape CSV fields
function escapeCsvField(field: string | null | undefined): string {
  if (field === null || field === undefined) {
    return '';
  }
  const str = String(field);
  // If the field contains a comma, newline, or double quote, wrap it in quotes and escape any quotes
  if (str.includes(',') || str.includes('\n') || str.includes('"')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json(createErrorResponse('Method not allowed'));
  }

  try {
    // Require authentication
    const user = requireAuth(req);
    
    // Check admin role
    if (user.role !== 'researcher_admin' && user.role !== 'superadmin') {
      return res.status(403).json(createErrorResponse('Admin access required'));
    }

    const pool = getPool();
    
    const result = await pool.query(
      `SELECT id, user_name, user_email, category, feedback, url, user_agent, created_at
       FROM feedback
       ORDER BY created_at DESC`
    );

    // Build CSV content
    const headers = ['ID', 'User Name', 'User Email', 'Category', 'Feedback', 'URL', 'User Agent', 'Created At'];
    const rows = result.rows.map(row => [
      row.id,
      escapeCsvField(row.user_name),
      escapeCsvField(row.user_email),
      escapeCsvField(row.category),
      escapeCsvField(row.feedback),
      escapeCsvField(row.url),
      escapeCsvField(row.user_agent),
      new Date(row.created_at).toISOString()
    ]);

    const csvContent = [
      headers.join(','),
      ...rows.map(row => row.join(','))
    ].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="feedback-export-${new Date().toISOString().split('T')[0]}.csv"`);
    return res.status(200).send(csvContent);
  } catch (error: unknown) {
    // Handle auth errors
    if (error && typeof error === 'object' && 'status' in error && error.status === 401) {
      return res.status(401).json(createErrorResponse(
        typeof error === 'object' && 'error' in error 
          ? String(error.error) 
          : 'Not authenticated'
      ));
    }
    
    logger.error('Error exporting feedback', {
      errorMessage: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    const errorMessage = getErrorMessage(error);
    return res.status(500).json(createErrorResponse('Failed to export feedback', errorMessage));
  }
}

