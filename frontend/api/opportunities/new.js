/**
 * GET /api/opportunities/new
 * Return a new opportunity for the form
 */
module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method not allowed' });
    }
    
    console.log('New opportunity endpoint called');
    
    // Return a new opportunity object with default values for the form
    const opportunity = {
      id: 'new',
      type: '',
      title: '',
      purpose_one_liner: '',
      description_optional: '',
      product_optional: '',
      default_duration_minutes: 30,
      external_link_optional: '',
      participant_type_required: 'any',
      participant_type_specific_details: '',
      status: 'draft',
      sessions: []
    };
    
    return res.status(200).json(opportunity);
  } catch (error) {
    console.error('Error in new opportunity handler:', error);
    return res.status(500).json({ error: 'Internal server error', details: error.message });
  }
};

