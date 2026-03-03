import type { VercelRequest, VercelResponse } from '@vercel/node';
import { query } from '../db';
import { createErrorResponse, createSafeErrorResponse } from '../utils/errors';

/**
 * POST /api/admin/seed-demo-user-2
 * Seeds Demo User 2 for multi-user testing
 * This is a one-time setup endpoint that can be called to ensure Demo User 2 exists
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== 'POST') {
      return res.status(405).json(createErrorResponse('Method not allowed'));
    }

    // Insert second demo user for multi-user testing
    // Using ON CONFLICT to ensure it doesn't fail if user already exists
    await query(`
      INSERT INTO users (id, email, name, business_unit, role_title, role) 
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (email) DO UPDATE SET
        name = EXCLUDED.name,
        business_unit = EXCLUDED.business_unit,
        role_title = EXCLUDED.role_title,
        role = EXCLUDED.role
    `, [
      'b2c3d4e5-f6a7-8901-bcde-f12345678901',
      'demo2@example.com',
      'Demo User 2',
      'Product',
      'Product Manager',
      'employee'
    ]);

    return res.status(200).json({ 
      success: true, 
      message: 'Demo User 2 seeded successfully',
      user: {
        id: 'b2c3d4e5-f6a7-8901-bcde-f12345678901',
        email: 'demo2@example.com',
        name: 'Demo User 2'
      }
    });
  } catch (error: unknown) {
    console.error('Error seeding Demo User 2:', error);
    return res.status(500).json(
      createSafeErrorResponse(error, { userMessage: 'Failed to seed Demo User 2' })
    );
  }
}

