/**
 * Dessin de la table à partir d'un instantané.
 *
 * Tout ce qui s'affiche se déduit de `view` (voir `Table.view`) : le rendu
 * est le même en solo, chez l'hôte et chez un invité. Les animations — cartes
 * qui arrivent, jetons qui filent au pot puis au gagnant — naissent de la
 * comparaison avec l'instantané précédent.
 */
import { isRed, RANK_SYMBOLS, SUIT_SYMBOLS, rankOf, suitOf } from '../core/cards.js';
import { bestFive, evaluate, handName } from '../core/evaluator.js';

export const formatChips = (value) => Math.round(value).toLocaleString('fr-FR');

/**
 * Places autour de la table, en pourcentage, pour les autres joueurs. Le
 * joueur est toujours en bas au centre ; les autres suivent le sens du jeu,
 * c'est-à-dire en partant de sa gauche et en remontant.
 */
const OTHER_PLACES = {
  1: [[50, 12]],
  2: [[17, 30], [83, 30]],
  3: [[14, 52], [50, 11], [86, 52]],
  4: [[14, 64], [22, 20], [78, 20], [86, 64]],
  5: [[14, 70], [14, 34], [50, 10], [86, 34], [86, 70]],
};
const MY_PLACE = [50, 87];
const CENTER = [50, 47];

const ACTION_LABELS = {
  fold: () => 'Couché',
  check: () => 'Parole',
  call: (amount) => `Suit ${formatChips(amount)}`,
  bet: (amount) => `Mise ${formatChips(amount)}`,
  raise: (amount) => `Relance ${formatChips(amount)}`,
  allin: () => 'Tapis',
};

/** Une carte, face visible si `card` est un nombre, dos sinon. */
export function cardElement(card, { deal = false, delay = 0 } = {}) {
  const element = document.createElement('span');
  element.className = 'card';
  if (card === null || card === undefined) {
    element.classList.add('back');
  } else {
    if (isRed(card)) element.classList.add('red');
    element.dataset.card = String(card);
    const rank = document.createElement('span');
    rank.className = 'rank';
    rank.textContent = RANK_SYMBOLS[rankOf(card)];
    const corner = document.createElement('span');
    corner.className = 'corner';
    corner.textContent = SUIT_SYMBOLS[suitOf(card)];
    const suit = document.createElement('span');
    suit.className = 'suit';
    suit.textContent = SUIT_SYMBOLS[suitOf(card)];
    element.append(rank, corner, suit);
    element.setAttribute('aria-label', `${RANK_SYMBOLS[rankOf(card)]}${SUIT_SYMBOLS[suitOf(card)]}`);
  }
  if (deal) {
    element.classList.add('deal');
    element.style.animationDelay = `${delay}ms`;
  }
  return element;
}

/** Nom affiché d'un siège : « Vous » pour soi-même. */
export function seatName(view, index) {
  return index === view.viewer ? 'Vous' : view.seats[index].name;
}

/** Nom de la meilleure main du joueur, dès qu'il y a de quoi la nommer. */
export function describeHole(hole, board) {
  if (!hole || hole.some((card) => card === null)) return '';
  if (board.length >= 3) return handName(evaluate([...hole, ...board]));
  if (rankOf(hole[0]) === rankOf(hole[1])) return handName(evaluate([...hole, ...fillers(hole)]));
  return '';
}

// Cinq cartes ne suffisent pas avant le flop : on complète par des cartes qui
// ne changent pas la paire annoncée.
function fillers(hole) {
  const used = new Set(hole.map(rankOf));
  const cards = [];
  for (let rank = 0; cards.length < 3; rank++) {
    if (!used.has(rank) && !(rank >= 1 && rank <= 3)) cards.push(rank * 4 + (cards.length % 4));
  }
  return cards;
}

export class TableView {
  constructor(elements) {
    this.el = elements;
    this.prev = null;
    this.layoutKey = '';
    this.seatNodes = [];
    this.betNodes = [];
    this.positions = [];
  }

