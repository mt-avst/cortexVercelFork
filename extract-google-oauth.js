#!/usr/bin/env node
/**
 * Extract Google OAuth credentials from JSON file
 * Usage: node extract-google-oauth.js /path/to/client_secret_*.json
 */

const fs = require('fs');
const path = require('path');

const jsonFilePath = process.argv[2];

if (!jsonFilePath) {
  console.error('❌ Please provide the path to your Google OAuth JSON file');
  console.log('\nUsage: node extract-google-oauth.js /path/to/client_secret_*.json');
  console.log('\nExample:');
  console.log('  node extract-google-oauth.js ~/Downloads/client_secret_652535789605-4vohra0r1ua0iee4a6d4ilqgeef3dnan.apps.googleusercontent.com.json');
  process.exit(1);
}

if (!fs.existsSync(jsonFilePath)) {
  console.error(`❌ File not found: ${jsonFilePath}`);
  process.exit(1);
}

try {
  const jsonContent = fs.readFileSync(jsonFilePath, 'utf8');
  const credentials = JSON.parse(jsonContent);
  
  // Extract credentials - could be in 'web' or 'installed' key
  const webClient = credentials.web || credentials.installed;
  
  if (!webClient) {
    console.error('❌ Could not find client credentials in JSON file');
    console.log('Expected structure: { "web": { "client_id": "...", "client_secret": "..." } }');
    process.exit(1);
  }
  
  const clientId = webClient.client_id;
  const clientSecret = webClient.client_secret;
  
  if (!clientId || !clientSecret) {
    console.error('❌ Missing client_id or client_secret in JSON file');
    process.exit(1);
  }
  
  console.log('\n✅ Google OAuth Credentials Extracted\n');
  console.log('═══════════════════════════════════════════════════════════\n');
  console.log('Add these to your backend/.env file:\n');
  console.log(`GOOGLE_OAUTH_CLIENT_ID=${clientId}`);
  console.log(`GOOGLE_OAUTH_CLIENT_SECRET=${clientSecret}`);
  console.log(`GOOGLE_OAUTH_REDIRECT_URI=http://localhost:3001/api/calendar/auth/callback`);
  console.log('\n═══════════════════════════════════════════════════════════\n');
  console.log('📋 Copy the lines above and add them to: backend/.env');
  console.log('\n💡 For production (Vercel), add these as environment variables:');
  console.log('   - GOOGLE_OAUTH_CLIENT_ID');
  console.log('   - GOOGLE_OAUTH_CLIENT_SECRET');
  console.log('   - GOOGLE_OAUTH_REDIRECT_URI=https://adapta-labs-p62q.vercel.app/api/calendar/auth/callback');
  console.log('\n');
  
  // Optionally write to a temporary file
  const tempFile = path.join(__dirname, 'backend', '.env.google-oauth');
  const envContent = `# Google OAuth Credentials (extracted from JSON)
# Add these to your backend/.env file

GOOGLE_OAUTH_CLIENT_ID=${clientId}
GOOGLE_OAUTH_CLIENT_SECRET=${clientSecret}
GOOGLE_OAUTH_REDIRECT_URI=http://localhost:3001/api/calendar/auth/callback

# Production redirect URI (for Vercel):
# GOOGLE_OAUTH_REDIRECT_URI=https://adapta-labs-p62q.vercel.app/api/calendar/auth/callback
`;
  
  fs.writeFileSync(tempFile, envContent);
  console.log(`✅ Also saved to: ${tempFile}`);
  console.log('   You can review it and copy the values to your .env file\n');
  
} catch (error) {
  console.error('❌ Error reading JSON file:', error.message);
  process.exit(1);
}

