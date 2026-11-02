/**
 * Runner réglementaire — LES RÈGLES ET LA REVUE IA : handler RULES (règles actives, sections arabes,
 * conflits du jumeau), handlers SIMULATE et AI_REVIEW (revue par morceaux, lots, escalade), clôture de
 * l'analyse, notification de l'issue, enrichissement et précédents.
 */
import type { RegulatoryJob } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { detectContainedSections } from "../../ctd/detect-sections";
import { assessVersion, type TwinDoc } from "../../rules/engine";
import { loadActiveRules, loadPresentFactKeys } from "../../rules/rule-engine";
import { missesArabic, arabicStats, isArabicRequiredSection } from "../../rules/notice-arabic";
import { reviewDocumentText, type AiFinding } from "../../agents/review-agent";
import { runReviewerSimulation } from "../../simulator/run";
import { lunaReviewFn } from "../../agents/review-ai";
import { escalateCriticalSections } from "../../agents/escalate";
import { corpusForSection } from "../../corpus/for-section";
import { experienceForSection } from "../../training/for-section";
import { submitVersionReviewBatch } from "../../cost/batch-runner";
import { splitTextIntoChunksWithOffsets, chunkPageSpan } from "../../agents/chunk-text";
import { pageSpanOfSlice, anchorEvidence } from "../../extract/pages";
import { sectionByCode } from "../../ctd/taxonomy";
import { aiConfigured, cleModeleRequise } from "@/lib/ai";
import { courtIaNonConfiguree } from "@/lib/ia/cle-manquante";
import { notifyRoles } from "@/lib/notify";
import { getAppSettings } from "@/lib/settings";
import { enrichVersionFindings, type EnrichmentContext } from "../../findings/enrich";
import { regAudit } from "../../audit";
import { sansBloquer } from "@/lib/journal";
import { clampInt, runPool, yieldToEventLoop } from "./reglages";
import { visionEnabled } from "./extraction";

