/**
 * GET /api/bookings/pending-approvals
 * Get pending approval bookings for admin
 */
module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  console.log('Pending approvals endpoint called');
  
  // Return empty array for now
  return res.status(200).json([]);
};

