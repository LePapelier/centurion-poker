/**
 * Moteur de table : Texas hold'em sans limite, en tournoi.
 *
 * Chacun commence avec le même tapis, les blinds montent à intervalles
 * réguliers, et la partie s'arrête quand un joueur a tous les jetons.
 *
 * Le moteur ne connaît ni l'écran, ni le temps, ni le réseau. Il avance d'un
 * pas à chaque décision (`act`) et s'arrête aux transitions — fin d'un tour
 * d'enchères, fin de la main — pour que celui qui le pilote choisisse le
 * rythme : une IA qui « réfléchit », une carte qui arrive, un abattage qu'on
 * laisse lire. `nextStreet` et `startHand` relancent la machine.
 *
 * Phases :
 *   idle      — rien n'a commencé
 *   betting   — un joueur doit parler (`toAct`)
 *   between   — tour d'enchères clos, la carte suivante attend `nextStreet`
 *   handOver  — main terminée, résultats dans `results`
 *   gameOver  — un seul joueur a encore des jetons
 */
import { cryptoRandom, shuffledDeck } from './cards.js';
import { evaluate, handName } from './evaluator.js';

export const STARTING_STACK = 1500;

/** Petite et grosse blind, niveau par niveau. */
export const BLIND_LEVELS = [
  [10, 20],
  [15, 30],
  [25, 50],
  [40, 80],
  [60, 120],
  [100, 200],
  [150, 300],
  [250, 500],
  [400, 800],
  [600, 1200],
  [1000, 2000],
  [1500, 3000],
  [2500, 5000],
];

/** Mains jouées à chaque niveau avant que les blinds montent. */
export const HANDS_PER_LEVEL = 10;

export const STREETS = ['preflop', 'flop', 'turn', 'river'];

/** Nombre maximal de joueurs à une table. */
export const MAX_SEATS = 6;

export class Table {
  /**
   * @param {object} options
   * @param {{id: string, name: string, kind: 'human'|'ai'|'remote', level?: number}[]} options.players
   * @param {() => number} [options.random]
   * @param {number} [options.stack]
   */
  constructor({ players, random = cryptoRandom, stack = STARTING_STACK }) {
    if (players.length < 2 || players.length > MAX_SEATS) {
      throw new Error(`une table compte de 2 à ${MAX_SEATS} joueurs`);
    }
    this.random = random;
    this.startingStack = stack;
    this.seats = players.map((player) => ({
      id: player.id,
      name: player.name,
      kind: player.kind,
      level: player.level ?? null,
      stack,
      bet: 0,
      committed: 0,
      hole: null,
      folded: false,
      allIn: false,
      out: false,
      acted: false,
      canRaise: true,
      lastAction: null,
      shown: false,
      place: null,
    }));
    this.button = Math.floor(random() * players.length);
    this.handNo = 0;
    this.phase = 'idle';
    this.street = null;
    this.board = [];
    this.deck = [];
    this.currentBet = 0;
    this.minRaise = 0;
    this.toAct = -1;
    this.aggressor = -1;
    this.sbSeat = -1;
    this.bbSeat = -1;
    this.results = null;
    this.log = [];
    /** Incrémenté à chaque changement d'état : sert aux instantanés réseau. */
    this.version = 0;
  }

  /* ---------------------------------------------------------------- */
  /* Lecture                                                           */
  /* ---------------------------------------------------------------- */

  get blindLevel() {
    return Math.min(Math.floor(Math.max(0, this.handNo - 1) / HANDS_PER_LEVEL), BLIND_LEVELS.length - 1);
  }

  get blinds() {
    return BLIND_LEVELS[this.blindLevel];
  }

  /** Mains restantes avant la prochaine hausse des blinds (0 au dernier niveau). */
  get handsToNextLevel() {
    if (this.blindLevel === BLIND_LEVELS.length - 1) return 0;
    return HANDS_PER_LEVEL - ((Math.max(1, this.handNo) - 1) % HANDS_PER_LEVEL);
  }

  get pot() {
    return this.seats.reduce((sum, seat) => sum + seat.committed, 0);
  }

