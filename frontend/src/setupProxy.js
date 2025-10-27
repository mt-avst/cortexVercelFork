const { createProxyMiddleware } = require('http-proxy-middleware');

module.exports = function(app) {
  // Get backend URL from environment variable or default to localhost:3001
  // This proxy is only used in development mode
  const backendUrl = process.env.REACT_APP_API_URL || process.env.REACT_APP_API_BASE_URL || 'http://localhost:3001';
  
  console.log('🔧 Setting up proxy for development to:', backendUrl);
  
  // Proxy API requests to backend
  app.use(
    '/api',
    createProxyMiddleware({
      target: backendUrl,
      changeOrigin: true,
    })
  );
  
  // Proxy auth requests to backend
  app.use(
    '/auth',
    createProxyMiddleware({
      target: backendUrl,
      changeOrigin: true,
    })
  );
};
