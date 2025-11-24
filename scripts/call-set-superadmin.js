#!/usr/bin/env node
/**
 * Call the set-superadmin API endpoint
 * This requires you to be logged in on the production site first
 * 
 * Usage: 
 * 1. Log in to https://adapta-labs-p62q.vercel.app
 * 2. Open browser console and get your session cookie
 * 3. Run: SESSION_COOKIE="your-cookie" node scripts/call-set-superadmin.js
 * 
 * OR just use the browser console method (easier) - see SET_SUPERADMIN_BROWSER.md
 */

const https = require('https');
const http = require('http');

const url = process.env.VERCEL_URL || 'adapta-labs-p62q.vercel.app';
const email = process.argv[2] || 'nfine@adaptavist.com';
const sessionCookie = process.env.SESSION_COOKIE;

if (!sessionCookie) {
  console.log('❌ SESSION_COOKIE environment variable is required');
  console.log('\n📝 To get your session cookie:');
  console.log('   1. Go to https://adapta-labs-p62q.vercel.app');
  console.log('   2. Log in');
  console.log('   3. Open browser console (F12)');
  console.log('   4. Run: document.cookie');
  console.log('   5. Copy the adaptalabs_session value');
  console.log('   6. Run: SESSION_COOKIE="your-cookie" node scripts/call-set-superadmin.js');
  console.log('\n💡 OR use the browser console method (easier):');
  console.log('   See SET_SUPERADMIN_BROWSER.md for instructions');
  process.exit(1);
}

const isHttps = !url.includes('localhost');
const client = isHttps ? https : http;

const options = {
  hostname: url,
  port: isHttps ? 443 : 3000,
  path: '/api/admin/set-superadmin',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Cookie': `adaptalabs_session=${sessionCookie}`
  }
};

const data = JSON.stringify({ email });

const req = client.request(options, (res) => {
  let responseData = '';

  res.on('data', (chunk) => {
    responseData += chunk;
  });

  res.on('end', () => {
    try {
      const result = JSON.parse(responseData);
      if (result.success) {
        console.log('✅ Success!');
        console.log(result.message);
        console.log('\n📋 Details:');
        console.log(`   Email: ${result.user.email}`);
        console.log(`   Name: ${result.user.name}`);
        console.log(`   Previous Role: ${result.user.previousRole}`);
        console.log(`   New Role: ${result.user.newRole}`);
        console.log(`\n${result.note}`);
      } else {
        console.error('❌ Failed:', result.error || result.message);
        process.exit(1);
      }
    } catch (error) {
      console.error('❌ Error parsing response:', error);
      console.log('Response:', responseData);
      process.exit(1);
    }
  });
});

req.on('error', (error) => {
  console.error('❌ Request error:', error.message);
  process.exit(1);
});

req.write(data);
req.end();

