/**
 * Cartes et paquet.
 *
 * Une carte est un entier de 0 à 51 : la hauteur dans les bits hauts (0 pour
 * le 2, 12 pour l'as), la couleur dans les deux bits bas. Tout le moteur
 * manipule ces entiers ; les noms ne servent qu'à l'affichage.
 */

export const RANK_SYMBOLS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'V', 'D', 'R', 'A'];

/** Pique, cœur, carreau, trèfle. */
export const SUIT_SYMBOLS = ['♠', '♥', '♦', '♣'];
export const SUIT_NAMES = ['pique', 'cœur', 'carreau', 'trèfle'];

export const ACE = 12;

export const rankOf = (card) => card >> 2;
export const suitOf = (card) => card & 3;
export const makeCard = (rank, suit) => (rank << 2) | suit;
export const isRed = (card) => suitOf(card) === 1 || suitOf(card) === 2;

/** Nom court, pour le journal et les tests : « A♠ », « 10♥ ». */
export function cardLabel(card) {
  return RANK_SYMBOLS[rankOf(card)] + SUIT_SYMBOLS[suitOf(card)];
}

/** Lecture inverse, pour les tests : « As », « Td », « 10h ». */
export function parseCard(text) {
  const match = /^(10|[2-9TJQKAVDR])([shdc♠♥♦♣])$/i.exec(text.trim());
  if (!match) throw new Error(`carte illisible : ${text}`);
  const rankText = match[1].toUpperCase();
  const rank = { T: 8, '10': 8, J: 9, V: 9, Q: 10, D: 10, K: 11, R: 11, A: 12 }[rankText] ?? Number(rankText) - 2;
  const suit = { s: 0, h: 1, d: 2, c: 3, '♠': 0, '♥': 1, '♦': 2, '♣': 3 }[match[2].toLowerCase()];
  return makeCard(rank, suit);
}

export const parseCards = (text) => text.trim().split(/\s+/).filter(Boolean).map(parseCard);

/** Tirage uniforme dans [0, 1), à partir du générateur du système. */
export function cryptoRandom() {
  const buffer = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buffer);
  return buffer[0] / 2 ** 32;
}

/**
 * Générateur reproductible (mulberry32), pour les simulations et les tests.
 * Les parties réelles utilisent `cryptoRandom`.
 */
export function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

/** Un paquet neuf, battu (Fisher-Yates). */
export function shuffledDeck(random = cryptoRandom) {
  const deck = Array.from({ length: 52 }, (_, index) => index);
  for (let index = deck.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [deck[index], deck[other]] = [deck[other], deck[index]];
  }
  return deck;
}