  inHand(seat) {
    return !seat.out && !seat.folded && seat.hole !== null;
  }

  canAct(seat) {
    return this.inHand(seat) && !seat.allIn;
  }

  /** Joueurs encore en lice dans la main. */
  contenders() {
    return this.seats.filter((seat) => this.inHand(seat));
  }

  nextSeat(from, predicate) {
    const count = this.seats.length;
    for (let step = 1; step <= count; step++) {
      const index = (from + step) % count;
      if (predicate(this.seats[index], index)) return index;
    }
    return -1;
  }

  /** Ce que le joueur `index` peut faire, s'il a la parole. */
  legalActions(index) {
    if (this.phase !== 'betting' || index !== this.toAct) return null;
    const seat = this.seats[index];
    const toCall = Math.max(0, this.currentBet - seat.bet);
    const call = Math.min(toCall, seat.stack);
    const maxRaiseTo = seat.bet + seat.stack;
    // Relancer n'a de sens que si quelqu'un d'autre peut encore payer.
    const someoneCanAnswer = this.seats.some(
      (other, otherIndex) => otherIndex !== index && this.canAct(other),
    );
    const canRaise = seat.canRaise && seat.stack > toCall && someoneCanAnswer;
    const fullRaiseTo = this.currentBet === 0 ? this.blinds[1] : this.currentBet + this.minRaise;
    return {
      toCall: call,
      canCheck: toCall === 0,
      canRaise,
      minRaiseTo: canRaise ? Math.min(fullRaiseTo, maxRaiseTo) : 0,
      maxRaiseTo: canRaise ? maxRaiseTo : 0,
      /** Mise d'ouverture (personne n'a encore misé) plutôt que relance. */
      isOpening: this.currentBet === 0,
    };
  }

  /* ---------------------------------------------------------------- */
  /* Déroulement                                                       */
  /* ---------------------------------------------------------------- */

  record(entry) {
    this.log.push({ hand: this.handNo, ...entry });
    if (this.log.length > 400) this.log.splice(0, this.log.length - 400);
  }

  touch() {
    this.version++;
  }

  startHand() {
    const alive = this.seats.filter((seat) => !seat.out);
    if (alive.length < 2) {
      this.phase = 'gameOver';
      this.touch();
      return;
    }

    this.handNo++;
    for (const seat of this.seats) {
      seat.bet = 0;
      seat.committed = 0;
      seat.hole = null;
      seat.folded = false;
      seat.allIn = false;
      seat.acted = false;
      seat.canRaise = true;
      seat.lastAction = null;
      seat.shown = false;
    }
    this.board = [];
    this.results = null;
    this.deck = shuffledDeck(this.random);
    this.button = this.nextSeat(this.button, (seat) => !seat.out);

    const [small, big] = this.blinds;
    const headsUp = alive.length === 2;
    // À deux, le bouton paie la petite blind et parle en premier avant le flop.
    this.sbSeat = headsUp ? this.button : this.nextSeat(this.button, (seat) => !seat.out);
    this.bbSeat = this.nextSeat(this.sbSeat, (seat) => !seat.out);

    this.record({ kind: 'hand', button: this.button, small, big, level: this.blindLevel });

    // Les cartes d'abord, pour que les blinds à tapis restent dans la main.
    for (let round = 0; round < 2; round++) {
      let index = this.button;
      for (let dealt = 0; dealt < alive.length; dealt++) {
        index = this.nextSeat(index, (seat) => !seat.out);
        const seat = this.seats[index];
        seat.hole = seat.hole ?? [];
        seat.hole.push(this.deck.pop());
      }
    }

    this.post(this.sbSeat, small, 'sb');
    this.post(this.bbSeat, big, 'bb');

    this.street = 'preflop';
    this.currentBet = Math.max(this.seats[this.sbSeat].bet, this.seats[this.bbSeat].bet);
    this.minRaise = big;
    this.aggressor = this.bbSeat;
    this.phase = 'betting';
    this.toAct = this.bbSeat;
    this.advance();
  }

