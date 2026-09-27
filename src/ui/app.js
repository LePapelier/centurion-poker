/**
 * L'application : la partie solo, la table en ligne, et tout ce qui se
 * touche à l'écran.
 *
 * Trois façons de tenir une table :
 *   solo  — le moteur tourne ici, contre des IA ; la partie est sauvegardée
 *           à chaque coup et reprend au rechargement ;
 *   host  — le moteur tourne ici aussi, et chaque invité reçoit l'état vu
 *           depuis son siège ;
 *   guest — le moteur est chez l'hôte : on affiche ce qu'il envoie et on lui
 *           transmet nos décisions.
 */
import { parseCards } from '../core/cards.js';
import { LEVELS, estimateEquity } from '../core/ai.js';
import { MAX_SEATS, Table } from '../core/table.js';
import { Director } from '../game/director.js';
import {
  GuestSession,
  HostSession,
  clearLocationCode,
  codeFromLocation,
  inviteLink,
  normalizeCode,
} from '../net/session.js';
import { TableView, cardElement, describeHole, escapeHtml, formatChips, seatName } from './table-view.js';

const SAVE_KEY = 'centurion-poker:solo';
const PREFS_KEY = 'centurion-poker:prefs';
const NAME_KEY = 'centurion-poker:name';

const AI_NAMES = ['Marcus', 'Livia', 'Brutus', 'Cornelia', 'Titus', 'Aurelia', 'Cassius', 'Flavia', 'Octavia', 'Quintus'];

const DEFAULT_PREFS = { opponents: 3, level: 2, hint: false };

const HAND_RANKS = [
  ['Quinte flush royale', 'As, roi, dame, valet, 10 de la même couleur.', 'As Ks Qs Js Ts'],
  ['Quinte flush', 'Cinq cartes qui se suivent, de la même couleur.', '9h 8h 7h 6h 5h'],
  ['Carré', 'Quatre cartes de même hauteur.', 'Qc Qd Qh Qs 4d'],
  ['Full', 'Un brelan et une paire.', 'Kc Kd Kh 7s 7d'],
  ['Couleur', 'Cinq cartes de la même couleur.', 'Ad Jd 8d 5d 2d'],
  ['Quinte', 'Cinq cartes qui se suivent.', 'Tc 9d 8h 7s 6c'],
  ['Brelan', 'Trois cartes de même hauteur.', 'Jc Jd Jh 9s 3c'],
  ['Double paire', 'Deux paires.', 'Kc Kd 8h 8s Ad'],
  ['Paire', 'Deux cartes de même hauteur.', 'Ac Ah Qd 7s 4c'],
  ['Hauteur', 'Rien de tout cela : la plus haute carte départage.', 'Ac Qd 9h 6s 3c'],
];

function shuffled(list) {
  const copy = [...list];
  for (let index = copy.length - 1; index > 0; index--) {
    const other = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[other]] = [copy[other], copy[index]];
  }
  return copy;
}

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* stockage plein ou refusé : la partie continue, sans sauvegarde */
  }
}

export class App {
  constructor() {
    this.prefs = { ...DEFAULT_PREFS, ...readJson(PREFS_KEY, {}) };
    this.myName = readJson(NAME_KEY, '') || '';
    this.mode = 'solo';
    this.mySeat = 0;
    this.view = null;
    this.meta = {};
    this.director = null;
    this.host = null;
    this.guest = null;
    this.lobby = [];
    /** Siège → identifiant du navigateur, pour les invités. */
    this.remoteSeats = new Map();
    this.away = new Set();
    this.raiseOpen = false;
    this.raiseAmount = 0;
    this.endShownFor = null;
    this.hintCache = { key: '', html: '' };
    this.logKey = '';
  }

  $(id) {
    return document.getElementById(id);
  }

