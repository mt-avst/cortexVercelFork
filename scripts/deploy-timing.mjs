#!/usr/bin/env node
// deploy-timing.mjs - time one change end-to-end, from its final-commit CI to
// the deploy going live, and count how many times the mutation canary ran.
//
// Purpose: confirm the saving from moving the canary to the merge train only
// (MRs !477 + !478, 2026-09-18). Before that a change paid the ~11.5 min canary
// THREE times - MR pipeline, merge-train pipeline, post-merge main pipeline;
// after, once, on the train. This measures the real numbers rather than
// trusting the estimate.
//
// Usage:
//   GITLAB_TOKEN=<read_api PAT> node scripts/deploy-timing.mjs <mr-iid> [--follow]
//   node scripts/deploy-timing.mjs --selftest
//
//   --follow    after the MR merges, poll <deploy-url>/version.json until it
//               serves the merge commit, and time the true go-live.
//   --project   project path or id (default: cto/AdaptaLabs)
//   --deploy-url deployed origin to poll (default the playground beta)
//
// The token is a personal access token with read_api scope. The bot token the
// gitlab MCP uses is not available to a standalone script, so this needs your
// own. Host is read from the origin remote.
//
// MEASURED BASELINE (!476, the last 3x-canary change, this is what --selftest
// pins): canary ran 3x; MR-pipeline start 08:45:50 -> deploy triggered
// 09:25:21 = ~39.6 min to deploy-triggered, ~46 min to live. The next real
// change on the train-only rule should show canaryRuns === 1 and a much
// shorter end-to-end.

import { pathToFileURL } from 'node:url';

const DEFAULT_PROJECT = 'cto/AdaptaLabs';
const DEFAULT_DEPLOY_URL = 'https://adaptalabs.kubera-playground.adaptavist.net';
const CANARY = 'mutation-canary';

const ms = (a, b) => new Date(b).getTime() - new Date(a).getTime();
const mins = (m) => `${(m / 60000).toFixed(1)} min`;
const kindOf = (ref) =>
  ref.endsWith('/train') ? 'train' : ref.endsWith('/merge') ? 'mr' : 'deploy';

/** Min started / max finished across a set of jobs, ignoring ones that never ran. */
function span(jobs) {
  const started = jobs.map((j) => j.started_at).filter(Boolean).sort();
  const finished = jobs.map((j) => j.finished_at).filter(Boolean).sort();
  if (!started.length || !finished.length) return null;
  return { start: started[0], finish: finished[finished.length - 1] };
}

/**
 * Pure: turn a normalised {mr, pipelines, live} bundle into the timing report.
 * Kept side-effect free so --selftest can drive it over baked real data.
 */
export function analyze({ mr, pipelines, live }) {
  const byKind = (k) => pipelines.filter((p) => kindOf(p.ref) === k);
  const canaryJobs = (p) => p.jobs.filter((j) => j.name.startsWith(CANARY));
  const ranCanary = (p) => canaryJobs(p).length > 0;

  const canaryPipelines = pipelines.filter(ranCanary);
  const canaryWallMs = canaryPipelines.reduce((sum, p) => {
    const s = span(canaryJobs(p));
    return sum + (s ? ms(s.start, s.finish) : 0);
  }, 0);

  const mrPipe = byKind('mr')[0];
  const trainPipe = byKind('train')[0];
  const deployPipe = byKind('deploy')[0];

  const startAt = mrPipe?.created_at ?? mr.created_at ?? null;
  const deployJob = deployPipe?.jobs.find((j) => j.name === 'trigger-deployment-prod');
  const deployTriggeredAt = deployJob?.finished_at ?? null;
  const liveAt = live?.at ?? null;
  const endAt = liveAt ?? deployTriggeredAt ?? mr.merged_at;

  const pipeSpan = (p) => (p ? span(p.jobs) : null);
  const dur = (p) => {
    const s = pipeSpan(p);
    return s ? ms(s.start, s.finish) : null;
  };

  return {
    canaryRuns: canaryPipelines.length,
    canaryOn: canaryPipelines.map((p) => kindOf(p.ref)),
    canaryWallMs,
    startAt,
    mergedAt: mr.merged_at,
    deployTriggeredAt,
    liveAt,
    endToEndMs: startAt && endAt ? ms(startAt, endAt) : null,
    endMeasuredTo: liveAt ? 'live' : deployTriggeredAt ? 'deploy-triggered' : 'merge',
    phases: {
      mrPipelineMs: dur(mrPipe),
      trainPipelineMs: dur(trainPipe),
      deployPipelineMs: dur(deployPipe),
      mergeToDeployTriggeredMs:
        mr.merged_at && deployTriggeredAt ? ms(mr.merged_at, deployTriggeredAt) : null
    }
  };
}

