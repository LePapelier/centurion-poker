# Centurion Poker

Texas hold'em sans limite, jouable dans le navigateur contre des IA à cinq
niveaux, ou entre amis (jusqu'à six) en liaison directe. La partie solo ne
fait aucun appel réseau une fois la page chargée, et reprend là où on l'a
laissée si l'onglet se ferme.

Même famille que [Centurion Scrabble](https://github.com/LePapelier/centurion-scrabble) :
même centurion, même feutre, même esprit.

## Commandes

```bash
npm install
npm run dev          # serveur de développement
npm run build        # bundle de production dans dist/
npm test             # évaluateur de mains et moteur de table
npm run simulate 40  # parties IA contre IA, niveau par niveau
```

## Règles

Tournoi à tapis égaux : chacun commence avec 1 500 jetons, blinds à 10/20,
qui montent toutes les dix mains. La partie s'arrête quand un joueur a tous
les jetons. Relances minimales, tapis incomplets qui ne rouvrent pas les
enchères, pots annexes, jetons indivisibles au premier gagnant à gauche du
bouton : les règles d'une vraie table.

## Adversaires

L'IA ne voit que ce qu'un joueur verrait à sa place : l'état de la table
depuis son siège, ses deux cartes, rien d'autre. Elle estime ses chances en
jouant la fin de la main des centaines de fois au hasard (Monte-Carlo), puis
décide selon son niveau :

| Niveau | Jeu |
| --- | --- |
| Novice | paie pour voir, mise rarement, ne bluffe jamais |
| Amateur | joue ses bonnes mains, se laisse encore impressionner |
| Confirmé | respecte la cote du pot et mise pour se faire payer |
| Expert | lit les relances, continue ses mises, bluffe à bon escient |
| Centurion | calcule tout, varie son jeu, joue tapis ou rien à tapis court |

`npm run simulate` fait s'affronter les niveaux voisins et les réunit à une
même table, pour vérifier qu'ils s'ordonnent.

## Partie en ligne

Aucun serveur de jeu : les navigateurs se relient en WebRTC. L'hôte ouvre une
table, obtient un code à six caractères et transmet le lien `…/#table=CODE` ;
les invités l'ouvrent, ou saisissent le code. L'hôte peut compléter la table
avec des IA.

L'hôte fait autorité : il bat les cartes, tient le moteur et envoie à chacun
l'état vu depuis son siège, sans jamais les cartes des autres. Les invités
n'envoient que leurs décisions. Chacun dispose de trente secondes pour parler ;
un joueur déconnecté est couché (ou passe parole) au bout de huit, et
retrouve son siège en revenant avec le même code.

La mise en relation passe par le courtier public de PeerJS, qui ne voit
transiter que l'identifiant de la table. Pour en utiliser un autre (un
serveur `peer` auto-hébergé, ou local pour les essais) :

```bash
VITE_PEER_SERVER=localhost:9000 npm run dev
```

## Déploiement

`base` vaut `./` : le contenu de `dist/` se copie tel quel dans n'importe
quel sous-répertoire. GitHub Pages le publie à chaque poussée sur `main`,
sous `paul-laurent.fr/centurion-poker/`.

## Organisation

| Chemin | Rôle |
| --- | --- |
| `src/core/cards.js` | cartes, paquet, tirages |
| `src/core/evaluator.js` | valeur et nom des mains |
| `src/core/table.js` | moteur de table : enchères, pots, abattage, blinds |
| `src/core/ai.js` | estimation des chances et décisions de l'IA |
| `src/game/director.js` | rythme de la table, tour des IA, temps de parole |
| `src/net/session.js` | liaison directe entre navigateurs |
| `src/ui/table-view.js` | dessin de la table à partir d'un instantané |
| `src/ui/app.js` | partie solo, table en ligne, commandes et fenêtres |

La police Cinzel est sous licence OFL (voir `public/fonts/OFL-Cinzel.txt`).
