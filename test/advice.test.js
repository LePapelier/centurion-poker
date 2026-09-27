import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advise } from '../src/core/advice.js';

const base = { bigBlind: 20, smallBlind: 10, myBet: 0, myStack: 1500, limpers: 0 };
const facing = (toCall, extra = {}) => ({
  toCall,
  canCheck: false,
  canRaise: true,
  isOpening: false,
  minRaiseTo: toCall * 2,
  maxRaiseTo: 1500,
  ...extra,
});
const free = { toCall: 0, canCheck: true, canRaise: true, isOpening: true, minRaiseTo: 20, maxRaiseTo: 1500 };

test('se coucher quand les chances sont sous la cote du pot', () => {
  const advice = advise({ ...base, equity: 0.18, opponents: 1, pot: 200, legal: facing(100), currentBet: 100, street: 'flop' });
  assert.equal(advice.action, 'fold');
  assert.match(advice.reason, /33 %/);
  assert.match(advice.reason, /18 %/);
});

test('suivre quand la cote du pot est favorable, sans relancer', () => {
  const advice = advise({ ...base, equity: 0.4, opponents: 1, pot: 300, legal: facing(50), currentBet: 50, street: 'turn' });
  assert.equal(advice.action, 'call');
  assert.match(advice.reason, /Pas assez pour relancer/);
});

test('relancer une main très forte, à trois fois la mise', () => {
  const advice = advise({ ...base, equity: 0.85, opponents: 1, pot: 300, legal: facing(50), currentBet: 50, street: 'flop' });
  assert.equal(advice.action, 'raise');
  assert.equal(advice.amount, 150);
  assert.equal(advice.label, 'Relancer à 150');
});

test('avant le flop : trois grosses blinds, une de plus par suiveur', () => {
  const legal = facing(20, { minRaiseTo: 40 });
  const alone = advise({ ...base, equity: 0.8, opponents: 1, pot: 30, legal, currentBet: 20, street: 'preflop' });
  assert.equal(alone.amount, 60);
  const withLimpers = advise({ ...base, limpers: 2, equity: 0.6, opponents: 3, pot: 70, legal, currentBet: 20, street: 'preflop' });
  assert.equal(withLimpers.amount, 100);
});

test('après le flop, une part du pot, et la mise d’ouverture s’appelle miser', () => {
  const bet = advise({ ...base, equity: 0.7, opponents: 2, pot: 120, legal: free, currentBet: 0, street: 'flop' });
  assert.equal(bet.action, 'raise');
  assert.equal(bet.amount, 70); // 60 % de 120, arrondi à la petite blind
  assert.equal(bet.label, 'Miser 70');
  assert.equal(advise({ ...base, equity: 0.3, opponents: 2, pot: 60, legal: free, currentBet: 0, street: 'flop' }).action, 'check');
});

test('tapis quand la mise engagerait presque tout', () => {
  const advice = advise({ ...base, myStack: 150, equity: 0.9, opponents: 1, pot: 200, legal: { ...free, maxRaiseTo: 150 }, currentBet: 0, street: 'river' });
  assert.equal(advice.label, 'Tapis');
  assert.equal(advice.amount, 150);
});

test('jamais de relance quand elle est impossible', () => {
  const legal = { ...facing(50), canRaise: false };
  assert.equal(advise({ ...base, equity: 0.95, opponents: 1, pot: 300, legal, currentBet: 50, street: 'flop' }).action, 'call');
});
