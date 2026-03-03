/**
 * Minimal load test for AdaptaLabs API.
 * Targets GET /api/health and GET /api/opportunities (no auth).
 *
 * Prerequisites: Install k6 (https://k6.io/docs/get-started/installation/)
 *
 * Run against production:
 *   k6 run load-test/api-smoke.js
 *
 * Run against a custom base URL:
 *   k6 run -e BASE_URL=https://your-app.vercel.app load-test/api-smoke.js
 *
 * Shorter run (e.g. 10s, 5 VUs):
 *   k6 run -e DURATION=10s -e VUS=5 load-test/api-smoke.js
 */
import http from 'k6/http';
import { check } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'https://adapta-labs-p62q.vercel.app';
const DURATION = __ENV.DURATION || '30s';
const VUS = __ENV.VUS ? parseInt(__ENV.VUS, 10) : 10;

export const options = {
  vus: VUS,
  duration: DURATION,
  thresholds: {
    http_req_failed: ['rate<0.05'],
    http_req_duration: ['p(95)<3000'],
  },
};

export default function () {
  const healthRes = http.get(`${BASE_URL}/api/health`);
  check(healthRes, {
    'health status 200': (r) => r.status === 200,
    'health body ok': (r) => {
      try {
        const b = JSON.parse(r.body);
        return b && b.ok === true;
      } catch {
        return false;
      }
    },
  });

  const opportunitiesRes = http.get(`${BASE_URL}/api/opportunities`);
  check(opportunitiesRes, {
    'opportunities status 200': (r) => r.status === 200,
    'opportunities is JSON': (r) => {
      if (r.status !== 200) return true;
      try {
        JSON.parse(r.body);
        return true;
      } catch {
        return false;
      }
    },
  });
}
