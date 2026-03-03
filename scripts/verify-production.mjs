#!/usr/bin/env node
/**
 * Post-deploy verification: GET /api/health and /api/opportunities.
 * Usage: node scripts/verify-production.mjs [BASE_URL]
 *   BASE_URL defaults to https://adapta-labs-p62q.vercel.app
 * Exit 0 if both pass, 1 otherwise.
 */

const BASE_URL = process.env.BASE_URL || process.argv[2] || 'https://adapta-labs-p62q.vercel.app';
const base = BASE_URL.replace(/\/$/, '');

async function check(name, url, validate) {
  try {
    const res = await fetch(url, { method: 'GET' });
    const text = await res.text();
    if (!res.ok) {
      console.error(`FAIL ${name}: ${res.status} ${res.statusText}`);
      return false;
    }
    if (!validate(res, text)) {
      console.error(`FAIL ${name}: response did not pass validation`);
      return false;
    }
    console.log(`OK   ${name}`);
    return true;
  } catch (err) {
    console.error(`FAIL ${name}:`, err.message);
    return false;
  }
}

const healthOk = await check(
  'health',
  `${base}/api/health`,
  (res, text) => {
    try {
      const j = JSON.parse(text);
      return j && j.ok === true;
    } catch {
      return false;
    }
  }
);

const opportunitiesOk = await check(
  'opportunities',
  `${base}/api/opportunities`,
  (res, text) => {
    if (res.headers.get('content-type')?.includes('application/json') !== true) return false;
    try {
      const j = JSON.parse(text);
      return Array.isArray(j);
    } catch {
      return false;
    }
  }
);

if (healthOk && opportunitiesOk) {
  console.log('Production verification passed.');
  process.exit(0);
} else {
  console.error('Production verification failed.');
  process.exit(1);
}
