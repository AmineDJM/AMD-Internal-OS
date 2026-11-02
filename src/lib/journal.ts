/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE JOURNAL — une ligne JSON par événement, et un `catch` qui NOMME ce qu'il rattrape.
 *
 * Pourquoi (audit 27/10, INFRA-07) : plus de mille `.catch(() => [])` taisaient leur erreur. Une
 * base en panne se lisait « rien à faire » dans le centre de validation du DG, et personne n'était
 * prévenu. La règle maison est désormais :
 *
 *   prisma.adProGateVisa.findMany(…).catch(sansBloquer("centre-adpro.visas", []))
 *
 * Le comportement NON BLOQUANT reste (l'écran s'affiche avec le repli), mais l'échec laisse une
 * ligne au journal, sous un nom qu'on peut chercher, et il est COMPTÉ : un échec qui se répète
 * remonte au Super Admin (`src/lib/incidents-repetes.ts`) et se lit dans `/api/health`.
 *
 * Trois outils, et un seul choix à faire :
 *   - `sansBloquer(evenement, repli)` — une PANNE qu'on tolère : journalisée, comptée.
 *   - `attendu(raison, repli)` — un rejet NORMAL (fichier absent, corps de requête illisible
 *     envoyé par un client) : ni journal, ni compte ; la raison est écrite là où on la lit.
 *   - `journal.erreur / .avertissement / .info(evenement, contexte?, erreur?)` — le reste.
 *
 * Le cliquet `src/lib/journal-catch-muets.test.ts` compte les `.catch(() => …)` qui restent et
 * ne laisse ce nombre que baisser.
 *
 * ⚠️ Ce module n'importe RIEN : il est pur, et donc utilisable depuis un composant client
 * (frontière client/serveur, CLAUDE.md). Ce qui parle à la base vit à côté, côté serveur.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type NiveauJournal = "info" | "avertissement" | "erreur";

/** Une ligne du journal, telle qu'elle part sur la sortie du processus. */
export type LigneJournal = {
  ts: string;
  niveau: NiveauJournal;
  evenement: string;
  erreur?: string;
  /** Lignes identiques tues depuis la précédente écriture de cet événement (anti-avalanche). */
  repetitions?: number;
} & Record<string, unknown>;

export type Ecrivain = (ligne: LigneJournal) => void;

/** Tronque un message d'erreur : assez pour diagnostiquer, jamais une pile entière ni un secret de 10 Ko. */
export function messageErreur(e: unknown, max = 500): string {
  const brut = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return brut.length > max ? `${brut.slice(0, max - 1)}…` : brut;
}

/** Production : stderr pour les erreurs (Render les colore), stdout pour le reste. */
const ecrivainConsole: Ecrivain = (ligne) => {
  const texte = JSON.stringify(ligne);
  if (ligne.niveau === "erreur") console.error(texte);
  else if (ligne.niveau === "avertissement") console.warn(texte);
  else console.log(texte);
};

let ecrivain: Ecrivain = ecrivainConsole;

/** Pour les tests : capter les lignes au lieu de les écrire. Rend la fonction qui restaure. */
export function remplacerEcrivain(autre: Ecrivain): () => void {
  const avant = ecrivain;
  ecrivain = autre;
  return () => { ecrivain = avant; };
}

// ── ANTI-AVALANCHE ────────────────────────────────────────────────────────────────────────────
// Base injoignable : chaque lecture de chaque écran échoue, des centaines de fois par minute. La
// même erreur sous le même nom n'est réécrite qu'une fois par fenêtre ; la ligne suivante dit
// combien ont été tues. Un message DIFFÉRENT s'écrit toujours (c'est une autre panne).

export const FENETRE_SILENCE_MS = 60_000;

const derniereEcriture = new Map<string, { message: string; a: number; tues: number }>();

// ── COMPTEURS D'INCIDENTS ─────────────────────────────────────────────────────────────────────
// Chaque ERREUR est comptée par événement, en mémoire du processus. Deux lecteurs :
//   - `incidentsRecents()` — la sonde `/api/health` (ce processus, fenêtre glissante) ;
//   - `releverCompteurs()` — le versement en base, côté serveur, qui agrège les processus et
//     décide de prévenir le Super Admin (`incidents-repetes.ts`).

export type CompteurIncident = { evenement: string; compte: number; premierA: number; dernierA: number; dernierMessage: string };

/** Le seuil d'un incident « répété » : une erreur isolée n'alerte personne, cinq dans la fenêtre, si. */
export const SEUIL_INCIDENT = 5;

/** À verser en base (vidé à chaque relevé). */
const aVerser = new Map<string, CompteurIncident>();
/** Horodatages récents par événement (bornés), pour la sonde. */
const recents = new Map<string, number[]>();
const MAX_HORODATAGES = 200;
/** Au-delà, un nom d'événement fabriqué à la volée (bug) ne fera pas gonfler la mémoire sans fin. */
const MAX_EVENEMENTS = 500;

