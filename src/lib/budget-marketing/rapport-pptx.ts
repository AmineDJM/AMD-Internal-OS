import pptxgen from "pptxgenjs";
import { OTHER_COLOR, SERIES } from "@/components/charts/palette";
import { CLE_SANS } from "@/lib/budget/marketing-vue";
import type { ExportMarketing } from "@/lib/budget-export";

/**
 * BUDGET MARKETING — LES DIAPOSITIVES (vue d'ensemble, sous les filtres de l'écran). Serveur uniquement.
 *
 * Le modèle Adventum des présentations de la plateforme (`market-presentation-pptx.ts` : bandeau navy, filet teal, pied
 * « Adventum Pharma ») ; une diapositive de synthèse puis une par graphique — de VRAIS graphiques PowerPoint (pptxgenjs),
 * modifiables, pas des images.
 */

const NAVY = "0B2545";
const TEAL = "1B7F79";
const ACCENT = "E0A458";
const LIGHT = "F4F6F8";
const GREY = "5B6470";
const BLEU = "2A78D6";
const AMBRE = "EDA100";
const VIOLET = "7C5CD6";
const ROUGE = "B4451F";

const hex = (c: string) => c.replace("#", "").toUpperCase();
const nb = (n: number) => Math.round(n).toLocaleString("fr-FR").replace(/[  ]/g, " ");

function bandeau(slide: pptxgen.Slide, titre: string) {
  slide.addShape("rect", { x: 0, y: 0, w: "100%", h: 0.9, fill: { color: NAVY } });
  slide.addShape("rect", { x: 0, y: 0.9, w: "100%", h: 0.06, fill: { color: TEAL } });
  slide.addText(titre, { x: 0.5, y: 0.12, w: 12.3, h: 0.66, fontSize: 22, bold: true, color: "FFFFFF", valign: "middle" });
}

function pied(slide: pptxgen.Slide, selection: string) {
  slide.addText(
    [{ text: "Adventum Pharma", options: { bold: true, color: TEAL } }, { text: `  ·  Budget Marketing · ${selection}`, options: { color: GREY } }],
    { x: 0.5, y: 7.05, w: 12.3, h: 0.3, fontSize: 9 },
  );
}