/** RULES : jumeau numérique + moteur déterministe → constats + bilan de conformité. */
export async function handleRules(job: RegulatoryJob): Promise<void> {
  const versionId = job.dossierVersionId;
  if (!versionId) {
    await prisma.regulatoryJob.update({ where: { id: job.id }, data: { status: "DONE", progress: 100, finishedAt: new Date() } });
    return;
  }

  const version = await prisma.regulatoryDossierVersion.findUnique({
    where: { id: versionId },
    select: { dossier: { select: { id: true, procedureType: true, productId: true } } },
  });
  if (!version) {
    await prisma.regulatoryJob.update({ where: { id: job.id }, data: { status: "DONE", finishedAt: new Date() } });
    return;
  }

  const docs = await prisma.regulatoryDocument.findMany({
    where: { dossierVersionId: versionId },
    select: { id: true, originalFilename: true, ctdSection: true, ctdModule: true, containedSections: true, securityStatus: true, extractionStatus: true, classificationMethod: true },
  });

  // Rattrapage multi-sections : pour un document déjà lu MAIS sans sections détectées (dossier
  // analysé avant cette fonctionnalité, ou « Relancer l'analyse »), on les calcule depuis le texte
  // déjà stocké (un document à la fois → mémoire bornée) et on les persiste. Corrige les fausses
  // « sections manquantes » d'un gros PDF consolidé sans devoir tout ré-extraire.
  for (const d of docs) {
    await yieldToEventLoop(); // détection de sections = regex lourde sur le texte → céder la main entre docs
    if (d.containedSections.length > 0) continue;
    const ext = await prisma.regulatoryExtraction.findUnique({ where: { documentId: d.id }, select: { content: true } });
    if (!ext?.content) continue;
    const detected = detectContainedSections(ext.content).map((x) => x.code);
    if (detected.length > 0) {
      await prisma.regulatoryDocument.update({ where: { id: d.id }, data: { containedSections: detected } }).catch(sansBloquer("jobs-runner.handleRules.regulatoryDocument"));
      d.containedSections = detected;
    }
  }

  const twinDocs: TwinDoc[] = docs.map((d) => ({ ...d, securityStatus: String(d.securityStatus), extractionStatus: String(d.extractionStatus) }));

  // G5 : règles administrables du/des pack(s) ACTIF(s) — sinon repli sur les profils codés.
  const [rules, factKeys] = await Promise.all([
    loadActiveRules(version.dossier.procedureType),
    loadPresentFactKeys(versionId),
  ]);
  const { findings, summary } = assessVersion({ procedureType: version.dossier.procedureType, documents: twinDocs, rules, factKeys });

  // NOTICE EN ARABE (spécificité algérienne, décret n° 92-286) : notice/étiquetage (1.3.x hors
  // RCP) sans version arabe → constat MAJEUR. Seuls les textes NATIFS sont jugés — l'OCR latin
  // massacre l'arabe et on refuse d'accuser une notice arabe scannée sur une lecture ratée.
  for (const d of docs) {
    const eligible =
      String(d.securityStatus) === "SAFE" &&
      String(d.extractionStatus) === "TEXT_EXTRACTED" &&
      (isArabicRequiredSection(d.ctdSection) || d.containedSections.some((s) => isArabicRequiredSection(s)));
    if (!eligible) continue;
    await yieldToEventLoop(); // comptage regex sur un gros texte → céder la main entre documents
    const ext = await prisma.regulatoryExtraction.findUnique({ where: { documentId: d.id }, select: { content: true } });
    if (!ext?.content || !missesArabic(ext.content)) continue;
    const { ratio, letters } = arabicStats(ext.content);
    findings.push({
      code: `NOTICE-AR:${d.id}`,
      severity: "MAJOR",
      category: "content",
      title: "Notice / étiquetage sans version arabe",
      detail:
        "La réglementation algérienne (décret exécutif n° 92-286, art. 4) impose une notice et un étiquetage rédigés en arabe. " +
        `Le texte lu de « ${d.originalFilename} » est presque exclusivement en caractères latins. ` +
        "Vérifier si la version arabe existe dans un document séparé du module 1.3 ; sinon, la produire avant dépôt.",
      evidence: `Texte natif analysé : ${letters.toLocaleString("fr-FR")} lettres, dont ${(ratio * 100).toFixed(1)} % en caractères arabes (seuil : 5 %).`,
      sectionCode: d.ctdSection ?? undefined,
      documentId: d.id,
      blocker: false,
    });
  }

  await prisma.$transaction([
    // Recalcul idempotent : on remplace les constats du MOTEUR (on préserve IA/HUMAIN).
    prisma.regulatoryFinding.deleteMany({ where: { dossierVersionId: versionId, source: "RULE" } }),
    prisma.regulatoryFinding.createMany({
      data: findings.map((f) => ({
        dossierVersionId: versionId, code: f.code, severity: f.severity, category: f.category,
        title: f.title, detail: f.detail, evidence: f.evidence ?? null, sectionCode: f.sectionCode ?? null,
        documentId: f.documentId ?? null, source: "RULE" as const, blocker: f.blocker ?? false, draft: false,
      })),
    }),
    prisma.regulatoryAssessment.upsert({
      where: { dossierVersionId: versionId },
      create: {
        dossierVersionId: versionId, completeness: summary.completeness, conforme: summary.conforme,
        blockers: summary.blockers, criticals: summary.criticals, majors: summary.majors, minors: summary.minors,
        requiredPresent: summary.requiredPresent, requiredTotal: summary.requiredTotal, computedAt: new Date(),
      },
      update: {
        completeness: summary.completeness, conforme: summary.conforme,
        blockers: summary.blockers, criticals: summary.criticals, majors: summary.majors, minors: summary.minors,
        requiredPresent: summary.requiredPresent, requiredTotal: summary.requiredTotal, computedAt: new Date(),
      },
    }),
    // Le dossier ne passe PLUS « en revue » ici : les contrôles déterministes ne sont que la
    // moitié du travail. C'est la simulation d'examen — dernière étape — qui clôt l'analyse.
    prisma.regulatoryJob.update({ where: { id: job.id }, data: { status: "DONE", progress: 100, finishedAt: new Date() } }),
  ]);

  await regAudit({
    companyId: job.companyId, actorId: "system", dossierId: version.dossier.id, dossierVersionId: versionId,
    action: "RULES_ASSESSED",
    detail: `Contrôles déterministes : complétude ${summary.completeness}%, ${summary.conforme ? "aucun bloqueur" : `${summary.blockers} bloqueur(s)`} — ${summary.criticals} critique(s), ${summary.majors} majeur(s).`,
    meta: { ...summary },
  });

  // Précédents ANPP attachés aux constats — après persistance, jamais bloquant.
  await attachPrecedents(job, versionId, await enrichmentContextOf(version.dossier.productId));

  // Revue IA (PROJET, non bloquante) uniquement si l'IA est configurée — sinon on n'empile
  // pas de jobs annulés.
  if (aiConfigured()) {
    await prisma.regulatoryJob.create({
      data: { companyId: job.companyId, dossierId: version.dossier.id, dossierVersionId: versionId, type: "AI_REVIEW", status: "QUEUED", payload: {} },
    });
  } else {
    // Sans IA il n'y a ni revue de fond ni simulation : l'analyse s'arrête ici, et le dossier
    // doit quand même arriver « en revue » — sinon il resterait « en analyse » indéfiniment.
    await closeAnalysis(version.dossier.id);
  }
  // EXAMEN VISUEL : figures (courbes, chromatogrammes, schémas) ET contrôle de FORME de chaque
  // page. Séparé de la revue de texte parce qu'il répond à une autre question — « qu'est-ce que
  // je VOIS ? » — sur laquelle l'OCR est structurellement aveugle : le texte d'une capture
  // d'écran est parfaitement propre.
  if (visionEnabled()) {
    await prisma.regulatoryJob.create({
      data: { companyId: job.companyId, dossierId: version.dossier.id, dossierVersionId: versionId, type: "VISION", status: "QUEUED", payload: {} },
    });
  }
}

