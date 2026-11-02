import { termes } from "../selection-outils";
import type { SorteMemoire } from "../memoire-ui";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE RAPPEL DE LA MÉMOIRE (M1, décision 0045) — règle PURE.
 *
 * À chaque tour, deux parts, chacune dans son enveloppe de jetons :
 *   • LE PROFIL, toujours là : qui est la personne, sa famille proche, comment elle veut qu'on lui réponde ;
 *   • LES SOUVENIRS PERTINENTS pour CETTE question : BM25 sur les racines (le texte du souvenir ET les mots de sa sorte —
 *     « mon voyage » trouve « Part à Lyon le 12 », rangé sous VOYAGES), mêlé au cosinus des plongements quand il y en a.
 *     Sans aucun signal (« bonjour »), les plus récents.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const ENVELOPPES_MEMOIRE = { profil: 250, pertinents: 600 } as const;

/**
 * LE COMPTEUR DE LA MÉMOIRE — CALIBRÉ sur le modèle (01/11/2026, gpt-6-luna) : une section mémoire de 820 caractères a
 * coûté 229 jetons d'entrée RÉELS (`usage.input_tokens`, avec et sans la section) — 3,58 caractères par jeton en
 * français. 3,5 est retenu : le compteur surestime de ~2 %, une enveloppe tenue ici l'est chez le fournisseur.
 * (Aucun tokeniseur n'est installé dans le dépôt — `lib/assistant/context/tokens.ts` dit pourquoi.)
 */
export const CARACTERES_PAR_JETON = 3.5;
export const jetonsMemoire = (t: string): number => (t ? Math.ceil(t.length / CARACTERES_PAR_JETON) : 0);
/** Une ligne de la section (« - fait\n ») — l'unité que les enveloppes comptent. */
export const jetonsLigne = (contenu: string): number => jetonsMemoire(`- ${contenu}\n`);
/** Les en-têtes fixes de la section (titre, consigne, « Profil : », « Souvenirs utiles… ») — hors enveloppes, bornés. */
export const ENTETE_MEMOIRE_MAX = 70;

/** Les sortes du PROFIL stable. */
export const SORTES_PROFIL: ReadonlySet<string> = new Set<SorteMemoire>(["PERSONNEL_IDENTITE", "FAMILLE", "USER_PREFERENCE"]);

/** Les mots qu'une question emploie pour viser une sorte — ajoutés à l'index du souvenir. */
export const MOTS_DE_LA_SORTE: Record<SorteMemoire, string> = {
  PERSONNEL_IDENTITE: "moi identité qui suis nom prénom âge anniversaire né naissance habite ville origine",
  FAMILLE: "famille proches enfants fille fils femme mari épouse époux parents mère père frère sœur",
  ETUDES_PARCOURS: "études étudié diplôme école université master doctorat parcours formation carrière",
  SANTE_DECLAREE: "santé allergie médical régime traitement",
  VOYAGES: "voyage voyager déplacement partir départ séjour vacances destination vol billet",
  GOUTS_LOISIRS: "goûts aime préfère loisirs passion sport musique cuisine lecture film",
  PROJETS: "projet projets objectif prévoit envisage plan",
  ORGANIZATIONAL_CONTEXT: "société entreprise service équipe poste rôle produits",
  WORKING_STYLE: "habitude travail travaille matin soir réunion",
  CONTRAINTES: "contrainte disponible disponibilité horaire indisponible absence",
  PERSONNES_CITEES: "personne collègue contact ami",
  USER_PREFERENCE: "préférence réponse format style",
  ENTITY_ALIAS: "alias raccourci",
  TERMINOLOGY: "vocabulaire terme mot",
};

export interface SouvenirRappelable {
  id: string;
  sorte: string;
  contenu: string;
  /** Du plus récent (0) au plus ancien. */
  rang: number;
}

export interface Rappel {
  profil: SouvenirRappelable[];
  pertinents: SouvenirRappelable[];
  /** Combien de souvenirs auraient pu entrer et n'ont pas tenu — le banc le lit. */
  ecartes: number;
}

const K1 = 1.2;
const B = 0.75;

/** BM25 sur les racines : un score par souvenir pour la question. */
export function scoresBm25(docs: readonly { texte: string }[], question: string): number[] {
  const q = [...new Set(termes(question))];
  if (!q.length || !docs.length) return docs.map(() => 0);
  const toks = docs.map((d) => termes(d.texte));
  const moy = toks.reduce((s, t) => s + t.length, 0) / toks.length || 1;
  const df = new Map<string, number>();
  for (const t of toks) for (const m of new Set(t)) df.set(m, (df.get(m) ?? 0) + 1);
  return toks.map((t) => {
    const tf = new Map<string, number>();
    for (const m of t) tf.set(m, (tf.get(m) ?? 0) + 1);
    let s = 0;
    for (const m of q) {
      const f = tf.get(m) ?? 0;
      if (!f) continue;
      const n = df.get(m) ?? 0;
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
      s += idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * t.length) / moy)));
    }
    return s;
  });
}