  /** Ordre d'affichage : le joueur d'abord, puis les autres dans le sens du jeu. */
  layout(view) {
    const count = view.seats.length;
    const anchor = view.viewer >= 0 ? view.viewer : 0;
    const key = `${count}:${anchor}`;
    if (key === this.layoutKey) return;
    this.layoutKey = key;

    const places = OTHER_PLACES[count - 1];
    this.positions = new Array(count);
    for (let offset = 0; offset < count; offset++) {
      const index = (anchor + offset) % count;
      this.positions[index] = offset === 0 ? MY_PLACE : places[offset - 1];
    }

    this.el.seats.replaceChildren();
    this.seatNodes = view.seats.map((_, index) => {
      const [x, y] = this.positions[index];
      const node = document.createElement('div');
      node.className = 'seat';
      node.style.setProperty('--x', `${x}%`);
      node.style.setProperty('--y', `${y}%`);
      node.innerHTML = `
        <div class="seat-cards"></div>
        <div class="seat-plate">
          <span class="avatar"></span>
          <span class="seat-name"></span>
          <span class="seat-stack"></span>
          <span class="dealer" hidden>D</span>
        </div>
        <span class="hand-label" hidden></span>`;
      this.el.seats.append(node);
      return {
        root: node,
        cards: node.querySelector('.seat-cards'),
        plate: node.querySelector('.seat-plate'),
        avatar: node.querySelector('.avatar'),
        name: node.querySelector('.seat-name'),
        stack: node.querySelector('.seat-stack'),
        dealer: node.querySelector('.dealer'),
        label: node.querySelector('.hand-label'),
        state: {},
      };
    });
    this.betNodes = view.seats.map(() => null);
  }

  betPosition(index) {
    const [x, y] = this.positions[index];
    const pull = index === this.anchor ? 0.5 : 0.42;
    return [x + (CENTER[0] - x) * pull, y + (CENTER[1] - y) * pull];
  }

  /**
   * @param {ReturnType<import('../core/table.js').Table['view']>} view
   * @param {{clock?: {seat: number, remaining: number, total: number} | null, away?: Set<number>}} meta
   */
  render(view, meta = {}) {
    this.anchor = view.viewer >= 0 ? view.viewer : 0;
    this.layout(view);
    const prev = this.prev && this.prev.handNo === view.handNo ? this.prev : null;
    const newHand = !this.prev || this.prev.handNo !== view.handNo;

    const highlight = this.highlightedCards(view);
    this.renderBoard(view, prev, highlight);
    this.renderSeats(view, prev, meta, newHand);
    this.renderBets(view);
    this.renderPot(view);
    this.renderBanner(view);
    this.animateChips(view, prev);

    this.prev = view;
    return { highlight, newHand };
  }

  /** À l'abattage, les cinq cartes de la main gagnante. */
  highlightedCards(view) {
    const results = view.results;
    if (!results || results.uncontested || view.phase === 'betting') return null;
    const main = results.pots.find((pot) => !pot.returned);
    if (!main) return null;
    const winner = view.seats[main.winners[0]];
    if (!winner.hole || winner.hole.some((card) => card === null)) return null;
    return new Set(bestFive([...winner.hole, ...view.board]));
  }

  renderBoard(view, prev, highlight) {
    const board = this.el.board;
    const shownBefore = prev ? prev.board.length : 0;
    // On ne reconstruit que si le tableau a changé, pour ne pas rejouer les
    // animations des cartes déjà posées.
    const key = view.board.join(',') + '|' + (highlight ? [...highlight].join(',') : '');
    if (board.dataset.key === key) return;
    board.dataset.key = key;
    board.replaceChildren();
    for (let index = 0; index < 5; index++) {
      const card = view.board[index];
      if (card === undefined) {
        const slot = document.createElement('span');
        slot.className = 'slot';
        board.append(slot);
        continue;
      }
      const fresh = index >= shownBefore && board.dataset.hand === String(view.handNo);
      const element = cardElement(card, { deal: fresh, delay: (index - shownBefore) * 110 });
      if (highlight) element.classList.add(highlight.has(card) ? 'win' : 'dim');
      board.append(element);
    }
    board.dataset.hand = String(view.handNo);
  }

