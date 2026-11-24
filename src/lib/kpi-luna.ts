import { callLuna, lunaConfigured, lunaModel, type LunaResult } from "@/lib/openai-luna";
import { aiFeatureEnabled, interrupteurIaCoupe, logAiUsage } from "@/lib/ai-settings";
import { neutralizeBoundaries, wrapUntrusted } from "@/lib/comms/untrusted";
import {
  CONSIGNE_COMMENTAIRE, CONSIGNE_DEFINITIONS, CONSIGNE_EVALUATION, SCHEMA_COMMENTAIRE, SCHEMA_DEFINITIONS, SCHEMA_EVALUATION,
  commentaireDeSecours, lireCommentaire, lireReponseDefinitions, lireReponseEvaluation, propositionsDeSecours,
  type KpiPourCommentaire, type ReponseDefinitions, type SourceEvaluation,
} from "@/lib/kpi/luna-pur";
import type { DefinitionKpi, NiveauGrille } from "@/lib/kpi/definition";
import { noterProposition } from "@/modules/pilotage/api-ecriture";
import {
  CONSIGNE_CIBLE, SCHEMA_CIBLE, entreePourLuna, historiqueSuffisant, lireReponseCibles, type CibleLuna, type EntreeCible,
} from "@/lib/kpi/luna-cible";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LUNA ET LES KPI — la part qui PARLE AU FOURNISSEUR. Elle vit en haut de `src/lib`, hors de tout domaine, comme
 * `recrutement-diffusion.ts` : un domaine ne parle pas aux fournisseurs (`platform/domains.test.ts`). Les consignes,
 * schémas et relectures sont purs, dans `kpi/luna-pur.ts`.
 *
 * L'ordre des portes : interrupteur général → bascule (« assistant ») → clé → appel borné (25 s) → relecture stricte →
 * journal (`logAiUsage`). Chaque échec retombe sur un repli DÉTERMINISTE (définitions reconnues par mots-clés,
 * commentaire écrit depuis les chiffres) — sauf la note d'un KPI évalué : sans preuve ancrée, il n'y a pas de
 * proposition, et le manager note lui-même. Luna ne produit jamais le chiffre d'un KPI.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const FONCTION = "kpi" as const;
const DELAI_MS = 25_000;

type Porte = { ouverte: true } | { ouverte: false; raison: string };

async function porte(): Promise<Porte> {
  if (await interrupteurIaCoupe()) return { ouverte: false, raison: "L'IA est coupée (Administration › Contrôle de l'IA)." };
  if (!(await aiFeatureEnabled(FONCTION))) return { ouverte: false, raison: "Luna est désactivée pour les KPI (Contrôle de l'IA)." };
  if (!lunaConfigured()) return { ouverte: false, raison: "Luna n'est pas configurée (clé du fournisseur absente)." };
  return { ouverte: true };
}

async function appeler<T>(entree: { system: string; user: string; schema: { name: string; schema: Record<string, unknown> }; max: number }, userId: string): Promise<{ data: unknown; ok: boolean }> {
  const t0 = Date.now();
  let r: LunaResult<T> | null = null;
  let panne = false;
  try {
    r = await Promise.race([
      callLuna<T>({ system: entree.system, user: entree.user, jsonSchema: entree.schema, maxOutputTokens: entree.max, model: lunaModel() }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), DELAI_MS)),
    ]);
  } catch {
    panne = true;
  }
  let data: unknown = r?.data;
  if (r?.ok && data === undefined) { try { data = JSON.parse(r.text); } catch { data = null; } }
  await logAiUsage({
    feature: FONCTION, provider: "openai", model: lunaModel(), userId, ok: Boolean(r?.ok && data),
    latencyMs: Date.now() - t0, errorCode: panne ? "exception" : r === null ? "timeout" : !r.ok ? (r.error ?? "error").slice(0, 120) : data ? null : "invalid_json",
    llmCalls: 1, inputTokens: r?.usage.inputTokens ?? null, outputTokens: r?.usage.outputTokens ?? null,
    cachedInputTokens: r?.usage.cachedInputTokens ?? null, costUsd: r?.usage.costUsd ?? null,
  });
  return { data: r?.ok ? data : null, ok: Boolean(r?.ok) };
}

