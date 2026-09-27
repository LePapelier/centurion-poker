/**
 * Décisions de l'adversaire.
 *
 * L'IA ne voit que ce qu'un joueur verrait à sa place : l'instantané de la
 * table pris depuis son siège, avec ses deux cartes et rien d'autre. Elle ne
 * triche pas, et le même code sert en solo comme en ligne.
 *
 * Tout part d'une estimation de ses chances de l'emporter, obtenue en jouant
 * la fin de la main des centaines de fois au hasard (Monte-Carlo). Le niveau
 * agit ensuite sur plusieurs leviers :
 *   — la précision de cette estimation (nombre de tirages, et un bruit qui
 *     imite le jugement approximatif d'un débutant) ;
 *   — la lecture des adversaires : aux niveaux élevés, une relance fait
 *     supposer une main forte, et les mains adverses tirées au hasard sont
 *     choisies en conséquence ;
 *   — le goût pour la mise quand la main est bonne, là où un débutant se
 *     contente de suivre ;
 *   — le bluff, absent chez le Novice, dosé ensuite ;
 *   — la discipline face à une mise : un débutant paie trop souvent pour voir.
 */
import { rankOf, suitOf } from './cards.js';
import { evaluate } from './evaluator.js';

export const LEVELS = [
  {
    name: 'Novice',
    description: 'Paie pour voir, mise rarement, ne bluffe jamais.',
    sims: 150,
    noise: 0.14,
    aggression: 0.3,
    bluff: 0,
    looseness: 0.14,
    reads: 0,
    valueEdge: 0,
    shortStack: 0,
  },
  {
    name: 'Amateur',
    description: 'Joue ses bonnes mains, se laisse encore impressionner.',
    sims: 300,
    noise: 0.09,
    aggression: 0.5,
    bluff: 0.03,
    looseness: 0.07,
    reads: 0.15,
    valueEdge: 0,
    shortStack: 0,
  },
  {
    name: 'Confirmé',
    description: 'Respecte la cote du pot et mise pour se faire payer.',
    sims: 500,
    noise: 0.05,
    aggression: 0.7,
    bluff: 0.07,
    looseness: 0.02,
    reads: 0.4,
    valueEdge: 0,
    shortStack: 12,
  },
  {
    name: 'Expert',
    description: 'Lit les relances, continue ses mises, bluffe à bon escient.',
    sims: 1200,
    noise: 0.035,
    aggression: 0.85,
    bluff: 0.1,
    looseness: 0,
    reads: 0.55,
    valueEdge: 0.05,
    shortStack: 12,
  },
  {
    name: 'Centurion',
    description: 'Calcule tout, varie son jeu et ne lâche rien à tapis court.',
    sims: 2500,
    noise: 0.008,
    aggression: 0.95,
    bluff: 0.13,
    looseness: -0.01,
    reads: 0.85,
    valueEdge: 0.2,
    shortStack: 15,
  },
];

/* ------------------------------------------------------------------ */
/* Force des deux cartes de départ                                     */
/* ------------------------------------------------------------------ */

/**
 * Formule de Chen, ramenée entre 0 et 1 : une note rapide des deux cartes
 * de départ, qui sert à trier les mains adverses plausibles.
 */
export function startingStrength(first, second) {
  const high = Math.max(rankOf(first), rankOf(second));
  const low = Math.min(rankOf(first), rankOf(second));
  const pointsFor = (rank) => (rank === 12 ? 10 : rank === 11 ? 8 : rank === 10 ? 7 : rank === 9 ? 6 : (rank + 2) / 2);

  let points = pointsFor(high);
  if (high === low) points = Math.max(5, points * 2);
  if (suitOf(first) === suitOf(second)) points += 2;
  const gap = high - low - 1;
  if (high !== low) {
    points -= gap <= 0 ? 0 : gap === 1 ? 1 : gap === 2 ? 2 : gap === 3 ? 4 : 5;
    if (gap <= 1 && high < 10) points += 1;
  }
  return Math.max(0, Math.min(1, (points + 1) / 21));
}

/* ------------------------------------------------------------------ */
/* Chances de l'emporter                                               */
/* ------------------------------------------------------------------ */

/**
 * Part du pot qu'on remporte en moyenne, face à `opponents` mains inconnues,
 * en jouant la fin du tableau au hasard. Une égalité compte pour sa part.
 *
 * `floor` écarte les mains adverses trop faibles pour avoir joué comme elles
 * l'ont fait (0 : n'importe quelles cartes).
 */