// Sections prioritaires (analysées EN PREMIER quand le budget de parts est limité).
const AI_PRIORITY_SECTIONS = new Set(["1.2", "1.3", "2.3", "2.5", "3.2.P.5", "3.2.P.8", "3.2.S.4", "5.3"]);

// Documents lisibles par l'IA (texte natif + OCR, y compris faible confiance pour couverture max).
const AI_REVIEWABLE_STATUSES = ["TEXT_EXTRACTED", "OCR_COMPLETED", "LOW_CONFIDENCE"] as const;

const SEVERITY_ORDER: Record<string, number> = { CRITICAL: 0, MAJOR: 1, MINOR: 2, INFO: 3 };

// Parts d'analyse océrisées EN PARALLÈLE (borne le débit vers l'IA) ; plafond de parts par version
// (coût — 0 = illimité) ; plafond de constats persistés (évite d'inonder l'UI/la base).
/**
 * Parts envoyées EN PARALLÈLE au modèle — 8 (était 4). C'est de l'ATTENTE RÉSEAU pure : doubler
 * le parallélisme divise à peu près par deux le temps de la revue de fond, sans coûter un jeton
 * de plus. Le plafond reste la tolérance du fournisseur (au-delà, des refus pour débit excessif).
 */
const aiConcurrency = () => clampInt(process.env.REG_AI_CONCURRENCY, 8, 1, 24);

/**
 * Parts analysées par version. **0 = INTÉGRAL, et c'est le défaut.**
 *
 * Le plafond valait 120, soit environ 1 200 pages. Sur un dossier de 15 000 pages, 92 % du
 * contenu n'était jamais lu — et la boucle sortait par un simple `break`, sans que rien à
 * l'écran ne distingue « analysé » de « analysé à 8 % ». Un dossier réglementaire à moitié lu
 * qui a l'air complet est pire qu'un dossier non analysé : on s'y fie.
 *
 * Le coût est désormais tenu par le bon outil — le plafond BUDGÉTAIRE du dossier, qui refuse
 * l'appel avant la dépense et le dit — plutôt que par un compteur de parts aveugle.
 */
const aiMaxChunks = () => clampInt(process.env.REG_AI_MAX_CHUNKS, 0, 0, 1_000_000);

export const aiMaxFindings = () => clampInt(process.env.REG_AI_MAX_FINDINGS, 3000, 10, 100_000);

/**
 * Voie de la revue de fond : **IMMÉDIATE par défaut**.
 *
 * Le différé (Batch, moitié prix) coûte deux fois moins cher, mais fait attendre les constats
 * jusqu'à 24 h — et pendant ce temps l'écran montre un dossier « en revue » dont il MANQUE la
 * partie la plus exigeante (les constats de fond). Découvrir après coup que l'analyse lue était
 * incomplète est bien plus coûteux que la différence de prix : on paie plein tarif et on voit
 * tout de suite.
 *
 * Le différé reste disponible **à la demande** (bouton « Réanalyser à moitié prix » de l'écran
 * dossier), et peut redevenir le défaut avec `REG_AI_BATCH=1` — utile pour une réanalyse
 * massive lancée le soir.
 */
