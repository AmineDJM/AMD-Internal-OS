import type { CurrentUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { getBudgetOverview, getEnvelopesGrandTotal } from "@/lib/queries/budget";
import { rapportMarketing } from "@/lib/queries/budget-marketing-rapport";
import { buildBudgetWorkbook, budgetExportFilename, buildRapportMarketingWorkbook, csvDepensesMarketing, type ExportMarketing } from "@/lib/budget-export";
import { rendreRapportMarketingPdf } from "@/lib/budget-marketing/rapport-pdf";
import { construireDiapositivesMarketing } from "@/lib/budget-marketing/rapport-pptx";
import { recordAudit } from "@/lib/audit";
import { DOMAINES, DOMAINES_POLE, type PorteeBudget } from "@/lib/budget/domaines";
import {
  alertesBudget, disponible, filtresDepuis, libellePeriode, lignesParCategorie, pctPeriodeEcoulee, pourcent, rythme, vueFiltree,
} from "@/lib/budget/marketing-vue";
import { estIdentifiant } from "@/lib/exports/filtres";
import { exporte, MIME_CSV, MIME_PDF, MIME_PPTX, MIME_XLSX, refusExport, type ResultatExport } from "@/lib/exports/types";

/**
 * LES EXPORTS DU BUDGET — partagés par les boutons des écrans (`/api/budgets/export`, `/api/budgets/marketing/export`)
 * et l'Assistant IA (lot K7, décision 0037). L'accès à l'enveloppe est celui de l'écran (`getBudgetOverview` : une
 * enveloppe non ouverte à la personne → `null`), la portée celle du pôle.
 */

/** L'enveloppe désignée par son identifiant (l'écran) ou par son nom (l'assistant) — l'accès est rejugé par la vue. */
async function enveloppeDesignee(designation: string | null | undefined): Promise<string | null> {
  const d = (designation ?? "").trim();
  if (!d || estIdentifiant(d)) return d || null;
  const e = await prisma.budgetEnvelope.findFirst({
    where: { name: { contains: d, mode: "insensitive" } },
    orderBy: [{ isActive: "desc" }, { periodStart: "desc" }],
    select: { id: true },
  });
  return e?.id ?? "introuvable";
}

export interface OptionsExportBudget {
  enveloppe?: string | null;
  du?: Date | null;
  au?: Date | null;
  /** MARKETING / REGULATORY / OPERATIONS… — un budget de pôle exporte ses seules enveloppes. */
  portee?: string | null;
}

/** Export Excel du budget affiché + total des enveloppes, avec taux de consommation. */
export async function exporterBudget(user: CurrentUser, o: OptionsExportBudget = {}): Promise<ResultatExport> {
  const voitBudgets = userCan(user, "BUDGETS", "VIEW");
  // Les budgets de pôle que la personne ouvre (Marketing, Regulatory, Operations & Sales).
  const poles = DOMAINES_POLE.filter((p) => userCan(user, DOMAINES[p].module, "VIEW"));
  if (!voitBudgets && poles.length === 0) return refusExport(403, "Non autorisé.");
  const demande = (o.portee ?? "").toUpperCase();
  const pole = poles.find((p) => p === demande) ?? (voitBudgets ? null : poles[0]);
  const opts: { portee: PorteeBudget } = { portee: pole ?? "TOUT" };

  const overview = await getBudgetOverview(user, await enveloppeDesignee(o.enveloppe), o.du ?? null, o.au ?? null, opts);
  if (!overview) return refusExport(404, "Aucune enveloppe accessible.");
  const grandTotal = await getEnvelopesGrandTotal(user, opts);
  const buffer = buildBudgetWorkbook(overview, grandTotal);
  await recordAudit({ actorId: user.id, action: "EXPORT", module: "Budgets", summary: `Export Excel « ${overview.envelope.name} »` });
  return exporte(buffer, budgetExportFilename(overview.envelope.name), MIME_XLSX, `le budget « ${overview.envelope.name} »`);
}

export const FORMATS_MARKETING = {
  xlsx: { type: MIME_XLSX, ext: "xlsx" },
  csv: { type: MIME_CSV, ext: "csv" },
  pdf: { type: MIME_PDF, ext: "pdf" },
  pptx: { type: MIME_PPTX, ext: "pptx" },
} as const;
export type FormatMarketing = keyof typeof FORMATS_MARKETING;

export interface OptionsExportMarketing extends OptionsExportBudget {
  format?: string | null;
  /** Les filtres de la vue d'ensemble : premier et dernier mois (AAAA-MM), catégorie, comparaison N-1. */
  debut?: string | null;
  fin?: string | null;
  categorie?: string | null;
  n1?: boolean;
}

/**
 * EXPORTS DE LA VUE D'ENSEMBLE BUDGET MARKETING — Excel complet, rapport PDF, CSV des dépenses, diapositives PowerPoint,
 * sous les filtres de l'écran. Les mêmes faits et les mêmes calculs que l'écran (`budget/marketing-vue.ts`) : un export
 * ne peut pas dire autre chose que la page.
 */
export async function exporterBudgetMarketing(user: CurrentUser, o: OptionsExportMarketing = {}): Promise<ResultatExport> {
  if (!userCan(user, DOMAINES.MARKETING.module, "VIEW") && !userCan(user, "BUDGETS", "VIEW")) return refusExport(403, "Non autorisé.");
  const format = (o.format || "xlsx") as FormatMarketing;
  if (!(format in FORMATS_MARKETING)) return refusExport(400, "Format inconnu.");

  const overview = await getBudgetOverview(user, await enveloppeDesignee(o.enveloppe), o.du ?? null, o.au ?? null, { portee: "MARKETING" });
  if (!overview) return refusExport(404, "Aucune enveloppe marketing accessible.");
  const comparer = o.n1 === true;
  const { rapport, lignes } = await rapportMarketing(user, overview, { n1: comparer });
  // Une catégorie se donne par son identifiant (l'écran) ou par son nom (l'assistant).
  const cat = o.categorie ? (rapport.categories.find((c) => c.id === o.categorie || c.nom.toLowerCase() === o.categorie!.toLowerCase())?.id ?? o.categorie) : null;
  const filtres = filtresDepuis(rapport.moisEnveloppe, { debut: o.debut ?? null, fin: o.fin ?? null, cat }, rapport.categories);
  const vue = vueFiltree(rapport, filtres, comparer && rapport.n1 !== null);
  const lignesCategories = lignesParCategorie(rapport);
  const t = overview.totals;
  const ecoule = pctPeriodeEcoulee(new Date(overview.envelope.periodStart), new Date(overview.envelope.periodEnd), new Date());
  const utilise = pourcent(t.consumed + t.committed, t.total);
  const categorie = filtres.cat ? rapport.categories.find((c) => c.id === filtres.cat)?.nom ?? null : null;

  const e: ExportMarketing = {
    enveloppe: { nom: overview.envelope.name, total: t.total, debut: overview.envelope.periodStart, fin: overview.envelope.periodEnd },
    totaux: { paye: t.consumed, engage: t.committed, disponible: disponible(t.total, t.consumed, t.committed), utilisePct: utilise, ecoulePct: ecoule, rythme: rythme(utilise, ecoule).libelle },
    periode: libellePeriode(filtres, rapport.moisEnveloppe),
    categorie,
    comparer: comparer && rapport.n1 ? { annee: rapport.n1.annee } : null,
    lignesCategories,
    sansCategorie: rapport.sansCategorie,
    vue,
    depenses: lignes.filter((l) => l.mois >= filtres.debut && l.mois <= filtres.fin && (filtres.cat === null || l.categorieId === filtres.cat)),
    alertes: alertesBudget({ categories: lignesCategories, sansCategorie: rapport.sansCategorie, total: t.total }).map((a) => ({ titre: a.titre, detail: a.detail })),
  };

  const corps: Buffer | Uint8Array | string = format === "xlsx" ? buildRapportMarketingWorkbook(e)
    : format === "csv" ? csvDepensesMarketing(e.depenses)
      : format === "pdf" ? await rendreRapportMarketingPdf(e)
        : await construireDiapositivesMarketing(e);

  await recordAudit({ actorId: user.id, action: "EXPORT", module: DOMAINES.MARKETING.titre, summary: `Export ${format.toUpperCase()} « ${overview.envelope.name} » — ${e.periode}${categorie ? ` · ${categorie}` : ""}` });
  const nom = overview.envelope.name.replace(/[^\p{L}\p{N} _-]+/gu, "").trim().replace(/\s+/g, "-").slice(0, 60) || "budget";
  return exporte(corps, `budget-marketing-${nom}-${filtres.debut}_${filtres.fin}.${FORMATS_MARKETING[format].ext}`, FORMATS_MARKETING[format].type,
    `le budget marketing « ${overview.envelope.name} » — ${e.periode}${categorie ? ` · ${categorie}` : ""}`);
}
