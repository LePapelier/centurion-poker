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
 * @param {object} situation
 * @param {number} situation.equity part du pot gagnée en moyenne, entre 0 et 1
 * @param {number} situation.opponents adversaires encore dans la main
 * @param {number} situation.pot pot total, mises en cours comprises
 * @param {{toCall: number, canCheck: boolean, canRaise: boolean, isOpening: boolean}} situation.legal
 * @returns {{action: 'fold'|'check'|'call'|'raise', label: string, reason: string}}
 */
export function advise({ equity, opponents, pot, legal }) {
  // Chacun gagnerait sa part si toutes les mains se valaient.
  const fairShare = 1 / (opponents + 1);
  const edge = equity / fairShare;
  const raiseLabel = legal.isOpening ? 'Miser' : 'Relancer';

  if (legal.canCheck) {
    if (legal.canRaise && edge >= 1.2 + 0.15 * opponents) {
      return {
        action: 'raise',
        label: raiseLabel,
        reason:
          `Vous gagnez ${percent(equity)} du temps contre ${opponentsText(opponents)}, ` +
          `bien plus que les ${percent(fairShare)} d'une main moyenne : misez pour vous faire payer.`,
      };
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
    return {
      action: 'raise',
      label: 'Relancer',
      reason:
        `Main très forte : ${percent(equity)} de chances contre ${opponentsText(opponents)}. ` +
        `Relancer fait grossir un pot que vous avez toutes les raisons de gagner.`,
    };
  }
  return {
    action: 'call',
    label: 'Suivre',
    reason:
      `Il suffit de gagner ${percent(needed)} du temps pour que suivre soit rentable, ` +
      `et vous êtes à ${percent(equity)}.`,
  };
}
