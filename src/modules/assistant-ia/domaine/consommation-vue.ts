/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ÉCRAN « CONSOMMATION » — ce qu'il montre, PUR (aucun import lourd) : les types, les périodes,
 * les libellés des usages, l'export. Lu par le serveur (`infra/consommation-detail.ts`) et par le
 * composant client (`ecrans/consommation/`). Lot K8, décision 0035.
 *
 * Tout chiffre vient du journal `ModelCallLog` (une ligne par appel payé). Un coût est une CHAÎNE
 * décimale au micro-dollar (« 0.012345 ») : jamais un flottant additionné.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type Perimetre = "moi" | "entreprise";

/** Les totaux d'un ensemble d'appels — tous les types de jetons et unités, et le coût. */
export interface Totaux {
  appels: number;
  entree: number;
  entreeCache: number;
  sortie: number;
  raisonnement: number;
  audioEntree: number;
  audioEntreeCache: number;
  audioSortie: number;
  imageEntree: number;
  imageEntreeCache: number;
  imageSortie: number;
  recherchesWeb: number;
  dureeMs: number;
  pages: number;
  /** Somme EXACTE des coûts connus, en dollars (« 0.012345 »). */
  coutUsd: string;
  /** Appels dont le coût est inconnu (modèle sans tarif) — le total n'est complet que s'il vaut 0. */
  sansTarif: number;
  /** Appels dont les jetons sont estimés (l'API n'a rien rendu). */
  estimes: number;
}

export interface LigneVentilee extends Totaux { cle: string; libelle: string; detail?: string }

export interface AppelDetaille {
  id: string;
  at: string;
  personne: string | null;
  usage: string;
  fournisseur: string;
  modele: string;
  conversation: string | null;
  entree: number; entreeCache: number; sortie: number; raisonnement: number;
  audioEntree: number; audioEntreeCache: number; audioSortie: number;
  imageEntree: number; imageEntreeCache: number; imageSortie: number;
  recherchesWeb: number; dureeFactureeMs: number; pages: number;
  coutUsd: string | null;
  ms: number;
  estime: boolean;
  lot: boolean;
  grille: string | null;
}

export interface PosteCout {
  poste: string; libelle: string; quantite: number; unite: string; coutUsd: string | null;
  /** Une partie de la quantité vient d'appels au tarif inconnu : le montant est celui des appels connus. */
  partiel: boolean;
}

export interface Rapprochement {
  configure: boolean;
  /** Ce que dit l'écran, toujours : configuré ou non, et pourquoi. */
  message: string;
  factureUsd?: string;
  journaliseUsd?: string;
  ecartUsd?: string;
  ecartPct?: number | null;
}

export interface Plafonds {
  jetonsJour: number;
  jetonsTour: number;
  travailUsd: number | null;
  mensuelUsd: number | null;
  atteints: { nom: string; jour: string; jetons: number; plafond: number }[];
}

export interface VueConsommation {
  perimetre: Perimetre;
  periode: { debut: string; fin: string; libelle: string };
  resumes: { cle: CleResume; libelle: string; totaux: Totaux }[];
  totaux: Totaux;
  postes: PosteCout[];
  parModele: LigneVentilee[];
  parUsage: LigneVentilee[];
  parConversation: LigneVentilee[];
  parPersonne: LigneVentilee[];
  parJour: { jour: string; coutUsd: string; jetons: number; appels: number }[];
  appels: AppelDetaille[];
  appelsTronques: boolean;
  plafonds: Plafonds | null;
  rapprochement: Rapprochement | null;
  grilleRelevee: string;
}

// ─────────────────────────────── Les périodes (heure d'Alger, UTC+1 sans heure d'été) ───────────────────────────────

const H = 3_600_000;
const J = 24 * H;

export type CleResume = "aujourdhui" | "7j" | "mois" | "moisPrecedent";
export const LIBELLE_RESUME: Record<CleResume, string> = {
  aujourdhui: "Aujourd'hui", "7j": "7 derniers jours", mois: "Mois en cours", moisPrecedent: "Mois précédent",
};

