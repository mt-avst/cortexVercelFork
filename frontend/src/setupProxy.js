const { createProxyMiddleware } = require('http-proxy-middleware');

module.exports = function(app) {
  // Get backend URL from environment variable or default to localhost:3001
  const backendUrl = process.env.REACT_APP_API_URL || 'http://localhost:3001';
  
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
