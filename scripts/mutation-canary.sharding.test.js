const test = require('node:test');
const assert = require('node:assert/strict');

/**
 * SHARDING IS A PARTITION, NOT A FILTER. cto/AdaptaLabs#77.
 *
 * The runner refuses filter flags on principle (#53, ADR-0004): a filtered run
 * is structurally blind to a pre-existing entry the same diff broke. A shard is
 * a different animal - one cell of a deterministic partition whose union is the
 * whole manifest, gated in CI by "all shards green". These tests pin the
 * properties that keep it that difference: both-or-neither flags, digit-only
 * values, 1-based bounds, a partition that is disjoint and complete and
 * independent of manifest order.
 *
 * `node --test`, run from the repo root by `npm run test:scripts`, so this runs
 * on the same gate as everything else.
 */

const load = () => import('./mutation-canary.mjs');

const entries = (ids) => ids.map((id) => ({ id }));

test('no shard flags means no shard - the full run stays the default', async () => {
  const { parseShardArgs } = await load();
  assert.equal(parseShardArgs([]), null);
  assert.equal(parseShardArgs(['--allow-dirty']), null);
});

test('a valid pair parses to 1-based numbers', async () => {
  const { parseShardArgs } = await load();
  assert.deepEqual(parseShardArgs(['--shard-index=2', '--shard-total=4']), {
    shardIndex: 2,
    shardTotal: 4
  });
  // Order-independent, and happy beside the existing flag.
  assert.deepEqual(parseShardArgs(['--shard-total=1', '--allow-dirty', '--shard-index=1']), {
    shardIndex: 1,
    shardTotal: 1
  });
});

test('one shard flag without the other is refused, naming the pair', async () => {
  const { parseShardArgs, Refusal } = await load();
  for (const argv of [['--shard-index=1'], ['--shard-total=4']]) {
    assert.throws(
      () => parseShardArgs(argv),
      (error) => error instanceof Refusal && /both or neither/.test(error.message),
      argv.join(' ')
    );
  }
});

test('a shard flag with no value is refused about the value, not the flag', async () => {
  const { parseShardArgs, Refusal } = await load();
  assert.throws(
    () => parseShardArgs(['--shard-index', '--shard-total=4']),
    (error) => error instanceof Refusal && /--shard-index=<n>/.test(error.message)
  );
});

test('shard values are plain digits only - the PORT lesson applies here too', async () => {
  // `Number()` reads `1e1`, `0x2`, `-1` and `' 2 '` happily, and every one of
  // them is a typo in this position, not a shard index.
  const { parseShardArgs, Refusal } = await load();
  for (const bad of ['1e1', '0x2', '-1', '', ' 2', '2.0']) {
    assert.throws(
      () => parseShardArgs([`--shard-index=${bad}`, '--shard-total=4']),
      (error) => error instanceof Refusal && /plain integer/.test(error.message),
      JSON.stringify(bad)
    );
  }
});

test('shard bounds are 1-based and inclusive: 1 <= index <= total', async () => {
  const { parseShardArgs, Refusal } = await load();
  const refused = (argv) =>
    assert.throws(() => parseShardArgs(argv), (error) => error instanceof Refusal, argv.join(' '));
  refused(['--shard-index=0', '--shard-total=4']);
  refused(['--shard-index=5', '--shard-total=4']);
  refused(['--shard-index=1', '--shard-total=0']);
  // The control: both edges of the valid range parse.
  const { parseShardArgs: parse } = await load();
  assert.deepEqual(parse(['--shard-index=1', '--shard-total=4']), { shardIndex: 1, shardTotal: 4 });
  assert.deepEqual(parse(['--shard-index=4', '--shard-total=4']), { shardIndex: 4, shardTotal: 4 });
});

test('a repeated shard flag is refused rather than last-one-wins', async () => {
  const { parseShardArgs, Refusal } = await load();
  assert.throws(
    () => parseShardArgs(['--shard-index=1', '--shard-index=2', '--shard-total=4']),
    (error) => error instanceof Refusal && /twice/.test(error.message)
  );
});

test('the partition is disjoint, complete and ordered by id', async () => {
  const { shardSlice } = await load();
  const all = entries(['e', 'a', 'c', 'b', 'g', 'f', 'd']);
  const shards = [1, 2, 3].map((k) => shardSlice(all, k, 3));

  // Complete: the union is the whole manifest, each entry exactly once.
  const union = shards.flat().map((entry) => entry.id).sort();
  assert.deepEqual(union, ['a', 'b', 'c', 'd', 'e', 'f', 'g']);

  // Disjoint sizes for 7 into 3: round-robin over the SORTED ids.
  assert.deepEqual(shards.map((shard) => shard.map((entry) => entry.id)), [
    ['a', 'd', 'g'],
    ['b', 'e'],
    ['c', 'f']
  ]);
});

test('the partition ignores manifest order - only ids decide the shard', async () => {
  // A reordering diff must not shuffle entries between shards mid-pipeline:
  // every job reads the same committed manifest, but the property is cheap to
  // pin and expensive to lose.
  const { shardSlice } = await load();
  const shuffled = entries(['g', 'b', 'f', 'a', 'd', 'c', 'e']);
  assert.deepEqual(
    shardSlice(shuffled, 2, 3).map((entry) => entry.id),
    ['b', 'e']
  );
});

test('one shard of one is the whole manifest - sharding degenerates to the full run', async () => {
  const { shardSlice } = await load();
  const all = entries(['b', 'a']);
  assert.deepEqual(shardSlice(all, 1, 1).map((entry) => entry.id), ['a', 'b']);
});

test('a shard past the manifest size selects nothing, for main() to refuse', async () => {
  // The refusal itself is wired through the real main() in the wiring tests;
  // this pins the function-level fact it acts on.
  const { shardSlice } = await load();
  assert.deepEqual(shardSlice(entries(['a', 'b']), 3, 4), []);
});

test('the shard flags are recognised arguments; near-misses are not', async () => {
  const { unrecognisedArgs, ACCEPTED_VALUE_ARGS } = await load();
  // THE VALUE-ARG SET, PINNED AS A LITERAL, for the same reason the bare set
  // is in mutation-canary.test.js: deriving the expectation from the set would
  // make this true of any set at all - including one that had grown `--id`,
  // the filter flag #53 says deliberately must not exist.
  assert.deepEqual([...ACCEPTED_VALUE_ARGS], ['--shard-index', '--shard-total']);
  // Recognised in both the valued and the bare form - the bare form is refused
  // later by parseShardArgs with a message about the VALUE, which beats a
  // generic one about the flag.
  assert.deepEqual(unrecognisedArgs(['--shard-index=1', '--shard-total=4']), []);
  assert.deepEqual(unrecognisedArgs(['--shard-index']), []);
  // Near-misses stay refusals: the door #53 closed stays closed.
  assert.deepEqual(unrecognisedArgs(['--shard=1']), ['--shard=1']);
  assert.deepEqual(unrecognisedArgs(['--shards-index=1']), ['--shards-index=1']);
  assert.deepEqual(unrecognisedArgs(['--id=x']), ['--id=x']);
});