  post(index, amount, blind) {
    const seat = this.seats[index];
    const paid = Math.min(amount, seat.stack);
    seat.stack -= paid;
    seat.bet += paid;
    seat.committed += paid;
    if (seat.stack === 0) seat.allIn = true;
    seat.lastAction = { type: blind, amount: paid };
    this.record({ kind: 'blind', seat: index, blind, amount: paid });
  }

  /**
   * Joue la décision du joueur qui a la parole.
   * @param {number} index siège qui agit
   * @param {{type: 'fold'|'check'|'call'|'raise'|'allin', amount?: number}} action
   *   `amount` est, pour une relance, le total misé sur ce tour après la relance.
   * @returns {boolean} faux si l'action est refusée
   */
  act(index, action) {
    const legal = this.legalActions(index);
    if (!legal) return false;
    const seat = this.seats[index];
    let { type } = action;

    if (type === 'allin') {
      if (legal.canRaise && seat.bet + seat.stack > this.currentBet) {
        return this.act(index, { type: 'raise', amount: seat.bet + seat.stack });
      }
      type = 'call';
    }
    if (type === 'check' && !legal.canCheck) return false;
    if (type === 'call' && legal.canCheck) type = 'check';

    switch (type) {
      case 'fold':
        seat.folded = true;
        seat.lastAction = { type: 'fold' };
        break;

      case 'check':
        seat.lastAction = { type: 'check' };
        break;

      case 'call': {
        const paid = legal.toCall;
        seat.stack -= paid;
        seat.bet += paid;
        seat.committed += paid;
        if (seat.stack === 0) seat.allIn = true;
        seat.lastAction = { type: seat.allIn ? 'allin' : 'call', amount: seat.bet };
        break;
      }

      case 'raise': {
        if (!legal.canRaise) return false;
        const target = Math.round(Number(action.amount));
        if (!Number.isFinite(target)) return false;
        const raiseTo = Math.min(Math.max(target, legal.minRaiseTo), legal.maxRaiseTo);
        const paid = raiseTo - seat.bet;
        const increment = raiseTo - this.currentBet;
        const opening = this.currentBet === 0;
        seat.stack -= paid;
        seat.bet = raiseTo;
        seat.committed += paid;
        if (seat.stack === 0) seat.allIn = true;

        const full = increment >= (opening ? this.blinds[1] : this.minRaise);
        if (full) {
          this.minRaise = increment;
          // Une vraie relance rouvre les enchères pour tout le monde.
          for (const other of this.seats) {
            if (other !== seat) {
              other.acted = false;
              other.canRaise = true;
            }
          }
        } else {
          // Tapis inférieur à une relance complète : ceux qui ont déjà parlé
          // peuvent suivre ou se coucher, pas relancer à nouveau.
          for (const other of this.seats) {
            if (other !== seat && other.acted) other.canRaise = false;
          }
        }
        if (increment > 0) {
          this.currentBet = raiseTo;
          this.aggressor = index;
        }
        seat.lastAction = {
          type: seat.allIn ? 'allin' : opening ? 'bet' : 'raise',
          amount: raiseTo,
        };
        break;
      }

      default:
        return false;
    }

    seat.acted = true;
    this.record({ kind: 'action', seat: index, street: this.street, ...seat.lastAction });
    this.advance();
    return true;
  }

  /** Passe la parole, ou clôt le tour d'enchères, ou la main. */
  advance() {
    this.touch();
    const contenders = this.contenders();
    if (contenders.length === 1) {
      this.awardUncontested(contenders[0]);
      return;
    }

    const needsAction = (seat) => this.canAct(seat) && (!seat.acted || seat.bet < this.currentBet);
    // Seul à pouvoir encore parler, et déjà à hauteur : rien à décider.
    const actors = this.seats.filter((seat) => this.canAct(seat));
    const lone = actors.length === 1 && actors[0].bet >= this.currentBet;
    const next = lone ? -1 : this.nextSeat(this.toAct, needsAction);

    if (next === -1) {
      this.closeStreet();
      return;
    }
    this.toAct = next;
  }

