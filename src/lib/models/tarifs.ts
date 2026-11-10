/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA GRILLE DES TARIFS DES FOURNISSEURS D'IA — datée, modèle par modèle, type de jeton par type
 * de jeton (lot K8, décision 0035). MODULE PUR, sans import : l'écran « Consommation » (navigateur)
 * et les journaux (serveur) lisent la MÊME grille et le MÊME calcul.
 *
 * ── CE QUE DIT CHAQUE LIGNE ──────────────────────────────────────────────────────────────
 *
 * Dollars par MILLION de jetons, écrits en CHAÎNES décimales (« 0.05 ») : un prix n'est jamais
 * un flottant. Les champs absents ne sont PAS gratuits : un appel qui consomme un type de jeton
 * sans prix a un coût INCONNU (`null`), et l'écran l'affiche ainsi — jamais 0 $.
 *
 * ── LE RAISONNEMENT ──────────────────────────────────────────────────────────────────────
 *
 * Les jetons de raisonnement sont facturés AU TARIF DE SORTIE et sont DÉJÀ COMPTÉS dans les
 * jetons de sortie que rendent les API (`output_tokens` inclut `reasoning_tokens`). Ils sont
 * journalisés à part pour être VUS, jamais ajoutés une seconde fois au coût.
 *
 * ── LES CONVENTIONS DU JOURNAL (`ModelCallLog`) ──────────────────────────────────────────
 *
 * `inputTokens` = TOUTE l'entrée (texte + audio + image), `cachedInputTokens` = toute l'entrée lue
 * en cache ; `audioInputTokens`, `imageInputTokens`, `cachedAudioInputTokens` en sont des PARTS.
 * Même règle en sortie (`audioOutputTokens`, `imageOutputTokens` ⊂ `outputTokens`). Le texte est
 * ce qui reste. Les unités hors jetons (secondes d'audio ou de vidéo, pages, recherches web) ont
 * leurs propres colonnes et leurs propres prix.
 *
 * ── LE CALCUL ────────────────────────────────────────────────────────────────────────────
 *
 * En ENTIERS (BigInt) au pico-dollar (10⁻¹² $), arrondi une seule fois, au micro-dollar
 * (10⁻⁶ $, demi vers le haut) : la colonne `costUsd` est un `Decimal(12, 6)` et reçoit la chaîne
 * exacte. Aucune somme de flottants n'entre dans un coût.
 *
 * ── LES SOURCES (relevées le 31/10/2026) ─────────────────────────────────────────────────
 *
 *   OpenAI    https://developers.openai.com/api/docs/pricing (Standard, ≤ 272 k jetons d'entrée)
 *   Gemini    https://ai.google.dev/gemini-api/docs/pricing (palier payant, « Last updated 2026-10-30 »)
 *   Anthropic https://platform.claude.com/docs/en/about-claude/pricing
 *
 * Non vérifiés, donc ABSENTS (coût inconnu à l'écran) : Mistral OCR (le site ne publie pas le
 * prix à la page ; les relais disent 1 à 2 $ les 1 000 pages), MiMo (journaux d'avant le
 * 28/10/2026), ElevenLabs (aucun appel serveur). Sora (`sora-2`, `sora-2-pro`) : arrêté par le
 * fournisseur le 24/09/2026, il ne figure plus sur la grille ; son dernier tarif connu (0,10 $ et
 * 0,30 $ la seconde en 720p, relevé au lot K2) est gardé pour relire les journaux d'avant.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const GRILLE_RELEVEE_LE = "2026-10-31";

export type FournisseurIa = "openai" | "anthropic" | "gemini" | "mistral" | "mimo" | "elevenlabs";

export interface TarifModele {
  fournisseur: FournisseurIa;
  /** Dollars par million de jetons (chaîne décimale exacte). */
  entree?: string;
  entreeCache?: string;
  sortie?: string;
  audioEntree?: string;
  audioEntreeCache?: string;
  audioSortie?: string;
  imageEntree?: string;
  imageEntreeCache?: string;
  imageSortie?: string;
  /** Dollars par MINUTE d'audio (transcription, GPT-Live) — facturée à la seconde. */
  parMinute?: string;
  /** Dollars par SECONDE de vidéo rendue. */
  parSeconde?: string;
  /** Dollars par PAGE (OCR). */
  parPage?: string;
  /** D'où vient la ligne, et quand elle a été lue. */
  source: string;
  verifieLe: string;
  note?: string;
}

const OPENAI = "https://developers.openai.com/api/docs/pricing";
const GEMINI = "https://ai.google.dev/gemini-api/docs/pricing";
const ANTHROPIC = "https://platform.claude.com/docs/en/about-claude/pricing";
const LE = GRILLE_RELEVEE_LE;

const texte = (entree: string, entreeCache: string | undefined, sortie: string, source = OPENAI, fournisseur: FournisseurIa = "openai"): TarifModele =>
  ({ fournisseur, entree, ...(entreeCache ? { entreeCache } : {}), sortie, source, verifieLe: LE });

/** LA GRILLE — un modèle, une ligne. Un suffixe de date (`gpt-5.6-terra-2026-03-01`) retombe sur sa base. */
export const GRILLE_TARIFS: Readonly<Record<string, TarifModele>> = {
  // ── OpenAI, texte (Responses / Chat) ──
  "gpt-6-astra": texte("10", "1", "50"),
  "gpt-6.1-sol": texte("2", "0.1", "10"),
  "gpt-6.1-terra": texte("1", "0.05", "5"),
  "gpt-6-sol": texte("2", "0.2", "10"),
  "gpt-6-luna": texte("0.1", "0.01", "0.5"),
  "gpt-5.6-sol": texte("4", "0.4", "20"),
  "gpt-5.6-terra": texte("2", "0.2", "12"),
  "gpt-5.6-luna": texte("0.2", "0.02", "1.2"),
  "gpt-5.5": texte("5", "0.5", "30"),
  "gpt-5.4": texte("2.5", "0.25", "15"),
  "gpt-5.4-mini": texte("0.75", "0.075", "4.5"),
  "gpt-5.4-nano": texte("0.2", "0.02", "1.25"),
  "gpt-5.2": texte("1.75", "0.175", "14"),
  "gpt-5.1": texte("1.25", "0.125", "10"),
  "gpt-5": texte("1.25", "0.125", "10"),
  "gpt-5-mini": texte("0.25", "0.025", "2"),
  "gpt-5-nano": texte("0.05", "0.005", "0.4"),
  "gpt-4.1": texte("2", "0.5", "8"),
  "gpt-4.1-mini": texte("0.4", "0.1", "1.6"),
  "gpt-4.1-nano": texte("0.1", "0.025", "0.4"),
  "gpt-4o": texte("2.5", "1.25", "10"),
  "gpt-4o-mini": texte("0.15", "0.075", "0.6"),
  "o3": texte("2", "0.5", "8"),
  "o4-mini": texte("1.1", "0.275", "4.4"),

  // ── OpenAI, temps réel (jetons texte, audio, image) ──
  "gpt-realtime-2.1": {
    fournisseur: "openai", entree: "4", entreeCache: "0.4", sortie: "24",
    audioEntree: "32", audioEntreeCache: "0.4", audioSortie: "64", imageEntree: "5", imageEntreeCache: "0.5", source: OPENAI, verifieLe: LE,
  },
  "gpt-realtime-2.1-mini": {
    fournisseur: "openai", entree: "0.6", entreeCache: "0.06", sortie: "2.4",
    audioEntree: "10", audioEntreeCache: "0.3", audioSortie: "20", imageEntree: "0.8", imageEntreeCache: "0.08", source: OPENAI, verifieLe: LE,
  },
  "gpt-realtime-2": {
    fournisseur: "openai", entree: "4", entreeCache: "0.4", sortie: "24",
    audioEntree: "32", audioEntreeCache: "0.4", audioSortie: "64", imageEntree: "5", imageEntreeCache: "0.5", source: OPENAI, verifieLe: LE,
  },
  "gpt-realtime": {
    fournisseur: "openai", entree: "4", entreeCache: "0.4", sortie: "16",
    audioEntree: "32", audioEntreeCache: "0.4", audioSortie: "64", imageEntree: "5", imageEntreeCache: "0.5", source: OPENAI, verifieLe: LE,
  },
  "gpt-realtime-mini": {
    fournisseur: "openai", entree: "0.6", entreeCache: "0.06", sortie: "2.4",
    audioEntree: "10", audioEntreeCache: "0.3", audioSortie: "20", imageEntree: "0.8", imageEntreeCache: "0.08", source: OPENAI, verifieLe: LE,
  },
  /** GPT-Live : 0,05 $ la minute, facturée à la seconde ; le modèle et les outils du fond se paient à part. */
  "gpt-live-1": { fournisseur: "openai", parMinute: "0.05", source: OPENAI, verifieLe: LE, note: "session facturée à la durée" },

  // ── OpenAI, voix (synthèse, transcription) ──
  "gpt-4o-mini-tts": { fournisseur: "openai", entree: "0.6", audioSortie: "12", source: OPENAI, verifieLe: LE },
  "gpt-transcribe": { fournisseur: "openai", parMinute: "0.0045", source: OPENAI, verifieLe: LE },
  "gpt-4o-transcribe": { fournisseur: "openai", entree: "2.5", audioEntree: "2.5", sortie: "10", parMinute: "0.006", source: OPENAI, verifieLe: LE },
  "gpt-4o-mini-transcribe": { fournisseur: "openai", entree: "1.25", audioEntree: "1.25", sortie: "5", parMinute: "0.003", source: OPENAI, verifieLe: LE },
  "whisper-1": { fournisseur: "openai", parMinute: "0.006", source: OPENAI, verifieLe: LE },

  // ── OpenAI, images (jetons texte et image) ──
  "gpt-image-2.5-sunburst": { fournisseur: "openai", entree: "5", entreeCache: "1.25", imageEntree: "8", imageEntreeCache: "2", imageSortie: "30", source: OPENAI, verifieLe: LE },
  "gpt-image-2.5-flare": { fournisseur: "openai", entree: "5", entreeCache: "1.25", imageEntree: "8", imageEntreeCache: "2", imageSortie: "30", source: OPENAI, verifieLe: LE },
  "gpt-image-2": { fournisseur: "openai", entree: "5", entreeCache: "1.25", imageEntree: "8", imageEntreeCache: "2", imageSortie: "30", source: OPENAI, verifieLe: LE },
  "gpt-image-1.5": { fournisseur: "openai", entree: "5", entreeCache: "1.25", sortie: "10", imageEntree: "8", imageEntreeCache: "2", imageSortie: "32", source: OPENAI, verifieLe: LE },
  "gpt-image-1-mini": { fournisseur: "openai", entree: "2", entreeCache: "0.2", imageEntree: "2.5", imageEntreeCache: "0.25", imageSortie: "8", source: OPENAI, verifieLe: LE },

  // ── OpenAI, vidéo (Sora — arrêté le 24/09/2026, gardé pour relire les journaux d'avant) ──
  "sora-2": { fournisseur: "openai", parSeconde: "0.1", source: "grille OpenAI relevée au lot K2 (modèle arrêté le 2026-09-24)", verifieLe: "2026-09-01" },
  "sora-2-pro": { fournisseur: "openai", parSeconde: "0.3", source: "grille OpenAI relevée au lot K2 (modèle arrêté le 2026-09-24)", verifieLe: "2026-09-01" },

  // ── OpenAI, plongements ──
  "text-embedding-3-small": { fournisseur: "openai", entree: "0.02", source: OPENAI, verifieLe: LE },
  "text-embedding-3-large": { fournisseur: "openai", entree: "0.13", source: OPENAI, verifieLe: LE },

  // ── Gemini ──
  "gemini-3-pro-image": { fournisseur: "gemini", entree: "2", imageEntree: "2", sortie: "12", imageSortie: "120", source: GEMINI, verifieLe: LE },

  // ── Anthropic (le repli d'Adam) — l'écriture en cache n'est pas rapportée par la passerelle : lue au tarif d'entrée ──
  "claude-opus-5-5": texte("4", "0.2", "20", ANTHROPIC, "anthropic"),
  "claude-sonnet-4-6": texte("3", "0.3", "15", ANTHROPIC, "anthropic"),
  "claude-haiku-4-5": texte("1", "0.1", "5", ANTHROPIC, "anthropic"),
};

/** La recherche web de Responses : 10 $ les 1 000 appels (les jetons de contenu au tarif du modèle). */
export const PRIX_RECHERCHE_WEB = "0.01";

/** Le tarif d'un modèle — exact, ou par sa base datée (`gpt-5.6-terra-2026-03-01`). `null` = inconnu. */
export function tarifDuModele(modele: string | null | undefined): TarifModele | null {
  const m = (modele ?? "").trim().toLowerCase();
  if (!m) return null;
  if (GRILLE_TARIFS[m]) return GRILLE_TARIFS[m];
  const base = Object.keys(GRILLE_TARIFS)
    .filter((k) => m.startsWith(`${k}-`) && /^\d{4}-\d{2}-\d{2}$/.test(m.slice(k.length + 1)))
    .sort((a, b) => b.length - a.length)[0];
  return base ? GRILLE_TARIFS[base] : null;
}

// ─────────────────────────────── L'USAGE D'UN APPEL ───────────────────────────────

export interface UsageAppel {
  /** Toute l'entrée (texte + audio + image). */
  entree: number;
  /** Toute l'entrée lue en cache — une PART de `entree`. */
  entreeCache?: number;
  /** Toute la sortie (raisonnement compris). */
  sortie: number;
  raisonnement?: number;
  audioEntree?: number;
  audioEntreeCache?: number;
  audioSortie?: number;
  imageEntree?: number;
  imageEntreeCache?: number;
  imageSortie?: number;
  /** Durée facturée (audio, GPT-Live, vidéo), en millisecondes. */
  dureeMs?: number;
  pages?: number;
  recherchesWeb?: number;
  /**
   * Les jetons sont des ÉQUIVALENTS (10 par seconde d'audio, pour le plafond), pas des jetons rendus par l'API :
   * ils ne se facturent pas — la durée, elle, se facture.
   */
  equivalents?: boolean;
  /** Appel de l'API Batch : chaque poste à MOITIÉ PRIX (grille OpenAI, « Batch »). */
  lot?: boolean;
}

/** Les postes d'une facture — chacun en micro-dollars (chaîne « 0.000123 »), ou `null` s'il manque son prix. */
export const POSTES = [
  "texteEntree", "texteEntreeCache", "texteSortie", "audioEntree", "audioEntreeCache", "audioSortie",
  "imageEntree", "imageEntreeCache", "imageSortie", "duree", "pages", "recherchesWeb",
] as const;
export type Poste = (typeof POSTES)[number];

export const LIBELLE_POSTE: Record<Poste, string> = {
  texteEntree: "Entrée texte", texteEntreeCache: "Entrée texte en cache", texteSortie: "Sortie texte (raisonnement compris)",
  audioEntree: "Entrée audio", audioEntreeCache: "Entrée audio en cache", audioSortie: "Sortie audio",
  imageEntree: "Entrée image", imageEntreeCache: "Entrée image en cache", imageSortie: "Sortie image",
  duree: "Durée (audio, voix, vidéo)", pages: "Pages (OCR)", recherchesWeb: "Recherches web",
};

export interface Facture {
  /** Le total, en dollars, au micro-dollar (« 0.012345 ») — `null` quand un poste consommé n'a pas de prix. */
  usd: string | null;
  /** Les postes consommés sans prix connu. */
  sansPrix: Poste[];
  /** Chaque poste consommé, en dollars au micro-dollar. */
  postes: Partial<Record<Poste, string>>;
}

// ─────────────────────────────── L'ARITHMÉTIQUE EXACTE ───────────────────────────────

const PICO_PAR_DOLLAR = 1_000_000_000_000n;

/** « 0.05 » → 50 000 micro-dollars (le prix par million, en 10⁻⁶ $). Rejette tout ce qui n'est pas un décimal positif. */
export function enMicro(prix: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(prix.trim());
  if (!m) throw new Error(`prix illisible : ${prix}`);
  return BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0") || "0");
}

/** Pico-dollars → chaîne en dollars au micro-dollar, arrondi demi vers le haut (« 0.000013 »). */
export function picoEnDollars(pico: bigint): string {
  const micro = (pico + 500_000n) / 1_000_000n;
  const ent = micro / 1_000_000n;
  const dec = (micro % 1_000_000n).toString().padStart(6, "0");
  return `${ent}.${dec}`;
}

/** Somme de montants en dollars (« 0.000013 ») — exacte, au micro-dollar. */
export function sommeDollars(montants: readonly (string | null | undefined)[]): string {
  let micro = 0n;
  for (const m of montants) if (m) micro += enMicro(m.startsWith("-") ? "0" : m);
  return picoEnDollars(micro * 1_000_000n);
}

const entier = (v: number | undefined): bigint => BigInt(Math.max(0, Math.round(Number.isFinite(v ?? 0) ? (v ?? 0) : 0)));

/**
 * LA FACTURE D'UN APPEL — poste par poste, en entiers. `tarif` absent : tout poste consommé est « sans prix ».
 * Les PARTS (cache, audio, image) sont bornées à leur total : un compteur incohérent ne fabrique pas de jetons.
 */
export function facturer(u: UsageAppel, tarif: TarifModele | null, prixRecherche: string = PRIX_RECHERCHE_WEB): Facture {
  const entree = entier(u.entree), sortie = entier(u.sortie);
  const min = (a: bigint, b: bigint) => (a < b ? a : b);
  const audioIn = min(entier(u.audioEntree), entree);
  const imageIn = min(entier(u.imageEntree), entree - audioIn);
  const texteIn = entree - audioIn - imageIn;
  const audioInCache = min(entier(u.audioEntreeCache), audioIn);
  const imageInCache = min(entier(u.imageEntreeCache), imageIn);
  const texteInCache = min(entier(Math.max(0, (u.entreeCache ?? 0) - (u.audioEntreeCache ?? 0) - (u.imageEntreeCache ?? 0))), texteIn);
  const audioOut = min(entier(u.audioSortie), sortie);
  const imageOut = min(entier(u.imageSortie), sortie - audioOut);
  const texteOut = sortie - audioOut - imageOut;

  const sansPrix: Poste[] = [];
  const postes: Partial<Record<Poste, string>> = {};
  let total = 0n;
  const ajouter = (poste: Poste, picoPlein: bigint) => {
    const pico = u.lot ? (picoPlein + 1n) / 2n : picoPlein;
    postes[poste] = picoEnDollars(pico);
    total += pico;
  };

  /** quantité × prix-par-million (jetons) ; `prix` absent → poste sans prix (ou repli). */
  const parJetons = (poste: Poste, quantite: bigint, prix: string | undefined) => {
    if (quantite === 0n) return;
    if (prix == null) { sansPrix.push(poste); return; }
    ajouter(poste, quantite * enMicro(prix)); // jetons × (10⁻⁶ $ par million) = 10⁻¹² $
  };
  const t = tarif;
  const parDuree = !!(t?.parMinute || t?.parSeconde) && (!!u.equivalents || !t || !hasJetons(t) || entree + sortie === 0n);
  // Une entrée en cache sans tarif réduit se facture au tarif plein (surestimer un coût connu, jamais inventer une remise).
  // Un modèle facturé SEULEMENT à la durée (Whisper, `gpt-transcribe`, GPT-Live) : ses jetons ne se facturent pas.
  const factureALaDuree = !!t && !hasJetons(t) && !!(t.parMinute || t.parSeconde);
  if (!u.equivalents && !factureALaDuree) {
    parJetons("texteEntree", texteIn - texteInCache, t?.entree);
    parJetons("texteEntreeCache", texteInCache, t?.entreeCache ?? t?.entree);
    parJetons("texteSortie", texteOut, t?.sortie);
    parJetons("audioEntree", audioIn - audioInCache, t?.audioEntree);
    parJetons("audioEntreeCache", audioInCache, t?.audioEntreeCache ?? t?.audioEntree);
    parJetons("audioSortie", audioOut, t?.audioSortie);
    parJetons("imageEntree", imageIn - imageInCache, t?.imageEntree);
    parJetons("imageEntreeCache", imageInCache, t?.imageEntreeCache ?? t?.imageEntree);
    parJetons("imageSortie", imageOut, t?.imageSortie);
  }

  // La durée : à la minute (facturée à la seconde, ici à la milliseconde) ou à la seconde (vidéo).
  const ms = entier(u.dureeMs);
  if (ms > 0n && parDuree && t) {
    // prix-par-minute en 10⁻⁶ $ × ms × 10⁶ / 60 000 = 10⁻¹² $ (division entière arrondie).
    const pico = t.parMinute
      ? (enMicro(t.parMinute) * ms * 1_000_000n + 30_000n) / 60_000n
      : (enMicro(t.parSeconde as string) * ms * 1_000_000n + 500n) / 1_000n;
    ajouter("duree", pico);
  } else if ((ms > 0n && (!t || entree + sortie === 0n)) || u.equivalents || factureALaDuree) {
    sansPrix.push("duree");
  }

  const pages = entier(u.pages);
  if (pages > 0n) {
    if (t?.parPage) ajouter("pages", pages * enMicro(t.parPage) * 1_000_000n);
    else sansPrix.push("pages");
  }
  const recherches = entier(u.recherchesWeb);
  if (recherches > 0n) {
    const pico = recherches * enMicro(prixRecherche) * 1_000_000n;
    postes.recherchesWeb = picoEnDollars(pico);
    total += pico;
  }
  // Un modèle absent de la grille n'a JAMAIS un coût de zéro : il est inconnu, même sans rien consommé.
  return { usd: sansPrix.length || !tarif ? null : picoEnDollars(total), sansPrix, postes };
}

function hasJetons(t: TarifModele): boolean {
  return !!(t.entree || t.sortie || t.audioEntree || t.audioSortie || t.imageEntree || t.imageSortie);
}

/** Le coût d'un appel en dollars (chaîne au micro-dollar), `null` si un poste consommé n'a pas de prix. */
export function coutDeLAppel(modele: string, u: UsageAppel): string | null {
  return facturer(u, tarifDuModele(modele)).usd;
}

/** Affichage : « 0,012345 $ » (6 décimales, exact) — et l'arrondi lisible à côté (« ≈ 0,01 $ »). */
export function dollarsExacts(usd: string | null): string {
  if (usd == null) return "tarif inconnu";
  const [e, d = ""] = usd.split(".");
  return `${Number(e).toLocaleString("fr-FR").replace(/ | /g, " ")},${d.padEnd(6, "0").slice(0, 6)} $`;
}

export function dollarsArrondis(usd: string | null): string {
  if (usd == null) return "tarif inconnu";
  const v = Number(usd);
  if (v === 0) return "0 $";
  if (v < 0.01) return "< 0,01 $";
  return `≈ ${v.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/ | /g, " ")} $`;
}

/**
 * L'USAGE D'UNE TRANSCRIPTION (`/audio/transcriptions`) — ce que l'API REND : des jetons pour les modèles
 * `gpt-*-transcribe` (`usage.type = "tokens"`, audio et texte ventilés), une durée pour Whisper
 * (`usage.type = "duration"`, ou `duration` du `verbose_json`). Rien de rendu : `equivalents` (coût inconnu).
 */
export function usageTranscription(data: unknown): {
  inputTokens: number; outputTokens: number; audioInputTokens: number; durationMs: number; equivalents: boolean;
} {
  const d = (data ?? {}) as {
    duration?: number;
    usage?: { type?: string; seconds?: number; input_tokens?: number; output_tokens?: number; input_token_details?: { audio_tokens?: number; text_tokens?: number } };
  };
  const nb = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
  const u = d.usage;
  const secondes = nb(u?.seconds) ?? nb(d.duration);
  if (u && nb(u.input_tokens) != null) {
    const entree = Math.round(nb(u.input_tokens) ?? 0);
    const audio = nb(u.input_token_details?.audio_tokens);
    return {
      inputTokens: entree, outputTokens: Math.round(nb(u.output_tokens) ?? 0),
      audioInputTokens: Math.min(entree, Math.round(audio ?? entree)), durationMs: secondes != null ? Math.round(secondes * 1000) : 0, equivalents: false,
    };
  }
  if (secondes != null) return { inputTokens: 0, outputTokens: 0, audioInputTokens: 0, durationMs: Math.round(secondes * 1000), equivalents: false };
  return { inputTokens: 0, outputTokens: 0, audioInputTokens: 0, durationMs: 0, equivalents: true };
}
