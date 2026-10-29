import { askModelJson } from "@/lib/models/gateway";
import type { ModelReply } from "@/lib/models/contract";
import { aiFeatureEnabled, interrupteurIaCoupe, logAiUsage, REFUS_IA_COUPEE, type AiUsageInput } from "@/lib/ai-settings";
import { aiConfigured, cleModeleRequise } from "@/lib/ai";
import { phraseIaNonConfiguree } from "@/lib/ia/cle-manquante";
import { neutralizeBoundaries, wrapUntrusted } from "@/lib/comms/untrusted";
import { BUDGET_CARACTERES, decouperPourLecture } from "@/lib/pch/extraction";
import { lireFichierUneFois } from "@/lib/pieces-lues/lecture-fichier";
import { moteurLuna } from "@/lib/pieces-lues/moteur-luna";
import { moteurParDefaut } from "@/lib/regulatory/intelligence/extract/texte-ou-ocr";
import { noteDeMethode, refusFormatDePiece, refusTailleDePiece } from "@/lib/pieces-lues/phrases";
import { FORMATS_LUS, PAGES_MAX, TAILLE_MAX_OCTETS } from "@/lib/pieces-lues/service";
import { CARACTERES_MIN, phraseCoupeDuTexte } from "@/lib/lecture-pieces-ia";
import {
  composerContexte, CONSIGNE_CONSEIL, lireConseilModele, SCHEMA_CONSEIL, type ConseilPiece, type ContexteConseil,
} from "@/modules/ad-pro/partage";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LUNA CONSEILLE OÙ RANGER UNE PIÈCE — la part SERVEUR : lire la pièce, appeler le modèle.
 *
 * Il vit HORS du domaine `ad-pro/`, exprès — comme `lecture-pieces-ia.ts` : un domaine ne parle pas
 * aux fournisseurs (`providerLeaks`, `platform/domains.ts`). La part pure, elle, est au domaine.
 *
 * Aucune écriture en base hors du journal d'usage et du cache de lecture (`LecturePiece`, celui de
 * tout le dépôt) : le résultat est un CONSEIL, jamais un fait, et rien ne bouge la pièce.
 *
 * ── L'ORDRE DES PORTES (le même que `lecture-pieces-ia.ts`) ────────────────────────────────
 *
 *   1. l'INTERRUPTEUR GÉNÉRAL — avant tout, avant même la clé ;
 *   2. la BASCULE « conseil des pièces » (Centre de contrôle IA) ;
 *   3. la CLÉ du fournisseur ;
 *   4. la CONFIDENTIALITÉ : une pièce non INTERNE ne sort pas de l'ERP — ni texte ni nom ;
 *   5. le FORMAT, la TAILLE, puis un TEXTE à lire.
 *
 * Chaque refus est un `{ ok: false, raison, error }` qui DIT pourquoi : une absence de conseil
 * n'est jamais « bien placé » (§104.15, §118.25). Le texte lu voyage sous `wrapUntrusted` : c'est
 * une DONNÉE (§104.10) ; le contexte (postes, emplacement) et la note de méthode viennent de NOTRE
 * code et restent hors de l'enclos.
 *
 * ── UN SCAN SE LIT PAR LUNA, PAS PAR UN OCR EXTERNE (§118.200) ────────────────────────────
 *
 * Le lecteur commun (`lireFichierUneFois`, une fois par empreinte) est appelé avec `cloud: false` ;
 * quand la pièce peut sortir et que le conseil est ouvert, un scan se lit par Luna (le texte
 * partira de toute façon chez le même fournisseur), sinon par le moteur local.
 *
 * Les dépendances s'injectent : les bascules sont des lignes GLOBALES qu'un banc ne pose jamais
 * pour de vrai (§118.132), et un banc ne lit pas de vrai scan.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const FONCTION = "conseil_pieces" as const;
const POUR_QUOI = "le conseil de rangement des pièces (Luna)";
const NATURE = "pièce déposée sur une demande Ad & Pro";
const SORTIE_MAX = 2_000;
const NOM_MAX = 120;

