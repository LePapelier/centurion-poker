/**
 * Table en ligne entre navigateurs, sans serveur de jeu.
 *
 * WebRTC exige tout de même un intermédiaire pour la mise en relation
 * initiale : on utilise le courtier public de PeerJS, qui ne voit transiter
 * que l'identifiant de la table. Une fois la liaison établie, tout passe de
 * navigateur à navigateur, et le site reste entièrement statique.
 *
 * L'hôte fait autorité : il bat les cartes, tient le moteur et diffuse à
 * chacun l'état vu depuis son siège — sans jamais les cartes des autres. Les
 * invités n'envoient que des intentions.
 *
 * Chaque navigateur porte un identifiant durable : un invité dont la liaison
 * tombe (téléphone mis en veille, réseau qui change) retrouve son siège en
 * revenant avec le même code.
 */
import Peer from 'peerjs';

/** Préfixe des identifiants, pour ne pas croiser d'autres applications. */
const PREFIX = 'centurion-poker-';

/** Alphabet sans caractères ambigus : ni I/1, ni O/0. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

const CONNECT_TIMEOUT_MS = 20000;
const RESUME_DELAYS_MS = [800, 1500, 3000, 6000, 10000, 15000];
const MAX_RESUME_ATTEMPTS = 20;

const CLIENT_KEY = 'centurion-poker:client';

/**
 * Courtier de mise en relation. Par défaut celui, public, de PeerJS ; on peut
 * en désigner un autre à la construction (`VITE_PEER_SERVER=hôte:port`), par
 * exemple un serveur `peer` auto-hébergé ou local pour les essais.
 */
const PEER_OPTIONS = (() => {
  const server = import.meta.env?.VITE_PEER_SERVER;
  if (!server) return { debug: 0 };
  const url = new URL(server.includes('://') ? server : `http://${server}`);
  return {
    debug: 0,
    host: url.hostname,
    port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80),
    secure: url.protocol === 'https:',
    path: url.pathname === '/' ? '/' : url.pathname,
  };
})();

export function makeCode() {
  const values = new Uint32Array(CODE_LENGTH);
  crypto.getRandomValues(values);
  return [...values].map((n) => ALPHABET[n % ALPHABET.length]).join('');
}

export function normalizeCode(raw) {
  return String(raw ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, CODE_LENGTH);
}

export function inviteLink(code) {
  const { origin, pathname } = window.location;
  return `${origin}${pathname}#table=${code}`;
}

