import { censurerTexte } from "../filtre-confidentialite";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES VISUELS DE L'ASSISTANT IA (lot K2, décision 0032) — les RÈGLES, pures.
 *
 *   • trois natures : IMAGE (gpt-image, générée ou modifiée), VIDEO (modèle vidéo, en arrière-plan),
 *     VIDEO_DONNEES (graphique animé rendu par le serveur ; les chiffres viennent des outils, jamais du modèle) ;
 *   • une CONSIGNE passe le filtre de confidentialité avant de partir : une rémunération, une coordonnée
 *     bancaire, un n° de pièce, un repère « ⟦Sn⟧ » ou un mot du dossier RH, et RIEN ne part (refus dit) ;
 *   • le COÛT RÉEL d'une génération se calcule ici (jetons rendus par le fournisseur × grille publique ;
 *     secondes × tarif pour la vidéo) — c'est lui qui va au journal et qui se compare au plafond du mois.
 *
 * Module PUR (aucun accès base, aucun réseau) : testé seul, lu par l'écran d'administration comme par le moteur.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const NATURES_VISUEL = ["IMAGE", "VIDEO", "VIDEO_DONNEES"] as const;
export type NatureVisuel = (typeof NATURES_VISUEL)[number];
export const STATUTS_VISUEL = ["EN_FILE", "EN_COURS", "PRET", "ECHEC"] as const;
export type StatutVisuel = (typeof STATUTS_VISUEL)[number];

/**
 * LES MODÈLES D'IMAGE — mesurés le 31/10/2026 sur la clé de production (3 essais chacun, même consigne, qualité
 * « medium », 1024²) : `sunburst` et `flare` rendent le même nombre de jetons (≈ 75 en entrée, 439 en sortie) donc le
 * même coût (≈ 0,0135 $) ; `sunburst` est plus riche en détails (photo), `flare` plus rapide (9–13 s contre 14–18 s).
 * Défaut : `sunburst` (la qualité d'abord) ; `flare` reste réglable. `gemini-3-pro-image` n'est qu'un SECOURS, pris
 * seulement quand OpenAI REFUSE (erreur ou refus de contenu) — et la réponse le dit.
 */
export const MODELES_IMAGE = ["gpt-image-2.5-sunburst", "gpt-image-2.5-flare", "gpt-image-2"] as const;
export const MODELE_IMAGE_DEFAUT = "gpt-image-2.5-sunburst";
export const MODELE_IMAGE_SECOURS = "gemini-3-pro-image";
/**
 * LES MODÈLES VIDÉO — `sora-2-pro` (qualité) et `sora-2` (moitié moins cher, plus court). Constat du 31/10/2026 : la
 * clé les liste avec `shutdown_date: 2026-09-24` et `/v1/videos` répond 404 — le fournisseur ne les sert plus.
 * L'outil le VÉRIFIE avant de lancer quoi que ce soit (`etatModeleVideo`), et le dit.
 */
export const MODELES_VIDEO = ["sora-2-pro", "sora-2"] as const;
export const MODELE_VIDEO_DEFAUT = "sora-2-pro";

/** Grille publique (dollars par million de jetons) — gpt-image 2.5 (flare et sunburst identiques) et 2. */
export const TARIF_IMAGE_OPENAI = { texteEntreeParM: 5, imageEntreeParM: 8, imageSortieParM: 30 } as const;
/** Grille publique de `gemini-3-pro-image` : 2 $ le million en entrée, 120 $ le million de jetons d'image en sortie. */
export const TARIF_IMAGE_GEMINI = { texteEntreeParM: 2, imageEntreeParM: 2, imageSortieParM: 120 } as const;
/** Sora (720p), dollars par seconde rendue. */
export const TARIF_VIDEO_PAR_SECONDE: Record<string, number> = { "sora-2": 0.1, "sora-2-pro": 0.3 };