const aiBatchDefault = () => (process.env.REG_AI_BATCH ?? "0").trim() === "1";

/**
 * AI_REVIEW : revue de fond/forme (PROJET, non bloquante). Chaque document lisible est découpé
 * en PARTS d'environ 10 pages (splitTextIntoChunks) ; chaque part est envoyée SÉPARÉMENT à l'IA,
 * EN PARALLÈLE (borné) — jamais le document entier. Sections prioritaires d'abord. ROBUSTE : une
 * part qui échoue est ignorée (les autres passent). Bornée en coût (REG_AI_MAX_CHUNKS) et en
 * nombre de constats persistés (les plus sévères d'abord). Mémoire bornée : un contenu à la fois.
 */
/**
 * CLÔTURE DE L'ANALYSE — le seul endroit qui fait passer un dossier « en revue ».
 *
 * C'était auparavant l'affaire des contrôles déterministes, qui se terminent bien avant la revue
 * de fond : l'écran annonçait « en revue » alors que la partie la plus exigeante n'avait pas
 * commencé. Le dossier n'est désormais déclaré prêt à relire que lorsque la machine n'a plus rien
 * à en dire — contrôles, revue de fond, et simulation d'examen comprises.
 */
async function closeAnalysis(dossierId: string | null): Promise<void> {
  if (!dossierId) return;
  await prisma.regulatoryDossier
    .update({ where: { id: dossierId }, data: { status: "IN_REVIEW" } })
    .catch(sansBloquer("jobs-runner.closeAnalysis.regulatoryDossier")); // dossier supprimé entre-temps : rien à clore
}

/**
 * Enchaîne la SIMULATION D'EXAMEN après la revue de fond. Appelée sur le chemin de succès COMME
 * sur celui d'échec : une revue qui a échoué ne doit pas laisser le dossier bloqué « en analyse »
 * pour toujours. Si l'IA n'est pas configurée, il n'y a rien à simuler et on clôt directement.
 */
async function queueSimulation(job: RegulatoryJob, versionId: string): Promise<void> {
  if (!aiConfigured()) {
    await closeAnalysis(job.dossierId);
    return;
  }
  const already = await prisma.regulatoryJob.count({
    where: { dossierVersionId: versionId, type: "SIMULATE", status: { in: ["QUEUED", "RUNNING"] } },
  });
  if (already > 0) return; // une simulation est déjà en file : ne pas en empiler une seconde
  await prisma.regulatoryJob.create({
    data: { companyId: job.companyId, dossierId: job.dossierId, dossierVersionId: versionId, type: "SIMULATE", status: "QUEUED", payload: {} },
  });
}

/**
 * SIMULATE : dix examinateurs simulés passent le dossier en revue (recevabilité, Module 1, qualité,
 * analytique, stabilité, bioéquivalence, clinique, pharmacovigilance, médico-économique,
 * commission) et rendent les questions qu'ils poseraient. C'est la dernière étape de l'analyse :
 * l'analyse dit ce qui ne va pas dans les pièces, la simulation dit ce qu'on va nous demander.
 *
 * Non bloquante : une simulation impossible (IA indisponible) NE doit pas retenir le dossier —
 * elle est tracée, et le dossier passe quand même en revue. L'inverse laisserait un dossier
 * parfaitement analysé coincé pour une carte d'anticipation.
 */