export function cosinus(a: readonly number[], b: readonly number[]): number {
  if (!a.length || a.length !== b.length) return 0;
  let p = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { p += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? p / Math.sqrt(na * nb) : 0;
}

/** Le texte indexé d'un souvenir : sa phrase et les mots de sa sorte. */
export const texteIndexe = (s: Pick<SouvenirRappelable, "sorte" | "contenu">): string =>
  `${s.contenu} ${MOTS_DE_LA_SORTE[s.sorte as SorteMemoire] ?? ""}`;

/** Remplit une enveloppe dans l'ordre donné ; un souvenir qui ne tient pas est sauté entier. */
function remplir<T extends { contenu: string }>(liste: readonly T[], enveloppe: number): { gardes: T[]; ecartes: number } {
  let j = 0;
  const gardes: T[] = [];
  for (const s of liste) {
    const n = jetonsLigne(s.contenu);
    if (j + n <= enveloppe) { gardes.push(s); j += n; }
  }
  return { gardes, ecartes: liste.length - gardes.length };
}

/**
 * CHOISIR les souvenirs d'un tour. `similarites` (facultatif) : le cosinus question ↔ souvenir, par id — il ne vient que
 * si la mémoire dépasse l'enveloppe (sinon tout tient, aucun appel de plongement n'est fait).
 */
export function choisirSouvenirs(
  souvenirs: readonly SouvenirRappelable[],
  question: string,
  opts: { similarites?: ReadonlyMap<string, number>; enveloppes?: { profil: number; pertinents: number } } = {},
): Rappel {
  const env = opts.enveloppes ?? ENVELOPPES_MEMOIRE;
  const profilBrut = souvenirs.filter((s) => SORTES_PROFIL.has(s.sorte)).sort((a, b) => a.rang - b.rang);
  const profil = remplir(profilBrut, env.profil);
  const dansProfil = new Set(profil.gardes.map((s) => s.id));
  const reste = souvenirs.filter((s) => !dansProfil.has(s.id));
  const bm = scoresBm25(reste.map((s) => ({ texte: texteIndexe(s) })), question);
  const maxBm = Math.max(0, ...bm) || 1;
  const notes = reste.map((s, i) => {
    const lexical = bm[i] / maxBm;
    const sem = opts.similarites?.get(s.id) ?? 0;
    // Le sens compte au-delà d'un seuil (un cosinus de 0,2 est du bruit) ; la récence départage.
    const semantique = Math.max(0, (sem - 0.25) / 0.75);
    return { s, note: lexical * 0.6 + semantique * 0.4, recence: 1 / (1 + s.rang) };
  });
  notes.sort((a, b) => b.note - a.note || b.recence - a.recence);
  const pertinents = remplir(notes.map((n) => n.s), env.pertinents);
  // Le texte se lit dans l'ordre de pertinence : le plus utile d'abord.
  return { profil: profil.gardes, pertinents: pertinents.gardes, ecartes: profil.ecartes + pertinents.ecartes };
}

/** La mémoire entière tient-elle dans les enveloppes ? Si oui, aucun plongement de la question n'est utile. */
export const toutTient = (souvenirs: readonly Pick<SouvenirRappelable, "contenu">[]): boolean =>
  souvenirs.reduce((s, x) => s + jetonsLigne(x.contenu), 0) <= ENVELOPPES_MEMOIRE.profil + ENVELOPPES_MEMOIRE.pertinents;

/** La section du contexte : le profil, puis les souvenirs pertinents — à la troisième personne, comme ils sont écrits. */
export function sectionDuRappel(r: Pick<Rappel, "profil" | "pertinents">, filtre: (t: string) => string = (t) => t): string | null {
  if (!r.profil.length && !r.pertinents.length) return null;
  const lignes = ["### MÉMOIRE DE L'INTERLOCUTEUR",
    "Ce que tu sais de la personne (elle te l'a dit ; elle le voit et le corrige dans « Ce qu'il retient »). Sers-t'en pour répondre et pour personnaliser, sans le réciter."];
  if (r.profil.length) lignes.push("Profil :", ...r.profil.map((s) => `- ${filtre(s.contenu)}`));
  if (r.pertinents.length) lignes.push("Souvenirs utiles pour ce message :", ...r.pertinents.map((s) => `- ${filtre(s.contenu)}`));
  return lignes.join("\n");
}
