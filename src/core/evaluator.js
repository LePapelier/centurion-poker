/**
 * Évaluation des mains.
 *
 * `evaluate` prend de cinq à sept cartes et rend un entier : plus il est
 * grand, meilleure est la meilleure combinaison de cinq cartes qu'on peut en
 * tirer. La catégorie occupe les bits hauts, puis viennent jusqu'à cinq
 * hauteurs départageantes de quatre bits chacune. Deux mains se comparent donc
 * d'une simple soustraction, ce qui compte : l'IA en évalue des dizaines de
 * milliers par décision.
 */
import { rankOf, suitOf } from './cards.js';

export const CATEGORY = {
  HIGH_CARD: 0,
  PAIR: 1,
  TWO_PAIR: 2,
  TRIPS: 3,
  STRAIGHT: 4,
  FLUSH: 5,
  FULL_HOUSE: 6,
  QUADS: 7,
  STRAIGHT_FLUSH: 8,
};

export const CATEGORY_NAMES = [
  'Hauteur',
  'Paire',
  'Double paire',
  'Brelan',
  'Quinte',
  'Couleur',
  'Full',
  'Carré',
  'Quinte flush',
];

const CATEGORY_SHIFT = 20;

// Tampons réutilisés d'un appel à l'autre : pas d'allocation dans la boucle
// de simulation.
const rankCounts = new Int8Array(13);
const suitCounts = new Int8Array(4);
const suitMasks = new Int32Array(4);

function pack(category, ...ranks) {
  let score = category << CATEGORY_SHIFT;
  for (let index = 0; index < 5; index++) {
    score |= (ranks[index] ?? 0) << (16 - index * 4);
  }
  return score;
}

/**
 * Hauteur de la plus haute quinte contenue dans un masque de hauteurs, ou -1.
 * L'as compte aussi en bas : A-2-3-4-5 est une quinte au 5.
 */
function straightHigh(mask) {
  const shifted = (mask << 1) | ((mask >> 12) & 1);
  for (let top = 13; top >= 4; top--) {
    if (((shifted >> (top - 4)) & 0x1f) === 0x1f) return top - 1;
  }
  return -1;
}

/** Les `count` plus hautes hauteurs d'un masque, dans l'ordre décroissant. */
function topRanks(mask, count, exclude = 0) {
  const ranks = [];
  for (let rank = 12; rank >= 0 && ranks.length < count; rank--) {
    if ((mask >> rank) & 1 && !((exclude >> rank) & 1)) ranks.push(rank);
  }
  return ranks;
}

/** Note de la meilleure main de cinq cartes parmi `cards` (5 à 7 cartes). */
export function evaluate(cards) {
  rankCounts.fill(0);
  suitCounts.fill(0);
  suitMasks.fill(0);
  let rankMask = 0;

  for (let index = 0; index < cards.length; index++) {
    const card = cards[index];
    const rank = rankOf(card);
    const suit = suitOf(card);
    rankCounts[rank]++;
    suitCounts[suit]++;
    suitMasks[suit] |= 1 << rank;
    rankMask |= 1 << rank;
  }

  let flushSuit = -1;
  for (let suit = 0; suit < 4; suit++) {
    if (suitCounts[suit] >= 5) flushSuit = suit;
  }

  if (flushSuit >= 0) {
    const high = straightHigh(suitMasks[flushSuit]);
    if (high >= 0) return pack(CATEGORY.STRAIGHT_FLUSH, high);
  }

  let quad = -1;
  const trips = [];
  const pairs = [];
  for (let rank = 12; rank >= 0; rank--) {
    const count = rankCounts[rank];
    if (count === 4) quad = rank;
    else if (count === 3) trips.push(rank);
    else if (count === 2) pairs.push(rank);
  }

  if (quad >= 0) {
    return pack(CATEGORY.QUADS, quad, topRanks(rankMask, 1, 1 << quad)[0]);
  }

  if (trips.length > 0 && (trips.length > 1 || pairs.length > 0)) {
    const pair = Math.max(trips[1] ?? -1, pairs[0] ?? -1);
    return pack(CATEGORY.FULL_HOUSE, trips[0], pair);
  }

  if (flushSuit >= 0) return pack(CATEGORY.FLUSH, ...topRanks(suitMasks[flushSuit], 5));

  const straight = straightHigh(rankMask);
  if (straight >= 0) return pack(CATEGORY.STRAIGHT, straight);

  if (trips.length > 0) {
    return pack(CATEGORY.TRIPS, trips[0], ...topRanks(rankMask, 2, 1 << trips[0]));
  }

  if (pairs.length >= 2) {
    const exclude = (1 << pairs[0]) | (1 << pairs[1]);
    return pack(CATEGORY.TWO_PAIR, pairs[0], pairs[1], topRanks(rankMask, 1, exclude)[0]);
  }

  if (pairs.length === 1) {
    return pack(CATEGORY.PAIR, pairs[0], ...topRanks(rankMask, 3, 1 << pairs[0]));
  }

  return pack(CATEGORY.HIGH_CARD, ...topRanks(rankMask, 5));
}

