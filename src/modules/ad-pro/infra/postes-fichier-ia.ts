import { askModelJson, type ModelReply } from "@/lib/models/gateway";
import { aiFeatureEnabled, interrupteurIaCoupe, logAiUsage, REFUS_IA_COUPEE, type AiUsageInput } from "@/lib/ai-settings";
import { aiConfigured, cleModeleRequise } from "@/lib/ai";
import { neutralizeBoundaries, wrapUntrusted } from "@/lib/comms/untrusted";
import { lireFichierUneFois } from "@/lib/pieces-lues/lecture-fichier";
import { moteurLuna } from "@/lib/pieces-lues/moteur-luna";
import { moteurParDefaut } from "@/lib/regulatory/intelligence/extract/texte-ou-ocr";
import { FORMATS_LUS, PAGES_MAX, TAILLE_MAX_OCTETS } from "@/lib/pieces-lues/formats";
import { sansBloquer } from "@/lib/journal";
import {
  CONSIGNE_POSTES_FICHIER, lirePostesDuModele, SCHEMA_POSTES_FICHIER, TEXTE_MAX, TEXTE_MIN, type PosteDuFichier,
} from "../domaine/postes-fichier";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES POSTES D'UNE DEMANDE LUS DANS UN FICHIER — la part SERVEUR (recette 24/11/2026) : lire le fichier
 * par le lecteur commun, appeler le modèle par la passerelle unique (`askModelJson`), relire, journaliser.
 *
 * Le même chemin que `postes-luna-ia.ts` (les postes lus dans la DESCRIPTION d'une demande) et que le
 * conseil des pièces (`conseil-pieces-ia.ts`, qui lit déjà un fichier) : la même fonction de l'IA
 * (`postes_luna`, la bascule de l'assistant), la même passerelle, le même modèle (rôle `worker`). Rien
 * de neuf côté fournisseur.
 *
 * ── L'ORDRE DES PORTES ────────────────────────────────────────────────────────────────────
 *
 *   1. l'INTERRUPTEUR GÉNÉRAL, la BASCULE, la CLÉ — avant de garder quoi que ce soit : une IA coupée ne
 *      laisse pas derrière elle un fichier déposé « pour rien » ;
 *   2. le FORMAT et la TAILLE que le lecteur sait lire (`FORMATS_LUS`) ;
 *   3. le fichier est GARDÉ sur la demande (`garder`, fourni par l'action) — AVANT la lecture : une lecture
 *      qui échoue n'efface pas le dépôt, et la phrase le dit (`garde`) ;
 *   4. la LECTURE (une fois par empreinte ; un scan se lit par Luna, le moteur local en repli — §118.200) ;
 *   5. l'APPEL, la RELECTURE stricte (`lirePostesDuModele`), le JOURNAL.
 *
 * Le texte lu voyage sous `wrapUntrusted` : c'est une DONNÉE (§104.10), jamais une consigne. Les dépendances
 * s'injectent : un banc ne pose jamais pour de vrai les bascules (lignes globales) ni ne lit un vrai scan.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const FONCTION = "postes_luna" as const;
const SORTIE_MAX = 4_000;
const NATURE = "document joint à une demande Ad & Pro (cahier des charges)";
const NOM_MAX = 120;

export type RaisonPostesFichier =
  | "IA_COUPEE" | "DESACTIVEE" | "NON_CONFIGUREE" | "FORMAT" | "VIDE" | "TAILLE"
  | "GARDE" | "LECTURE" | "TEXTE_ILLISIBLE" | "ECHEC" | "INEXPLOITABLE";

export type ResultatPostesFichier =
  | { ok: true; postes: PosteDuFichier[]; remarques: string[]; coupe: boolean; scan: boolean }
  /** `garde` : le fichier est déjà sur la demande quand le refus arrive — la phrase de l'écran le dit. */
  | { ok: false; raison: RaisonPostesFichier; error: string; garde: boolean };

export type LectureDuFichier =
  | { ok: true; texte: string; scan: boolean }
  | { ok: false; error: string };

export interface DependancesPostesFichier {
  coupee: () => Promise<boolean>;
  fonctionActive: () => Promise<boolean>;
  configure: () => boolean;
  cle: () => string | null;
  /** Lit le texte du fichier par le lecteur commun (une fois par empreinte). */
  lire: (a: { octets: Buffer; ext: string; userId: string }) => Promise<LectureDuFichier>;
  appeler: <T>(
    role: "worker",
    prompt: string,
    schema: { name: string; schema: Record<string, unknown> },
    opts: { system: string; maxOutputTokens: number; verbosity: "low" },
  ) => Promise<{ data: T | null; reply: ModelReply }>;
  journaliser: (u: AiUsageInput) => Promise<void>;
}

async function lireParLeLecteurCommun(a: { octets: Buffer; ext: string; userId: string }): Promise<LectureDuFichier> {
  // UN SCAN SE LIT PAR LUNA (§118.200) : le texte part de toute façon chez le même fournisseur ; sans Luna, le moteur local.
  const lu = await lireFichierUneFois(
    { octets: a.octets, ext: a.ext, cloud: false, maxPages: PAGES_MAX, userId: a.userId },
    { ocr: moteurLuna(moteurParDefaut) },
  );
  if (!lu.ok) return { ok: false, error: lu.message };
  return { ok: true, texte: lu.lecture.texte, scan: lu.lecture.methode === "ocr" };
}

const REELLES: DependancesPostesFichier = {
  coupee: () => interrupteurIaCoupe(),
  fonctionActive: () => aiFeatureEnabled(FONCTION),
  configure: () => aiConfigured(),
  cle: () => cleModeleRequise(),
  lire: lireParLeLecteurCommun,
  appeler: (role, prompt, schema, opts) => askModelJson(role, prompt, schema, opts),
  journaliser: (u) => logAiUsage(u),
};

const PHRASE_DESACTIVEE = "L'assistant IA est désactivé (Administration › Contrôle de l'IA) : ajoutez les postes un par un.";
const PHRASE_NON_CONFIGUREE = "L'IA n'est pas configurée sur ce serveur : ajoutez les postes un par un.";
const PHRASE_VIDE = "Fichier vide : il n'y a rien à lire.";
const PHRASE_ILLISIBLE = "Aucun texte n'a pu être lu dans ce fichier (scan blanc ou image sans écrit) : saisissez les postes vous-même.";
const PHRASE_PANNE = "Le service d'IA n'a pas répondu : réessayez dans un instant, ou saisissez les postes vous-même.";
const PHRASE_INEXPLOITABLE = "La réponse de l'IA n'a pas la forme attendue : réessayez, ou saisissez les postes vous-même.";

function extensionDe(nom: string): string {
  const i = nom.lastIndexOf(".");
  return i >= 0 ? nom.slice(i + 1).trim().toLowerCase() : "";
}

function nomSur(nom: string): string {
  return neutralizeBoundaries(nom).replace(/\s+/g, " ").trim().slice(0, NOM_MAX) || "fichier sans nom";
}

const mo = (octets: number) => `${(octets / (1024 * 1024)).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} Mo`;

export interface EntreePostesFichier {
  octets: Buffer;
  nomFichier: string;
  userId: string;
  /** La nature de la demande, pour le contexte (« sponsoring », « congrès national »…). */
  natureDemande: string;
  /** Garde le fichier sur la demande — appelé APRÈS les portes et le format, AVANT la lecture. */
  garder: () => Promise<{ ok: true } | { ok: false; error: string }>;
}

/** LE CHEMIN : portes → format → garder → lire → appeler → relire → journaliser. */
export async function proposerPostesDuFichier(e: EntreePostesFichier, deps: DependancesPostesFichier = REELLES): Promise<ResultatPostesFichier> {
  let garde = false;
  const refus = (raison: RaisonPostesFichier, error: string): ResultatPostesFichier => ({ ok: false, raison, error, garde });

  if (await deps.coupee()) return refus("IA_COUPEE", `${REFUS_IA_COUPEE} Ajoutez les postes un par un.`);
  if (!(await deps.fonctionActive())) return refus("DESACTIVEE", PHRASE_DESACTIVEE);
  if (!deps.configure()) return refus("NON_CONFIGUREE", PHRASE_NON_CONFIGUREE);

  const ext = extensionDe(e.nomFichier ?? "");
  if (!(FORMATS_LUS as readonly string[]).includes(ext)) {
    return refus("FORMAT", `Ce format${ext ? ` (.${ext})` : ""} ne se lit pas : déposez un PDF, une image (PNG, JPEG, WebP, TIFF), un Word (.docx) ou un Excel.`);
  }
  if (e.octets.length === 0) return refus("VIDE", PHRASE_VIDE);
  if (e.octets.length > TAILLE_MAX_OCTETS) return refus("TAILLE", `Fichier trop lourd (${mo(e.octets.length)}) : au plus ${mo(TAILLE_MAX_OCTETS)} pour une lecture par l'IA.`);

  const g = await e.garder();
  if (!g.ok) return refus("GARDE", g.error);
  garde = true;

  const lu = await deps.lire({ octets: e.octets, ext, userId: e.userId });
  if (!lu.ok) return refus("LECTURE", lu.error);
  const texteComplet = lu.texte.trim();
  if (texteComplet.replace(/\s+/g, "").length < TEXTE_MIN) return refus("TEXTE_ILLISIBLE", PHRASE_ILLISIBLE);
  const coupe = texteComplet.length > TEXTE_MAX;
  const texte = coupe ? texteComplet.slice(0, TEXTE_MAX) : texteComplet;

  const prompt = [
    `Nature de la demande : ${e.natureDemande}.`,
    lu.scan ? "NOTE — écrite par l'ERP : ce texte a été reconnu sur un scan ; un chiffre douteux ne se recopie pas." : "NOTE — écrite par l'ERP : texte natif du fichier.",
    coupe ? `EXTRAIT : seuls les ${TEXTE_MAX.toLocaleString("fr-FR")} premiers caractères sur ${texteComplet.length.toLocaleString("fr-FR")} te sont transmis.` : "Le texte du document t'est transmis en entier.",
    "",
    wrapUntrusted(texte, { source: nomSur(e.nomFichier), kind: NATURE, maxChars: texte.length + 64 }),
    "",
    "Tire de ce document les postes de dépense, dans la forme imposée.",
  ].join("\n");

  const t0 = Date.now();
  let resultat: { data: unknown; reply: ModelReply } | null = null;
  let panne = false;
  try {
    resultat = await deps.appeler<unknown>("worker", prompt, SCHEMA_POSTES_FICHIER as unknown as { name: string; schema: Record<string, unknown> }, {
      system: CONSIGNE_POSTES_FICHIER, maxOutputTokens: SORTIE_MAX, verbosity: "low",
    });
  } catch {
    panne = true;
  }
  const reply = resultat?.reply ?? null;
  const usage = reply?.usage;
  // Les montants se vérifient contre le texte TRANSMIS : un chiffre que le modèle n'a pas vu ne peut pas en venir.
  const lecture = reply?.ok && resultat?.data != null ? lirePostesDuModele(resultat.data, texte) : null;
  const errorCode: string | null = panne ? "exception"
    : !reply?.ok ? (reply?.error ?? "error")
    : resultat?.data == null ? "invalid_json"
    : lecture === null ? "relecture"
    : null;

  // LA RELECTURE AVANT LE JOURNAL : une réponse illisible est un échec de la fonction (§118.51).
  await deps.journaliser({
    feature: FONCTION,
    // `cle()` rend l'une des variables du registre : son préfixe dit le fournisseur, sans recopier le nom de la clé ici.
    provider: usage?.provider ?? (deps.cle()?.startsWith("ANTHROPIC") ? "anthropic" : "openai"),
    model: usage?.model ?? null,
    userId: e.userId,
    ok: errorCode === null,
    latencyMs: Date.now() - t0,
    errorCode,
    llmCalls: 1,
    inputTokens: usage?.inputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    cachedInputTokens: usage?.cachedInputTokens ?? null,
    reasoningTokens: usage?.reasoningTokens ?? null,
    costUsd: usage?.costUsd ?? null,
  }).catch(sansBloquer("postes-fichier-ia.proposerPostesDuFichier.journaliser"));

  if (lecture) return { ok: true, postes: lecture.postes, remarques: lecture.remarques, coupe, scan: lu.scan };
  if (reply && !reply.ok && !reply.configured) return refus("NON_CONFIGUREE", PHRASE_NON_CONFIGUREE);
  if (panne || !reply?.ok) return refus("ECHEC", PHRASE_PANNE);
  return refus("INEXPLOITABLE", PHRASE_INEXPLOITABLE);
}
