// Guards the deploy-timing analysis (scripts/deploy-timing.mjs). The tool's job
// is to count how many pipelines ran the mutation canary and to time a change
// end to end; these pin that logic against the real !476 numbers (3x canary)
// and a synthetic train-only change (1x), so the two are provably told apart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, BASELINE_476 } from './deploy-timing.mjs';

const MIN = 60000;

test('the !476 baseline reads as three canary runs, on mr+train+deploy', () => {
  const r = analyze(BASELINE_476);
  assert.equal(r.canaryRuns, 3);
  assert.deepEqual(r.canaryOn, ['mr', 'train', 'deploy']);
});

test('the !476 end-to-end (to deploy-triggered) is ~39.5 min, deploy waited on the canary', () => {
  const r = analyze(BASELINE_476);
  assert.ok(Math.abs(r.endToEndMs - 39.5 * MIN) < MIN, `got ${r.endToEndMs / MIN} min`);
  // merge -> deploy triggered was ~14 min: the deploy sat behind the main canary.
  assert.ok(r.phases.mergeToDeployTriggeredMs > 13 * MIN);
});

// CONTROL: a train-only change must read as ONE canary run, or the count above
// proves nothing. Same shape, canary present only on the train pipeline.
const TRAIN_ONLY = {
  mr: {
    iid: 999,
    created_at: '2026-09-18T12:32:31Z',
    merged_at: '2026-09-18T12:48:34Z',
    merge_commit_sha: 'a505c97c25d4f1537d56f3f33925fcdcb29aad60'
  },
  pipelines: [
    {
      id: 1, ref: 'refs/merge-requests/999/merge', created_at: '2026-09-18T12:32:33Z',
      jobs: [{ name: 'lint', started_at: '2026-09-18T12:32:37Z', finished_at: '2026-09-18T12:36:30Z' }]
    },
    {
      id: 2, ref: 'refs/merge-requests/999/train', created_at: '2026-09-18T12:36:33Z',
      jobs: [{ name: 'mutation-canary 1/4', started_at: '2026-09-18T12:37:04Z', finished_at: '2026-09-18T12:47:03Z' }]
    }
  ],
  live: null
};

test('a train-only change reads as one canary run, on the train', () => {
  const r = analyze(TRAIN_ONLY);
  assert.equal(r.canaryRuns, 1);
  assert.deepEqual(r.canaryOn, ['train']);
  // The MR pipeline ran no canary, so it is fast; the tool still times it.
  assert.ok(r.phases.mrPipelineMs < 5 * MIN);
});

test('endToEnd falls back to deploy-triggered, then merge, when live is absent', () => {
  // No deploy pipeline and no live: the end clamps to merged_at.
  const noDeploy = {
    mr: { merged_at: '2026-09-18T12:48:34Z', merge_commit_sha: 'x' },
    pipelines: [
      {
        id: 1, ref: 'refs/merge-requests/999/merge', created_at: '2026-09-18T12:32:33Z',
        jobs: [{ name: 'lint', started_at: '2026-09-18T12:32:37Z', finished_at: '2026-09-18T12:36:30Z' }]
      }
    ],
    live: null
  };
  const r = analyze(noDeploy);
  assert.equal(r.endMeasuredTo, 'merge');
  assert.equal(r.deployTriggeredAt, null);
});