/**
 * CE QUI SE COMPARE d'une définition proposée à une définition créée (journal « proposition → décision », module
 * `pilotage`) : le nom, la nature et la brique mesurée — un seuil retouché n'est pas un refus de la proposition.
 */
export const empreinteDefinition = (d: Pick<DefinitionKpi, "nom" | "nature" | "numerateur">) =>
  ({ nom: d.nom, nature: d.nature, brique: d.numerateur?.brique ?? null });

/** (a) UNE PHRASE → des définitions contraintes au catalogue des briques. Ne lève jamais. */
export async function proposerDefinitions(phrase: string, userId: string): Promise<ReponseDefinitions & { parLuna: boolean; note: string | null }> {
  const r = await definitionsProposees(phrase, userId);
  // LA PROPOSITION EST GARDÉE, retenue ou non : `creerKpi` dira ce que le manager en a fait.
  if (r.propositions.length) await noterProposition({ source: FONCTION, nature: "definitions", auteurId: userId, propose: r.propositions.map((x) => empreinteDefinition(x.def)), producteur: r.parLuna ? "ia" : "repli" });
  return r;
}

async function definitionsProposees(phrase: string, userId: string): Promise<ReponseDefinitions & { parLuna: boolean; note: string | null }> {
  const p = await porte();
  if (!p.ouverte) return { ...propositionsDeSecours(phrase), parLuna: false, note: p.raison };
  const demande = `DEMANDE DU MANAGER :\n${wrapUntrusted(phrase.slice(0, 1500), { source: "manager", kind: "demande de KPI", maxChars: 3200 })}`;
  const { data } = await appeler({ system: CONSIGNE_DEFINITIONS, user: demande, schema: SCHEMA_DEFINITIONS as unknown as { name: string; schema: Record<string, unknown> }, max: 3000 }, userId);
  const lue = lireReponseDefinitions(data);
  if (!lue || (lue.propositions.length === 0 && !lue.horsBriques)) {
    return { ...propositionsDeSecours(phrase), parLuna: false, note: "Luna n'a pas répondu dans la forme attendue : propositions reconnues sans IA." };
  }
  return { ...lue, parLuna: true, note: null };
}

/**
 * (c) LE NIVEAU D'UN KPI ÉVALUÉ, avec ses preuves citées mot pour mot. Les extraits voyagent comme DONNÉES
 * (`wrapUntrusted`). Sans citation ancrée : pas de proposition.
 */
export async function proposerNiveau(
  entree: { nomKpi: string; grille: readonly NiveauGrille[]; sources: readonly SourceEvaluation[] },
  userId: string,
): Promise<{ ok: true; niveau: number; justification: string; preuves: { source: string; date: string | null; extrait: string }[] } | { ok: false; raison: string }> {
  if (entree.sources.length === 0) return { ok: false, raison: "Aucun rapport ni fiche de coaching sur la période : rien sur quoi s'appuyer — notez vous-même." };
  const p = await porte();
  if (!p.ouverte) return { ok: false, raison: `${p.raison} Notez vous-même.` };
  const grille = entree.grille.map((n, i) => `${i + 1}. ${n.libelle} — ${n.critere}`).join("\n");
  const sources = entree.sources.map((s) => `[${s.id}] ${s.type}${s.date ? ` du ${s.date.slice(0, 10)}` : ""}\n${wrapUntrusted(s.texte, { source: s.id, kind: "extrait de rapport", maxChars: 1600 })}`).join("\n\n");
  const user = `CRITÈRE : ${neutralizeBoundaries(entree.nomKpi)}\nGRILLE (${entree.grille.length} niveaux) :\n${grille}\n\nSOURCES :\n${sources}`;
  const { data } = await appeler({ system: CONSIGNE_EVALUATION, user, schema: SCHEMA_EVALUATION as unknown as { name: string; schema: Record<string, unknown> }, max: 1500 }, userId);
  const lue = lireReponseEvaluation(data, entree.sources, entree.grille.length);
  if (!lue) return { ok: false, raison: "Luna n'a pas pu appuyer un niveau sur des extraits vérifiables : notez vous-même." };
  return { ok: true, ...lue };
}