/** Minuit d'Alger du jour de `d`, en instant UTC. */
export function minuitAlger(d: Date): Date {
  const l = new Date(d.getTime() + H);
  return new Date(Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), l.getUTCDate()) - H);
}

/** Le 1er du mois d'Alger de `d` (décalé de `decalage` mois), minuit d'Alger. */
export function debutMoisAlger(d: Date, decalage = 0): Date {
  const l = new Date(d.getTime() + H);
  return new Date(Date.UTC(l.getUTCFullYear(), l.getUTCMonth() + decalage, 1) - H);
}

/** Les quatre résumés, en intervalles semi-ouverts [début, fin). */
export function intervallesResumes(now: Date): Record<CleResume, { debut: Date; fin: Date }> {
  const auj = minuitAlger(now);
  const fin = new Date(auj.getTime() + J);
  return {
    aujourdhui: { debut: auj, fin },
    "7j": { debut: new Date(auj.getTime() - 6 * J), fin },
    mois: { debut: debutMoisAlger(now), fin },
    moisPrecedent: { debut: debutMoisAlger(now, -1), fin: debutMoisAlger(now) },
  };
}

/** « 2026-10-01 » (jour d'Alger) → instant UTC de son minuit. `null` si illisible. */
export function jourAlgerVersInstant(jour: string | null | undefined): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(jour ?? "");
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - H;
  return Number.isFinite(t) ? new Date(t) : null;
}

/** La date d'Alger d'un instant (« 2026-10-31 »). */
export function jourAlger(d: Date): string {
  return new Date(d.getTime() + H).toISOString().slice(0, 10);
}

/**
 * LA PÉRIODE CHOISIE — du jour `du` au jour `au` INCLUS (heure d'Alger). Par défaut, le mois en cours. Bornée à
 * 400 jours : l'écran agrège en base, mais une période sans fin n'est jamais ce qu'on demande.
 */
export function periodeChoisie(du: string | null | undefined, au: string | null | undefined, now: Date): { debut: Date; fin: Date } {
  const d = jourAlgerVersInstant(du) ?? debutMoisAlger(now);
  const a = jourAlgerVersInstant(au);
  let fin = a ? new Date(a.getTime() + J) : new Date(minuitAlger(now).getTime() + J);
  if (fin <= d) fin = new Date(d.getTime() + J);
  if (fin.getTime() - d.getTime() > 400 * J) fin = new Date(d.getTime() + 400 * J);
  return { debut: d, fin };
}

// ─────────────────────────────── Les usages ───────────────────────────────

/**
 * L'USAGE D'UN APPEL, dit en français — à partir de ce que le journal écrit (`feature`, `role`, `route`). Une
 * clé inconnue reste visible sous son nom brut : rien ne disparaît dans « autre ».
 */
export function usageDe(feature: string | null, role: string | null, route: string | null): { cle: string; libelle: string } {
  const r = (role ?? "").toLowerCase(), f = (feature ?? "").toLowerCase(), ro = (route ?? "").toLowerCase();
  if (r === "image") return { cle: "image", libelle: "Images" };
  if (r === "video") return { cle: "video", libelle: "Vidéos" };
  if (f === "voice_realtime" || r === "realtime" || r === "voix" || ro.startsWith("voice")) return { cle: "voix", libelle: "Voix (temps réel)" };
  if (r === "synthese") return { cle: "synthese", libelle: "Voix (lecture des réponses)" };
  if (r === "transcription" || r === "stt") return { cle: "transcription", libelle: "Transcription" };
  if (r === "ocr" || r === "vision") return { cle: "analyse", libelle: "Analyse de documents (OCR, vision)" };
  if (r === "routine" || r === "fil" || ro === "fil" || ro === "routine") return { cle: "arriere-plan", libelle: "Travaux en arrière-plan" };
  if (r === "redaction") return { cle: "redaction", libelle: "Rédaction, résumés, traductions" };
  if (r === "conversation") return { cle: "conversation", libelle: "Conversation" };
  if (f === "mission" || f.startsWith("mission")) return { cle: "missions", libelle: "Missions (Adam)" };
  if (f === "assistant" || f === "adam") return { cle: "adam", libelle: "Adam (assistant de l'ERP)" };
  if (r === "bulk") return { cle: "fond", libelle: "Traitements de fond (lecture, classement, plongements)" };
  if (f === "assistant_ia") return { cle: "assistant-ia", libelle: "Adventum IA — autre" };
  const brut = [f, r].filter(Boolean).join(" / ") || "non attribué";
  return { cle: `brut:${brut}`, libelle: brut };
}