export function estimateEquity({ hole, board, opponents, sims = 600, random = Math.random, floor = 0 }) {
  if (opponents <= 0) return 1;
  const used = new Set([...hole, ...board]);
  const deck = [];
  for (let card = 0; card < 52; card++) if (!used.has(card)) deck.push(card);

  const missing = 5 - board.length;
  const mine = new Array(7);
  const theirs = new Array(7);
  let won = 0;

  for (let sim = 0; sim < sims; sim++) {
    // Tirage partiel de Fisher-Yates : seules les premières cartes servent.
    let top = 0;
    const draw = () => {
      const pick = top + Math.floor(random() * (deck.length - top));
      const card = deck[pick];
      deck[pick] = deck[top];
      deck[top] = card;
      top++;
      return card;
    };

    const hands = [];
    for (let opponent = 0; opponent < opponents; opponent++) {
      let first = draw();
      let second = draw();
      // Quelques essais pour tomber sur une main qui colle au jeu adverse ;
      // au-delà on garde la dernière, pour ne pas biaiser à l'infini.
      for (let tries = 0; floor > 0 && tries < 6 && startingStrength(first, second) < floor; tries++) {
        top -= 2;
        first = draw();
        second = draw();
      }
      hands.push(first, second);
    }

    const runout = [...board];
    for (let index = 0; index < missing; index++) runout.push(draw());

    mine[0] = hole[0];
    mine[1] = hole[1];
    for (let index = 0; index < 5; index++) {
      mine[index + 2] = runout[index];
      theirs[index + 2] = runout[index];
    }
    const myScore = evaluate(mine);

    let ties = 0;
    let beaten = false;
    for (let opponent = 0; opponent < opponents; opponent++) {
      theirs[0] = hands[opponent * 2];
      theirs[1] = hands[opponent * 2 + 1];
      const score = evaluate(theirs);
      if (score > myScore) {
        beaten = true;
        break;
      }
      if (score === myScore) ties++;
    }
    if (!beaten) won += 1 / (ties + 1);
  }
  return won / sims;
}

/* ------------------------------------------------------------------ */
/* Décision                                                            */
/* ------------------------------------------------------------------ */