  closeStreet() {
    for (const seat of this.seats) {
      seat.bet = 0;
      seat.acted = false;
      seat.canRaise = true;
    }
    this.currentBet = 0;
    this.minRaise = this.blinds[1];
    this.toAct = -1;
    this.phase = 'between';

    // Plus personne ne peut miser : les mains se retournent tout de suite,
    // et le tableau se déroule jusqu'au bout.
    const actors = this.seats.filter((seat) => this.canAct(seat));
    if (actors.length <= 1) {
      for (const seat of this.contenders()) seat.shown = true;
    }
    this.touch();
  }

  /** Vrai si le tableau se déroule sans plus aucune enchère possible. */
  get isRunout() {
    return this.phase === 'between' && this.seats.filter((seat) => this.canAct(seat)).length <= 1;
  }

  /** Distribue la carte suivante, ou passe à l'abattage après la rivière. */
  nextStreet() {
    if (this.phase !== 'between') return;
    const streetIndex = STREETS.indexOf(this.street);
    if (streetIndex === STREETS.length - 1) {
      this.showdown();
      return;
    }

    this.street = STREETS[streetIndex + 1];
    this.deck.pop(); // carte brûlée
    const count = this.street === 'flop' ? 3 : 1;
    for (let index = 0; index < count; index++) this.board.push(this.deck.pop());
    this.record({ kind: 'street', street: this.street, cards: [...this.board] });

    for (const seat of this.seats) {
      if (seat.lastAction?.type !== 'allin') seat.lastAction = null;
    }

    const actors = this.seats.filter((seat) => this.canAct(seat));
    if (actors.length <= 1) {
      this.touch();
      return;
    }
    this.phase = 'betting';
    this.aggressor = -1;
    this.toAct = this.button;
    this.advance();
  }

  awardUncontested(winner) {
    const index = this.seats.indexOf(winner);
    const amount = this.pot;
    winner.stack += amount;
    this.results = {
      uncontested: true,
      pots: [{ amount, winners: [index], hand: null }],
      scores: {},
    };
    this.record({ kind: 'win', seat: index, amount, hand: null });
    this.finishHand();
  }

  /** Les pots, principal puis annexes, avec qui peut prétendre à chacun. */
  buildPots() {
    const levels = [...new Set(this.seats.map((seat) => seat.committed).filter((value) => value > 0))].sort(
      (a, b) => a - b,
    );
    const pots = [];
    let previous = 0;
    let carry = 0;
    for (const level of levels) {
      let amount = carry;
      for (const seat of this.seats) {
        amount += Math.min(seat.committed, level) - Math.min(seat.committed, previous);
      }
      const eligible = this.seats
        .map((seat, index) => (this.inHand(seat) && seat.committed >= level ? index : -1))
        .filter((index) => index >= 0);
      previous = level;
      if (eligible.length === 0) {
        carry = amount;
        continue;
      }
      carry = 0;
      const last = pots[pots.length - 1];
      if (last && last.eligible.join() === eligible.join()) last.amount += amount;
      else pots.push({ amount, eligible });
    }
    return pots;
  }

  showdown() {
    const scores = {};
    for (const seat of this.contenders()) {
      const index = this.seats.indexOf(seat);
      scores[index] = evaluate([...seat.hole, ...this.board]);
      seat.shown = true;
    }

    const pots = this.buildPots().map((pot) => {
      // Mise non suivie : un pot à un seul prétendant lui revient, sans abattage.
      if (pot.eligible.length === 1) {
        this.seats[pot.eligible[0]].stack += pot.amount;
        return { amount: pot.amount, winners: pot.eligible, hand: null, returned: true };
      }
      const best = Math.max(...pot.eligible.map((index) => scores[index]));
      const winners = pot.eligible.filter((index) => scores[index] === best);
      const share = Math.floor(pot.amount / winners.length);
      let remainder = pot.amount - share * winners.length;
      // Jetons indivisibles : au premier gagnant à gauche du bouton.
      const ordered = [...winners].sort(
        (a, b) => this.distanceFromButton(a) - this.distanceFromButton(b),
      );
      for (const index of ordered) {
        this.seats[index].stack += share + (remainder > 0 ? 1 : 0);
        remainder = Math.max(0, remainder - 1);
      }
      return { amount: pot.amount, winners, hand: handName(best) };
    });

    this.results = { uncontested: false, pots, scores };
    for (const pot of pots) {
      if (!pot.returned) {
        this.record({ kind: 'win', seats: pot.winners, amount: pot.amount, hand: pot.hand });
      }
    }
    this.finishHand();
  }

