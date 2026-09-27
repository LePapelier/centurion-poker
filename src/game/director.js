/**
 * Le croupier : fait avancer le moteur au rythme d'une vraie table.
 *
 * Il donne la parole aux IA après un temps de réflexion, laisse arriver les
 * cartes une à une, laisse lire l'abattage avant la main suivante, et en
 * ligne, tient le temps de parole de chacun. Il sert aussi bien la partie
 * solo que l'hôte d'une table en ligne ; seuls diffèrent ceux qu'il prévient
 * à chaque changement.
 */
import { decide } from '../core/ai.js';
import { Table } from '../core/table.js';

/** Temps de parole en ligne, et celui laissé à un joueur déconnecté. */
export const CLOCK_MS = 30000;
export const AWAY_CLOCK_MS = 8000;

const PACE = {
  /** Réflexion d'une IA, en millisecondes : base plus une part au hasard. */
  think: [650, 900],
  street: 750,
  runout: 1300,
  uncontested: 2200,
  showdown: 5200,
};

export class Director {
  /**
   * @param {object} options
   * @param {Table} options.table
   * @param {boolean} [options.clock] temps de parole limité (en ligne)
   * @param {number} [options.watchSeat] en solo, le siège du joueur : son
   *   élimination arrête la partie
   * @param {(director: Director) => void} options.onChange
   * @param {() => boolean} [options.isAway] siège déconnecté ?
   */
  constructor({ table, clock = false, watchSeat = -1, onChange, isAway = () => false }) {
    this.table = table;
    this.clock = clock;
    this.watchSeat = watchSeat;
    this.onChange = onChange;
    this.isAway = isAway;
    this.timer = null;
    this.clockTimer = null;
    /** Siège dont le temps de parole court, et son échéance. */
    this.clockSeat = -1;
    this.deadline = 0;
    this.clockTotal = 0;
    this.stopped = false;
  }

  get finished() {
    const { table } = this;
    return (
      table.phase === 'gameOver' ||
      (this.watchSeat >= 0 && table.seats[this.watchSeat].out && table.phase === 'handOver')
    );
  }

  start() {
    if (this.table.phase === 'idle') this.table.startHand();
    this.step();
  }

  /** Réagit à l'état courant : programme la prochaine étape, puis prévient. */
  step() {
    if (this.stopped) return;
    clearTimeout(this.timer);
    clearTimeout(this.clockTimer);
    this.clockSeat = -1;
    const { table } = this;

    switch (table.phase) {
      case 'betting': {
        const seat = table.seats[table.toAct];
        if (seat.kind === 'ai') {
          const [base, spread] = PACE.think;
          this.timer = setTimeout(() => this.playAi(), base + Math.random() * spread);
        } else if (this.clock) {
          this.startClock(table.toAct);
        }
        break;
      }
      case 'between':
        this.timer = setTimeout(() => {
          table.nextStreet();
          this.step();
        }, table.isRunout ? PACE.runout : PACE.street);
        break;
      case 'handOver':
        if (!this.finished) {
          const delay = table.results?.uncontested ? PACE.uncontested : PACE.showdown;
          this.timer = setTimeout(() => this.nextHand(), delay);
        }
        break;
      default:
        break;
    }
    this.onChange(this);
  }

  startClock(seatIndex) {
    const total = this.isAway(seatIndex) ? AWAY_CLOCK_MS : CLOCK_MS;
    this.clockSeat = seatIndex;
    this.clockTotal = total;
    this.deadline = Date.now() + total;
    this.clockTimer = setTimeout(() => {
      const legal = this.table.legalActions(seatIndex);
      if (!legal) return;
      this.act(seatIndex, { type: legal.canCheck ? 'check' : 'fold' }, { timedOut: true });
    }, total);
  }

  /** Relance le temps de parole, par exemple quand un joueur se déconnecte. */
  refreshClock() {
    const { table } = this;
    if (!this.clock || table.phase !== 'betting' || table.seats[table.toAct].kind === 'ai') return;
    clearTimeout(this.clockTimer);
    const remaining = this.deadline - Date.now();
    if (this.isAway(table.toAct) && remaining > AWAY_CLOCK_MS) this.startClock(table.toAct);
    this.onChange(this);
  }

  playAi() {
    const { table } = this;
    if (table.phase !== 'betting') return;
    const seatIndex = table.toAct;
    const seat = table.seats[seatIndex];
    const action = decide(table.view(seatIndex), seat.level ?? 2);
    if (!table.act(seatIndex, action)) {
      // Ne devrait pas arriver ; on ne bloque pas la table pour autant.
      const legal = table.legalActions(seatIndex);
      table.act(seatIndex, { type: legal?.canCheck ? 'check' : 'fold' });
    }
    this.step();
  }

  /** Action d'un joueur humain, local ou distant. */
  act(seatIndex, action, { timedOut = false } = {}) {
    if (this.stopped || !this.table.act(seatIndex, action)) return false;
    this.lastTimeout = timedOut ? seatIndex : -1;
    this.step();
    return true;
  }

  /** Passe à la main suivante sans attendre la fin de la pause. */
  nextHand() {
    if (this.stopped || this.table.phase !== 'handOver' || this.finished) return;
    this.table.startHand();
    this.step();
  }

  /** Ce qu'il faut savoir du temps de parole pour l'afficher ailleurs. */
  clockInfo() {
    if (this.clockSeat < 0) return null;
    return {
      seat: this.clockSeat,
      remaining: Math.max(0, this.deadline - Date.now()),
      total: this.clockTotal,
      /** Change à chaque nouveau temps de parole : la barre repart. */
      id: this.deadline,
    };
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearTimeout(this.clockTimer);
  }
}