export async function construireDiapositivesMarketing(e: ExportMarketing): Promise<Buffer> {
  const pptx = new pptxgen();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "Adventum Pharma";
  pptx.company = "Adventum Pharma";
  pptx.title = `Budget Marketing — ${e.enveloppe.nom}`;
  const v = e.vue;
  const selection = `${e.periode}${e.categorie ? ` · ${e.categorie}` : ""}${e.comparer ? ` · comparé à ${e.comparer.annee}` : ""}`;
  const ordre = e.lignesCategories.map((l) => l.id);
  const cCat = (id: string) => hex(id === CLE_SANS ? OTHER_COLOR : SERIES[Math.max(0, ordre.indexOf(id)) % SERIES.length]);

  // ── Titre ──
  const t = pptx.addSlide();
  t.background = { color: NAVY };
  t.addShape("rect", { x: 0, y: 3.15, w: 13.33, h: 0.06, fill: { color: ACCENT } });
  t.addText("BUDGET MARKETING", { x: 0.7, y: 2.15, w: 12, h: 0.5, fontSize: 16, color: ACCENT, charSpacing: 2, bold: true });
  t.addText(e.enveloppe.nom, { x: 0.7, y: 2.6, w: 12, h: 0.6, fontSize: 32, bold: true, color: "FFFFFF" });
  t.addText(
    [
      { text: "Adventum Pharma", options: { fontSize: 16, color: "FFFFFF", bold: true } },
      { text: `\n${selection}  ·  ${new Date().toLocaleDateString("fr-FR", { day: "2-digit", month: "long", year: "numeric" })}`, options: { fontSize: 13, color: "D8DEE6" } },
    ],
    { x: 0.7, y: 3.5, w: 12, h: 1.0 },
  );

  // ── Synthèse ──
  const s = pptx.addSlide();
  bandeau(s, "Où en est l'enveloppe");
  const kpis: [string, string, string?][] = [
    ["Disponible", `${nb(e.totaux.disponible)} DZD`, e.totaux.disponible < 0 ? ROUGE : NAVY],
    ["Enveloppe", `${nb(e.enveloppe.total)} DZD`],
    ["Payé", `${nb(e.totaux.paye)} DZD`],
    ["Engagé, pas encore payé", `${nb(e.totaux.engage)} DZD`],
  ];
  kpis.forEach(([label, val, c], i) => {
    const x = 0.5 + i * 3.1;
    s.addShape("roundRect", { x, y: 1.3, w: 2.9, h: 1.1, rectRadius: 0.06, fill: { color: LIGHT }, line: { color: "E1E6EB", width: 1 } });
    s.addText(label.toUpperCase(), { x: x + 0.12, y: 1.38, w: 2.7, h: 0.3, fontSize: 9, color: GREY, bold: true, charSpacing: 1 });
    s.addText(val, { x: x + 0.12, y: 1.7, w: 2.7, h: 0.55, fontSize: 18, bold: true, color: c ?? NAVY, valign: "middle" });
  });
  s.addText(`${e.totaux.rythme} — ${Math.round(e.totaux.utilisePct)} % utilisé, ${Math.round(e.totaux.ecoulePct)} % de l'année écoulée`, { x: 0.5, y: 2.6, w: 12.3, h: 0.4, fontSize: 14, color: TEAL, bold: true });
  if (e.alertes.length) {
    s.addText("À traiter", { x: 0.5, y: 3.15, w: 12.3, h: 0.35, fontSize: 14, bold: true, color: NAVY });
    s.addText(
      e.alertes.map((a) => ({ text: `${a.titre} — ${a.detail}`, options: { bullet: { code: "2022" }, color: "24303A" } })),
      { x: 0.6, y: 3.55, w: 12.2, h: 3.2, fontSize: 13, valign: "top", paraSpaceAfter: 6 },
    );
  }
  pied(s, selection);

  // ── Tableau par catégorie ──
  const tb = pptx.addSlide();
  bandeau(tb, "Par catégorie (toute l'enveloppe)");
  const entete = ["Catégorie", "Alloué", "Payé", "Engagé", "Reste", "%"].map((h) => ({ text: h, options: { bold: true, color: "FFFFFF", fill: { color: TEAL }, fontSize: 11, align: "center" as const } }));
  const corps = e.lignesCategories.map((l, i) => {
    const fill = i % 2 === 0 ? "FFFFFF" : LIGHT;
    const c = (text: string, align: "left" | "right" = "right", color = "222222") => ({ text, options: { fill: { color: fill }, fontSize: 10, align, color } });
    return [c(l.nom, "left"), c(nb(l.alloue)), c(nb(l.paye)), c(nb(l.engage)), c(nb(l.reste), "right", l.reste < 0 ? ROUGE : "222222"), c(l.alloue > 0 ? `${Math.round(l.pct)} %` : "—", "right", l.pct > 100 ? ROUGE : "222222")];
  });
  tb.addTable([entete, ...corps], { x: 0.5, y: 1.2, w: 12.3, colW: [4.3, 1.8, 1.8, 1.6, 1.8, 1.0], border: { type: "solid", color: "D5DAE0", pt: 0.5 }, autoPage: true, autoPageRepeatHeader: true, newSlideStartY: 1.2 });
  pied(tb, selection);

  const camembert = (titre: string, parts: { nom: string; valeur: number; couleur: string }[]) => {
    const sl = pptx.addSlide();
    bandeau(sl, titre);
    if (parts.length === 0) sl.addText("Rien sur cette sélection.", { x: 0.5, y: 3.3, w: 12.3, h: 0.5, fontSize: 14, color: GREY, align: "center" });
    else sl.addChart(pptx.ChartType.doughnut, [{ name: titre, labels: parts.map((p) => p.nom), values: parts.map((p) => Math.round(p.valeur)) }], {
      x: 0.8, y: 1.2, w: 11.7, h: 5.6, holeSize: 55, chartColors: parts.map((p) => p.couleur), showLegend: true, legendPos: "r", legendFontSize: 11,
      showPercent: true, showValue: false, dataLabelColor: "FFFFFF", dataLabelFontSize: 10,
    });
    pied(sl, selection);
  };
  camembert("Répartition de l'enveloppe", v.repartition.map((p) => ({ nom: p.nom, valeur: p.valeur, couleur: cCat(p.id) })));
  camembert("Payé par catégorie", v.payeParCat.map((p) => ({ nom: p.nom, valeur: p.valeur, couleur: cCat(p.id) })));
  camembert("Par nature de dépense", v.natures.map((n, i) => ({ nom: n.nature, valeur: n.montant, couleur: hex(n.nature === "Non renseignée" ? OTHER_COLOR : SERIES[i % SERIES.length]) })));

  // ── Alloué / payé / engagé ──
  const b = pptx.addSlide();
  bandeau(b, "Alloué, payé et engagé par catégorie");
  if (v.barres.length) {
    const noms = v.barres.map((x) => x.nom);
    b.addChart(pptx.ChartType.bar, [
      { name: "Alloué", labels: noms, values: v.barres.map((x) => Math.round(x.alloue)) },
      { name: "Payé", labels: noms, values: v.barres.map((x) => Math.round(x.paye)) },
      { name: "Engagé", labels: noms, values: v.barres.map((x) => Math.round(x.engage)) },
      ...(e.comparer ? [{ name: `Payé ${e.comparer.annee}`, labels: noms, values: v.barres.map((x) => Math.round(x.payeN1 ?? 0)) }] : []),
    ], {
      x: 0.5, y: 1.2, w: 12.3, h: 5.7, barDir: "bar", barGrouping: "clustered", chartColors: ["C9D1DC", BLEU, AMBRE, VIOLET],
      showLegend: true, legendPos: "b", catAxisLabelFontSize: 10, valAxisLabelFontSize: 9, valAxisLabelFormatCode: "#,##0",
    });
  }
  pied(b, selection);

  // ── Payé par mois ──
  const m = pptx.addSlide();
  bandeau(m, "Payé par mois, cumul et rythme régulier");
  if (v.mois.length) {
    const labels = v.mois.map((x) => x.libelle);
    const cats = [...new Set(v.mois.flatMap((x) => Object.keys(x.parCat)))];
    const nom = (id: string) => (id === CLE_SANS ? "Sans catégorie" : e.lignesCategories.find((l) => l.id === id)?.nom ?? "—");
    // Graphique combiné (barres + courbes) : pptxgenjs prend alors (types, options) — sa déclaration ne le dit pas.
    (m.addChart as unknown as (types: pptxgen.IChartMulti[], options: pptxgen.IChartOpts) => pptxgen.Slide).call(m,
      [
        {
          type: pptx.ChartType.bar,
          data: cats.map((c) => ({ name: nom(c), labels, values: v.mois.map((x) => Math.round(x.parCat[c] ?? 0)) })),
          options: { barGrouping: "stacked", chartColors: cats.map(cCat) },
        },
        {
          type: pptx.ChartType.line,
          data: [
            { name: "Cumul payé", labels, values: v.mois.map((x) => Math.round(x.cumul)) },
            { name: "Rythme régulier", labels, values: v.mois.map((x) => Math.round(x.rythme)) },
            ...(e.comparer ? [{ name: `Cumul ${e.comparer.annee}`, labels, values: v.mois.map((x) => Math.round(x.cumulN1 ?? 0)) }] : []),
          ],
          options: { chartColors: [NAVY, "9AA3AE", VIOLET], secondaryValAxis: true, secondaryCatAxis: true },
        },
      ] as unknown as pptxgen.IChartMulti[],
      {
        x: 0.5, y: 1.2, w: 12.3, h: 5.7, showLegend: true, legendPos: "b", valAxisLabelFormatCode: "#,##0",
        valAxes: [{ showValAxisTitle: true, valAxisTitle: "Payé du mois" }, { showValAxisTitle: true, valAxisTitle: "Cumul", valGridLine: { style: "none" } }],
        catAxes: [{ catAxisTitle: "Mois" }, { catAxisHidden: true }],
      } as pptxgen.IChartOpts,
    );
  }
  pied(m, selection);

  // ── Top demandes ──
  const d = pptx.addSlide();
  bandeau(d, "Les 8 demandes qui pèsent le plus");
  if (v.top.length) {
    const noms = v.top.map((x) => (x.libelle.length > 48 ? `${x.libelle.slice(0, 47)}…` : x.libelle));
    d.addChart(pptx.ChartType.bar, [
      { name: "Payé", labels: noms, values: v.top.map((x) => Math.round(x.paye)) },
      { name: "Engagé", labels: noms, values: v.top.map((x) => Math.round(x.engage)) },
    ], { x: 0.5, y: 1.2, w: 12.3, h: 5.7, barDir: "bar", barGrouping: "stacked", chartColors: [BLEU, AMBRE], showLegend: true, legendPos: "b", catAxisLabelFontSize: 10, valAxisLabelFormatCode: "#,##0" });
  } else {
    d.addText("Aucune demande Ad & Pro sur cette sélection.", { x: 0.5, y: 3.3, w: 12.3, h: 0.5, fontSize: 14, color: GREY, align: "center" });
  }
  pied(d, selection);

  return (await pptx.write({ outputType: "nodebuffer" })) as Buffer;
}