export async function handleSimulate(job: RegulatoryJob): Promise<void> {
  const versionId = job.dossierVersionId;
  if (!versionId) {
    await prisma.regulatoryJob.update({ where: { id: job.id }, data: { status: "CANCELLED", finishedAt: new Date(), error: "Version absente." } });
    await closeAnalysis(job.dossierId);
    return;
  }

  const res = await runReviewerSimulation(versionId, "system").catch((e) => ({
    ok: false as const, configured: true, perspectives: [], error: e instanceof Error ? e.message : String(e),
  }));

  await prisma.regulatoryJob.update({
    where: { id: job.id },
    data: res.ok
      ? { status: "DONE", progress: 100, finishedAt: new Date() }
      : { status: "FAILED", finishedAt: new Date(), error: (res.error ?? "Simulation impossible.").slice(0, 500) },
  });

  await regAudit({
    companyId: job.companyId, actorId: "system", dossierId: job.dossierId, dossierVersionId: versionId,
    action: res.ok ? "SIMULATION_DONE" : "SIMULATION_FAILED",
    detail: res.ok
      ? `Simulation d'examen : ${res.perspectives.length} perspective(s) rendues.`
      : `Simulation d'examen impossible : ${res.error ?? "raison inconnue"}. Le dossier passe quand même en revue.`,
  });

  await closeAnalysis(job.dossierId);
}