export interface UsageImage {
  texteEntree: number;
  imageEntree: number;
  imageSortie: number;
}

const arrondi = (v: number) => Math.round(v * 1_000_000) / 1_000_000;

/** Le coût réel d'une image, à partir des jetons RENDUS par le fournisseur. */
export function coutImageUsd(u: UsageImage, fournisseur: "openai" | "gemini" = "openai"): number {
  const t = fournisseur === "gemini" ? TARIF_IMAGE_GEMINI : TARIF_IMAGE_OPENAI;
  return arrondi((u.texteEntree * t.texteEntreeParM + u.imageEntree * t.imageEntreeParM + u.imageSortie * t.imageSortieParM) / 1_000_000);
}

/** Le coût d'une vidéo : secondes rendues × tarif du modèle ; `null` pour un modèle sans tarif connu (jamais deviné). */
export function coutVideoUsd(modele: string, secondes: number): number | null {
  const t = TARIF_VIDEO_PAR_SECONDE[modele];
  return t == null ? null : arrondi(t * Math.max(0, secondes));
}

/** L'usage OpenAI (`usage` de `/images/*`) ramené à nos trois compteurs. */
export function usageOpenAI(usage: unknown): UsageImage {
  const u = (usage ?? {}) as { input_tokens?: number; output_tokens?: number; input_tokens_details?: { text_tokens?: number; image_tokens?: number } };
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);
  const d = u.input_tokens_details;
  const texte = d ? n(d.text_tokens) : n(u.input_tokens);
  return { texteEntree: texte, imageEntree: d ? n(d.image_tokens) : 0, imageSortie: n(u.output_tokens) };
}

/** L'usage Gemini (`usageMetadata`) : le prompt en entrée, les jetons du candidat (l'image) en sortie. */
export function usageGemini(usage: unknown): UsageImage {
  const u = (usage ?? {}) as { promptTokenCount?: number; candidatesTokenCount?: number };
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);
  return { texteEntree: n(u.promptTokenCount), imageEntree: 0, imageSortie: n(u.candidatesTokenCount) };
}

// ─────────────────────────────── LA CONSIGNE, AVANT DE PARTIR ───────────────────────────────

/**
 * Les mots d'un dossier confidentiel : une image n'a aucune raison d'en porter. Le filtre de texte attrape les VALEURS
 * (un IBAN, un montant de salaire) ; ces mots-ci attrapent l'intention (« fais une affiche du salaire de Karim »).
 */
