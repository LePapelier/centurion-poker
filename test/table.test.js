import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCards, seededRandom } from '../src/core/cards.js';
import { Table } from '../src/core/table.js';

const players = (count) =>
  Array.from({ length: count }, (_, index) => ({ id: `p${index}`, name: `J${index}`, kind: 'ai' }));

/** Termine le tour d'enchères en cours ou la main, carte après carte. */
function settle(table) {
  while (table.phase === 'between') table.nextStreet();
}

/** Prépare une main aux cartes choisies : `holes` par siège, puis le tableau. */
function rig(table, holes, board) {
  table.startHand();
  const cards = holes.map(parseCards);
  const boardCards = parseCards(board);
  table.seats.forEach((seat, index) => {
    if (seat.hole) seat.hole = cards[index];
  });
  const used = new Set([...cards.flat(), ...boardCards]);
  // Le paquet se dépile par la fin : carte brûlée, flop, brûlée, turn, brûlée, river.
  const rest = table.deck.filter((card) => !used.has(card));
  const order = [rest[0], ...boardCards.slice(0, 3), rest[1], boardCards[3], rest[2], boardCards[4]];
  table.deck = [...rest.slice(3), ...order.reverse()];
}

test('parties aléatoires : les jetons se conservent et la partie finit', () => {
  for (let game = 0; game < 60; game++) {
    const random = seededRandom(1000 + game);
    const count = 2 + (game % 5);
    const table = new Table({ players: players(count), random, stack: 400 });
    const total = 400 * count;
    let guard = 0;
    table.startHand();
    while (table.phase !== 'gameOver') {
      assert.ok(guard++ < 200000, 'la partie ne finit pas');
      if (table.phase === 'betting') {
        const legal = table.legalActions(table.toAct);
        const roll = random();
        let action;
        if (roll < 0.15) action = { type: 'fold' };
        else if (roll < 0.6) action = { type: legal.canCheck ? 'check' : 'call' };
        else if (roll < 0.9 && legal.canRaise) {
          const span = legal.maxRaiseTo - legal.minRaiseTo;
          action = { type: 'raise', amount: legal.minRaiseTo + Math.floor(random() * span * 0.4) };
        } else action = { type: 'allin' };
        assert.ok(table.act(table.toAct, action), JSON.stringify(action));
      } else if (table.phase === 'between') {
        table.nextStreet();
      } else if (table.phase === 'handOver') {
        table.startHand();
      }
      assert.equal(table.chipTotal, total);
      for (const seat of table.seats) assert.ok(seat.stack >= 0);
    }
    const places = table.seats.map((seat) => seat.place).sort();
    assert.equal(places[0], 1);
    assert.equal(table.seats.filter((seat) => seat.place === 1).length, 1);
  }
});

test('refuse de parler hors de son tour ou de checker face à une mise', () => {
  const table = new Table({ players: players(3), random: seededRandom(7) });
  table.startHand();
  const other = (table.toAct + 1) % 3;
  assert.equal(table.act(other, { type: 'call' }), false);
  assert.equal(table.act(table.toAct, { type: 'check' }), false);
});

test('à deux, le bouton paie la petite blind et parle en premier', () => {
  const table = new Table({ players: players(2), random: seededRandom(3) });
  table.startHand();
  assert.equal(table.sbSeat, table.button);
  assert.equal(table.toAct, table.button);
  table.act(table.toAct, { type: 'call' });
  table.act(table.toAct, { type: 'check' });
  table.nextStreet();
  assert.equal(table.street, 'flop');
  assert.notEqual(table.toAct, table.button);
});

test('pots annexes : chacun ne gagne que ce qu’il a pu couvrir', () => {
  const table = new Table({ players: players(3), random: seededRandom(11), stack: 1000 });
  table.seats[0].stack = 100;
  table.seats[1].stack = 300;
  table.seats[2].stack = 1000;
  table.button = 1; // avance au siège 2 : 0 petite blind, 1 grosse blind, 2 parle en premier
  rig(table, ['As Ad', 'Ks Kd', 'Qs Qd'], '2c 7h 9s Jc 3d');
  assert.ok(table.act(2, { type: 'allin' }));
  assert.ok(table.act(0, { type: 'call' }));
  assert.ok(table.act(1, { type: 'call' }));
  settle(table);
  assert.equal(table.phase, 'handOver');
  // Principal : 3 × 100 à l'as ; annexe : 2 × 200 au roi ; le reste revient au siège 2.
  assert.equal(table.seats[0].stack, 300);
  assert.equal(table.seats[1].stack, 400);
  assert.equal(table.seats[2].stack, 1000 - 300);
  assert.equal(table.seats[0].out, false);
});

test('égalité : le pot se partage', () => {
  const table = new Table({ players: players(2), random: seededRandom(5), stack: 500 });
  rig(table, ['As 2d', 'Ah 3c'], 'Kc Qd Jh Ts 5c');
  table.act(table.toAct, { type: 'allin' });
  table.act(table.toAct, { type: 'call' });
  settle(table);
  assert.equal(table.seats[0].stack, 500);
  assert.equal(table.seats[1].stack, 500);
});

test('un tapis trop court ne rouvre pas les relances', () => {
  const table = new Table({ players: players(3), random: seededRandom(9), stack: 1000 });
  table.button = 1; // avance au siège 2
  table.startHand(); // blinds 10/20 : siège 0 SB, 1 BB, 2 parle
  table.seats[0].stack = 70; // tapis à 80 en tout, petite blind comprise
  assert.ok(table.act(2, { type: 'raise', amount: 60 }));
  assert.ok(table.act(0, { type: 'allin' })); // 80 : plus que 60, moins qu'une relance complète (100)
  assert.ok(table.act(1, { type: 'call' }));
  assert.equal(table.toAct, 2);
  const legal = table.legalActions(2);
  assert.equal(legal.canRaise, false);
  assert.equal(legal.toCall, 20);
});

test('les cartes adverses restent cachées dans l’instantané', () => {
  const table = new Table({ players: players(3), random: seededRandom(2) });
  table.startHand();
  const view = table.view(1);
  assert.ok(view.seats[1].hole.every((card) => typeof card === 'number'));
  assert.deepEqual(view.seats[0].hole, [null, null]);
  assert.equal(JSON.stringify(view).includes('"deck"'), false);
});
