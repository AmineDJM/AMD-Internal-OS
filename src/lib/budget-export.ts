import * as XLSX from "xlsx";
import type { BudgetOverview, EnvelopesGrandTotal } from "@/lib/queries/budget";
import type { LigneDepense } from "@/lib/queries/budget-marketing-rapport";
import type { LigneCategorie, VueFiltree } from "@/lib/budget/marketing-vue";

/**
 * EXPORT EXCEL (.xlsx) du budget avec le TAUX DE CONSOMMATION actuel. Feuille 1 : l'enveloppe
 * affichée (catégories + sous-catégories, alloué / consommé / engagé / reste / % consommé).
 * Feuille 2 (si fournie) : le total de toutes les enveloppes accessibles. Serveur uniquement.
 */

const rate = (consumed: number, base: number) => (base > 0 ? Math.round((consumed / base) * 100) : 0);
const day = (iso: string) => iso.slice(0, 10);

export function buildBudgetWorkbook(overview: BudgetOverview, grandTotal?: EnvelopesGrandTotal): Buffer {
  const wb = XLSX.utils.book_new();
  const env = overview.envelope;
  const t = overview.totals;
  const catNameById = new Map(overview.categories.map((c) => [c.id, c.name]));

  const rows: (string | number)[][] = [
    [`Enveloppe : ${env.name}`],
    [`Période : ${day(overview.period.from)} → ${day(overview.period.to)}`],
    [`Budget total : ${t.total}`, `Alloué : ${t.allocated}`, `Consommé : ${t.consumed}`, `Reste : ${t.remaining}`, `Taux global : ${t.pct} %`],
    [],
    ["Catégorie", "Sous-catégorie de", "Module", "Alloué (DZD)", "Consommé (DZD)", "Engagé (DZD)", "Reste (DZD)", "Taux consommation (%)"],
  ];
  for (const c of overview.categories) {
    rows.push([
      c.name,
      c.parentId ? catNameById.get(c.parentId) ?? "" : "",
      c.module ?? "",
      c.allocated, c.consumed, c.committed, c.remaining, rate(c.consumed, c.allocated),
    ]);
  }
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws["!cols"] = [{ wch: 30 }, { wch: 20 }, { wch: 24 }, { wch: 16 }, { wch: 16 }, { wch: 14 }, { wch: 16 }, { wch: 22 }];
  XLSX.utils.book_append_sheet(wb, ws, "Enveloppe");

  if (grandTotal && grandTotal.items.length > 0) {
    const gRows: (string | number)[][] = [
      ["Enveloppe", "Statut", "Budget (DZD)", "Alloué (DZD)", "Consommé (DZD)", "Reste (DZD)", "Taux consommation (%)"],
      ...grandTotal.items.map((i) => [i.name, i.isActive ? "Active" : "Archivée", i.total, i.allocated, i.consumed, i.remaining, rate(i.consumed, i.total)]),
      [],
      ["TOTAL", "", grandTotal.total, grandTotal.allocated, grandTotal.consumed, grandTotal.remaining, rate(grandTotal.consumed, grandTotal.total)],
    ];
    const gws = XLSX.utils.aoa_to_sheet(gRows);
    gws["!cols"] = [{ wch: 32 }, { wch: 12 }, { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 22 }];
    XLSX.utils.book_append_sheet(wb, gws, "Total enveloppes");
  }

  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

// ───────────────────────────── Budget Marketing — l'Excel complet ─────────────────────────────

/** Ce que les exports de la vue d'ensemble Budget Marketing reçoivent — la sélection de l'écran, déjà calculée. */
export interface ExportMarketing {
  enveloppe: { nom: string; total: number; debut: string; fin: string };
  /** Toute l'enveloppe (le compteur de l'écran). */
  totaux: { paye: number; engage: number; disponible: number; utilisePct: number; ecoulePct: number; rythme: string };
  periode: string;
  categorie: string | null;
  comparer: { annee: number } | null;
  lignesCategories: LigneCategorie[];
  sansCategorie: { total: number; count: number };
  vue: VueFiltree;
  depenses: LigneDepense[];
  alertes: { titre: string; detail: string }[];
}

const r0 = (n: number) => Math.round(n);

/**
 * L'EXCEL COMPLET de la vue d'ensemble Budget Marketing — cinq feuilles (synthèse, catégories, dépenses, demandes,
 * mois), sous les filtres de l'écran. Les montants de synthèse sont arrondis au dinar ; ceux des dépenses restent exacts.
 */
export function buildRapportMarketingWorkbook(e: ExportMarketing): Buffer {
  const wb = XLSX.utils.book_new();
  const v = e.vue;
  const synthese: (string | number)[][] = [
    [`Budget Marketing — ${e.enveloppe.nom}`],
    [`Enveloppe : ${day(e.enveloppe.debut)} → ${day(e.enveloppe.fin)}`],
    [`Sélection : ${e.periode}${e.categorie ? ` · ${e.categorie}` : ""}${e.comparer ? ` · comparée à ${e.comparer.annee}` : ""}`],
    [],
    ["Indicateur", "Montant (DZD)"],
    ["Enveloppe", r0(e.enveloppe.total)],
    ["Payé (toute l'enveloppe)", r0(e.totaux.paye)],
    ["Engagé, pas encore payé", r0(e.totaux.engage)],
    ["Disponible", r0(e.totaux.disponible)],
    ["Utilisé (%)", Math.round(e.totaux.utilisePct)],
    ["Année écoulée (%)", Math.round(e.totaux.ecoulePct)],
    ["Rythme", e.totaux.rythme],
    [],
    ["Sur la sélection", ""],
    ["Payé", r0(v.totaux.paye)],
    ["Engagé", r0(v.totaux.engage)],
    ...(v.totaux.payeN1 !== null && e.comparer ? [[`Payé ${e.comparer.annee} (même période)`, r0(v.totaux.payeN1)]] : []),
    ...(e.alertes.length ? [[], ["À traiter", ""], ...e.alertes.map((a) => [a.titre, a.detail])] : []),
  ];
  const ws1 = XLSX.utils.aoa_to_sheet(synthese);
  ws1["!cols"] = [{ wch: 44 }, { wch: 60 }];
  XLSX.utils.book_append_sheet(wb, ws1, "Synthèse");

  const payePeriode = new Map(v.barres.map((b) => [b.id, b]));
  const cats: (string | number)[][] = [
    ["Catégorie", "Alloué", "Payé (enveloppe)", "Engagé", "Reste", "Utilisé (%)", "Payé (sélection)", ...(e.comparer ? [`Payé ${e.comparer.annee} (sélection)`] : [])],
    ...e.lignesCategories
      .filter((l) => v.filtres.cat === null || l.id === v.filtres.cat)
      .map((l) => [l.nom, r0(l.alloue), r0(l.paye), r0(l.engage), r0(l.reste), Math.round(l.pct), r0(payePeriode.get(l.id)?.paye ?? 0), ...(e.comparer ? [r0(payePeriode.get(l.id)?.payeN1 ?? 0)] : [])]),
    ...(v.filtres.cat === null && e.sansCategorie.total > 0 ? [["Sans catégorie (à imputer)", "", r0(e.sansCategorie.total), "", "", "", ""]] : []),
  ];
  const ws2 = XLSX.utils.aoa_to_sheet(cats);
  ws2["!cols"] = [{ wch: 36 }, { wch: 14 }, { wch: 16 }, { wch: 14 }, { wch: 14 }, { wch: 12 }, { wch: 16 }, { wch: 18 }];
  XLSX.utils.book_append_sheet(wb, ws2, "Catégories");

  const dep: (string | number)[][] = [
    ["Date", "Référence", "Libellé", "Catégorie", "Nature", "Demande", "Origine", "Montant (DZD)"],
    ...e.depenses.map((d) => [d.date, d.reference, d.libelle, d.categorie, d.nature, d.demande, d.origine, d.montant]),
  ];
  const ws3 = XLSX.utils.aoa_to_sheet(dep);
  ws3["!cols"] = [{ wch: 12 }, { wch: 18 }, { wch: 44 }, { wch: 28 }, { wch: 24 }, { wch: 36 }, { wch: 16 }, { wch: 16 }];
  XLSX.utils.book_append_sheet(wb, ws3, "Dépenses");

  const dem: (string | number)[][] = [
    ["Demande", "Type", "Payé (sélection)", "Engagé", "Total", "Lien"],
    ...v.demandes.map((d) => [d.libelle, d.type, r0(d.paye), r0(d.engage), r0(d.total), d.href ?? ""]),
  ];
  const ws4 = XLSX.utils.aoa_to_sheet(dem);
  ws4["!cols"] = [{ wch: 44 }, { wch: 28 }, { wch: 16 }, { wch: 14 }, { wch: 14 }, { wch: 36 }];
  XLSX.utils.book_append_sheet(wb, ws4, "Demandes");

  const nomsCat = new Map(e.lignesCategories.map((l) => [l.id, l.nom]));
  const colonnes = [...new Set(v.mois.flatMap((m) => Object.keys(m.parCat)))];
  const mois: (string | number)[][] = [
    ["Mois", ...colonnes.map((c) => nomsCat.get(c) ?? "Sans catégorie"), "Payé du mois", "Cumul", "Rythme régulier", ...(e.comparer ? [`Cumul ${e.comparer.annee}`] : [])],
    ...v.mois.map((m) => [m.mois, ...colonnes.map((c) => r0(m.parCat[c] ?? 0)), r0(m.total), r0(m.cumul), r0(m.rythme), ...(e.comparer ? [r0(m.cumulN1 ?? 0)] : [])]),
  ];
  const ws5 = XLSX.utils.aoa_to_sheet(mois);
  ws5["!cols"] = [{ wch: 10 }, ...colonnes.map(() => ({ wch: 18 })), { wch: 14 }, { wch: 14 }, { wch: 16 }, { wch: 16 }];
  XLSX.utils.book_append_sheet(wb, ws5, "Mois");

  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

/** Le CSV des dépenses (séparateur « ; », virgule décimale, BOM : il s'ouvre tel quel dans un tableur français). */
export function csvDepensesMarketing(depenses: readonly LigneDepense[]): string {
  const cel = (s: string | number) => {
    const t = typeof s === "number" ? s.toFixed(2).replace(".", ",") : s;
    return /[";\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const lignes = [
    ["Date", "Référence", "Libellé", "Catégorie", "Nature", "Demande", "Origine", "Montant (DZD)"],
    ...depenses.map((d) => [d.date, d.reference, d.libelle, d.categorie, d.nature, d.demande, d.origine, d.montant]),
  ];
  return `﻿${lignes.map((l) => l.map(cel).join(";")).join("\r\n")}\r\n`;
}

/** Nom de fichier sûr pour l'export (nom d'enveloppe assaini + date du jour). */
export function budgetExportFilename(envelopeName: string): string {
  const safe = envelopeName.replace(/[^\p{L}\p{N} _-]+/gu, "").trim().replace(/\s+/g, "-").slice(0, 60) || "budget";
  return `budget-${safe}-${new Date().toISOString().slice(0, 10)}.xlsx`;
}
