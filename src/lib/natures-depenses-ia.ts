import { askModelJson } from "@/lib/models/gateway";
import type { ModelReply } from "@/lib/models/contract";
import { aiFeatureEnabled, interrupteurIaCoupe, logAiUsage, type AiUsageInput } from "@/lib/ai-settings";
import { aiConfigured, cleModeleRequise } from "@/lib/ai";
import { wrapUntrusted } from "@/lib/comms/untrusted";
import {
  CONSIGNE_NATURES, LIGNES_MAX_PAR_APPEL, SCHEMA_NATURES, devinerParMotsCles, lireClassement, promptNatures,
  type CategorieConnue, type PropositionNature,
} from "@/lib/general-means/natures";
import { sansBloquer } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'IA RANGE LES DÉPENSES DES MOYENS GÉNÉRAUX PAR NATURE — la part SERVEUR : appeler le modèle par la passerelle
 * unique (`askModelJson`), relire, journaliser (Direction, 10/2026).
 *
 * HORS du domaine `general-means/`, comme `postes-luna-ia.ts` : un domaine ne parle pas aux fournisseurs
 * (`providerLeaks`). La part pure (catégories par défaut, consigne, relecture) est au domaine (`natures.ts`).
 *
 * Aucune écriture en base hors du journal d'usage : le résultat est une PROPOSITION par ligne — une catégorie
 * existante, ou le nom d'une nouvelle. Créer la catégorie et l'imputer est l'affaire de l'appelant.
 *
 * ── TOUJOURS UNE RÉPONSE ────────────────────────────────────────────────────────────────────
 *
 * IA coupée, non configurée, en panne ou trop lente : chaque ligne laissée sans proposition passe par les mots-clés
 * des catégories par défaut (`devinerParMotsCles`). On range moins finement — on ne bloque jamais une saisie.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const FONCTION = "nature_depense" as const;
const SORTIE_MAX = 3_000;
/** Au-delà, la personne attend : on se replie sur les mots-clés plutôt que de la faire patienter. */
const DELAI_MAX_MS = 12_000;

export interface DependancesNatures {
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

const REELLES: DependancesNatures = {
  coupee: () => interrupteurIaCoupe(),
  fonctionActive: () => aiFeatureEnabled(FONCTION),
  configure: () => aiConfigured(),
  cle: () => cleModeleRequise(),
  appeler: (role, prompt, schema, opts) => askModelJson(role, prompt, schema, opts),
  journaliser: (u) => logAiUsage(u),
};

export interface EntreeNatures {
  /** Les libellés à ranger, dans l'ordre (un par ligne du ticket). */
  libelles: string[];
  /** L'objet de la dépense, quand il est donné — un contexte, pas une ligne. */
  objet?: string | null;
  categories: CategorieConnue[];
  userId: string;
}

/** Une proposition par libellé ; `ia` dit si le modèle a répondu (sinon : mots-clés seuls). */
export interface ResultatNatures {
  propositions: (PropositionNature | null)[];
  ia: boolean;
}

async function appelerLeModele(e: EntreeNatures, libelles: string[], deps: DependancesNatures): Promise<(PropositionNature | null)[] | null> {
  if (await deps.coupee()) return null;
  if (!(await deps.fonctionActive())) return null;
  if (!deps.configure()) return null;

  const { liste, lignes } = promptNatures(libelles, e.categories);
  const prompt = [
    "Catégories existantes (identifiant — nom) :",
    liste,
    "",
    ...(e.objet?.trim() ? [`Objet de la dépense (contexte) : ${e.objet.trim().slice(0, 200)}`, ""] : []),
    wrapUntrusted(lignes, { source: "formulaire de dépense", kind: "libellés des articles d'un ticket", maxChars: 12_000 }),
    "",
    "Range chaque ligne (index = son numéro), dans la forme imposée.",
  ].join("\n");

  const t0 = Date.now();
  let resultat: { data: unknown; reply: ModelReply } | null = null;
  let panne = false;
  let delaiDepasse = false;
  let minuteur: ReturnType<typeof setTimeout> | undefined;
  try {
    resultat = await Promise.race([
      deps.appeler<unknown>("worker", prompt, SCHEMA_NATURES as unknown as { name: string; schema: Record<string, unknown> }, {
        system: CONSIGNE_NATURES, maxOutputTokens: SORTIE_MAX, verbosity: "low",
      }),
      new Promise<null>((resolve) => { minuteur = setTimeout(() => { delaiDepasse = true; resolve(null); }, DELAI_MAX_MS); }),
    ]);
  } catch {
    panne = true;
  } finally {
    clearTimeout(minuteur);
  }
  const reply = resultat?.reply ?? null;
  const usage = reply?.usage;
  const lues = reply?.ok && resultat?.data != null ? lireClassement(resultat.data, libelles.length, e.categories) : null;
  const errorCode: string | null = delaiDepasse ? "timeout" : panne ? "exception"
    : !reply?.ok ? (reply?.error ?? "error")
    : resultat?.data == null ? "invalid_json"
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
  }).catch(sansBloquer("natures-depenses-ia.appelerLeModele.journaliser"));

  return lues;
}

/**
 * RANGE des libellés : le modèle d'abord (par paquets de 40), puis les mots-clés pour ce qu'il a laissé sans réponse.
 * Une ligne sans proposition reste `null` — elle s'affichera « Non classé », sans rien inventer.
 */
export async function classerLibelles(e: EntreeNatures, deps: DependancesNatures = REELLES): Promise<ResultatNatures> {
  const libelles = e.libelles.map((l) => String(l ?? "").trim());
  const propositions: (PropositionNature | null)[] = libelles.map(() => null);
  let ia = false;
  const aClasser = libelles.map((l, i) => ({ l, i })).filter((x) => x.l.length > 0);
  for (let k = 0; k < aClasser.length; k += LIGNES_MAX_PAR_APPEL) {
    const paquet = aClasser.slice(k, k + LIGNES_MAX_PAR_APPEL);
    const lues = await appelerLeModele(e, paquet.map((x) => x.l), deps);
    if (!lues) break; // coupée, non configurée ou en panne : inutile d'insister sur les paquets suivants
    ia = true;
    paquet.forEach((x, j) => { propositions[x.i] = lues[j] ?? null; });
  }
  libelles.forEach((l, i) => {
    if (propositions[i] || !l) return;
    const id = devinerParMotsCles(l, e.categories);
    if (id) propositions[i] = { categorieId: id };
  });
  return { propositions, ia };
}