const MOTS_CONFIDENTIELS = /\b(salaires?|r[ée]mun[ée]rations?|paie|bulletins? de paie|iban|rib|coordonn[ée]es? bancaires?|passeports?|carte d'identit[ée]|cni|nin|num[ée]ro de s[ée]curit[ée] sociale|dossier m[ée]dical|diagnostic d[eu] (?:salari[ée]|collaborat))\b/i;

export const CONSIGNE_MAX = 3_000;

export type ConsigneFiltree = { ok: true; texte: string } | { ok: false; raison: string };

/** La consigne d'une image ou d'une vidéo, telle qu'elle peut partir — ou le refus, dit. */
export function filtrerConsigne(brut: unknown): ConsigneFiltree {
  const texte = typeof brut === "string" ? brut.replace(/\s+/g, " ").trim().slice(0, CONSIGNE_MAX) : "";
  if (!texte) return { ok: false, raison: "Décrivez ce que l'image doit montrer." };
  if (/⟦S\d+⟧/.test(texte) || censurerTexte(texte).censure || MOTS_CONFIDENTIELS.test(texte)) {
    return {
      ok: false,
      raison: "Cette description porte une donnée confidentielle (rémunération, coordonnée bancaire, pièce d'identité, dossier RH) : "
        + "elle ne part pas à un modèle d'image. Reformulez sans elle.",
    };
  }
  return { ok: true, texte };
}

/** La charte Adventum, ajoutée à la consigne quand la personne la demande (ou l'accepte). */
export const CHARTE_ADVENTUM = "Charte graphique Adventum Pharma : palette bleu profond #2C59A7 et sarcelle #2B6E82 sur fond blanc ou très clair, "
  + "accents gris ardoise, style sobre, professionnel et lumineux d'un laboratoire pharmaceutique ; typographie moderne sans empattement ; "
  + "aucun logo inventé, aucun texte parasite ; tout texte visible en français, parfaitement orthographié.";

export function consigneAvecCharte(consigne: string, charte: boolean): string {
  return charte ? `${consigne}\n\n${CHARTE_ADVENTUM}` : consigne;
}

// ─────────────────────────────── LES RÉGLAGES DU SUPER ADMIN ───────────────────────────────

export interface ReglagesVisuels {
  imagesActives: boolean;
  imagesPlafondUsd: number;
  modeleImage: string;
  videosActives: boolean;
  videosPlafondUsd: number;
  modeleVideo: string;
  videoSecondesMax: number;
  donneesActives: boolean;
}

export const REGLAGES_VISUELS_DEFAUT: ReglagesVisuels = {
  imagesActives: true, imagesPlafondUsd: 20, modeleImage: MODELE_IMAGE_DEFAUT,
  videosActives: false, videosPlafondUsd: 30, modeleVideo: MODELE_VIDEO_DEFAUT, videoSecondesMax: 8,
  donneesActives: true,
};

/** Les durées qu'accepte le fournisseur vidéo (secondes). */
export const DUREES_VIDEO = [4, 8, 12] as const;

const borne = (v: unknown, min: number, max: number, defaut: number) => {
  const n = Number(typeof v === "string" ? v.replace(",", ".") : v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n * 100) / 100)) : defaut;
};
const oui = (v: unknown, defaut: boolean) => (typeof v === "boolean" ? v : v === "on" || v === "true" ? true : v === "false" ? false : defaut);

/** Une ligne de réglages (base ou formulaire) ramenée dans les bornes. */
export function normaliserReglagesVisuels(r: Record<string, unknown> | null | undefined): ReglagesVisuels {
  const d = REGLAGES_VISUELS_DEFAUT;
  if (!r) return d;
  const modeleImage = typeof r.visuelsModeleImage === "string" && (MODELES_IMAGE as readonly string[]).includes(r.visuelsModeleImage) ? r.visuelsModeleImage : d.modeleImage;
  const modeleVideo = typeof r.visuelsModeleVideo === "string" && (MODELES_VIDEO as readonly string[]).includes(r.visuelsModeleVideo) ? r.visuelsModeleVideo : d.modeleVideo;
  const secondes = Number(r.visuelsVideoSecondesMax);
  return {
    imagesActives: oui(r.visuelsImagesActives, d.imagesActives),
    imagesPlafondUsd: borne(r.visuelsImagesPlafondUsd, 0, 10_000, d.imagesPlafondUsd),
    modeleImage,
    videosActives: oui(r.visuelsVideosActives, d.videosActives),
    videosPlafondUsd: borne(r.visuelsVideosPlafondUsd, 0, 10_000, d.videosPlafondUsd),
    modeleVideo,
    videoSecondesMax: (DUREES_VIDEO as readonly number[]).includes(secondes) ? secondes : d.videoSecondesMax,
    donneesActives: oui(r.visuelsDonneesActives, d.donneesActives),
  };
}

/** La durée réellement demandée au fournisseur : la plus proche des durées acceptées, sous le maximum réglé. */
export function dureeVideo(demandee: unknown, max: number): number {
  const n = Number(demandee);
  const permises = DUREES_VIDEO.filter((d) => d <= max);
  if (!permises.length) return DUREES_VIDEO[0];
  if (!Number.isFinite(n) || n <= 0) return permises[permises.length - 1] >= 8 && permises.includes(8) ? 8 : permises[permises.length - 1];
  return permises.reduce((m, d) => (Math.abs(d - n) < Math.abs(m - n) ? d : m), permises[0]);
}

