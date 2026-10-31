import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRpc, setKeyedRpc, bindKeyedLedger, keyedStatus } from '../src/playbook/solana.js';

test('keyed rpc (her helius key) goes first, counts, and stops at the daily budget', async () => {
  const hits = [];
  const fetchImpl = async (url) => { hits.push(url); return { ok: true, status: 200, json: async () => ({ result: 7 }) }; };
  const K = 'https://keyed.example/?api-key=TEST';
  setKeyedRpc(K, { dailyCap: 10, softPct: 50 });
  const L = bindKeyedLedger({ day: '', used: 0, denied: 0 });
  const rpc = makeRpc({ fetchImpl });
  for (let i = 0; i < 5; i++) assert.equal(await rpc('getSlot', []), 7);
  assert.deepEqual(hits, Array(5).fill(K));
  await rpc('getSlot', []); // soft cap (5 of 10) reached: ordinary calls go to the free list
  assert.notEqual(hits.at(-1), K);
  await rpc('getMultipleAccounts', [[]], { priority: true }); // watching an open position may still use it
  assert.equal(hits.at(-1), K);
  assert.equal(L.used, 6);
  assert.equal(keyedStatus().on, true);
  setKeyedRpc(null);
  await rpc('getSlot', []);
  assert.notEqual(hits.at(-1), K);
});