function compter(evenement: string, message: string, a: number): void {
  const c = aVerser.get(evenement);
  if (c) { c.compte += 1; c.dernierA = a; c.dernierMessage = message; }
  else if (aVerser.size < MAX_EVENEMENTS) aVerser.set(evenement, { evenement, compte: 1, premierA: a, dernierA: a, dernierMessage: message });

  const h = recents.get(evenement);
  if (h) { h.push(a); if (h.length > MAX_HORODATAGES) h.shift(); }
  else if (recents.size < MAX_EVENEMENTS) recents.set(evenement, [a]);
}

/** Vide et rend les compteurs accumulés depuis le dernier relevé. */
export function releverCompteurs(): CompteurIncident[] {
  const lot = [...aVerser.values()];
  aVerser.clear();
  return lot;
}

/** Remet un lot non versé (base injoignable) : il partira au relevé suivant, rien n'est perdu. */
export function restituerCompteurs(lot: readonly CompteurIncident[]): void {
  for (const c of lot) {
    const deja = aVerser.get(c.evenement);
    if (deja) {
      deja.compte += c.compte;
      deja.premierA = Math.min(deja.premierA, c.premierA);
    } else if (aVerser.size < MAX_EVENEMENTS) aVerser.set(c.evenement, { ...c });
  }
}

/** Les événements en erreur dans la fenêtre, de ce processus — le plus fréquent d'abord. */
export function incidentsRecents(fenetreMs = 15 * 60_000, maintenant = Date.now()): { evenement: string; compte: number }[] {
  const depuis = maintenant - fenetreMs;
  const sortie: { evenement: string; compte: number }[] = [];
  for (const [evenement, h] of recents) {
    while (h.length && h[0] < depuis) h.shift();
    if (h.length === 0) { recents.delete(evenement); continue; }
    sortie.push({ evenement, compte: h.length });
  }
  return sortie.sort((a, b) => b.compte - a.compte);
}

/** Pour les tests : repartir d'un processus neuf. */
export function reinitialiserJournal(): void {
  derniereEcriture.clear();
  aVerser.clear();
  recents.clear();
}

// ── L'ÉCRITURE ────────────────────────────────────────────────────────────────────────────────

export type OptionsJournal = {
  /** Clé de comptage, quand l'événement seul est trop large (ex. `tache.echec:rappels.reunions`). */
  cle?: string;
};

export function journaliser(
  niveau: NiveauJournal,
  evenement: string,
  contexte: Record<string, unknown> = {},
  erreur?: unknown,
  options: OptionsJournal = {},
): void {
  const a = Date.now();
  const message = erreur === undefined ? "" : messageErreur(erreur);
  const cle = options.cle ?? evenement;
  if (niveau === "erreur") compter(cle, message, a);

  let repetitions: number | undefined;
  if (niveau !== "info") {
    const precedente = derniereEcriture.get(cle);
    if (precedente && precedente.message === message && a - precedente.a < FENETRE_SILENCE_MS) {
      precedente.tues += 1;
      return;
    }
    if (precedente?.tues) repetitions = precedente.tues;
    if (derniereEcriture.size >= MAX_EVENEMENTS && !precedente) derniereEcriture.clear();
    derniereEcriture.set(cle, { message, a, tues: 0 });
  }

  const ligne: LigneJournal = { ts: new Date(a).toISOString(), niveau, evenement, ...contexte };
  if (message) ligne.erreur = message;
  if (repetitions) ligne.repetitions = repetitions;
  try {
    ecrivain(ligne);
  } catch {
    // Un journal ne fait jamais tomber ce qu'il observe (contexte non sérialisable, flux fermé).
  }
}

export const journal = {
  info: (evenement: string, contexte?: Record<string, unknown>) => journaliser("info", evenement, contexte),
  avertissement: (evenement: string, contexte?: Record<string, unknown>, erreur?: unknown) =>
    journaliser("avertissement", evenement, contexte, erreur),
  erreur: (evenement: string, contexte?: Record<string, unknown>, erreur?: unknown) =>
    journaliser("erreur", evenement, contexte, erreur),
};

// ── LES DEUX `catch` NOMMÉS ───────────────────────────────────────────────────────────────────

/**
 * Une PANNE tolérée : l'appelant continue avec `repli`, l'échec est journalisé sous `evenement`
 * et compté. Nom d'événement : `domaine.ce-qui-a-echoue` (ex. `centre-adpro.visas`).
 *
 *   .catch(sansBloquer("tresorerie.soldes", []))   // repli : liste vide
 *   .catch(sansBloquer("notif.push"))              // repli : undefined
 */
export function sansBloquer(evenement: string): (e: unknown) => undefined;
export function sansBloquer<T>(evenement: string, repli: T): (e: unknown) => T;
export function sansBloquer<T>(evenement: string, repli?: T): (e: unknown) => T | undefined {
  return (e) => {
    journaliser("erreur", evenement, {}, e);
    return repli;
  };
}

/**
 * Un rejet ATTENDU — ce n'est pas une panne, c'est un cas du métier ou du client : un fichier
 * qui peut ne pas exister, un corps de requête mal formé envoyé par un navigateur. Rien n'est
 * journalisé ; `raison` documente le choix là où un relecteur le lira.
 */
export function attendu(raison: string): (e: unknown) => undefined;
export function attendu<T>(raison: string, repli: T): (e: unknown) => T;
export function attendu<T>(_raison: string, repli?: T): (_e: unknown) => T | undefined {
  return () => repli;
}