export async function handleAiReview(job: RegulatoryJob): Promise<void> {
  const versionId = job.dossierVersionId;
  if (!versionId || !aiConfigured()) {
    await prisma.regulatoryJob.update({
      where: { id: job.id },
      data: { status: "CANCELLED", finishedAt: new Date(), error: aiConfigured() ? "Version absente." : `${courtIaNonConfiguree(cleModeleRequise())} — aucune revue simulée.` },
    });
    await closeAnalysis(job.dossierId); // ne jamais laisser un dossier bloqué « en analyse »
    return;
  }

  const docs = await prisma.regulatoryDocument.findMany({
    where: { dossierVersionId: versionId, extractionStatus: { in: [...AI_REVIEWABLE_STATUSES] }, securityStatus: { in: ["SAFE", "SUSPICIOUS"] } },
    orderBy: { createdAt: "asc" },
    select: { id: true, originalFilename: true, ctdSection: true },
  });
  // Sections prioritaires en tête (tri stable), puis le reste → couverture complète, budget permettant.
  const ordered = [...docs].sort((a, b) => Number(!!b.ctdSection && AI_PRIORITY_SECTIONS.has(b.ctdSection)) - Number(!!a.ctdSection && AI_PRIORITY_SECTIONS.has(a.ctdSection)));

  // ── VOIE DIFFÉRÉE (Batch, moitié prix) — désormais SUR DEMANDE, plus par défaut : elle fait
  // attendre les constats jusqu'à 24 h, pendant lesquelles l'écran montre un dossier « en revue »
  // amputé de sa partie la plus exigeante. On passe donc directement à la voie immédiate
  // ci-dessous, sauf réglage explicite (`REG_AI_BATCH=1`) ou demande de l'utilisateur.
  // Le mode peut être FORCÉ par la charge utile du job (choix à l'écran) : « résultats
  // maintenant, plein tarif » l'emporte toujours.
  const forcedImmediate = (job.payload as { mode?: string } | null)?.mode === "immediate";
  if (!forcedImmediate && aiBatchDefault()) {
    const submitted = await submitVersionReviewBatch(versionId, {
      companyId: job.companyId, dossierId: job.dossierId, userId: null,
    }).catch((e) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }));

    if (submitted.ok) {
      await prisma.regulatoryJob.update({
        where: { id: job.id },
        data: { status: "DONE", progress: 100, finishedAt: new Date() },
      });
      await regAudit({
        companyId: job.companyId, actorId: "system", dossierId: job.dossierId, dossierVersionId: versionId,
        action: "AI_REVIEW_DEFERRED",
        detail: submitted.message ?? "Analyse différée déposée (moitié prix). Les constats arriveront sous 24 h.",
      });
      await queueSimulation(job, versionId);
      return;
    }
    console.warn("[reg-ai] dépôt différé impossible, repli sur la voie immédiate :", submitted.error);
  }

  const maxChunks = aiMaxChunks();
  const concurrency = aiConcurrency();
  const collected: (AiFinding & { documentId: string })[] = [];
  let usedChunks = 0;
  let analyzedDocs = 0;
  /** Une part refusée faute de budget arrête l'analyse : continuer produirait un trou silencieux. */
  let budgetStopped = false;
  /**
   * Parts réellement LUES vs parts en ÉCHEC, et la première raison d'échec.
   *
   * Sans ce comptage, une panne totale (clé invalide, quota épuisé, fournisseur indisponible)
   * se terminait en « job DONE, 0 constat » : le dossier avait l'air impeccable alors que
   * l'analyse n'avait jamais eu lieu. C'est le pire des résultats possibles — on s'y fie.
   */
  let okParts = 0;
  let failedParts = 0;
  let firstError: string | null = null;

  for (const d of ordered) {
    if (maxChunks > 0 && usedChunks >= maxChunks) break;
    await yieldToEventLoop(); // céder la main entre documents (découpage + appels IA)
    // Contenu chargé UN document à la fois (pic mémoire borné même pour un document de 10 000 pages).
    const ext = await prisma.regulatoryExtraction.findUnique({ where: { documentId: d.id }, select: { content: true, pageMap: true } });
    const pageMap = Array.isArray(ext?.pageMap) ? (ext!.pageMap as number[]) : null;
    let parts = splitTextIntoChunksWithOffsets(ext?.content ?? "");
    if (parts.length === 0) continue;
    if (maxChunks > 0) parts = parts.slice(0, maxChunks - usedChunks);
    usedChunks += parts.length;
    analyzedDocs++;
    const ctdTitle = d.ctdSection ? sectionByCode(d.ctdSection)?.title ?? null : null;
    // Les textes opposables de CETTE section, cherchés UNE fois et partagés par toutes ses parts :
    // même contexte, donc même empreinte de cache — un document inchangé n'est pas repayé.
    const corpus = await corpusForSection(d.ctdSection);
    // L'expérience interne (module Entraînement IA) : ce que l'ANPP a réellement dit sur NOS
    // produits passés pour cette section — précédents, jamais règles.
    const experience = await experienceForSection(d.ctdSection);
    const total = parts.length;
    // L'en-tête du document (page de garde : produit, dosage, forme) accompagne chaque part —
    // sans lui, la part 8/12 juge un tableau sans savoir de quoi il parle. Pas pour la part 1,
    // qui le contient déjà.
    const docLead = total > 1 ? parts[0].text.slice(0, 1200) : null;
    const content = ext?.content ?? "";
    // Parts de CE document envoyées à l'IA en parallèle ; une part en échec n'arrête pas les autres.
    await runPool(parts, concurrency, async (part, i) => {
      if (budgetStopped) return;
      try {
        // Pages EXACTES quand la carte existe (extraction paginée) ; estimation sinon.
        const span = pageMap ? pageSpanOfSlice(pageMap, part.start, part.end) : chunkPageSpan(i);
        const r = await reviewDocumentText(
          {
            filename: total > 1 ? `${d.originalFilename} — partie ${i + 1}/${total}` : d.originalFilename,
            ctdSection: d.ctdSection, ctdTitle, text: part.text, corpus, experience,
            pageStart: span.start, pageEnd: span.end,
            docLead: i > 0 ? docLead : null,
          },
          // TRACÉ : chaque part est imputée au dossier, à la version et au fichier, et le plafond
          // budgétaire refuse l'appel AVANT la dépense (cf. review-ai.ts).
          lunaReviewFn({ dossierId: job.dossierId, dossierVersionId: versionId, documentId: d.id, step: "review" }),
        );
        if (r.ok) {
          okParts++;
          for (const f of r.findings) {
            // L'ANCRAGE PRIME SUR L'ESTIMATION : si la preuve citée se retrouve dans le texte,
            // sa page devient LA page — celle qu'on ouvre au clic, celle qu'on montre en séance.
            const anchored = pageMap ? anchorEvidence(content, pageMap, f.evidence) : null;
            collected.push({ ...f, page: anchored ?? f.page, documentId: d.id });
          }
        } else {
          failedParts++;
          firstError ??= r.error ?? "raison inconnue";
          if ((r.error ?? "").includes("Budget IA")) budgetStopped = true;
        }
      } catch (err) {
        failedParts++;
        firstError ??= err instanceof Error ? err.message : String(err);
        console.error("[reg-ai] analyse d'une part échouée", d.id, i, err instanceof Error ? err.message : err);
      }
    });
    if (budgetStopped) break;
  }

  // ── PANNE TOTALE : aucune part n'a pu être lue. Ce n'est PAS un dossier sans reproche.
  // On ne détruit pas les constats existants, on marque le job en échec avec sa raison, et on
  // prévient — un « terminé, 0 constat » silencieux ferait croire à un dossier impeccable.
  if (okParts === 0 && failedParts > 0) {
    const reason = firstError ?? "raison inconnue";
    await prisma.regulatoryJob.update({
      where: { id: job.id },
      data: { status: "FAILED", finishedAt: new Date(), error: `Revue de fond impossible (${failedParts} lecture(s) en échec) : ${reason}`.slice(0, 500) },
    });
    await regAudit({
      companyId: job.companyId, actorId: "system", dossierId: job.dossierId, dossierVersionId: versionId,
      action: "AI_REVIEW_FAILED",
      detail: `⚠ La revue de fond n'a RIEN pu lire : ${failedParts} lecture(s) en échec — ${reason}. Aucun constat n'a été produit et les constats précédents sont CONSERVÉS. Ce dossier n'a pas été examiné sur le fond.`,
    }).catch(sansBloquer("jobs-runner.handleAiReview.regAudit"));
    await notifyAiReviewOutcome(job, versionId, {
      title: "Revue de fond impossible",
      body: `La lecture de fond du dossier a échoué (${reason.slice(0, 120)}). Le dossier n'a PAS été examiné sur le fond.`,
    });
    // Même en échec, la suite doit avoir lieu : sans cela le dossier resterait « en analyse »
    // pour toujours, et l'utilisateur attendrait un écran qui ne changera plus jamais.
    await queueSimulation(job, versionId);
    return;
  }

  // Dédoublonne (même document + même titre) puis garde les constats les PLUS SÉVÈRES (plafond).
  const seen = new Set<string>();
  const deduped = collected.filter((f) => {
    const key = `${f.documentId}|${f.title.trim().toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  deduped.sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9));
  const kept = deduped.slice(0, aiMaxFindings());

  await prisma.$transaction([
    prisma.regulatoryFinding.deleteMany({ where: { dossierVersionId: versionId, source: "AI" } }),
    prisma.regulatoryFinding.createMany({
      data: kept.map((f) => ({
        dossierVersionId: versionId, code: "AI_REVIEW", severity: f.severity, category: f.category.slice(0, 40),
        title: f.title.slice(0, 200), detail: f.detail.slice(0, 2000), evidence: f.evidence ? f.evidence.slice(0, 1200) : null,
        sectionCode: f.sectionCode, documentId: f.documentId, source: "AI" as const, blocker: false, draft: true,
        // Ce qui rend le constat défendable : la pièce, le degré de certitude, et quoi faire.
        excerpt: f.evidence ? f.evidence.slice(0, 1200) : null,
        page: f.page, confidence: f.confidence, recommendation: f.recommendation,
        conflictingValues: f.conflictingValues,
      })),
    }),
    prisma.regulatoryJob.update({ where: { id: job.id }, data: { status: "DONE", progress: 100, finishedAt: new Date() } }),
  ]);

  await regAudit({
    companyId: job.companyId, actorId: "system", dossierId: job.dossierId, dossierVersionId: versionId,
    action: "AI_REVIEW_DONE",
    // « Incomplète » se dit, toujours. Un dossier lu à moitié qui a l'air complet est pire qu'un
    // dossier non analysé, parce qu'on s'y fie.
    detail: `Revue IA (PROJET — revue humaine requise) : ${kept.length} constat(s) sur ${usedChunks} part(s) de ${analyzedDocs} document(s)`
      + (failedParts > 0 ? ` — ⚠ ${failedParts} part(s) n'ont PAS pu être lues (${firstError ?? "raison inconnue"})` : "")
      + (budgetStopped ? " — ⚠ ANALYSE INCOMPLÈTE : plafond budgétaire du dossier atteint, le reste n'a PAS été lu. Relevez le plafond et relancez." : "")
      + (!budgetStopped && maxChunks > 0 && usedChunks >= maxChunks ? ` — ⚠ ANALYSE INCOMPLÈTE : plafond de ${maxChunks} parts atteint (REG_AI_MAX_CHUNKS), le reste n'a PAS été lu.` : "")
      + ".",
  });

  // LA FIN DE L'ANALYSE SE DIT. Sans cela, une revue lancée puis oubliée reste invisible : le
  // pharmacien n'a aucune raison de revenir sur l'écran au bon moment.
  await notifyAiReviewOutcome(job, versionId, {
    title: kept.length > 0 ? "Analyse de fond terminée" : "Analyse de fond terminée — aucun constat",
    body: kept.length > 0
      ? `${kept.length} constat(s) de fond à relire (PROJET — revue humaine requise) sur ${analyzedDocs} document(s).`
      : `Aucun écart relevé sur ${analyzedDocs} document(s) lus. À confirmer par une relecture humaine.`,
  });

  const productId = job.dossierId
    ? (await prisma.regulatoryDossier.findUnique({ where: { id: job.dossierId }, select: { productId: true } }))?.productId ?? null
    : null;
  await attachPrecedents(job, versionId, await enrichmentContextOf(productId));

  // Là où le balayage a trouvé du CRITIQUE, l'agent spécialiste repasse — automatiquement.
  await escalateCriticalSections(versionId, { companyId: job.companyId, dossierId: job.dossierId });

  // DERNIÈRE ÉTAPE de l'analyse : ce que les examinateurs vont probablement demander.
  await queueSimulation(job, versionId);
}

