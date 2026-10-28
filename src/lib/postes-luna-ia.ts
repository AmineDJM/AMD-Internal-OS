import { askModelJson } from "@/lib/models/gateway";
import type { ModelReply } from "@/lib/models/contract";
import { aiFeatureEnabled, interrupteurIaCoupe, logAiUsage, type AiUsageInput } from "@/lib/ai-settings";
import { aiConfigured, cleModeleRequise } from "@/lib/ai";
import { wrapUntrusted } from "@/lib/comms/untrusted";
import {
  CONSIGNE_POSTES, DESCRIPTION_MAX, DESCRIPTION_MIN, lirePropositionModele, propositionVide, SCHEMA_POSTES, type RaisonPostes, type ResultatPostes,
} from "@/lib/ad-pro/postes-luna";
import { sansBloquer } from "@/lib/journal";

export type { RaisonPostes, ResultatPostes };

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LUNA PROPOSE LES POSTES D'UNE DEMANDE À PARTIR DE SA DESCRIPTION — la part SERVEUR : appeler le
 * modèle par la passerelle unique (`askModelJson`), relire, journaliser.
 *
 * HORS du domaine `ad-pro/`, comme `conseil-pieces-ia.ts` : un domaine ne parle pas aux fournisseurs
 * (`providerLeaks`). La part pure (contrat, consigne, relecture) est au domaine.
 *
 * Aucune écriture en base hors du journal d'usage : le résultat est une PROPOSITION. La personne la
 * reprend (ou non) à l'écran ; les postes se créent alors par l'action ordinaire d'ajout de poste.
 *
 * ── LUNA EST INVISIBLE QUAND IL NE PEUT RIEN ─────────────────────────────────────────────
 *
 * L'ordre des portes est celui du conseil des pièces : interrupteur général, bascule (celle de
 * l'assistant), clé du fournisseur, puis une description assez longue pour valoir un appel. Chaque
 * refus porte sa RAISON : l'écran se tait sur les abstentions (IA coupée, non configurée, texte trop
 * court) — la demande se crée normalement — et ne dit une phrase courte que sur une panne.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const FONCTION = "postes_luna" as const;
const SORTIE_MAX = 4_000;
const NATURE = "description d'une demande Ad & Pro (souvent un mail d'organisation)";


export interface DependancesPostes {
  coupee: () => Promise<boolean>;
  fonctionActive: () => Promise<boolean>;
  configure: () => boolean;
  cle: () => string | null;
  appeler: <T>(
    role: "worker",
    prompt: string,
    schema: { name: string; schema: Record<string, unknown> },
    opts: { system: string; maxOutputTokens: number; verbosity: "low" },
  ) => Promise<{ data: T | null; reply: ModelReply }>;
  journaliser: (u: AiUsageInput) => Promise<void>;
}

const REELLES: DependancesPostes = {
  coupee: () => interrupteurIaCoupe(),
  fonctionActive: () => aiFeatureEnabled(FONCTION),
  configure: () => aiConfigured(),
  cle: () => cleModeleRequise(),
  appeler: (role, prompt, schema, opts) => askModelJson(role, prompt, schema, opts),
  journaliser: (u) => logAiUsage(u),
};

const refus = (raison: RaisonPostes, error: string): ResultatPostes => ({ ok: false, raison, error });

const JOURS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];

/** « 2026-10-19 (lundi) » — le repère des dates relatives (« le 5 novembre », « le lendemain »). */
export function aujourdhuiLisible(d: Date): string {
  return `${d.toISOString().slice(0, 10)} (${JOURS[d.getUTCDay()]})`;
}

export interface EntreePostes {
  description: string;
  /** La nature de la demande, pour le contexte (« événement »). */
  natureDemande: string;
  userId: string;
  aujourdhui?: Date;
}

export async function proposerPostesParModele(e: EntreePostes, deps: DependancesPostes = REELLES): Promise<ResultatPostes> {
  if (await deps.coupee()) return refus("IA_COUPEE", "IA coupée.");
  if (!(await deps.fonctionActive())) return refus("DESACTIVEE", "Assistant désactivé.");
  if (!deps.configure()) return refus("NON_CONFIGUREE", "IA non configurée.");
  const description = (e.description ?? "").trim().slice(0, DESCRIPTION_MAX);
  if (description.replace(/\s+/g, " ").length < DESCRIPTION_MIN) return refus("TROP_COURT", "Description trop courte.");

  const prompt = [
    `Aujourd'hui : ${aujourdhuiLisible(e.aujourdhui ?? new Date())}.`,
    `Nature de la demande : ${e.natureDemande}.`,
    "",
    wrapUntrusted(description, { source: "formulaire de demande", kind: NATURE, maxChars: DESCRIPTION_MAX + 64 }),
    "",
    "Tire de cette description l'événement et ses postes, dans la forme imposée.",
  ].join("\n");

  const t0 = Date.now();
  let resultat: { data: unknown; reply: ModelReply } | null = null;
  let panne = false;
  try {
    resultat = await deps.appeler<unknown>("worker", prompt, SCHEMA_POSTES as unknown as { name: string; schema: Record<string, unknown> }, {
      system: CONSIGNE_POSTES, maxOutputTokens: SORTIE_MAX, verbosity: "low",
    });
  } catch {
    panne = true;
  }
  const reply = resultat?.reply ?? null;
  const usage = reply?.usage;
  const proposition = reply?.ok && resultat?.data != null ? lirePropositionModele(resultat.data, description) : null;
  const errorCode: string | null = panne ? "exception"
    : !reply?.ok ? (reply?.error ?? "error")
    : resultat?.data == null ? "invalid_json"
    : proposition === null ? "relecture"
    : null;

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
  }).catch(sansBloquer("postes-luna-ia.proposerPostesParModele.journaliser"));

  if (proposition) return propositionVide(proposition) ? refus("RIEN", "Rien à proposer.") : { ok: true, proposition };
  if (reply && !reply.ok && !reply.configured) return refus("NON_CONFIGUREE", "IA non configurée.");
  if (panne || !reply?.ok) return refus("ECHEC", "Luna n'a pas pu lire la description.");
  return refus("INEXPLOITABLE", "Luna n'a pas pu lire la description.");
}
