/**
 * Proxy API routes to the real backend
 * This forwards requests to the backend server
 */
const fetch = require('node-fetch');

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3001';

module.exports = async function handler(req, res) {
  try {
    console.log('Proxying opportunity request to backend:', req.method, req.url);
    
    const response = await fetch(`${BACKEND_URL}/api/opportunities`, {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        ...req.headers
      },
      body: req.method !== 'GET' ? JSON.stringify(req.body) : undefined
    });
    
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    console.error('Error proxying to backend:', error);
    res.status(500).json({ error: 'Backend unavailable' });
  }
};