export function refusCoupe(nature: NatureVisuel): string {
  const quoi = nature === "IMAGE" ? "La génération d'images" : nature === "VIDEO" ? "La génération de vidéos" : "Les vidéos de données";
  return `${quoi} est coupée par le Super Admin (Administration › IA). Rien n'a été généré.`;
}

export function refusPlafond(nature: NatureVisuel, plafondUsd: number, depenseUsd: number): string {
  const quoi = nature === "IMAGE" ? "images" : "vidéos";
  return `Le plafond mensuel des ${quoi} générées est atteint (${depenseUsd.toFixed(2)} $ dépensés sur ${plafondUsd.toFixed(2)} $ ce mois-ci). `
    + "Rien n'a été généré : le Super Admin peut relever le plafond en Administration › IA.";
}

// ─────────────────────────────── CE QUE VOIT L'ÉCRAN ───────────────────────────────

/** L'état d'un visuel tel que la carte le lit (route `/api/assistant-ia/visuels/[id]`). */
export interface VueVisuel {
  id: string;
  nature: NatureVisuel;
  titre: string;
  etat: "en-file" | "en-cours" | "pret" | "echec";
  progression: number;
  src: string | null;
  telecharger: string | null;
  drive: string | null;
  mime: string | null;
  detail: string | null;
  erreur: string | null;
}

const ETATS: Record<StatutVisuel, VueVisuel["etat"]> = { EN_FILE: "en-file", EN_COURS: "en-cours", PRET: "pret", ECHEC: "echec" };

export const routeVisuel = (id: string) => `/api/assistant-ia/visuels/${id}`;

export function vueVisuel(v: {
  id: string; nature: string; titre: string; statut: string; progression: number; driveNodeId: string | null; mime: string | null;
  modele: string | null; secondes: number | null; coutUsd: number | null; erreur: string | null; fournisseur: string | null;
}): VueVisuel {
  const nature = (NATURES_VISUEL as readonly string[]).includes(v.nature) ? (v.nature as NatureVisuel) : "IMAGE";
  const etat = ETATS[v.statut as StatutVisuel] ?? "en-file";
  const pret = etat === "pret" && !!v.driveNodeId;
  const morceaux = [
    v.modele ? (v.fournisseur === "gemini" ? `${v.modele} (secours : OpenAI a refusé)` : v.modele) : nature === "VIDEO_DONNEES" ? "rendu par le serveur" : null,
    v.secondes ? `${String(Math.round(v.secondes * 10) / 10).replace(".", ",")} s` : null,
    v.coutUsd != null && v.coutUsd > 0 ? `${v.coutUsd.toFixed(v.coutUsd < 0.1 ? 4 : 2).replace(".", ",")} $` : null,
  ].filter(Boolean);
  return {
    id: v.id, nature, titre: v.titre, etat,
    progression: Math.max(0, Math.min(100, Math.round(v.progression))),
    src: pret ? `${routeVisuel(v.id)}/media` : null,
    telecharger: pret ? `${routeVisuel(v.id)}/media?dl=1` : null,
    drive: pret ? `/drive/${v.driveNodeId}` : null,
    mime: v.mime,
    detail: morceaux.length ? morceaux.join(" · ") : null,
    erreur: etat === "echec" ? v.erreur ?? "La génération n'a pas abouti." : null,
  };
}

/** Le nom du fichier au Drive : lisible, sans caractère interdit, unique par l'identifiant. */
export function nomDeFichierVisuel(titre: string, id: string, extension: "png" | "mp4" | "jpg" | "webp"): string {
  const base = titre.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "Visuel";
  return `${base} (${id.slice(-6)}).${extension}`;
}

export const DOSSIER_VISUELS = "Visuels de l'assistant";