  renderSeats(view, prev, meta, newHand) {
    const winners = new Set();
    if (view.phase === 'handOver' || view.phase === 'gameOver') {
      for (const pot of view.results?.pots ?? []) {
        if (!pot.returned) pot.winners.forEach((index) => winners.add(index));
      }
    }

    view.seats.forEach((seat, index) => {
      const node = this.seatNodes[index];
      const me = index === view.viewer;
      const root = node.root;
      root.classList.toggle('me', me);
      root.classList.toggle('active', view.phase === 'betting' && view.toAct === index);
      root.classList.toggle('folded', seat.folded && !seat.out);
      root.classList.toggle('out', seat.out);
      root.classList.toggle('winner', winners.has(index));
      root.classList.toggle('away', Boolean(meta.away?.has(index)));

      const name = me ? 'Vous' : seat.name;
      if (node.state.name !== name) {
        node.state.name = name;
        node.name.textContent = name;
        node.avatar.textContent = (seat.name || '?').trim().charAt(0).toUpperCase();
        node.root.title = seat.kind === 'ai' && seat.level !== null ? `${seat.name}` : '';
      }

      const stackText = seat.out ? (seat.place ? `${seat.place}e` : 'Éliminé') : formatChips(seat.stack);
      if (node.state.stack !== stackText) {
        const grew = prev && !seat.out && seat.stack > (prev.seats[index]?.stack ?? seat.stack);
        node.state.stack = stackText;
        node.stack.textContent = stackText;
        if (grew) this.bump(node.stack);
      }
      node.dealer.hidden = view.button !== index || seat.out;

      // Cartes : dos tant qu'elles sont cachées, faces à l'abattage.
      const cardsKey = seat.hole && !seat.folded && !seat.out ? seat.hole.map((card) => card ?? 'x').join(',') : '';
      const highlight = this.highlightedCards(view);
      const fullKey = cardsKey + (highlight ? '|h' : '');
      if (node.state.cards !== fullKey) {
        const dealing = newHand && cardsKey !== '';
        node.state.cards = fullKey;
        node.cards.replaceChildren();
        if (cardsKey) {
          seat.hole.forEach((card, cardIndex) => {
            const element = cardElement(card, { deal: dealing, delay: cardIndex * 120 + index * 40 });
            if (highlight && card !== null) element.classList.add(highlight.has(card) ? 'win' : 'dim');
            node.cards.append(element);
          });
        }
      }

      // Nom de la main, une fois retournée.
      const score = view.results?.scores?.[index];
      const label = score !== undefined && seat.shown && !seat.folded ? handName(score) : '';
      node.label.hidden = !label;
      node.label.textContent = label;

      this.renderBubble(node, seat, view);
      this.renderClock(node, index, meta.clock);
    });
  }

  renderBubble(node, seat, view) {
    const action = seat.lastAction;
    const visible =
      action && !['sb', 'bb'].includes(action.type) && view.phase !== 'handOver' && view.phase !== 'gameOver';
    const text = visible ? ACTION_LABELS[action.type]?.(action.amount) : '';
    const key = text ? `${view.handNo}:${view.street}:${action.type}:${action.amount ?? ''}` : '';
    if (node.state.bubble === key) return;
    node.state.bubble = key;
    node.root.querySelector('.bubble')?.remove();
    if (!text) return;
    const bubble = document.createElement('span');
    bubble.className = `bubble ${action.type}`;
    bubble.textContent = text;
    node.root.append(bubble);
  }

  /** Barre de temps de parole, en ligne : elle part de ce qui reste et se vide. */
  renderClock(node, index, clock) {
    const key = clock && clock.seat === index ? String(clock.id) : '';
    if (node.state.clock === key) return;
    node.state.clock = key;
    node.plate.querySelector('.clock')?.remove();
    if (!key) return;
    const bar = document.createElement('span');
    bar.className = 'clock';
    node.plate.append(bar);
    bar.animate(
      [{ transform: `scaleX(${clock.remaining / clock.total})` }, { transform: 'scaleX(0)', background: 'var(--danger)' }],
      { duration: clock.remaining, easing: 'linear', fill: 'forwards' },
    );
  }

  renderBets(view) {
    view.seats.forEach((seat, index) => {
      const amount = view.phase === 'betting' || view.phase === 'between' ? seat.bet : 0;
      let node = this.betNodes[index];
      if (amount <= 0) {
        node?.remove();
        this.betNodes[index] = null;
        return;
      }
      if (!node) {
        node = document.createElement('div');
        node.className = 'bet';
        const [x, y] = this.betPosition(index);
        node.style.setProperty('--x', `${x}%`);
        node.style.setProperty('--y', `${y}%`);
        node.innerHTML = '<span class="chip-icon"></span><span class="bet-value"></span>';
        this.el.seats.append(node);
        this.betNodes[index] = node;
      }
      node.querySelector('.bet-value').textContent = formatChips(amount);
    });
  }