  distanceFromButton(index) {
    const count = this.seats.length;
    return (index - this.button - 1 + count) % count;
  }

  finishHand() {
    this.phase = 'handOver';
    this.toAct = -1;
    this.street = this.street ?? 'preflop';

    const busted = this.seats.filter((seat) => !seat.out && seat.stack === 0);
    if (busted.length > 0) {
      const remaining = this.seats.filter((seat) => !seat.out && seat.stack > 0).length;
      for (const seat of busted) {
        seat.out = true;
        seat.place = remaining + 1;
        this.record({ kind: 'bust', seat: this.seats.indexOf(seat), place: seat.place });
      }
    }

    const alive = this.seats.filter((seat) => !seat.out);
    if (alive.length === 1) {
      alive[0].place = 1;
      this.phase = 'gameOver';
      this.record({ kind: 'champion', seat: this.seats.indexOf(alive[0]) });
    }
    this.touch();
  }

  /** Total des jetons en jeu, pour les vérifications. */
  get chipTotal() {
    return this.seats.reduce((sum, seat) => sum + seat.stack, 0) + this.pot * (this.phase === 'handOver' || this.phase === 'gameOver' ? 0 : 1);
  }

  /* ---------------------------------------------------------------- */
  /* Sauvegarde                                                        */
  /* ---------------------------------------------------------------- */

  /** État complet, paquet compris : réservé à la sauvegarde locale. */
  toJSON() {
    const { random, ...state } = this;
    return JSON.parse(JSON.stringify(state));
  }

  static fromJSON(data, random = cryptoRandom) {
    const table = Object.create(Table.prototype);
    Object.assign(table, JSON.parse(JSON.stringify(data)), { random });
    return table;
  }

  /* ---------------------------------------------------------------- */
  /* Instantanés                                                       */
  /* ---------------------------------------------------------------- */

  /**
   * L'état tel que le voit le siège `viewer` : ses propres cartes, celles
   * retournées à l'abattage, et rien d'autre. C'est tout ce qu'un invité
   * reçoit du réseau ; un spectateur passe -1.
   */
  view(viewer) {
    return {
      version: this.version,
      viewer,
      phase: this.phase,
      street: this.street,
      handNo: this.handNo,
      blinds: this.blinds,
      blindLevel: this.blindLevel,
      handsToNextLevel: this.handsToNextLevel,
      button: this.button,
      sbSeat: this.sbSeat,
      bbSeat: this.bbSeat,
      board: [...this.board],
      pot: this.pot,
      currentBet: this.currentBet,
      toAct: this.toAct,
      aggressor: this.aggressor,
      isRunout: this.isRunout,
      legal: viewer >= 0 ? this.legalActions(viewer) : null,
      results: this.results && {
        uncontested: this.results.uncontested,
        pots: this.results.pots.map((pot) => ({ ...pot, winners: [...pot.winners] })),
        // Les scores des mains cachées ne regardent personne.
        scores: Object.fromEntries(
          Object.entries(this.results.scores).filter(([index]) => this.seats[index].shown),
        ),
      },
      seats: this.seats.map((seat, index) => ({
        id: seat.id,
        name: seat.name,
        kind: seat.kind,
        level: seat.level,
        stack: seat.stack,
        bet: seat.bet,
        committed: seat.committed,
        folded: seat.folded,
        allIn: seat.allIn,
        out: seat.out,
        inHand: this.inHand(seat),
        lastAction: seat.lastAction && { ...seat.lastAction },
        shown: seat.shown,
        place: seat.place,
        hole:
          seat.hole === null
            ? null
            : index === viewer || seat.shown
              ? [...seat.hole]
              : seat.hole.map(() => null),
      })),
      log: this.log.slice(-80).map((entry) => ({ ...entry })),
    };
  }
}