function gaussian(random) {
  const u = Math.max(1e-9, random());
  const v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Nombre de mises et relances de ce tour, lu dans le journal. */
function raisesThisStreet(view) {
  let count = 0;
  for (let index = view.log.length - 1; index >= 0; index--) {
    const entry = view.log[index];
    if (entry.hand !== view.handNo || entry.kind === 'street' || entry.kind === 'hand') break;
    if (entry.kind === 'action' && ['bet', 'raise', 'allin'].includes(entry.type)) count++;
  }
  return count;
}

/** Tardive : le joueur parle après la plupart des autres. */
function isLatePosition(view) {
  const alive = view.seats.filter((seat) => !seat.out).length;
  const distance = (view.viewer - view.button + view.seats.length) % view.seats.length;
  return distance === 0 || distance >= alive - 1;
}

/**
 * Choisit l'action du siège `view.viewer`.
 * @param {ReturnType<import('./table.js').Table['view']>} view
 * @param {number} levelIndex 0 (Novice) à 4 (Centurion)
 * @param {() => number} random
 * @returns {{type: string, amount?: number}}
 */
export function decide(view, levelIndex, random = Math.random) {
  const level = LEVELS[Math.max(0, Math.min(LEVELS.length - 1, levelIndex))];
  const me = view.seats[view.viewer];
  const legal = view.legal;
  const [, bigBlind] = view.blinds;
  const opponents = view.seats.filter((seat, index) => index !== view.viewer && seat.inHand).length;
  const preflop = view.street === 'preflop';
  const raises = raisesThisStreet(view);
  const facing = !legal.canCheck;
  const pot = view.pot;
  const stackInBlinds = (me.stack + me.bet) / bigBlind;

  // Tapis court avant le flop : on ne joue plus que « tapis ou rien ».
  if (preflop && level.shortStack > 0 && stackInBlinds <= level.shortStack) {
    const strength = startingStrength(me.hole[0], me.hole[1]);
    const needed = 0.42 + stackInBlinds * 0.012 + opponents * 0.02 + raises * 0.06;
    if (strength >= needed || (legal.canCheck && strength >= needed - 0.1)) {
      return legal.canRaise ? { type: 'allin' } : { type: 'call' };
    }
    return legal.canCheck ? { type: 'check' } : { type: 'fold' };
  }

  // Une relance resserre l'éventail des mains qu'on prête à l'adversaire.
  const aggression = raises + (preflop ? 0 : view.aggressor >= 0 && view.aggressor !== view.viewer ? 0.5 : 0);
  const floor = level.reads * Math.min(0.55, aggression * 0.18);
  const exact = estimateEquity({
    hole: me.hole,
    board: view.board,
    opponents,
    sims: level.sims,
    random,
    floor,
  });
  const equity = Math.max(0, Math.min(1, exact + gaussian(random) * level.noise));

  const fairShare = 1 / (opponents + 1);
  const relative = equity / fairShare;
  const late = isLatePosition(view);

  // Taille d'une mise, en fraction du pot.
  const sized = (fraction) => {
    let raiseTo;
    if (preflop && raises <= 1 && view.currentBet <= bigBlind) {
      const limpers = view.seats.filter((seat) => seat.bet === bigBlind).length - 1;
      raiseTo = bigBlind * (2.5 + fraction) + Math.max(0, limpers) * bigBlind;
    } else {
      const callAmount = legal.toCall;
      raiseTo = view.currentBet + (pot + callAmount) * fraction;
    }
    raiseTo = Math.round(Math.max(legal.minRaiseTo, Math.min(legal.maxRaiseTo, raiseTo)));
    // Plus de la moitié du tapis engagé : autant tout mettre.
    if (raiseTo - me.bet > me.stack * 0.55) raiseTo = legal.maxRaiseTo;
    return { type: raiseTo >= legal.maxRaiseTo ? 'allin' : 'raise', amount: raiseTo };
  };

  const valueFraction = () => {
    if (levelIndex === 0) return random() < 0.5 ? 0.3 : 1.1;
    return 0.5 + random() * 0.35 + (equity > 0.8 ? 0.25 : 0);
  };

  if (!facing) {
    // Les meilleurs joueurs misent aussi les mains simplement bonnes, pour
    // se faire payer par pire.
    const strong = relative > 1.55 + 0.1 * opponents - level.valueEdge;
    if (legal.canRaise && strong && random() < level.aggression) return sized(valueFraction());

    // Mise de continuation : on a relancé avant le flop, on insiste.
    const continuation =
      view.street === 'flop' && view.aggressor === -1 && levelIndex >= 2 && opponents <= 2 && wasPreflopAggressor(view);
    if (legal.canRaise && continuation && random() < level.aggression * 0.55) return sized(0.45);

    const bluffChance = level.bluff * (late ? 1.6 : 1) * (opponents === 1 ? 1.4 : 0.6);
    if (legal.canRaise && !preflop && random() < bluffChance) return sized(0.5);
    return { type: 'check' };
  }

  // Face à une mise : la cote du pot fixe le seuil.
  const potOdds = legal.toCall / (pot + legal.toCall);
  const required = potOdds - level.looseness + (raises >= 2 ? 0.04 : 0);
  const cheap = legal.toCall <= bigBlind && preflop;

  if (equity >= required || (cheap && relative > 0.75)) {
    const raiseWorthy = relative > 1.9 + 0.15 * opponents + raises * 0.3 - level.valueEdge;
    if (legal.canRaise && raiseWorthy && random() < level.aggression * 0.75) return sized(valueFraction());
    return { type: 'call' };
  }

  // Relance de semi-bluff, rare, et jamais chez les débutants.
  if (legal.canRaise && levelIndex >= 3 && !preflop && view.street !== 'river' && random() < level.bluff * 0.35) {
    return sized(0.7);
  }
  // Le débutant paie souvent « pour voir » quand ce n'est pas cher.
  if (levelIndex === 0 && legal.toCall < me.stack * 0.08 && random() < 0.35) return { type: 'call' };
  return { type: 'fold' };
}

function wasPreflopAggressor(view) {
  for (let index = view.log.length - 1; index >= 0; index--) {
    const entry = view.log[index];
    if (entry.hand !== view.handNo) break;
    if (entry.kind === 'action' && entry.street === 'preflop' && ['bet', 'raise', 'allin'].includes(entry.type)) {
      return entry.seat === view.viewer;
    }
  }
  return false;
}