export function codeFromLocation() {
  const match = /[#&?]table=([A-Za-z0-9]+)/.exec(window.location.hash);
  return match ? normalizeCode(match[1]) : null;
}

export function clearLocationCode() {
  if (window.location.hash) {
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }
}

/** Identifiant durable de ce navigateur, pour reprendre son siège. */
export function clientId() {
  try {
    let id = localStorage.getItem(CLIENT_KEY);
    if (!id) {
      id = makeCode() + makeCode();
      localStorage.setItem(CLIENT_KEY, id);
    }
    return id;
  } catch {
    return makeCode() + makeCode();
  }
}

/**
 * L'hôte : ouvre la table sous un code et accueille les invités.
 *
 * Événements attendus dans `handlers` :
 *   onStatus(texte), onReady(code), onError(message)
 *   onGuest(client, name)       — un invité s'est présenté (ou est revenu)
 *   onGuestData(client, message)
 *   onGuestLeft(client)         — sa liaison est tombée ; il peut revenir
 */
export class HostSession {
  constructor(handlers = {}) {
    this.handlers = handlers;
    this.peer = null;
    this.code = null;
    this.closing = false;
    /** client → liaison ouverte */
    this.links = new Map();
    this.resumeTimer = null;
    this.attempts = 0;
  }

  emit(name, ...args) {
    this.handlers[name]?.(...args);
  }

  open(resume = false, attempt = 0) {
    this.teardownPeer();
    this.closing = false;
    if (!resume || !this.code) this.code = makeCode();
    this.emit('onStatus', resume ? 'Rétablissement de la table…' : 'Ouverture de la table…');

    const peer = new Peer(PREFIX + this.code, PEER_OPTIONS);
    this.peer = peer;

    peer.on('open', () => {
      this.attempts = 0;
      this.emit('onReady', this.code);
    });

    peer.on('connection', (conn) => this.accept(conn));

    peer.on('error', (error) => {
      if (error.type === 'unavailable-id') {
        // En reprise, l'identifiant occupé est le nôtre : il se libère seul.
        if (resume) return this.scheduleResume();
        if (attempt < 4) return this.open(false, attempt + 1);
      }
      if (resume) return this.scheduleResume();
      if (error.type === 'peer-unavailable') return; // un invité parti entre-temps
      this.emit('onError', describeError(error));
    });

    peer.on('disconnected', () => {
      if (!this.closing) peer.reconnect();
    });

    peer.on('close', () => {
      if (!this.closing) this.scheduleResume();
    });
  }

  scheduleResume() {
    if (this.closing) return;
    if (this.attempts >= MAX_RESUME_ATTEMPTS) {
      this.emit('onError', 'Le service de mise en relation ne répond plus.');
      return;
    }
    const delay = RESUME_DELAYS_MS[Math.min(this.attempts, RESUME_DELAYS_MS.length - 1)];
    this.attempts++;
    clearTimeout(this.resumeTimer);
    this.resumeTimer = setTimeout(() => this.open(true), delay);
  }

  accept(conn) {
    let client = null;

    conn.on('data', (message) => {
      if (!message || typeof message !== 'object') return;
      if (message.t === 'hello') {
        client = String(message.client ?? '').slice(0, 40);
        if (!client) return;
        // Une ancienne liaison du même navigateur cède la place.
        const previous = this.links.get(client);
        if (previous && previous !== conn) {
          try {
            previous.close();
          } catch {
            /* déjà fermée */
          }
        }
        this.links.set(client, conn);
        this.emit('onGuest', client, String(message.name ?? '').slice(0, 18));
        return;
      }
      if (client && this.links.get(client) === conn) this.emit('onGuestData', client, message);
    });

    conn.on('close', () => {
      if (client && this.links.get(client) === conn) {
        this.links.delete(client);
        if (!this.closing) this.emit('onGuestLeft', client);
      }
    });
  }

  isConnected(client) {
    return Boolean(this.links.get(client)?.open);
  }

  send(client, message) {
    const conn = this.links.get(client);
    if (conn?.open) conn.send(message);
  }

  /** Coupe un invité, par exemple quand la table est pleine. */
  dismiss(client, message) {
    const conn = this.links.get(client);
    if (!conn) return;
    this.links.delete(client);
    if (message) conn.send(message);
    setTimeout(() => conn.close(), 300);
  }

  teardownPeer() {
    clearTimeout(this.resumeTimer);
    try {
      this.peer?.destroy();
    } catch {
      /* déjà détruit */
    }
    this.peer = null;
  }

  destroy() {
    this.closing = true;
    for (const conn of this.links.values()) {
      try {
        conn.close();
      } catch {
        /* déjà fermée */
      }
    }
    this.links.clear();
    this.teardownPeer();
  }
}

/**
 * Un invité : rejoint une table par son code, et la rappelle tant qu'elle
 * peut revenir.
 *
 * Événements : onStatus(texte), onConnected(), onData(message),
 *   onDropped(texte), onClosed(texte), onError(message)
 */
export class GuestSession {
  constructor(handlers = {}) {
    this.handlers = handlers;
    this.peer = null;
    this.conn = null;
    this.code = null;
    this.name = '';
    this.closing = false;
    this.timer = null;
    this.resumeTimer = null;
    this.attempts = 0;
    this.resuming = false;
  }

  emit(name, ...args) {
    this.handlers[name]?.(...args);
  }

  get connected() {
    return Boolean(this.conn?.open);
  }

  join(rawCode, name, resume = false) {
    const code = normalizeCode(rawCode);
    if (code.length !== CODE_LENGTH) {
      this.emit('onError', 'Ce code de table est incomplet.');
      return;
    }
    this.teardown();
    this.closing = false;
    this.code = code;
    this.name = name;
    this.resuming = resume;
    if (!resume) this.attempts = 0;
    this.emit('onStatus', resume ? 'Reconnexion à la table…' : 'Connexion à la table…');

    const peer = new Peer(PEER_OPTIONS);
    this.peer = peer;

    peer.on('open', () => {
      const conn = peer.connect(PREFIX + code, { reliable: true, serialization: 'json' });
      this.conn = conn;

      conn.on('open', () => {
        clearTimeout(this.timer);
        this.attempts = 0;
        this.resuming = false;
        conn.send({ t: 'hello', client: clientId(), name: this.name });
        this.emit('onConnected');
      });

      conn.on('data', (message) => {
        if (message && typeof message === 'object') this.emit('onData', message);
      });

      conn.on('close', () => {
        if (this.closing || this.conn !== conn) return;
        this.conn = null;
        this.emit('onDropped', 'Liaison interrompue. Reprise en cours…');
        this.scheduleResume();
      });

      this.timer = setTimeout(() => {
        if (this.connected) return;
        if (this.resuming) return this.scheduleResume();
        this.emit('onError', 'Aucune réponse : la table est peut-être fermée.');
        this.destroy();
      }, CONNECT_TIMEOUT_MS);
    });

    peer.on('error', (error) => {
      if (this.resuming) return this.scheduleResume();
      clearTimeout(this.timer);
      this.emit('onError', describeError(error));
      this.destroy();
    });

    peer.on('disconnected', () => {
      if (!this.closing) peer.reconnect();
    });
  }

  scheduleResume() {
    if (this.closing || !this.code) return;
    if (this.attempts >= MAX_RESUME_ATTEMPTS) {
      this.emit('onClosed', 'Liaison perdue : la table n’a pas pu être retrouvée.');
      this.destroy();
      return;
    }
    const delay = RESUME_DELAYS_MS[Math.min(this.attempts, RESUME_DELAYS_MS.length - 1)];
    this.attempts++;
    clearTimeout(this.resumeTimer);
    this.resumeTimer = setTimeout(() => this.resumeNow(), delay);
  }

  /** Au retour dans l'onglet, inutile d'attendre l'essai programmé. */
  resumeNow() {
    if (this.closing || this.connected || !this.code) return;
    this.join(this.code, this.name, true);
  }

  send(message) {
    if (this.conn?.open) this.conn.send(message);
  }

  teardown() {
    clearTimeout(this.timer);
    clearTimeout(this.resumeTimer);
    try {
      this.conn?.close();
    } catch {
      /* déjà fermée */
    }
    try {
      this.peer?.destroy();
    } catch {
      /* déjà détruit */
    }
    this.conn = null;
    this.peer = null;
  }

  destroy() {
    this.closing = true;
    this.teardown();
  }
}

function describeError(error) {
  const messages = {
    'peer-unavailable': 'Table introuvable : vérifiez le code, ou l’hôte a fermé son onglet.',
    'unavailable-id': 'Impossible d’ouvrir la table, réessayez.',
    'browser-incompatible': 'Ce navigateur ne gère pas les connexions directes.',
    network: 'Connexion au service de mise en relation impossible.',
    'server-error': 'Le service de mise en relation ne répond pas.',
    'socket-error': 'Le service de mise en relation ne répond pas.',
    'ssl-unavailable': 'Connexion sécurisée refusée par le service de mise en relation.',
  };
  return messages[error?.type] ?? 'La connexion a échoué.';
}