  renderPot(view) {
    const collected = view.pot - view.seats.reduce((sum, seat) => sum + seat.bet, 0);
    const show = (view.phase === 'betting' || view.phase === 'between') && collected > 0;
    this.el.pot.hidden = !show;
    const text = formatChips(show ? Math.max(collected, 0) : 0);
    if (this.el.potValue.textContent !== text) {
      this.el.potValue.textContent = text;
      if (show && collected > 0) this.bump(this.el.pot);
    }
  }

  renderBanner(view) {
    const banner = this.el.banner;
    const results = view.results;
    const show = results && (view.phase === 'handOver' || view.phase === 'gameOver');
    const key = show ? `${view.handNo}` : '';
    if (banner.dataset.key === key) return;
    banner.dataset.key = key;
    if (!show) {
      banner.hidden = true;
      return;
    }
    const lines = results.pots
      .filter((pot) => !pot.returned)
      .map((pot, index, pots) => {
        const names = pot.winners.map((seat) => seatName(view, seat));
        const mine = pot.winners.includes(view.viewer);
        const verb =
          names.length > 1
            ? `${joinNames(names)} se partagent`
            : mine
              ? 'Vous remportez'
              : `${names[0]} remporte`;
        const label = pots.length > 1 ? (index === 0 ? ' le pot principal' : ' un pot annexe') : '';
        return `<div>${escapeHtml(verb)}${label} <strong>${formatChips(pot.amount)}</strong>${
          pot.hand ? `<small>${escapeHtml(pot.hand)}</small>` : ''
        }</div>`;
      });
    banner.innerHTML = lines.join('');
    banner.hidden = lines.length === 0;
  }

  /* ---------------------------------------------------------------- */
  /* Jetons en mouvement                                               */
  /* ---------------------------------------------------------------- */

  animateChips(view, prev) {
    if (!prev) return;
    // Fin d'un tour d'enchères : les mises rejoignent le pot.
    const hadBets = prev.seats.some((seat) => seat.bet > 0);
    const betsGone = view.seats.every((seat) => seat.bet === 0);
    const potTarget = this.el.pot.hidden ? this.el.board : this.el.pot;
    if (hadBets && betsGone) {
      prev.seats.forEach((seat, index) => {
        if (seat.bet > 0) this.fly(this.betPosition(index), this.centerOf(potTarget));
      });
    }
    // Fin de la main : le pot file vers les gagnants.
    const finished = (view.phase === 'handOver' || view.phase === 'gameOver') && prev.phase !== view.phase;
    if (finished && view.results) {
      const from = this.centerOf(this.el.board);
      const delay = hadBets ? 380 : 0;
      for (const pot of view.results.pots) {
        for (const seat of pot.winners) {
          setTimeout(() => {
            for (let chip = 0; chip < 3; chip++) {
              setTimeout(() => this.fly(from, this.positions[seat]), chip * 70);
            }
          }, delay);
        }
      }
    }
  }

  /** Centre d'un élément, en pourcentage de la table. */
  centerOf(element) {
    const felt = this.el.felt.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    if (!felt.width || !felt.height) return CENTER;
    return [
      ((box.left + box.width / 2 - felt.left) / felt.width) * 100,
      ((box.top + box.height / 2 - felt.top) / felt.height) * 100,
    ];
  }

  fly([fromX, fromY], [toX, toY]) {
    const felt = this.el.felt.getBoundingClientRect();
    if (!felt.width) return;
    const chip = document.createElement('span');
    chip.className = 'chip-icon fly-chip';
    const at = (x, y) => `translate(${(x / 100) * felt.width - 7}px, ${(y / 100) * felt.height - 7}px)`;
    chip.style.transform = at(fromX, fromY);
    this.el.flying.append(chip);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        chip.style.transform = at(toX, toY);
        chip.style.opacity = '0.2';
      });
    });
    setTimeout(() => chip.remove(), 650);
  }

  bump(element) {
    element.classList.remove('bump');
    void element.offsetWidth;
    element.classList.add('bump');
  }
}

function joinNames(names) {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} et ${names[names.length - 1]}`;
}

export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}
