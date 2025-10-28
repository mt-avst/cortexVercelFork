/**
 * GET /api/opportunities
 * Returns empty array for now (no database)
 */
module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method not allowed' });
    }
    
    console.log('Opportunities list endpoint called');
    
    // Return empty array - the app will show "No studies available"
    return res.status(200).json([]);
  } catch (error) {
    console.error('Error in opportunities handler:', error);
    return res.status(500).json({ error: 'Internal server error', details: error.message });
  }
};