export const categoryOf = (score) => score >> CATEGORY_SHIFT;
const rankAt = (score, index) => (score >> (16 - index * 4)) & 0xf;

/* ------------------------------------------------------------------ */
/* Noms                                                                */
/* ------------------------------------------------------------------ */

const SINGULAR = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'valet', 'dame', 'roi', 'as'];
const PLURAL = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'valets', 'dames', 'rois', 'as'];

/** « de rois », « d'as », « de 8 ». */
const ofPlural = (rank) => (rank === 12 ? 'd’as' : `de ${PLURAL[rank]}`);

/** « au roi », « à la dame », « à l'as », « au 10 ». */
function toSingular(rank) {
  if (rank === 12) return 'à l’as';
  if (rank === 10) return 'à la dame';
  return `au ${SINGULAR[rank]}`;
}

/** Nom de la main, tel qu'on l'annonce à la table : « Full aux rois par les 7 ». */
export function handName(score) {
  const category = categoryOf(score);
  const first = rankAt(score, 0);
  const second = rankAt(score, 1);

  switch (category) {
    case CATEGORY.STRAIGHT_FLUSH:
      return first === 12 ? 'Quinte flush royale' : `Quinte flush ${toSingular(first)}`;
    case CATEGORY.QUADS:
      return `Carré ${ofPlural(first)}`;
    case CATEGORY.FULL_HOUSE:
      return `Full aux ${PLURAL[first]} par les ${PLURAL[second]}`;
    case CATEGORY.FLUSH:
      return `Couleur ${toSingular(first)}`;
    case CATEGORY.STRAIGHT:
      return `Quinte ${toSingular(first)}`;
    case CATEGORY.TRIPS:
      return `Brelan ${ofPlural(first)}`;
    case CATEGORY.TWO_PAIR:
      return `Double paire, ${PLURAL[first]} et ${PLURAL[second]}`;
    case CATEGORY.PAIR:
      return `Paire ${ofPlural(first)}`;
    default:
      return `Hauteur ${SINGULAR[first]}`;
  }
}

/**
 * Les cinq cartes qui forment la meilleure main, pour les mettre en valeur à
 * l'abattage. Seulement pour l'affichage : on essaie toutes les combinaisons.
 */
export function bestFive(cards) {
  if (cards.length <= 5) return [...cards];
  let best = null;
  let bestScore = -1;
  const visit = (start, chosen) => {
    if (chosen.length === 5) {
      const score = evaluate(chosen);
      if (score > bestScore) {
        bestScore = score;
        best = [...chosen];
      }
      return;
    }
    for (let index = start; index <= cards.length - (5 - chosen.length); index++) {
      chosen.push(cards[index]);
      visit(index + 1, chosen);
      chosen.pop();
    }
  };
  visit(0, []);
  return best;
}
