// Emojis automatiques : mot-clé (français / anglais) → emoji.
// Les racines de 5 lettres ou plus matchent aussi les mots qui commencent par elles
// (« gagner » → gagné, gagnant…). Les plus courtes doivent correspondre exactement (± s/x).
import { norm } from './analyzer.js';

const RULES = [
  ['💰', 'argent riche riches million millions milliard euros dollar salaire money cash payer paye fric thune'],
  ['💸', 'depenser depense acheter achat spend buy'],
  ['🔥', 'feu incroyable dingue enorme hallucinant fire crazy insane'],
  ['🤯', 'mindblowing choquant'],
  ['😂', 'rire drole marrant haha funny lol mdr'],
  ['❤️', 'amour aime aimer coeur adore love heart'],
  ['💔', 'triste pleurer larme larmes sad cry'],
  ['😱', 'peur flippant terrifiant effrayant scared terrifying'],
  ['🧠', 'cerveau intelligent penser pensee reflechir mental brain smart think'],
  ['💪', 'fort =force muscle sport entrainement discipline motivation gym strong'],
  ['🏆', 'gagner victoire champion reussir reussite succes winner success'],
  ['📈', 'croissance augmenter progresser progres growth grow'],
  ['📉', 'baisse chute perdre perte perdu loss lose'],
  ['⏰', 'temps =heure =heures minute minutes matin reveil time morning'],
  ['📅', 'jour jours semaine semaines mois annee annees calendrier week year years'],
  ['🚀', 'rapide vite fusee decoller lancer fast rocket launch'],
  ['🎯', 'objectif objectifs cible focus goal goals target'],
  ['💡', 'idee idees astuce astuces conseil conseils solution idea tips'],
  ['❌', 'non jamais erreur erreurs faux interdit never mistake wrong'],
  ['✅', 'oui vrai correct valide yes true right'],
  ['❓', 'pourquoi comment question why'],
  ['⚠️', 'attention danger dangereux warning careful'],
  ['🤫', 'secret secrets cache'],
  ['👀', 'regarde regardez regarder voir look watch'],
  ['🎉', 'fete celebrer bravo felicitations party'],
  ['😴', 'dormir sommeil fatigue sleep tired'],
  ['🍕', 'manger nourriture pizza repas food'],
  ['💼', 'travail travailler boulot bureau entreprise business work'],
  ['📱', 'telephone portable instagram tiktok reseaux phone'],
  ['🎬', 'video videos film cinema youtube'],
  ['🎵', 'musique chanson music song'],
  ['🌍', 'monde planete world'],
  ['👑', 'roi reine king queen boss'],
  ['💯', 'parfait parfaitement perfect'],
  ['🙏', 'merci thanks please'],
  ['😎', 'cool'],
  ['🤝', 'ensemble equipe partenaire team together'],
  ['📚', 'lire livre livres apprendre etudier ecole book learn study'],
  ['🏠', 'maison home'],
  ['✈️', 'avion voyage voyager travel'],
  ['🚗', 'voiture car'],
  ['👶', 'enfant enfants bebe baby'],
  ['🔑', 'cle key'],
  ['🧘', 'calme paix respirer calm peace'],
  ['😡', 'colere enerve angry'],
  ['🥇', 'premier premiere first'],
  ['🎁', 'cadeau gratuit free gift'],
  ['🔄', 'changer changement change'],
  ['🛑', 'arrete arreter arretez'],
  ['🗣️', 'parler parle talk speak'],
];

const exact = new Map();
const prefix = [];
for (const [emo, words] of RULES) {
  for (const raw of words.split(' ')) {
    const only = raw.startsWith('='); // « =mot » : correspondance exacte uniquement
    const w = only ? raw.slice(1) : raw;
    exact.set(w, emo);
    if (!only && w.length >= 5) prefix.push([w, emo]);
  }
}
prefix.sort((a, b) => b[0].length - a[0].length);

export function emojiFor(word) {
  const n = norm(word.replace(/^(?:[ldjcsnmt]|qu|jusqu|lorsqu|puisqu)['’]/i, ''));
  if (n.length < 2) return null;
  const hit = exact.get(n) || exact.get(n.replace(/[sx]$/, ''));
  if (hit) return hit;
  for (const [stem, emo] of prefix) if (n.startsWith(stem)) return emo;
  return null;
}
