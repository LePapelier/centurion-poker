import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCards } from '../src/core/cards.js';
import { evaluate, handName, bestFive, categoryOf, CATEGORY } from '../src/core/evaluator.js';

const score = (text) => evaluate(parseCards(text));
const name = (text) => handName(score(text));

test('nomme chaque catégorie', () => {
  assert.equal(name('As Ks Qs Js Ts 2d 3c'), 'Quinte flush royale');
  assert.equal(name('9h 8h 7h 6h 5h Ac Ad'), 'Quinte flush au 9');
  assert.equal(name('Ah 2h 3h 4h 5h Kc Kd'), 'Quinte flush au 5');
  assert.equal(name('Qc Qd Qh Qs 2c 3d 4h'), 'Carré de dames');
  assert.equal(name('Ac Ad Ah Kc Kd 2s 3s'), 'Full aux as par les rois');
  assert.equal(name('7c 7d 7h 2c 2d 2s 3s'), 'Full aux 7 par les 2');
  assert.equal(name('Ac 9c 7c 4c 2c Kd Kh'), 'Couleur à l’as');
  assert.equal(name('Tc 9d 8h 7s 6c 2d 2h'), 'Quinte au 10');
  assert.equal(name('Ac 2d 3h 4s 5c Kd Qh'), 'Quinte au 5');
  assert.equal(name('Jc Jd Jh 2c 5d 8h 9s'), 'Brelan de valets');
  assert.equal(name('Kc Kd 8h 8s 2c 3d 4h'), 'Double paire, rois et 8');
  assert.equal(name('Ac Ad 8h 7s 2c 3d 4h'), 'Paire d’as');
  assert.equal(name('Ac Qd 8h 7s 2c 3d 5h'), 'Hauteur as');
});

test('ordonne les catégories', () => {
  const ladder = [
    'Ac Qd 8h 7s 2c 3d 5h',
    'Ac Ad 8h 7s 2c 3d 4h',
    'Kc Kd 8h 8s 2c 3d 4h',
    'Jc Jd Jh 2c 5d 8h 9s',
    'Ac 2d 3h 4s 5c Kd Qh',
    'Ac 9c 7c 4c 2c Kd Kh',
    '7c 7d 7h 2c 2d 2s 3s',
    'Qc Qd Qh Qs 2c 3d 4h',
    'Ah 2h 3h 4h 5h Kc Kd',
  ];
  for (let index = 1; index < ladder.length; index++) {
    assert.ok(score(ladder[index]) > score(ladder[index - 1]), ladder[index]);
  }
});

test('départage par les cartes d’accompagnement', () => {
  assert.ok(score('Ac Ad Kh 7s 2c 3d 4h') > score('Ac Ad Qh 7s 2c 3d 4h'));
  assert.ok(score('Kc Kd 8h 8s Ac 3d 4h') > score('Kc Kd 8h 8s Qc 3d 4h'));
  // Trois paires : la plus basse ne compte plus, la meilleure carte restante oui.
  assert.equal(score('Kc Kd 8h 8s 5c 5d 9h'), score('Kc Kd 8h 8s 9c 2d 3h'));
  // Quinte au 6 contre quinte au 5 (la roue).
  assert.ok(score('2c 3d 4h 5s 6c Kd Kh') > score('Ac 2d 3h 4s 5c Jd Jh'));
  // Même main, cartes inutiles différentes : égalité.
  assert.equal(score('As Ks Qs Js Ts 2d 3c'), score('As Ks Qs Js Ts 9d 8c'));
});

test('retient les cinq bonnes cartes', () => {
  const cards = parseCards('Ac Ad Ah Kc Kd 2s 3s');
  const five = bestFive(cards);
  assert.equal(five.length, 5);
  assert.equal(evaluate(five), evaluate(cards));
  assert.equal(categoryOf(evaluate(five)), CATEGORY.FULL_HOUSE);
});