/**
 * PRÉVIENT à la fin d'une revue de fond — succès, silence ou panne.
 *
 * La revue tourne en arrière-plan, parfois de longues minutes : sans notification, son résultat
 * n'existe que pour qui pense à rouvrir l'écran au bon moment. On prévient donc les rôles
 * superviseurs du module (réglage `regulatorySupervisorRoles`) et le Super Admin.
 * Ne lève jamais : une notification ratée n'annule pas une analyse réussie.
 */
async function notifyAiReviewOutcome(
  job: RegulatoryJob,
  versionId: string,
  msg: { title: string; body: string },
): Promise<void> {
  try {
    if (!job.dossierId) return;
    const dossier = await prisma.regulatoryDossier.findUnique({
      where: { id: job.dossierId },
      select: { reference: true, title: true },
    });
    const roles = (await getAppSettings().catch(sansBloquer("jobs-runner.notifyAiReviewOutcome.getAppSettings", null)))?.regulatorySupervisorRoles ?? [];
    await notifyRoles([...new Set([...roles, "SUPER_ADMIN"])] as never, {
      type: "GENERIC",
      title: msg.title,
      body: `${dossier ? `${dossier.reference} — ${dossier.title} : ` : ""}${msg.body}`,
      link: `/regulatory/enregistrement/analyse/${job.dossierId}`,
    });
  } catch (e) {
    console.error("[reg-ai] notification de fin de revue impossible", versionId, e);
  }
}

