import { prisma } from "@/lib/prisma";
import { askClaude, aiConfigured, cleModeleRequise } from "@/lib/ai";
import { courtIaNonConfiguree } from "@/lib/ia/cle-manquante";
import { extractLooseJson } from "../ai/json";
import { regAudit } from "../audit";
import { PROCEDURE_TYPE_LABELS } from "../labels";

/**
 * REVIEWER SIMULATOR (G11) — stress test MULTI-PERSPECTIVES du dossier. **Simulation interne
 * NON PRÉDICTIVE** : ce n'est jamais une décision de l'ANPP, seulement un exercice d'anticipation
 * des questions probables. IA encadrée (Zod, anti-injection), opt-in sur clé ; sinon abstention.
 */

export const PERSPECTIVES: { key: string; label: string; focus: string }[] = [
  { key: "RECEVABILITE", label: "Recevabilité", focus: "pièces administratives minimales, formulaire, droits" },
  { key: "M1", label: "Module 1 (Algérie)", focus: "exigences administratives ANPP, RCP/notice/étiquetage" },
  { key: "CMC", label: "Qualité (CMC)", focus: "substance active, produit fini, procédé, spécifications" },
  { key: "ANALYTIQUE", label: "Analytique", focus: "méthodes et validation (ICH Q2)" },
  { key: "STABILITE", label: "Stabilité", focus: "études zone IVb, durée de conservation" },
  { key: "BIOEQUIVALENCE", label: "Bioéquivalence", focus: "produit de référence, design d'étude (génériques)" },
  { key: "CLINIQUE", label: "Clinique", focus: "efficacité, sécurité, indication" },
  { key: "PV", label: "Pharmacovigilance", focus: "profil de sécurité, plan de gestion des risques" },
  { key: "MEDICO_ECO", label: "Médico-économique", focus: "intérêt thérapeutique, positionnement" },
  { key: "COMMISSION", label: "Commission d'enregistrement", focus: "synthèse et points de blocage probables" },
];

export interface SimPerspective { perspective: string; verdict: string; questions: string[]; risks: string[] }

function normVerdict(raw: unknown): string {
  const s = String(raw ?? "").toUpperCase();
  if (s.includes("DEFAV") || s.includes("DÉFAV") || s.includes("REJE") || s.includes("UNFAV")) return "DEFAVORABLE";
  if (s.includes("FAV")) return "FAVORABLE";
  return "RESERVES";
}

/** Toute valeur (liste, chaîne, objet) → liste de chaînes propres, bornée. */
function toLines(raw: unknown, max = 6): string[] {
  const arr = Array.isArray(raw) ? raw : raw == null || raw === "" ? [] : [raw];
  return arr
    .map((x) => (typeof x === "string" ? x : x == null ? "" : typeof x === "object" ? String((x as Record<string, unknown>).text ?? (x as Record<string, unknown>).label ?? JSON.stringify(x)) : String(x)))
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, max)
    .map((s) => s.slice(0, 400));
}

export function normalizeSimulation(parsed: unknown): { perspectives: SimPerspective[]; overall: string } {
  const root = (parsed && typeof parsed === "object") ? parsed as Record<string, unknown> : {};
  const rawList = Array.isArray(root.perspectives) ? root.perspectives
    : Array.isArray(root.result) ? root.result
    : Array.isArray(parsed) ? (parsed as unknown[])
    : [];
  const perspectives = rawList.slice(0, 12).map((p) => {
    const o = (p && typeof p === "object") ? p as Record<string, unknown> : {};
    return {
      perspective: String(o.perspective ?? o.label ?? o.name ?? o.axe ?? "Perspective").trim().slice(0, 80) || "Perspective",
      verdict: normVerdict(o.verdict ?? o.avis ?? o.decision),
      questions: toLines(o.questions ?? o.questions_probables),
      risks: toLines(o.risks ?? o.risques),
    };
  }).filter((p) => p.questions.length > 0 || p.risks.length > 0 || p.verdict !== "RESERVES" || p.perspective !== "Perspective");
  const overall = typeof root.overall === "string" ? root.overall.slice(0, 4000)
    : typeof root.synthese === "string" ? (root.synthese as string).slice(0, 4000) : "";
  return { perspectives, overall };
}
export interface SimulationResult { ok: boolean; configured: boolean; simulationId?: string; perspectives: SimPerspective[]; overall?: string; error?: string }

export type AiFn = (prompt: string, opts: { system?: string; maxTokens?: number; temperature?: number }) => Promise<{ ok: boolean; configured: boolean; text?: string; error?: string }>;

