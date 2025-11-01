import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/authenticate';
import { pool } from '../config/index';
import { asyncHandler } from '../utils/errorHandler';

const router: Router = Router();

interface NotificationPreference {
  id: string;
  user_id: string;
  on_book_email: boolean;
  on_cancel_email: boolean;
}

// GET /api/notification-preferences - Get user's notification preferences
router.get('/', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.user!;
  const userId = user.id;

  const result = await pool.query<NotificationPreference>(
    `SELECT id, user_id, on_book_email, on_cancel_email 
     FROM notification_preferences 
     WHERE user_id = $1`,
    [userId]
  );

  if (result.rows.length === 0) {
    // Return defaults if no preferences exist
    return res.status(200).json({
      success: true,
      data: {
        id: null,
        user_id: userId,
        on_book_email: true,
        on_cancel_email: true
      }
    });
  }

  return res.status(200).json({
    success: true,
    data: result.rows[0]
  });
}));

// PATCH /api/notification-preferences - Update user's notification preferences
router.patch('/', requireAuth, asyncHandler(async (req: Request, res: Response) => {
  const user = req.user!;
  const userId = user.id;
  const { on_book_email, on_cancel_email } = req.body;

  if (typeof on_book_email !== 'boolean' || typeof on_cancel_email !== 'boolean') {
    return res.status(400).json({ 
      error: 'Invalid request body. Both on_book_email and on_cancel_email must be booleans.' 
    });
  }

  // Check if preferences exist
  const existing = await pool.query(
    `SELECT id FROM notification_preferences WHERE user_id = $1`,
    [userId]
  );

  if (existing.rows.length === 0) {
    // Create new preferences
    const insertResult = await pool.query<NotificationPreference>(
      `INSERT INTO notification_preferences (user_id, on_book_email, on_cancel_email)
       VALUES ($1, $2, $3)
       RETURNING id, user_id, on_book_email, on_cancel_email`,
      [userId, on_book_email, on_cancel_email]
    );

    return res.status(200).json({
      success: true,
      data: insertResult.rows[0]
    });
  } else {
    // Update existing preferences
    const updateResult = await pool.query<NotificationPreference>(
      `UPDATE notification_preferences
       SET on_book_email = $1, on_cancel_email = $2
       WHERE user_id = $3
       RETURNING id, user_id, on_book_email, on_cancel_email`,
      [on_book_email, on_cancel_email, userId]
    );

    return res.status(200).json({
      success: true,
      data: updateResult.rows[0]
    });
  }
}));

export default router;

