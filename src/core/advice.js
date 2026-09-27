/**
 * Le coup conseillé au joueur, avec sa raison, pour apprendre en jouant.
 *
 * Le conseil ne s'appuie que sur deux nombres, ceux qu'affiche déjà « Mes
 * chances » : la part du pot qu'on gagne en moyenne (l'équité) et, face à une
 * mise, la part qu'il faut gagner pour que suivre soit rentable (la cote du
 * pot). C'est le raisonnement de base d'un bon joueur, sans lecture des
 * adversaires, sans bluff ni jeu de position : de quoi comprendre pourquoi
 * un coup est rentable, pas jouer à la place du joueur.
 */

const percent = (value) => `${Math.round(value * 100)}\u00a0%`;
const chips = (value) => Math.round(value).toLocaleString('fr-FR');

const opponentsText = (count) => (count > 1 ? `${count} adversaires` : 'un adversaire');

/**
 * Combien miser ou relancer, et comment le dire. Des tailles d'usage : trois
 * grosses blinds pour ouvrir avant le flop (une de plus par joueur qui a
 * seulement suivi), trois fois la mise adverse pour relancer, et après le flop
 * une part du pot d'autant plus grosse que la main est forte. Quand la mise
 * engagerait presque tout le tapis, autant le mettre en entier.
 */
function sizeRaise({ equity, pot, legal, currentBet, bigBlind, smallBlind, street, myBet, myStack, limpers }) {
  let target;
  let how;
  if (street === 'preflop') {
    if (currentBet <= bigBlind) {
      target = bigBlind * (3 + limpers);
      how =
        limpers > 0
          ? `trois grosses blinds, plus une par joueur qui s'est contenté de suivre`
          : 'trois fois la grosse blind';
    } else {
      target = currentBet * 3;
      how = 'trois fois la relance';
    }
  } else if (legal.isOpening) {
    const strong = equity >= 0.8;
    target = pot * (strong ? 0.75 : 0.6);
    how = strong ? 'les trois quarts du pot' : 'un peu plus de la moitié du pot';
  } else {
    target = currentBet * 3;
    how = 'trois fois sa mise';
  }

  const step = Math.max(1, smallBlind);
  let amount = Math.min(legal.maxRaiseTo, Math.max(legal.minRaiseTo, Math.round(target / step) * step));
  const allIn = amount >= legal.maxRaiseTo || amount - myBet >= 0.6 * myStack;
  if (allIn) {
    amount = legal.maxRaiseTo;
    how = 'tout votre tapis, puisque la mise en engagerait déjà presque tout';
  }
  return { amount, how, allIn };
}

/**
 * @param {object} situation
 * @param {number} situation.equity part du pot gagnée en moyenne, entre 0 et 1
 * @param {number} situation.opponents adversaires encore dans la main
 * @param {number} situation.pot pot total, mises en cours comprises
 * @param {{toCall: number, canCheck: boolean, canRaise: boolean, isOpening: boolean, minRaiseTo: number, maxRaiseTo: number}} situation.legal
 * @param {number} situation.currentBet mise la plus haute de ce tour
 * @param {number} situation.bigBlind
 * @param {number} situation.smallBlind
 * @param {string} situation.street
 * @param {number} situation.myBet ce que le joueur a déjà misé à ce tour
 * @param {number} situation.myStack ses jetons derrière
 * @param {number} situation.limpers joueurs qui ont seulement suivi la grosse blind
 * @returns {{action: 'fold'|'check'|'call'|'raise', label: string, reason: string, amount?: number}}
 */
export function advise(situation) {
  const { equity, opponents, pot, legal } = situation;
  // Chacun gagnerait sa part si toutes les mains se valaient.
  const fairShare = 1 / (opponents + 1);
  const edge = equity / fairShare;

  const raise = (why) => {
    const { amount, how, allIn } = sizeRaise(situation);
    const opening = legal.isOpening;
    const label = allIn ? 'Tapis' : opening ? `Miser ${chips(amount)}` : `Relancer à ${chips(amount)}`;
    const action = allIn
      ? `Mettez tapis (${chips(amount)})`
      : opening
        ? `Misez ${chips(amount)}, soit ${how}`
        : `Relancez à ${chips(amount)}, soit ${how}`;
    return {
      action: 'raise',
      label,
      amount,
      reason: `${why} ${action}${allIn ? `, ${how}` : ''}.`,
    };
  };

  if (legal.canCheck) {
    if (legal.canRaise && edge >= 1.2 + 0.15 * opponents) {
      return raise(
        `Vous gagnez ${percent(equity)} du temps contre ${opponentsText(opponents)}, ` +
          `bien plus que les ${percent(fairShare)} d'une main moyenne : faites payer les autres.`,
      );
    }
    return {
      action: 'check',
      label: 'Parole',
      reason:
        edge >= 1
          ? `Main correcte (${percent(equity)}), sans plus : passer ne coûte rien et garde le pot petit.`
          : `Main faible (${percent(equity)}) : voir la suite gratuitement plutôt que miser.`,
    };
  }

  const needed = legal.toCall / (pot + legal.toCall);
  if (equity < needed) {
    return {
      action: 'fold',
      label: 'Se coucher',
      reason:
        `Suivre ${chips(legal.toCall)} pour un pot de ${chips(pot + legal.toCall)} demande de gagner ${percent(needed)} du temps ; ` +
        `vous n'avez que ${percent(equity)}. À la longue, suivre ici perd des jetons.`,
    };
  }
  if (legal.canRaise && edge >= 1.3 + 0.2 * opponents) {
    return raise(
      `Main très forte : ${percent(equity)} de chances contre ${opponentsText(opponents)}, ` +
        `faites grossir un pot que vous avez toutes les raisons de gagner.`,
    );
  }
  return {
    action: 'call',
    label: 'Suivre',
    reason:
      `Il suffit de gagner ${percent(needed)} du temps pour que suivre soit rentable, ` +
      `et vous êtes à ${percent(equity)}. Pas assez pour relancer : suivez simplement.`,
  };
}