const SYSTEM = [
  "Tu SIMULES un examen réglementaire multi-perspectives INTERNE pour un dossier CTD destiné à l'ANPP (Algérie).",
  "Cette simulation est NON PRÉDICTIVE : ce n'est en AUCUN CAS une décision de l'ANPP, seulement un exercice d'anticipation des questions probables.",
  "L'ANPP émet TROIS types de réserves — cale tes questions sur le bon registre : TECHNICO-RÉGLEMENTAIRES (module 1 : pièces, certificats, RCP/notice), CONTRÔLE QUALITÉ (rares — lots contrôlés sur place), et surtout ÉVALUATION SCIENTIFIQUE (modules 3 et 5 : les plus nombreuses et les plus détaillées — caractérisation et spectres, polymorphisme, impuretés et nitrosamines, LOD/LOQ et chromatogrammes de spécificité, solvants résiduels, stabilité couvrant toute la durée revendiquée, justification des différences de composition, bioéquivalence).",
  "RÈGLES : 1) réponds UNIQUEMENT en JSON conforme au schéma ; 2) pour chaque perspective, donne un verdict SIMULÉ (FAVORABLE|RESERVES|DEFAVORABLE), des questions probables et des risques ; 3) reste factuel et prudent ; 4) n'invente pas de données absentes du résumé ; 5) formule les questions COMME l'ANPP les écrit (« Veuillez fournir… », « Veuillez justifier… »), précises et actionnables.",
].join("\n");

/** Résumé compact et FIABLE du dossier (nos propres données structurées) pour le prompt. */
async function dossierSummary(dossierVersionId: string): Promise<string> {
  const [version, assessment, facts, docs] = await Promise.all([
    prisma.regulatoryDossierVersion.findUnique({ where: { id: dossierVersionId }, select: { dossier: { select: { procedureType: true, title: true } } } }),
    prisma.regulatoryAssessment.findUnique({ where: { dossierVersionId }, select: { completeness: true, conforme: true, blockers: true, criticals: true, majors: true } }),
    prisma.regulatoryFact.findMany({ where: { dossierVersionId, status: { in: ["CONFIRMED", "CORRECTED"] } }, select: { label: true, value: true, approvedValue: true }, take: 30 }),
    prisma.regulatoryDocument.findMany({ where: { dossierVersionId, ctdSection: { not: null } }, select: { ctdSection: true }, take: 200 }),
  ]);
  const sections = [...new Set(docs.map((d) => d.ctdSection))].join(", ");
  const factLines = facts.map((f) => `- ${f.label} : ${f.approvedValue ?? f.value}`).join("\n");
  return [
    `Procédure : ${version ? PROCEDURE_TYPE_LABELS[version.dossier.procedureType] : "?"}`,
    assessment ? `Complétude : ${assessment.completeness}% ; bloqueurs : ${assessment.blockers} ; critiques : ${assessment.criticals} ; majeurs : ${assessment.majors} ; conforme : ${assessment.conforme}` : "Aucun bilan déterministe.",
    `Sections CTD présentes : ${sections || "aucune"}`,
    `Faits approuvés du jumeau numérique :\n${factLines || "(aucun fait approuvé)"}`,
  ].join("\n");
}

export async function runReviewerSimulation(dossierVersionId: string, actorId: string, aiFn: AiFn = askClaude): Promise<SimulationResult> {
  const version = await prisma.regulatoryDossierVersion.findUnique({ where: { id: dossierVersionId }, select: { dossier: { select: { id: true, companyId: true } } } });
  if (!version) return { ok: false, configured: aiConfigured(), perspectives: [], error: "Version introuvable." };

  if (!aiConfigured() && aiFn === askClaude) {
    return { ok: true, configured: false, perspectives: [], error: `${courtIaNonConfiguree(cleModeleRequise())} — simulation indisponible, aucune donnée simulée.` };
  }

  const summary = await dossierSummary(dossierVersionId);
  const prompt = [
    "RÉSUMÉ DU DOSSIER (données fiables, issues de l'analyse interne) :",
    summary,
    "",
    `PERSPECTIVES À SIMULER : ${PERSPECTIVES.map((p) => `${p.label} (${p.focus})`).join(" ; ")}.`,
    'Renvoie STRICTEMENT : {"overall":"synthèse simulée","perspectives":[{"perspective":"...","verdict":"FAVORABLE|RESERVES|DEFAVORABLE","questions":["..."],"risks":["..."]}]}.',
  ].join("\n");

  // Plafond de jetons LARGE (10 perspectives riches) pour éviter la troncature — cause n°1 des
  // « Réponse IA non exploitable » ; et parsing TOLÉRANT (récupère même une réponse tronquée).
  const res = await aiFn(prompt, { system: SYSTEM, maxTokens: 6000, temperature: 0.3 });
  if (!res.ok) return { ok: false, configured: res.configured, perspectives: [], error: res.error };
  const parsed = extractLooseJson(res.text ?? "");
  if (parsed === null) return { ok: false, configured: res.configured, perspectives: [], error: "Réponse IA non exploitable — réessayez." };

  // Mise en forme TOLÉRANTE : on ne rejette plus une simulation exploitable pour un détail de format.
  const { perspectives, overall } = normalizeSimulation(parsed);
  if (perspectives.length === 0) return { ok: false, configured: res.configured, perspectives: [], error: "La simulation n'a produit aucune perspective — réessayez." };

  const sim = await prisma.regulatorySimulation.create({
    data: { dossierVersionId, perspectives: perspectives as unknown as object, overall: overall || null, configured: true, createdById: actorId },
    select: { id: true },
  });
  await regAudit({ companyId: version.dossier.companyId, actorId, dossierId: version.dossier.id, dossierVersionId, action: "SIMULATION_RUN", detail: `Simulation multi-perspectives (NON prédictive) : ${perspectives.length} perspective(s).` });
  return { ok: true, configured: true, simulationId: sim.id, perspectives, overall };
}
