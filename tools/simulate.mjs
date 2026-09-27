/**
 * Parties IA contre IA, pour vérifier que les niveaux s'ordonnent : chaque
 * niveau affronte le niveau voisin en tête-à-tête, puis tous se retrouvent à
 * une table de cinq.
 *
 *   node tools/simulate.mjs [parties par duel]
 */
import { seededRandom } from '../src/core/cards.js';
import { Table } from '../src/core/table.js';
import { decide, LEVELS } from '../src/core/ai.js';

const games = Number(process.argv[2] ?? 20);

function play(levels, seed) {
  const random = seededRandom(seed);
  const table = new Table({
    players: levels.map((level, index) => ({ id: `s${index}`, name: LEVELS[level].name, kind: 'ai', level })),
    random,
  });
  let decisions = 0;
  let time = 0;
  table.startHand();
  while (table.phase !== 'gameOver' && table.handNo < 400) {
    if (table.phase === 'betting') {
      const seat = table.toAct;
      const started = performance.now();
      const action = decide(table.view(seat), table.seats[seat].level, random);
      time += performance.now() - started;
      decisions++;
      if (!table.act(seat, action)) throw new Error(`action refusée : ${JSON.stringify(action)}`);
    } else if (table.phase === 'between') table.nextStreet();
    else table.startHand();
  }
  const ranking = [...table.seats].sort((a, b) => (a.place ?? 99) - (b.place ?? 99) || b.stack - a.stack);
  return { winner: ranking[0].level, hands: table.handNo, perDecision: time / Math.max(1, decisions) };
}

let seed = 1;
console.log('Duels entre niveaux voisins :');
for (let low = 0; low < LEVELS.length - 1; low++) {
  let highWins = 0;
  let hands = 0;
  let perDecision = 0;
  for (let game = 0; game < games; game++) {
    const order = game % 2 === 0 ? [low, low + 1] : [low + 1, low];
    const result = play(order, seed++);
    if (result.winner === low + 1) highWins++;
    hands += result.hands;
    perDecision += result.perDecision;
  }
  console.log(
    `  ${LEVELS[low + 1].name.padEnd(10)} bat ${LEVELS[low].name.padEnd(10)} ${String(highWins).padStart(3)}/${games}` +
      `   ${Math.round(hands / games)} mains en moyenne, ${(perDecision / games).toFixed(1)} ms par décision`,
  );
}

console.log('Table de cinq, un joueur par niveau :');
const wins = new Array(LEVELS.length).fill(0);
for (let game = 0; game < games; game++) {
  const levels = [0, 1, 2, 3, 4].sort(() => 0.5 - seededRandom(seed)());
  wins[play(levels, seed++).winner]++;
}
LEVELS.forEach((level, index) => console.log(`  ${level.name.padEnd(10)} ${wins[index]} victoire(s)`));