/**
 * (b) LES CIBLES PROPOSÉES d'après l'historique mensuel (3 à 6 mois) de l'équipe et de la personne visée. Une seule
 * requête pour tous les KPI de l'aperçu. Les données voyagent comme DONNÉES (`wrapUntrusted`). Ne lève jamais : toute
 * garde qui cède (porte fermée, délai, JSON illisible, chiffre étranger à l'historique) rend `null` pour le KPI, et
 * l'appelant retombe sur la règle fixe (`score.ts › proposerCible`).
 */
export async function proposerCibles(
  entrees: readonly (EntreeCible | null)[],
  userId: string,
): Promise<{ cibles: (CibleLuna | null)[]; note: string | null }> {
  const vide = entrees.map(() => null);
  const utiles = entrees.map((e, i) => (e && historiqueSuffisant(e.historique) ? i : -1)).filter((i) => i >= 0);
  if (utiles.length === 0) return { cibles: vide, note: "Moins de trois mois d'historique : la cible suit la règle fixe (moyenne et meilleur de l'équipe)." };
  const p = await porte();
  if (!p.ouverte) return { cibles: vide, note: `${p.raison} La cible suit la règle fixe.` };
  const donnees = JSON.stringify(utiles.map((i) => entreePourLuna(i, entrees[i]!)));
  const user = `KPI À CIBLER (historique mensuel réel, du plus ancien au plus récent) :\n${wrapUntrusted(donnees, { source: "plateforme", kind: "historique de KPI", maxChars: 12_000 })}`;
  const { data } = await appeler({ system: CONSIGNE_CIBLE, user, schema: SCHEMA_CIBLE as unknown as { name: string; schema: Record<string, unknown> }, max: 1800 }, userId);
  const cibles = lireReponseCibles(data, entrees);
  const lues = cibles.filter(Boolean).length;
  // LES OBJECTIFS PROPOSÉS SONT GARDÉS (KPI → cible), retenus ou non : `creerKpi` dira la cible enregistrée.
  const proposees = Object.fromEntries(entrees.flatMap((e, i) => (e && cibles[i] ? [[e.nom, cibles[i]!.cible]] : [])));
  if (lues > 0) await noterProposition({ source: FONCTION, nature: "cibles", auteurId: userId, propose: proposees, producteur: "ia" });
  return { cibles, note: lues === 0 ? "Luna n'a pas pu appuyer une cible sur l'historique : la cible suit la règle fixe." : null };
}

/** (d) LE BROUILLON DU COMMENTAIRE de la revue. Repli : un commentaire écrit depuis les seuls chiffres. */
export async function redigerCommentaire(prenom: string, periode: string, kpis: readonly KpiPourCommentaire[], userId: string): Promise<{ texte: string; parLuna: boolean }> {
  const secours = commentaireDeSecours(prenom, periode, kpis);
  const p = await porte();
  if (!p.ouverte) return { texte: secours, parLuna: false };
  const user = JSON.stringify({ collaborateur: prenom, periode, kpis });
  const { data } = await appeler({ system: CONSIGNE_COMMENTAIRE, user, schema: SCHEMA_COMMENTAIRE as unknown as { name: string; schema: Record<string, unknown> }, max: 900 }, userId);
  const c = lireCommentaire(data);
  return c ? { texte: c, parLuna: true } : { texte: secours, parLuna: false };
}
