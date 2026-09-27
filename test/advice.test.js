import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advise } from '../src/core/advice.js';

const facing = (toCall) => ({ toCall, canCheck: false, canRaise: true, isOpening: false });
const free = { toCall: 0, canCheck: true, canRaise: true, isOpening: true };

test('se coucher quand les chances sont sous la cote du pot', () => {
  const advice = advise({ equity: 0.18, opponents: 1, pot: 200, legal: facing(100) });
  assert.equal(advice.action, 'fold');
  assert.match(advice.reason, /33\u00a0%/);
  assert.match(advice.reason, /18\u00a0%/);
});

test('suivre quand la cote du pot est favorable', () => {
  const advice = advise({ equity: 0.4, opponents: 1, pot: 300, legal: facing(50) });
  assert.equal(advice.action, 'call');
});

test('relancer une main très forte', () => {
  assert.equal(advise({ equity: 0.85, opponents: 1, pot: 300, legal: facing(50) }).action, 'raise');
});

test('parole ou mise quand personne n’a misé', () => {
  assert.equal(advise({ equity: 0.3, opponents: 2, pot: 60, legal: free }).action, 'check');
  const bet = advise({ equity: 0.7, opponents: 2, pot: 60, legal: free });
  assert.equal(bet.action, 'raise');
  assert.equal(bet.label, 'Miser');
});

test('jamais de relance quand elle est impossible', () => {
  const legal = { ...facing(50), canRaise: false };
  assert.equal(advise({ equity: 0.95, opponents: 1, pot: 300, legal }).action, 'call');
});