// ---- live fetch -----------------------------------------------------------

function apiBase() {
  const remote =
    process.env.GIT_REMOTE ||
    'git@gitlab.adaptavist.net:cto/AdaptaLabs.git';
  const host = remote.replace(/^git@/, '').replace(/^https?:\/\//, '').split(/[:/]/)[0];
  return `https://${host}/api/v4`;
}

async function gl(path) {
  const token = process.env.GITLAB_TOKEN || process.env.GL_TOKEN;
  if (!token) throw new Error('set GITLAB_TOKEN (personal access token, read_api scope)');
  const res = await fetch(`${apiBase()}${path}`, {
    headers: { 'PRIVATE-TOKEN': token }
  });
  if (!res.ok) throw new Error(`GitLab ${res.status} on ${path}: ${await res.text()}`);
  return res.json();
}

async function jobsFor(projectId, pipelineId) {
  // 100 covers this project's pipeline (~30 jobs incl 4 canary shards).
  return gl(`/projects/${projectId}/pipelines/${pipelineId}/jobs?per_page=100`);
}

async function collect(projectRaw, iid) {
  const projectId = encodeURIComponent(projectRaw);
  const mr = await gl(`/projects/${projectId}/merge_requests/${iid}`);
  const mrPipes = await gl(`/projects/${projectId}/merge_requests/${iid}/pipelines`);

  const pipes = [...mrPipes];
  if (mr.merge_commit_sha) {
    const mainPipes = await gl(
      `/projects/${projectId}/pipelines?sha=${mr.merge_commit_sha}`
    );
    for (const p of mainPipes) if (!pipes.some((q) => q.id === p.id)) pipes.push(p);
  }

  const pipelines = [];
  for (const p of pipes) {
    pipelines.push({ id: p.id, ref: p.ref, created_at: p.created_at, jobs: await jobsFor(projectId, p.id) });
  }
  return { mr, pipelines };
}

async function pollLive(deployUrl, sha) {
  process.stderr.write(`following ${deployUrl}/version.json for ${sha.slice(0, 8)} ...\n`);
  const deadline = Date.now() + 20 * 60000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${deployUrl}/version.json`, { cache: 'no-store' });
      const { revision } = await r.json();
      if (revision === sha) return { revision, at: new Date().toISOString() };
    } catch { /* transient - keep polling */ }
    await new Promise((r) => setTimeout(r, 15000));
  }
  return null;
}

function report(r) {
  const line = (k, v) => console.log(`  ${k.padEnd(26)} ${v}`);
  console.log('\n=== deploy timing ===');
  line('canary runs', `${r.canaryRuns}  (${r.canaryOn.join(', ') || 'none'})`);
  line('canary wall time', mins(r.canaryWallMs));
  console.log('  --- phases ---');
  if (r.phases.mrPipelineMs != null) line('MR pipeline', mins(r.phases.mrPipelineMs));
  if (r.phases.trainPipelineMs != null) line('merge-train pipeline', mins(r.phases.trainPipelineMs));
  if (r.phases.deployPipelineMs != null) line('deploy (main) pipeline', mins(r.phases.deployPipelineMs));
  if (r.phases.mergeToDeployTriggeredMs != null)
    line('merge -> deploy triggered', mins(r.phases.mergeToDeployTriggeredMs));
  console.log('  --- end to end ---');
  line('start (MR pipeline)', r.startAt);
  line('merged', r.mergedAt ?? '(not merged yet)');
  line('deploy triggered', r.deployTriggeredAt ?? '(pending)');
  if (r.liveAt) line('live', r.liveAt);
  if (r.endToEndMs != null) line(`TOTAL (to ${r.endMeasuredTo})`, mins(r.endToEndMs));
  console.log('\nbaseline !476 (3x canary): ~39.6 min to deploy-triggered, ~46 min to live\n');
}

// ---- self-test: real !476 numbers, measured this session -------------------

// Real, measured !476 pipeline timestamps (the last 3x-canary change). Canary
// spans are the real 1/4-shard start..finish; the other shards land within
// ~1 min, so shard 1/4 is a faithful stand-in for the job's span. Exported so
// deploy-timing.test.js pins the analysis against these numbers in CI.
export const BASELINE_476 = {
  mr: {
    iid: 476,
    created_at: '2026-09-18T08:39:53Z',
    merged_at: '2026-09-18T09:11:21Z',
    merge_commit_sha: 'b5141b900a99537b9c9ef968fb631fe870ac17c0'
  },
  pipelines: [
    {
      id: 383509, ref: 'refs/merge-requests/476/merge', created_at: '2026-09-18T08:45:50Z',
      jobs: [{ name: 'mutation-canary 1/4', started_at: '2026-09-18T08:46:33Z', finished_at: '2026-09-18T08:56:46Z' },
             { name: 'lint', started_at: '2026-09-18T08:45:55Z', finished_at: '2026-09-18T08:58:05Z' }]
    },
    {
      id: 383513, ref: 'refs/merge-requests/476/train', created_at: '2026-09-18T08:58:18Z',
      jobs: [{ name: 'mutation-canary 1/4', started_at: '2026-09-18T08:58:58Z', finished_at: '2026-09-18T09:11:03Z' }]
    },
    {
      id: 383519, ref: 'main', created_at: '2026-09-18T09:11:25Z',
      jobs: [{ name: 'mutation-canary 1/4', started_at: '2026-09-18T09:12:12Z', finished_at: '2026-09-18T09:22:40Z' },
             { name: 'trigger-deployment-prod', started_at: '2026-09-18T09:24:07Z', finished_at: '2026-09-18T09:25:21Z' }]
    }
  ],
  live: null
};

function selftest() {
  const r = analyze(BASELINE_476);
  const checks = [
    ['canary ran 3x', r.canaryRuns === 3],
    ['canary on mr+train+deploy', r.canaryOn.join(',') === 'mr,train,deploy'],
    ['end-to-end to deploy-triggered ~39.6 min', Math.abs(r.endToEndMs - 39.5 * 60000) < 60000],
    ['deploy waited on canary (merge->trigger > 13 min)', r.phases.mergeToDeployTriggeredMs > 13 * 60000]
  ];
  let ok = true;
  for (const [name, pass] of checks) {
    console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}`);
    if (!pass) ok = false;
  }
  report(r);
  process.exit(ok ? 0 : 1);
}

// ---- main -----------------------------------------------------------------

async function main(args) {
  if (args.includes('--selftest')) {
    selftest();
    return;
  }
  const iid = args.find((a) => /^\d+$/.test(a));
  if (!iid) {
    console.error('usage: GITLAB_TOKEN=<pat> node scripts/deploy-timing.mjs <mr-iid> [--follow]');
    process.exit(2);
  }
  const flagVal = (flag, fallback) => {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
  };
  const project = flagVal('--project', DEFAULT_PROJECT);
  const deployUrl = flagVal('--deploy-url', DEFAULT_DEPLOY_URL);
  const { mr, pipelines } = await collect(project, iid);
  let live = null;
  if (args.includes('--follow') && mr.merge_commit_sha) {
    live = await pollLive(deployUrl, mr.merge_commit_sha);
  }
  report(analyze({ mr, pipelines, live }));
}

// Run only when invoked directly, so importing `analyze` in a test does not
// trigger the CLI (which would process.exit on no args).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
