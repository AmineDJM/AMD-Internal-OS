import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { getBudgetOverview } from "@/lib/queries/budget";
import { rapportMarketing } from "@/lib/queries/budget-marketing-rapport";
import { buildRapportMarketingWorkbook, csvDepensesMarketing, type ExportMarketing } from "@/lib/budget-export";
import { rendreRapportMarketingPdf } from "@/lib/budget-marketing/rapport-pdf";
import { construireDiapositivesMarketing } from "@/lib/budget-marketing/rapport-pptx";
import { recordAudit } from "@/lib/audit";
import { contentDisposition } from "@/lib/http/content-disposition";
import { DOMAINES } from "@/lib/budget/domaines";
import {
  alertesBudget, disponible, filtresDepuis, libellePeriode, lignesParCategorie, pctPeriodeEcoulee, pourcent, rythme, vueFiltree,
} from "@/lib/budget/marketing-vue";

/**
 * EXPORTS DE LA VUE D'ENSEMBLE BUDGET MARKETING — Excel complet, rapport PDF, CSV des dépenses, diapositives PowerPoint,
 * sous les filtres de l'écran (`debut`, `fin`, `cat`, `n1`). Les mêmes faits et les mêmes calculs que l'écran
 * (`budget/marketing-vue.ts`) : un export ne peut pas dire autre chose que la page.
 */

const FORMATS = {
  xlsx: { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ext: "xlsx" },
  csv: { type: "text/csv; charset=utf-8", ext: "csv" },
  pdf: { type: "application/pdf", ext: "pdf" },
  pptx: { type: "application/vnd.openxmlformats-officedocument.presentationml.presentation", ext: "pptx" },
} as const;
type Format = keyof typeof FORMATS;

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  if (!userCan(user, DOMAINES.MARKETING.module, "VIEW") && !userCan(user, "BUDGETS", "VIEW")) return NextResponse.json({ error: "Non autorisé." }, { status: 403 });

  const sp = req.nextUrl.searchParams;
  const format = (sp.get("format") ?? "xlsx") as Format;
  if (!(format in FORMATS)) return NextResponse.json({ error: "Format inconnu." }, { status: 400 });
  const from = sp.get("from") ? new Date(sp.get("from")!) : null;
  const to = sp.get("to") ? new Date(sp.get("to")!) : null;

  // L'accès à l'enveloppe est vérifié ici (une enveloppe non ouverte → null), et la portée reste celle du pôle.
  const overview = await getBudgetOverview(user, sp.get("env"), from, to, { portee: "MARKETING" });
  if (!overview) return NextResponse.json({ error: "Aucune enveloppe marketing accessible." }, { status: 404 });
  const comparer = sp.get("n1") === "1";
  const { rapport, lignes } = await rapportMarketing(user, overview, { n1: comparer });
  const filtres = filtresDepuis(rapport.moisEnveloppe, { debut: sp.get("debut"), fin: sp.get("fin"), cat: sp.get("cat") }, rapport.categories);
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

  const corps: Buffer | string = format === "xlsx" ? buildRapportMarketingWorkbook(e)
    : format === "csv" ? csvDepensesMarketing(e.depenses)
      : format === "pdf" ? await rendreRapportMarketingPdf(e)
        : await construireDiapositivesMarketing(e);

  await recordAudit({ actorId: user.id, action: "EXPORT", module: DOMAINES.MARKETING.titre, summary: `Export ${format.toUpperCase()} « ${overview.envelope.name} » — ${e.periode}${categorie ? ` · ${categorie}` : ""}` });
  const nom = overview.envelope.name.replace(/[^\p{L}\p{N} _-]+/gu, "").trim().replace(/\s+/g, "-").slice(0, 60) || "budget";
  return new NextResponse(corps as unknown as BodyInit, {
    headers: {
      "Content-Type": FORMATS[format].type,
      "Content-Disposition": contentDisposition(`budget-marketing-${nom}-${filtres.debut}_${filtres.fin}.${FORMATS[format].ext}`),
      "Cache-Control": "no-store",
    },
  });
}