export type RaisonConseil =
  | "IA_COUPEE" | "DESACTIVEE" | "NON_CONFIGUREE" | "CONFIDENTIELLE"
  | "FORMAT" | "TAILLE" | "VIDE" | "LECTURE" | "TEXTE_ILLISIBLE"
  | "ECHEC" | "INEXPLOITABLE";

export type ResultatConseil =
  | { ok: true; conseil: ConseilPiece; noteMethode: string; coupe: string | null }
  | { ok: false; raison: RaisonConseil; error: string };

export interface TexteLu { ok: true; texte: string; noteMethode: string }
export type LectureConseil = TexteLu | { ok: false; error: string };

export interface DependancesConseil {
  coupee: () => Promise<boolean>;
  fonctionActive: () => Promise<boolean>;
  configure: () => boolean;
  cle: () => string | null;
  /** Lit le texte de la pièce par le lecteur commun. */
  lire: (a: { octets: Buffer; ext: string; parLuna: boolean; userId: string }) => Promise<LectureConseil>;
  appeler: <T>(
    role: "worker",
    prompt: string,
    schema: { name: string; schema: Record<string, unknown> },
    opts: { system: string; maxOutputTokens: number; verbosity: "low" },
  ) => Promise<{ data: T | null; reply: ModelReply }>;
  journaliser: (u: AiUsageInput) => Promise<void>;
}

async function lireParLeLecteurCommun(a: { octets: Buffer; ext: string; parLuna: boolean; userId: string }): Promise<LectureConseil> {
  const lu = await lireFichierUneFois(
    { octets: a.octets, ext: a.ext, cloud: false, maxPages: PAGES_MAX, userId: a.userId },
    a.parLuna ? { ocr: moteurLuna(moteurParDefaut) } : {},
  );
  if (!lu.ok) return { ok: false, error: lu.message };
  return { ok: true, texte: lu.lecture.texte, noteMethode: noteDeMethode(lu.lecture) };
}

const REELLES: DependancesConseil = {
  coupee: () => interrupteurIaCoupe(),
  fonctionActive: () => aiFeatureEnabled(FONCTION),
  configure: () => aiConfigured(),
  cle: () => cleModeleRequise(),
  lire: lireParLeLecteurCommun,
  appeler: (role, prompt, schema, opts) => askModelJson(role, prompt, schema, opts),
  journaliser: (u) => logAiUsage(u),
};

export const PHRASE_DESACTIVEE = "Le conseil de rangement de Luna est désactivé (Administration › Contrôle de l'IA) : vérifiez vous-même l'emplacement de la pièce.";
export const PHRASE_CONFIDENTIELLE = "Pièce confidentielle : son contenu ne sort pas de l'ERP, Luna ne la lit pas — vérifiez vous-même son emplacement.";
const PHRASE_VIDE = "Fichier vide : il n'y a rien à lire.";
const PHRASE_ILLISIBLE = "Aucun texte n'a pu être lu dans cette pièce : Luna ne peut pas dire où elle va — vérifiez vous-même son emplacement.";
const PHRASE_PANNE = "Le service d'IA n'a pas répondu : pas de conseil pour cette pièce — réessayez dans un instant.";
const PHRASE_REFUS = "Le service d'IA a refusé la demande : pas de conseil pour cette pièce.";
const PHRASE_INEXPLOITABLE = "La réponse de Luna n'a pas la forme attendue : pas de conseil pour cette pièce — vérifiez vous-même son emplacement.";

const refus = (raison: RaisonConseil, error: string): ResultatConseil => ({ ok: false, raison, error });

function extensionDe(nom: string): string {
  const i = nom.lastIndexOf(".");
  return i >= 0 ? nom.slice(i + 1).trim().toLowerCase() : "";
}

function nomSur(nom: string): string {
  return neutralizeBoundaries(nom).replace(/\s+/g, " ").trim().slice(0, NOM_MAX) || "fichier sans nom";
}

export interface EntreeConseil {
  octets: Buffer;
  contexte: ContexteConseil;
  /** Faux dès que la pièce n'est pas INTERNE : rien ne sort de l'ERP. */
  confidentielle: boolean;
  userId: string;
}

/**
 * LE CHEMIN : interrupteur → bascule → clé → confidentialité → format → lecture → appel →
 * relecture stricte → journal.
 */