// ─────────────────────────────── Les montants ───────────────────────────────

const PICO = 1_000_000n;

/** Somme exacte de montants « 0.012345 » (positifs) → « 0.024690 ». */
export function additionner(montants: readonly (string | null | undefined)[]): string {
  let micro = 0n;
  for (const m of montants) {
    const x = /^(\d+)(?:\.(\d{1,6}))?\d*$/.exec((m ?? "").trim());
    if (x) micro += BigInt(x[1]) * PICO + BigInt((x[2] ?? "").padEnd(6, "0"));
  }
  return `${micro / PICO}.${(micro % PICO).toString().padStart(6, "0")}`;
}

/** Écart signé `a - b` (« -0.000120 »). */
export function soustraire(a: string, b: string): string {
  const v = (s: string) => { const x = /^(\d+)(?:\.(\d{1,6}))?/.exec(s) ?? ["", "0", ""]; return BigInt(x[1]) * PICO + BigInt((x[2] ?? "").padEnd(6, "0")); };
  const d = v(a) - v(b);
  const abs = d < 0n ? -d : d;
  return `${d < 0n ? "-" : ""}${abs / PICO}.${(abs % PICO).toString().padStart(6, "0")}`;
}

export const totauxVides = (): Totaux => ({
  appels: 0, entree: 0, entreeCache: 0, sortie: 0, raisonnement: 0, audioEntree: 0, audioEntreeCache: 0, audioSortie: 0,
  imageEntree: 0, imageEntreeCache: 0, imageSortie: 0, recherchesWeb: 0, dureeMs: 0, pages: 0, coutUsd: "0.000000", sansTarif: 0, estimes: 0,
});

/** Jetons « affichés » d'un total : entrée + sortie (le cache, l'audio, l'image en sont des parts). */
export const jetonsDe = (t: Pick<Totaux, "entree" | "sortie">): number => t.entree + t.sortie;

// ─────────────────────────────── L'export ───────────────────────────────

export const COLONNES_EXPORT = [
  "Date et heure (Alger)", "Personne", "Usage", "Fournisseur", "Modèle", "Conversation",
  "Entrée (total)", "Entrée en cache", "Sortie (total)", "dont raisonnement",
  "Entrée audio", "Entrée audio en cache", "Sortie audio", "Entrée image", "Entrée image en cache", "Sortie image",
  "Recherches web", "Durée facturée (s)", "Pages", "Coût (USD, 6 décimales)", "Durée de l'appel (ms)", "Jetons estimés", "API Batch", "Grille tarifaire",
] as const;

export function ligneExport(a: AppelDetaille): (string | number)[] {
  const heure = new Date(new Date(a.at).getTime() + H).toISOString().replace("T", " ").slice(0, 19);
  return [
    heure, a.personne ?? "", a.usage, a.fournisseur, a.modele, a.conversation ?? "",
    a.entree, a.entreeCache, a.sortie, a.raisonnement, a.audioEntree, a.audioEntreeCache, a.audioSortie,
    a.imageEntree, a.imageEntreeCache, a.imageSortie, a.recherchesWeb, a.dureeFactureeMs / 1000, a.pages,
    a.coutUsd ?? "tarif inconnu", a.ms, a.estime ? "oui" : "non", a.lot ? "oui" : "non", a.grille ?? "",
  ];
}

/** CSV (séparateur « ; », lisible par Excel en français), BOM UTF-8 compris. */
export function versCsv(lignes: (string | number)[][]): string {
  const cell = (v: string | number) => {
    const s = String(v);
    return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return `﻿${lignes.map((l) => l.map(cell).join(";")).join("\r\n")}\r\n`;
}