/**
 * DCI et fournisseur du dossier : ils affinent la recherche de précédents ANPP (« cette réserve,
 * l'avons-nous déjà eue SUR CETTE MOLÉCULE, chez CE fournisseur ? »). Un dossier sans produit
 * rattaché cherche sans filtre — moins précis, mais jamais bloquant.
 */
async function enrichmentContextOf(productId: string | null): Promise<EnrichmentContext> {
  if (!productId) return {};
  const p = await prisma.regulatoryProduct
    .findUnique({ where: { id: productId }, select: { dci: true, partnerLab: true } })
    .catch(sansBloquer("jobs-runner.enrichmentContextOf.regulatoryProduct", null));
  return { dci: p?.dci ?? null, supplier: p?.partnerLab ?? null };
}

/**
 * Attache à chaque constat les réserves ANPP comparables et la probabilité qu'elle revienne.
 *
 * Volontairement APRÈS la persistance et hors transaction : c'est un enrichissement, pas une
 * condition. Un échec ici laisse l'analyse complète et exploitable — on perd seulement la
 * mémoire des précédents, qu'un « Relancer l'analyse » rattrapera.
 *
 * ⚠️ Ces précédents n'aggravent jamais la sévérité d'un constat : « l'ANPP nous l'a déjà
 * reproché » informe la préparation, ce n'est pas une règle de droit.
 */
async function attachPrecedents(job: RegulatoryJob, versionId: string, ctx: EnrichmentContext): Promise<void> {
  try {
    const n = await enrichVersionFindings(versionId, ctx);
    if (n > 0) {
      await regAudit({
        companyId: job.companyId, actorId: "system", dossierId: job.dossierId, dossierVersionId: versionId,
        action: "FINDINGS_ENRICHED",
        detail: `${n} constat(s) rapproché(s) de réserves ANPP déjà reçues. Précédents à titre indicatif — aucune sévérité n'a été modifiée.`,
      });
    }
  } catch (err) {
    console.error("[reg-ai] rapprochement des précédents impossible", versionId, err);
  }
}