export async function conseillerParModele(e: EntreeConseil, deps: DependancesConseil = REELLES): Promise<ResultatConseil> {
  if (await deps.coupee()) return refus("IA_COUPEE", `${REFUS_IA_COUPEE} Pas de conseil de Luna pour cette pièce.`);
  if (!(await deps.fonctionActive())) return refus("DESACTIVEE", PHRASE_DESACTIVEE);
  if (!deps.configure()) return refus("NON_CONFIGUREE", phraseIaNonConfiguree(deps.cle(), POUR_QUOI));
  if (e.confidentielle) return refus("CONFIDENTIELLE", PHRASE_CONFIDENTIELLE);

  const nomFichier = (e.contexte.nomFichier ?? "").trim();
  const ext = extensionDe(nomFichier);
  if (!(FORMATS_LUS as readonly string[]).includes(ext)) return refus("FORMAT", refusFormatDePiece(ext, FORMATS_LUS));
  if (e.octets.length === 0) return refus("VIDE", PHRASE_VIDE);
  if (e.octets.length > TAILLE_MAX_OCTETS) return refus("TAILLE", refusTailleDePiece(e.octets.length, TAILLE_MAX_OCTETS));

  const lu = await deps.lire({ octets: e.octets, ext, parLuna: true, userId: e.userId });
  if (!lu.ok) return refus("LECTURE", lu.error);
  if (lu.texte.replace(/\s+/g, "").length < CARACTERES_MIN) return refus("TEXTE_ILLISIBLE", PHRASE_ILLISIBLE);

  const decoupe = decouperPourLecture(lu.texte, BUDGET_CARACTERES);
  const note = neutralizeBoundaries(lu.noteMethode).replace(/\s+/g, " ").trim().slice(0, 1_200);
  const prompt = [
    composerContexte(e.contexte),
    "",
    `NOTE DE MÉTHODE — écrite par l'ERP, pas par le document : ${note || "non fournie."}`,
    decoupe.coupe ? `EXTRAIT : seuls les ${decoupe.lu.length.toLocaleString("fr-FR")} premiers caractères sur ${decoupe.total.toLocaleString("fr-FR")} te sont transmis.` : "Le texte de la pièce t'est transmis en entier.",
    "",
    wrapUntrusted(decoupe.lu, { source: nomSur(nomFichier), kind: NATURE, maxChars: decoupe.lu.length * 2 + 64 }),
    "",
    "Dis si cette pièce est au bon endroit, dans la forme imposée.",
  ].join("\n");

  const t0 = Date.now();
  let resultat: { data: unknown; reply: ModelReply } | null = null;
  let panne = false;
  try {
    resultat = await deps.appeler<unknown>("worker", prompt, SCHEMA_CONSEIL as unknown as { name: string; schema: Record<string, unknown> }, {
      system: CONSIGNE_CONSEIL, maxOutputTokens: SORTIE_MAX, verbosity: "low",
    });
  } catch {
    panne = true;
  }
  const reply = resultat?.reply ?? null;
  const usage = reply?.usage;
  const conseil = reply?.ok && resultat?.data != null ? lireConseilModele(resultat.data, e.contexte) : null;
  const errorCode: string | null = panne ? "exception"
    : !reply?.ok ? (reply?.error ?? "error")
    : resultat?.data == null ? "invalid_json"
    : conseil === null ? "relecture"
    : null;

  // LA RELECTURE AVANT LE JOURNAL : une réponse illisible est un échec de la fonction (§118.51).
  await deps.journaliser({
    feature: FONCTION,
    provider: usage?.provider ?? (deps.cle() === "ANTHROPIC_API_KEY" ? "anthropic" : "openai"),
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
  });

  if (conseil) return { ok: true, conseil, noteMethode: lu.noteMethode, coupe: phraseCoupeDuTexte(decoupe.total, decoupe.lu.length) };
  if (reply && !reply.ok && !reply.configured) return refus("NON_CONFIGUREE", phraseIaNonConfiguree(deps.cle(), POUR_QUOI));
  if (panne) return refus("ECHEC", PHRASE_PANNE);
  if (!reply?.ok) return refus("ECHEC", PHRASE_REFUS);
  return refus("INEXPLOITABLE", PHRASE_INEXPLOITABLE);
}