  mount() {
    this.tableView = new TableView({
      felt: this.$('felt'),
      seats: this.$('seats'),
      board: this.$('board'),
      pot: this.$('pot'),
      potValue: this.$('pot-value'),
      banner: this.$('banner'),
      flying: this.$('flying'),
    });

    this.bindControls();
    this.bindDialogs();
    this.buildRanks();

    const code = codeFromLocation();
    if (!this.restoreSolo()) this.startSolo();
    if (code) this.openOnlineDialog(code);

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.guest?.resumeNow();
    });
  }

  /* ---------------------------------------------------------------- */
  /* Partie solo                                                       */
  /* ---------------------------------------------------------------- */

  startSolo(prefs = this.prefs) {
    this.stopDirector();
    const names = shuffled(AI_NAMES).slice(0, prefs.opponents);
    const table = new Table({
      players: [
        { id: 'me', name: this.myName || 'Vous', kind: 'human' },
        ...names.map((name, index) => ({ id: `ai${index}`, name, kind: 'ai', level: prefs.level })),
      ],
    });
    this.mode = 'solo';
    this.mySeat = 0;
    this.endShownFor = null;
    this.attachDirector(table, { watchSeat: 0 });
    this.director.start();
  }

  restoreSolo() {
    const saved = readJson(SAVE_KEY, null);
    if (!saved?.table) return false;
    try {
      const table = Table.fromJSON(saved.table);
      if (table.phase === 'gameOver' || table.seats[0].out) return false;
      this.mode = 'solo';
      this.mySeat = 0;
      this.endShownFor = null;
      this.attachDirector(table, { watchSeat: 0 });
      this.director.start();
      return true;
    } catch {
      return false;
    }
  }

  attachDirector(table, { watchSeat = -1, clock = false } = {}) {
    this.stopDirector();
    this.director = new Director({
      table,
      clock,
      watchSeat,
      isAway: (seat) => this.away.has(seat),
      onChange: (director) => this.onDirectorChange(director),
    });
  }

  stopDirector() {
    this.director?.stop();
    this.director = null;
  }

  onDirectorChange(director) {
    const { table } = director;
    if (this.mode === 'solo') writeJson(SAVE_KEY, { table: table.toJSON() });

    const clock = director.clockInfo();
    this.show(table.view(this.mySeat), { clock, away: this.away });

    if (this.mode === 'host') {
      for (const [seat, client] of this.remoteSeats) {
        this.host?.send(client, { t: 'view', view: table.view(seat), clock, away: [...this.away] });
      }
    }

    if (director.finished || (this.mode !== 'solo' && table.seats[this.mySeat].out)) {
      // Laisse le temps de voir la dernière main avant la fenêtre de fin.
      const id = `${this.mode}:${table.handNo}`;
      if (this.endShownFor !== id) {
        this.endShownFor = id;
        setTimeout(() => this.showEnd(), 2400);
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* Affichage                                                         */
  /* ---------------------------------------------------------------- */

  show(view, meta = {}) {
    this.view = view;
    this.meta = meta;
    this.tableView.render(view, meta);
    this.renderInfo(view);
    this.renderStatus(view);
    this.renderMyHand(view);
    this.renderActions(view);
    this.renderLog(view);
  }

  renderInfo(view) {
    const [small, big] = view.blinds;
    this.$('info-blinds').textContent = `${formatChips(small)}/${formatChips(big)}`;
    const next = this.$('info-next');
    const left = view.handsToNextLevel;
    next.textContent = left === 0 ? 'dernier niveau' : left === 1 ? 'hausse à la prochaine main' : `hausse dans ${left} mains`;
    next.classList.toggle('soon', left === 1);
    this.$('info-hand').textContent = view.handNo ? `Main ${view.handNo}` : '';
  }

  renderStatus(view) {
    const status = this.$('status');
    const thinking = this.$('thinking');
    const me = view.seats[view.viewer];
    let text = '';
    let thinker = '';

    if (view.phase === 'betting') {
      if (view.toAct === view.viewer) {
        const toCall = view.legal?.toCall ?? 0;
        text = toCall > 0 ? `À vous de parler · ${formatChips(toCall)} à suivre` : 'À vous de parler';
      } else {
        thinker = seatName(view, view.toAct);
      }
    } else if (view.phase === 'between' && view.isRunout) {
      text = 'Tapis : on retourne les cartes';
    } else if (view.phase === 'gameOver') {
      text = 'Partie terminée';
    } else if (view.phase === 'handOver') {
      text = me?.out ? 'Vous êtes éliminé' : '';
    }
    if (!text && me?.folded && view.phase === 'betting' && !thinker) text = 'Vous êtes couché';

    status.textContent = text;
    status.hidden = Boolean(thinker);
    thinking.hidden = !thinker;
    if (thinker) this.$('thinking-label').textContent = `${thinker} réfléchit`;
  }

  renderMyHand(view) {
    const me = view.seats[view.viewer];
    const box = this.$('my-cards');
    const hole = me && me.hole && !me.out ? me.hole : null;
    const highlight = this.tableView.highlightedCards(view);
    const key = `${view.handNo}:${hole ? hole.join(',') : ''}:${me?.folded}:${highlight ? [...highlight].join(',') : ''}`;
    if (box.dataset.key !== key) {
      const fresh = box.dataset.hand !== String(view.handNo);
      box.dataset.key = key;
      box.dataset.hand = String(view.handNo);
      box.replaceChildren();
      for (const [index, card] of (hole ?? []).entries()) {
        const element = cardElement(card, { deal: fresh, delay: 150 + index * 140 });
        if (me.folded) element.classList.add('dim');
        else if (highlight) element.classList.add(highlight.has(card) ? 'win' : 'dim');
        box.append(element);
      }
    }

    this.$('my-hand').textContent = hole && !me.folded ? describeHole(hole, view.board) : '';
    this.$('my-stack').innerHTML = me
      ? me.out
        ? 'Éliminé'
        : `Tapis <strong>${formatChips(me.stack)}</strong>`
      : '';

    this.renderHint(view, hole && !me.folded ? hole : null);
  }

  /** Conseil, en solo : chances de l'emporter et cote du pot. */
  renderHint(view, hole) {
    const button = this.$('btn-hint');
    const available = this.mode === 'solo' && hole && view.phase !== 'handOver' && view.phase !== 'gameOver';
    button.hidden = !available;
    if (!available) return;
    button.classList.toggle('shown', this.prefs.hint);
    const text = this.$('hint-text');
    if (!this.prefs.hint) {
      text.textContent = 'Mes chances';
      return;
    }

    const opponents = view.seats.filter((seat, index) => index !== view.viewer && seat.inHand).length;
    const legal = view.phase === 'betting' && view.toAct === view.viewer ? view.legal : null;
    const key = `${hole.join()}|${view.board.join()}|${opponents}|${legal?.toCall ?? ''}`;
    if (this.hintCache.key !== key) {
      const equity = estimateEquity({ hole, board: view.board, opponents, sims: 3000 });
      let html = `Chances <strong>${Math.round(equity * 100)} %</strong>`;
      if (legal && legal.toCall > 0) {
        const needed = legal.toCall / (view.pot + legal.toCall);
        const worth = equity >= needed;
        html += ` · il faut <span class="${worth ? 'good' : 'bad'}">${Math.round(needed * 100)} %</span>`;
      }
      this.hintCache = { key, html };
    }
    text.innerHTML = this.hintCache.html;
  }

  renderActions(view) {
    const legal = view.phase === 'betting' && view.toAct === view.viewer ? view.legal : null;
    const fold = this.$('btn-fold');
    const call = this.$('btn-call');
    const raise = this.$('btn-raise');
    const waitBar = this.$('actions-wait');
    const bar = this.$('actions');

    const canSkip = this.mode === 'solo' && view.phase === 'handOver' && !this.director?.finished;
    waitBar.hidden = !canSkip;
    bar.hidden = canSkip;

    if (!legal) {
      this.closeRaise();
      fold.disabled = true;
      call.disabled = true;
      raise.disabled = true;
      fold.textContent = 'Se coucher';
      call.textContent = 'Parole';
      raise.textContent = 'Relancer';
      return;
    }

    const me = view.seats[view.viewer];
    fold.disabled = legal.canCheck && !this.raiseOpen;
    fold.textContent = this.raiseOpen ? 'Retour' : 'Se coucher';
    call.disabled = false;
    if (legal.canCheck) call.textContent = 'Parole';
    else {
      const allIn = legal.toCall >= me.stack;
      call.innerHTML = `${allIn ? 'Tapis' : 'Suivre'} <span class="amount">${formatChips(legal.toCall)}</span>`;
    }
    raise.disabled = !legal.canRaise;
    const verb = legal.isOpening ? 'Miser' : 'Relancer';
    if (this.raiseOpen) {
      const allIn = this.raiseAmount >= legal.maxRaiseTo;
      raise.innerHTML = allIn
        ? `Tapis <span class="amount">${formatChips(this.raiseAmount)}</span>`
        : `${verb} <span class="amount">${formatChips(this.raiseAmount)}</span>`;
      this.renderRaisePanel(view, legal);
    } else {
      raise.textContent = verb;
    }
  }

  /** Montants proposés d'un geste : multiples de la blind avant le flop, fractions du pot ensuite. */
  presets(view, legal) {
    const [, big] = view.blinds;
    const clamp = (value) => Math.round(Math.min(legal.maxRaiseTo, Math.max(legal.minRaiseTo, value)));
    const potAfterCall = view.pot + legal.toCall;
    const options = [];
    if (view.street === 'preflop' && view.currentBet <= big) {
      options.push(['×2,5', clamp(big * 2.5)], ['×3', clamp(big * 3)], ['×4', clamp(big * 4)]);
    } else {
      options.push(['Min', legal.minRaiseTo]);
      options.push(['½ pot', clamp(view.currentBet + potAfterCall / 2)]);
      options.push(['¾ pot', clamp(view.currentBet + potAfterCall * 0.75)]);
    }
    options.push(['Pot', clamp(view.currentBet + potAfterCall)]);
    options.push(['Tapis', legal.maxRaiseTo]);
    // Pas deux boutons pour le même montant.
    const seen = new Set();
    return options.filter(([, amount]) => (seen.has(amount) ? false : (seen.add(amount), true)));
  }

  openRaise() {
    const view = this.view;
    const legal = view?.legal;
    if (!legal?.canRaise) return;
    this.raiseOpen = true;
    const presets = this.presets(view, legal);
    // Par défaut, un montant raisonnable : ×2,5 avant le flop, ½ pot ensuite.
    this.raiseAmount = presets[view.street === 'preflop' ? 0 : Math.min(1, presets.length - 1)][1];
    this.$('raise-panel').hidden = false;
    this.renderActions(view);
  }

  closeRaise() {
    if (!this.raiseOpen) return;
    this.raiseOpen = false;
    this.$('raise-panel').hidden = true;
  }

  renderRaisePanel(view, legal) {
    const presets = this.presets(view, legal);
    const box = this.$('presets');
    box.replaceChildren(
      ...presets.map(([label, amount]) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.classList.toggle('selected', amount === this.raiseAmount);
        button.addEventListener('click', () => this.setRaise(amount));
        return button;
      }),
    );
    const range = this.$('raise-range');
    range.min = String(legal.minRaiseTo);
    range.max = String(legal.maxRaiseTo);
    range.step = String(Math.max(1, view.blinds[0]));
    range.value = String(this.raiseAmount);
  }

  setRaise(amount) {
    const legal = this.view?.legal;
    if (!legal) return;
    this.raiseAmount = Math.round(Math.min(legal.maxRaiseTo, Math.max(legal.minRaiseTo, amount)));
    this.renderActions(this.view);
  }

  /* ---------------------------------------------------------------- */
  /* Historique                                                        */
  /* ---------------------------------------------------------------- */

  renderLog(view) {
    const last = view.log[view.log.length - 1];
    const key = `${view.viewer}:${view.log.length}:${last?.hand}:${last?.kind}:${last?.seat}:${last?.amount}`;
    if (this.logKey === key) return;
    this.logKey = key;
    const rows = [];
    for (const entry of view.log) {
      const row = this.logRow(view, entry);
      if (row) rows.push(row);
    }
    this.$('log').innerHTML = rows.reverse().slice(0, 120).join('');
  }

  logRow(view, entry) {
    const name = (seat) => escapeHtml(seatName(view, seat));
    const cards = (list) => list.map((card) => (card === null ? '?' : cardText(card))).join(' ');
    const row = (who, what, pts = '', muted = false) =>
      `<li><span class="who">${who}</span><span class="what${muted ? ' muted' : ''}">${what}</span>${
        pts ? `<span class="pts">${pts}</span>` : ''
      }</li>`;

    switch (entry.kind) {
      case 'hand':
        return `<li class="sep"><span class="what muted">Main ${entry.hand} · blinds ${formatChips(entry.small)}/${formatChips(entry.big)}</span></li>`;
      case 'blind':
        return row(name(entry.seat), entry.blind === 'sb' ? 'Petite blind' : 'Grosse blind', formatChips(entry.amount), true);
      case 'action': {
        const labels = {
          fold: 'Se couche',
          check: 'Parole',
          call: 'Suit',
          bet: 'Mise',
          raise: 'Relance à',
          allin: 'Tapis',
        };
        const amount = ['call', 'bet', 'raise', 'allin'].includes(entry.type) ? formatChips(entry.amount) : '';
        return row(name(entry.seat), labels[entry.type] ?? entry.type, amount, entry.type === 'fold' || entry.type === 'check');
      }
      case 'street': {
        const titles = { flop: 'Flop', turn: 'Turn', river: 'River' };
        return row(titles[entry.street], cards(entry.cards));
      }
      case 'win': {
        const seats = entry.seats ?? [entry.seat];
        const who = seats.map(name).join(', ');
        return row(who, entry.hand ? `remporte · ${escapeHtml(entry.hand)}` : 'remporte le pot', `+${formatChips(entry.amount)}`);
      }
      case 'bust':
        return row(name(entry.seat), `éliminé · ${entry.place}e`, '', true);
      case 'champion':
        return row(name(entry.seat), 'remporte la partie');
      default:
        return '';
    }
  }

  /* ---------------------------------------------------------------- */
  /* Décisions du joueur                                               */
  /* ---------------------------------------------------------------- */

  submit(action) {
    const view = this.view;
    if (!view || view.phase !== 'betting' || view.toAct !== view.viewer) return;
    this.closeRaise();
    if (this.mode === 'guest') {
      this.guest?.send({ t: 'act', action, hand: view.handNo, version: view.version });
      // L'hôte répondra par le nouvel état ; en attendant, on fige les boutons.
      this.renderActions({ ...view, toAct: -1 });
    } else {
      this.director?.act(this.mySeat, action);
    }
  }

  bindControls() {
    this.$('btn-fold').addEventListener('click', () => {
      if (this.raiseOpen) {
        this.closeRaise();
        this.renderActions(this.view);
      } else this.submit({ type: 'fold' });
    });
    this.$('btn-call').addEventListener('click', () => {
      const legal = this.view?.legal;
      if (legal) this.submit({ type: legal.canCheck ? 'check' : 'call' });
    });
    this.$('btn-raise').addEventListener('click', () => {
      if (!this.raiseOpen) this.openRaise();
      else this.submit({ type: 'raise', amount: this.raiseAmount });
    });
    this.$('raise-range').addEventListener('input', (event) => this.setRaise(Number(event.target.value)));
    this.$('raise-less').addEventListener('click', () => this.setRaise(this.raiseAmount - this.view.blinds[1]));
    this.$('raise-more').addEventListener('click', () => this.setRaise(this.raiseAmount + this.view.blinds[1]));
    this.$('btn-next').addEventListener('click', () => this.director?.nextHand());

    this.$('btn-hint').addEventListener('click', () => {
      this.prefs.hint = !this.prefs.hint;
      writeJson(PREFS_KEY, this.prefs);
      if (this.view) this.renderMyHand(this.view);
    });

    this.$('log-toggle').addEventListener('click', () => {
      const log = this.$('log');
      log.hidden = !log.hidden;
      this.$('log-toggle').setAttribute('aria-expanded', String(!log.hidden));
    });

    // Clavier, sur ordinateur : C pour parole ou suivre, F pour se coucher,
    // R pour relancer puis Entrée pour confirmer, Échap pour renoncer.
    document.addEventListener('keydown', (event) => {
      if (event.target instanceof HTMLInputElement || document.querySelector('dialog[open]')) return;
      const key = event.key.toLowerCase();
      if (key === 'c') this.$('btn-call').click();
      else if (key === 'f' && !this.$('btn-fold').disabled) this.$('btn-fold').click();
      else if (key === 'r' || (key === 'enter' && this.raiseOpen)) this.$('btn-raise').click();
      else if (key === 'escape' && this.raiseOpen) {
        this.closeRaise();
        this.renderActions(this.view);
      }
    });

    // Un clic sur la marque fait sauter le centurion, comme au Scrabble.
    const mascot = document.querySelector('.brand-mascot');
    document.querySelector('.brand').addEventListener('click', () => {
      mascot.classList.remove('hop');
      void mascot.offsetWidth;
      mascot.classList.add('hop');
      document.querySelectorAll('.brand-card').forEach((card, index) => {
        card.classList.remove('wiggle');
        void card.offsetWidth;
        card.style.animationDelay = `${index * 35}ms`;
        card.classList.add('wiggle');
      });
    });
  }

  /* ---------------------------------------------------------------- */
  /* Fenêtres                                                          */
  /* ---------------------------------------------------------------- */

  bindDialogs() {
    const newDialog = this.$('new-dialog');
    this.$('btn-new').addEventListener('click', () => {
      if (this.mode !== 'solo') {
        this.openOnlineDialog();
        return;
      }
      this.draft = { ...this.prefs };
      this.renderNewDialog();
      const inProgress = this.view && this.view.phase !== 'gameOver' && !this.director?.finished && this.view.handNo > 1;
      this.$('new-warning').hidden = !inProgress;
      newDialog.showModal();
    });
    this.$('new-cancel').addEventListener('click', () => newDialog.close());
    this.$('new-confirm').addEventListener('click', () => {
      this.prefs = { ...this.prefs, ...this.draft };
      writeJson(PREFS_KEY, this.prefs);
      newDialog.close();
      this.startSolo();
    });

    this.$('btn-ranks').addEventListener('click', () => this.$('ranks-dialog').showModal());
    this.$('ranks-close').addEventListener('click', () => this.$('ranks-dialog').close());

    this.$('end-close').addEventListener('click', () => this.$('end-dialog').close());
    this.$('end-again').addEventListener('click', () => {
      this.$('end-dialog').close();
      if (this.mode === 'host') this.backToLobby();
      else if (this.mode === 'solo') this.startSolo();
    });

    this.$('btn-multi').addEventListener('click', () => this.openOnlineDialog());
    this.bindOnline();

    // Fermer une feuille en touchant le fond.
    for (const dialog of document.querySelectorAll('dialog.sheet')) {
      dialog.addEventListener('click', (event) => {
        if (event.target === dialog) dialog.close();
      });
    }
  }

  renderNewDialog() {
    const opponents = this.$('opponents');
    opponents.replaceChildren(
      ...[1, 2, 3, 4, 5].map((count) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = String(count);
        button.setAttribute('role', 'radio');
        button.setAttribute('aria-checked', String(count === this.draft.opponents));
        button.classList.toggle('selected', count === this.draft.opponents);
        button.addEventListener('click', () => {
          this.draft.opponents = count;
          this.renderNewDialog();
        });
        return button;
      }),
    );

    const levels = this.$('levels');
    levels.replaceChildren(
      ...LEVELS.map((level, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'level-option';
        button.classList.toggle('selected', index === this.draft.level);
        button.innerHTML = `<span class="level-badge">${index + 1}</span>
          <span class="level-text"><span class="level-name">${level.name}</span>
          <span class="level-blurb">${level.description}</span></span>`;
        button.addEventListener('click', () => {
          this.draft.level = index;
          this.renderNewDialog();
        });
        return button;
      }),
    );
  }

  buildRanks() {
    this.$('ranks').innerHTML = '';
    HAND_RANKS.forEach(([name, blurb, example], index) => {
      const item = document.createElement('li');
      item.innerHTML = `<span class="n">${index + 1}</span><span class="what">${name}<small>${blurb}</small></span><span class="cards"></span>`;
      const cards = item.querySelector('.cards');
      for (const card of parseCards(example)) cards.append(cardElement(card));
      this.$('ranks').append(item);
    });
  }

  showEnd() {
    const view = this.view;
    if (!view) return;
    const me = view.seats[view.viewer];
    const count = view.seats.length;
    const place = me?.place ?? 1;
    const won = place === 1 && view.phase === 'gameOver';
    this.$('end-title').textContent = won ? 'Victoire !' : 'Éliminé';
    const hands = `${view.handNo} main${view.handNo > 1 ? 's' : ''}`;
    this.$('end-detail').textContent = won
      ? `Vous remportez tous les jetons en ${hands}.`
      : `Vous terminez ${place === 1 ? '1er' : `${place}e`} sur ${count}, après ${hands}.`;

    const ranked = view.seats
      .map((seat, index) => ({ seat, index }))
      .sort((a, b) => (a.seat.place ?? 0) - (b.seat.place ?? 0) || b.seat.stack - a.seat.stack);
    this.$('end-standings').innerHTML = ranked
      .map(
        ({ seat, index }) =>
          `<li class="${index === view.viewer ? 'me' : ''}"><span class="place">${seat.place ? `${seat.place}e` : '·'}</span>${escapeHtml(
            seatName(view, index),
          )}<span class="tag">${seat.out ? 'éliminé' : `${formatChips(seat.stack)} jetons`}</span></li>`,
      )
      .join('')
      .replace('<span class="place">1e</span>', '<span class="place">1er</span>');

    const again = this.$('end-again');
    // L'hôte éliminé fait encore tourner la table : pas question de la
    // relancer avant la fin.
    again.hidden = this.mode === 'guest' || (this.mode === 'host' && view.phase !== 'gameOver');
    again.textContent = this.mode === 'host' ? 'Nouvelle partie à cette table' : 'Rejouer';
    if (!this.$('end-dialog').open) this.$('end-dialog').showModal();
  }

  toast(text, tone = '') {
    const toast = this.$('toast');
    toast.textContent = text;
    toast.className = `toast ${tone}`;
    toast.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      toast.hidden = true;
    }, 3200);
  }

  /* ---------------------------------------------------------------- */
  /* En ligne                                                          */
  /* ---------------------------------------------------------------- */

  openOnlineDialog(code = '') {
    const dialog = this.$('mp-dialog');
    this.$('mp-name').value = this.myName;
    if (code) this.$('mp-code').value = code;
    this.renderOnlineDialog();
    if (!dialog.open) dialog.showModal();
    if (code && !this.myName) this.$('mp-name').focus();
  }

  renderOnlineDialog() {
    const online = Boolean(this.host || this.guest);
    this.$('mp-choice').hidden = online;
    this.$('mp-name-field').hidden = online;
    this.$('mp-intro').hidden = online;
    this.$('mp-invite').hidden = !this.hostReady;
    if (this.hostReady) this.$('mp-code-value').textContent = this.host.code;
    this.$('mp-lobby').hidden = !online;
    this.$('mp-leave').hidden = !online;
    this.$('lobby-host').hidden = !this.host || this.mode === 'host';
    this.$('mp-start').disabled = this.lobby.length < 2;
    this.$('mp-add-ai').disabled = this.lobby.length >= MAX_SEATS;
    this.$('mp-lobby-title').textContent =
      this.mode === 'guest' || this.mode === 'host' ? 'Partie en cours' : `À la table (${this.lobby.length}/${MAX_SEATS})`;
    this.renderLobby();
  }

  renderLobby() {
    const list = this.$('lobby');
    list.replaceChildren(
      ...this.lobby.map((player, index) => {
        const item = document.createElement('li');
        const label =
          player.kind === 'ai'
            ? `IA · ${LEVELS[player.level]?.name ?? ''}`
            : index === 0
              ? 'hôte'
              : player.you
                ? 'vous'
                : player.away
                  ? 'déconnecté'
                  : 'en ligne';
        item.innerHTML = `${escapeHtml(player.name)}<span class="tag">${label}</span>`;
        if (this.host && this.mode !== 'host' && index > 0) {
          const remove = document.createElement('button');
          remove.type = 'button';
          remove.className = 'remove';
          remove.textContent = '×';
          remove.setAttribute('aria-label', `Retirer ${player.name}`);
          remove.addEventListener('click', () => this.removeFromLobby(index));
          item.append(remove);
        }
        return item;
      }),
    );
  }

  setOnlineStatus(text, tone = '') {
    const status = this.$('mp-status');
    status.textContent = text;
    status.className = `mp-status ${tone}`;
  }

  setNetchip(text, tone) {
    const chip = this.$('netchip');
    chip.hidden = !text;
    chip.className = `netchip ${tone ?? ''}`;
    chip.innerHTML = `<span class="netchip-label">${escapeHtml(text ?? '')}</span>`;
  }

  readName() {
    const name = this.$('mp-name').value.trim().slice(0, 18);
    if (!name) {
      this.setOnlineStatus('Choisissez d’abord un pseudo.', 'error');
      this.$('mp-name').focus();
      return null;
    }
    this.myName = name;
    writeJson(NAME_KEY, name);
    return name;
  }

  bindOnline() {
    this.$('mp-close').addEventListener('click', () => this.$('mp-dialog').close());
    this.$('mp-create').addEventListener('click', () => this.openTable());
    this.$('mp-join').addEventListener('click', () => this.joinTable(this.$('mp-code').value));
    this.$('mp-code').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') this.joinTable(this.$('mp-code').value);
    });
    this.$('mp-copy').addEventListener('click', async () => {
      const link = inviteLink(this.host.code);
      try {
        await navigator.clipboard.writeText(link);
        this.setOnlineStatus('Lien copié.', 'live');
      } catch {
        this.setOnlineStatus(link);
      }
    });
    this.$('mp-add-ai').addEventListener('click', () => {
      if (this.lobby.length >= MAX_SEATS) return;
      const taken = new Set(this.lobby.map((player) => player.name));
      const name = AI_NAMES.find((candidate) => !taken.has(candidate)) ?? 'Centurion';
      this.lobby.push({ kind: 'ai', name, level: this.prefs.level });
      this.broadcastLobby();
    });
    this.$('mp-start').addEventListener('click', () => this.startOnline());
    this.$('mp-leave').addEventListener('click', () => {
      this.leaveOnline();
      this.$('mp-dialog').close();
    });
  }

  /* --- Hôte --------------------------------------------------------- */

  openTable() {
    const name = this.readName();
    if (!name) return;
    this.stopDirector();
    this.mode = 'lobby';
    this.lobby = [{ kind: 'human', name, client: null }];
    this.host = new HostSession({
      onStatus: (text) => this.setOnlineStatus(text),
      onReady: (code) => {
        this.hostReady = true;
        this.setOnlineStatus('Table ouverte. En attente des joueurs…', 'live');
        this.setNetchip(`Table ${code}`, 'live');
        this.renderOnlineDialog();
      },
      onError: (message) => {
        this.setOnlineStatus(message, 'error');
        this.setNetchip('Hors ligne', 'lost');
      },
      onGuest: (client, guestName) => this.onGuest(client, guestName),
      onGuestLeft: (client) => this.onGuestLeft(client),
      onGuestData: (client, message) => this.onGuestData(client, message),
    });
    this.host.open();
    this.renderOnlineDialog();
  }

  onGuest(client, guestName) {
    if (this.mode === 'host') {
      const seat = [...this.remoteSeats].find(([, id]) => id === client)?.[0];
      if (seat === undefined) {
        this.host.dismiss(client, { t: 'refused', text: 'La partie a déjà commencé.' });
        return;
      }
      this.away.delete(seat);
      this.host.send(client, { t: 'start' });
      this.toast(`${this.director.table.seats[seat].name} est de retour.`);
      this.director.refreshClock();
      this.onDirectorChange(this.director);
      return;
    }
    const existing = this.lobby.find((player) => player.client === client);
    if (existing) {
      existing.name = guestName || existing.name;
    } else {
      if (this.lobby.length >= MAX_SEATS) {
        this.host.dismiss(client, { t: 'refused', text: 'La table est complète.' });
        return;
      }
      this.lobby.push({ kind: 'remote', name: guestName || 'Invité', client });
      this.toast(`${guestName || 'Un invité'} s’installe à la table.`);
    }
    this.broadcastLobby();
  }

  onGuestLeft(client) {
    if (this.mode === 'host') {
      const seat = [...this.remoteSeats].find(([, id]) => id === client)?.[0];
      if (seat === undefined) return;
      this.away.add(seat);
      this.toast(`${this.director.table.seats[seat].name} s’est déconnecté.`, 'error');
      this.director.refreshClock();
      this.onDirectorChange(this.director);
      return;
    }
    const index = this.lobby.findIndex((player) => player.client === client);
    if (index > 0) {
      this.lobby.splice(index, 1);
      this.broadcastLobby();
    }
  }

  onGuestData(client, message) {
    if (message.t !== 'act' || this.mode !== 'host') return;
    const seat = [...this.remoteSeats].find(([, id]) => id === client)?.[0];
    if (seat === undefined || message.hand !== this.director.table.handNo) return;
    this.director.act(seat, message.action ?? {});
  }

  removeFromLobby(index) {
    const [player] = this.lobby.splice(index, 1);
    if (player?.client) this.host.dismiss(player.client, { t: 'refused', text: 'L’hôte vous a retiré de la table.' });
    this.broadcastLobby();
  }

  broadcastLobby() {
    const players = this.lobby.map((player) => ({ name: player.name, kind: player.kind, level: player.level ?? null }));
    this.lobby.forEach((player, index) => {
      if (player.client) this.host.send(player.client, { t: 'lobby', players, you: index });
    });
    this.renderOnlineDialog();
  }

  startOnline() {
    if (this.lobby.length < 2) return;
    const players = this.lobby.map((player, index) => ({
      id: player.client ?? (player.kind === 'ai' ? `ai${index}` : 'host'),
      name: player.name,
      kind: player.kind === 'remote' ? 'remote' : player.kind,
      level: player.level,
    }));
    const table = new Table({ players });
    this.mode = 'host';
    this.mySeat = 0;
    this.remoteSeats = new Map();
    this.away = new Set();
    this.lobby.forEach((player, index) => {
      if (player.client) this.remoteSeats.set(index, player.client);
    });
    this.endShownFor = null;
    for (const client of this.remoteSeats.values()) this.host.send(client, { t: 'start' });
    this.attachDirector(table, { clock: true });
    this.$('mp-dialog').close();
    this.renderOnlineDialog();
    this.director.start();
  }

  backToLobby() {
    this.stopDirector();
    this.mode = 'lobby';
    this.remoteSeats = new Map();
    this.away = new Set();
    // Seuls restent les invités encore reliés.
    this.lobby = this.lobby.filter((player) => !player.client || this.host?.isConnected(player.client));
    this.broadcastLobby();
    this.openOnlineDialog();
  }

  /* --- Invité ------------------------------------------------------- */

  joinTable(rawCode) {
    const name = this.readName();
    if (!name) return;
    const code = normalizeCode(rawCode);
    if (code.length !== 6) {
      this.setOnlineStatus('Le code compte six caractères.', 'error');
      return;
    }
    this.stopDirector();
    this.lobby = [];
    clearLocationCode();
    this.guest = new GuestSession({
      onStatus: (text) => this.setOnlineStatus(text),
      onConnected: () => {
        this.setOnlineStatus('Vous êtes à la table. L’hôte lancera la partie.', 'live');
        this.setNetchip(`Table ${code}`, 'live');
        this.renderOnlineDialog();
      },
      onData: (message) => this.onHostMessage(message),
      onDropped: (text) => {
        this.setNetchip('Reconnexion…', 'lost');
        this.toast(text, 'error');
      },
      onClosed: (text) => {
        this.toast(text, 'error');
        this.leaveOnline();
      },
      onError: (message) => {
        this.setOnlineStatus(message, 'error');
        this.guest = null;
        this.renderOnlineDialog();
        if (this.mode !== 'guest') this.resumeSolo();
      },
    });
    this.guest.join(code, name);
    this.renderOnlineDialog();
  }

  onHostMessage(message) {
    switch (message.t) {
      case 'lobby':
        this.lobby = message.players.map((player, index) => ({ ...player, you: index === message.you }));
        if (this.mode === 'guest') {
          // L'hôte prépare une nouvelle partie.
          this.mode = 'lobby';
          this.openOnlineDialog();
        }
        this.renderOnlineDialog();
        break;
      case 'start':
        this.mode = 'guest';
        this.endShownFor = null;
        this.setNetchip(`Table ${this.guest?.code ?? ''}`, 'live');
        this.$('mp-dialog').close();
        this.renderOnlineDialog();
        break;
      case 'view': {
        if (this.mode !== 'guest') {
          this.mode = 'guest';
          this.$('mp-dialog').close();
        }
        this.setNetchip(`Table ${this.guest?.code ?? ''}`, 'live');
        this.mySeat = message.view.viewer;
        const view = message.view;
        this.show(view, { clock: message.clock, away: new Set(message.away ?? []) });
        const me = view.seats[view.viewer];
        if (view.phase === 'gameOver' || me?.out) {
          const id = `guest:${view.handNo}`;
          if (this.endShownFor !== id) {
            this.endShownFor = id;
            setTimeout(() => this.showEnd(), 2400);
          }
        }
        break;
      }
      case 'refused':
        this.setOnlineStatus(message.text ?? 'Accès refusé.', 'error');
        this.toast(message.text ?? 'Accès refusé.', 'error');
        this.leaveOnline();
        this.openOnlineDialog();
        break;
      default:
        break;
    }
  }

  /* --- Départ ------------------------------------------------------- */

  leaveOnline() {
    this.host?.destroy();
    this.guest?.destroy();
    this.host = null;
    this.hostReady = false;
    this.guest = null;
    this.lobby = [];
    this.remoteSeats = new Map();
    this.away = new Set();
    this.setNetchip(null);
    if (this.mode !== 'solo' || !this.director) this.resumeSolo();
    this.renderOnlineDialog();
  }

  /** Revient à la partie solo sauvegardée, ou en commence une. */
  resumeSolo() {
    this.mode = 'solo';
    this.mySeat = 0;
    this.tableView.prev = null;
    this.tableView.layoutKey = '';
    if (!this.restoreSolo()) this.startSolo();
  }
}

function cardText(card) {
  const element = cardElement(card);
  return element.getAttribute('aria-label');
}
