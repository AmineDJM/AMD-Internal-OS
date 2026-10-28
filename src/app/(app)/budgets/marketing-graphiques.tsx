"use client";

/**
 * BUDGET MARKETING — LES SIX GRAPHIQUES DE LA VUE D'ENSEMBLE (maquettes validées, Direction 10/2026 : la vue d'ensemble,
 * puis les « onglets » — plus de camembert : deux barres à 100 %, un classement par nature, le cumul sur son graphique).
 *
 * Ils lisent tous la MÊME `VueFiltree` (période, catégorie, comparaison N-1) : un filtre change les six à la fois. Les
 * couleurs se lisent sur le thème de la page (jetons CSS) au moment du dessin, et se relisent quand le thème change.
 * Chaque graphique s'exporte en PNG — titre, dessin et légende chiffrée.
 */

import * as React from "react";
import {
  Area, Bar, BarChart, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { ImageDown } from "lucide-react";
import { OTHER_COLOR, SERIES } from "@/components/charts/palette";
import { CLE_SANS, LIBELLE_SANS, type VueFiltree } from "@/lib/budget/marketing-vue";

// ───────────────────────────── Couleurs du thème ─────────────────────────────

export interface Couleurs {
  fg: string; muted: string; border: string; card: string; primary: string; warning: string; danger: string; success: string; violet: string;
}

const PAR_DEFAUT: Couleurs = {
  fg: "hsl(217 33% 12%)", muted: "hsl(216 14% 47%)", border: "hsl(218 27% 92%)", card: "#ffffff", primary: "hsl(215 100% 54%)",
  warning: "hsl(35 88% 45%)", danger: "hsl(356 68% 51%)", success: "hsl(152 56% 36%)", violet: "hsl(258 70% 58%)",
};

function lireCouleurs(): Couleurs {
  if (typeof window === "undefined") return PAR_DEFAUT;
  const s = getComputedStyle(document.documentElement);
  const v = (nom: string, defaut: string) => { const x = s.getPropertyValue(nom).trim(); return x ? `hsl(${x})` : defaut; };
  return {
    fg: v("--foreground", PAR_DEFAUT.fg), muted: v("--muted-foreground", PAR_DEFAUT.muted), border: v("--border", PAR_DEFAUT.border),
    card: v("--card", PAR_DEFAUT.card), primary: v("--primary", PAR_DEFAUT.primary), warning: v("--warning", PAR_DEFAUT.warning),
    danger: v("--destructive", PAR_DEFAUT.danger), success: v("--success", PAR_DEFAUT.success), violet: PAR_DEFAUT.violet,
  };
}

/** Les couleurs du thème courant — relues quand la page change de thème (classe, attribut, préférence système). */
export function useCouleurs(): Couleurs {
  const [c, setC] = React.useState<Couleurs>(PAR_DEFAUT);
  React.useEffect(() => {
    const relire = () => setC(lireCouleurs());
    relire();
    const obs = new MutationObserver(relire);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    mq?.addEventListener?.("change", relire);
    return () => { obs.disconnect(); mq?.removeEventListener?.("change", relire); };
  }, []);
  return c;
}

export const fmt = (n: number): string => Math.round(n).toLocaleString("fr-FR");
const fmtM = (n: number): string => (Math.abs(n) >= 1e6 ? `${(n / 1e6).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} M` : Math.abs(n) >= 1e3 ? `${Math.round(n / 1e3).toLocaleString("fr-FR")} k` : fmt(n));
const court = (s: string, n = 32) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** La couleur stable d'une catégorie (l'ordre de l'enveloppe, palette validée ; « Sans catégorie » en neutre). */
export function couleurDeCategorie(ordre: readonly string[]): (id: string) => string {
  return (id) => (id === CLE_SANS ? OTHER_COLOR : SERIES[ordre.indexOf(id) % SERIES.length] ?? OTHER_COLOR);
}

// ───────────────────────────── Export PNG ─────────────────────────────

export interface EntreeLegende { label: string; color: string; valeur?: string }

async function exporterPng(conteneur: HTMLElement | null, titre: string, legende: EntreeLegende[], c: Couleurs, fichier: string): Promise<void> {
  const svg = conteneur?.querySelector("svg.recharts-surface") as SVGSVGElement | null;
  if (!svg) return;
  const { width, height } = svg.getBoundingClientRect();
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(width));
  clone.setAttribute("height", String(height));
  clone.setAttribute("style", "font-family: Inter, ui-sans-serif, system-ui, sans-serif; font-size: 12px");
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(clone))}`;
  await img.decode();

  const echelle = 2, marge = 20, ligne = 20;
  const largeur = Math.max(width, 480) + marge * 2;
  const ctx0 = document.createElement("canvas").getContext("2d");
  if (!ctx0) return;
  ctx0.font = "12px Inter, ui-sans-serif, system-ui, sans-serif";
  // La légende se range en lignes, comme à l'écran.
  const lignes: EntreeLegende[][] = [[]];
  let x = 0;
  for (const e of legende) {
    const w = 18 + ctx0.measureText(`${e.label}${e.valeur ? ` ${e.valeur}` : ""}`).width + 18;
    if (x + w > largeur - marge * 2 && lignes[lignes.length - 1].length) { lignes.push([]); x = 0; }
    lignes[lignes.length - 1].push(e);
    x += w;
  }
  const hauteur = marge + 26 + height + (legende.length ? lignes.length * ligne + 10 : 0) + marge;
  const canvas = document.createElement("canvas");
  canvas.width = largeur * echelle;
  canvas.height = hauteur * echelle;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.scale(echelle, echelle);
  ctx.fillStyle = c.card;
  ctx.fillRect(0, 0, largeur, hauteur);
  ctx.fillStyle = c.fg;
  ctx.font = "600 15px Inter, ui-sans-serif, system-ui, sans-serif";
  ctx.fillText(titre, marge, marge + 14);
  ctx.drawImage(img, marge, marge + 26, width, height);
  ctx.font = "12px Inter, ui-sans-serif, system-ui, sans-serif";
  let y = marge + 26 + height + 18;
  for (const l of lignes) {
    x = marge;
    for (const e of l) {
      ctx.fillStyle = e.color;
      ctx.fillRect(x, y - 9, 10, 10);
      ctx.fillStyle = c.fg;
      const t = `${e.label}${e.valeur ? ` ${e.valeur}` : ""}`;
      ctx.fillText(t, x + 16, y);
      x += 18 + ctx.measureText(t).width + 18;
    }
    y += ligne;
  }
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
  if (!blob) return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fichier;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export type RegistreExports = React.MutableRefObject<Map<string, () => Promise<void>>>;

const nomFichier = (titre: string) => `${titre.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase()}.png`;

function Legende({ entrees }: { entrees: EntreeLegende[] }) {
  if (entrees.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 px-4 pb-3 text-xs">
      {entrees.map((e) => (
        <li key={e.label} className="inline-flex min-w-0 items-center gap-1.5">
          <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: e.color }} />
          <span className="truncate">{e.label}</span>
          {e.valeur && <b className="font-medium tabular-nums">{e.valeur}</b>}
        </li>
      ))}
    </ul>
  );
}

function CarteGraphique({ id, titre, legende, couleurs, registre, hauteur, large, vide, children }: {
  id: string; titre: string; legende: EntreeLegende[]; couleurs: Couleurs; registre: RegistreExports; hauteur: number; large?: boolean; vide?: boolean;
  children: React.ReactElement;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const exporter = React.useCallback(() => exporterPng(ref.current, titre, legende, couleurs, nomFichier(titre)), [titre, legende, couleurs]);
  React.useEffect(() => {
    const r = registre.current;
    if (vide) { r.delete(id); return; }
    r.set(id, exporter);
    return () => { r.delete(id); };
  }, [id, exporter, registre, vide]);
  return (
    <section className={`surface min-w-0 overflow-hidden rounded-xl ${large ? "lg:col-span-2" : ""}`}>
      <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <h2 className="text-sm font-semibold">{titre}</h2>
        {!vide && (
          <button type="button" onClick={() => void exporter()} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-secondary" aria-label={`Exporter « ${titre} » en image PNG`}>
            <ImageDown className="h-3.5 w-3.5" /> PNG
          </button>
        )}
      </header>
      {vide ? (
        <p className="px-4 py-8 text-center text-sm text-muted-foreground">Rien sur cette sélection.</p>
      ) : (
        <>
          <div ref={ref} className="px-2 pt-3" style={{ height: hauteur }}>
            <ResponsiveContainer width="100%" height="100%">{children}</ResponsiveContainer>
          </div>
          <Legende entrees={legende} />
        </>
      )}
    </section>
  );
}

function infobulle(c: Couleurs) {
  return {
    contentStyle: { background: c.card, border: `1px solid ${c.border}`, borderRadius: 10, fontSize: 12, color: c.fg },
    itemStyle: { color: c.fg },
    labelStyle: { color: c.fg, fontWeight: 600 },
    formatter: (v: number, n: string) => [`${fmt(Number(v))} DZD`, n] as [string, string],
  };
}

// ───────────────────────────── Les six graphiques ─────────────────────────────

/**
 * Les six graphiques de la vue d'ensemble (maquette « onglets » validée, 10/2026). Les trois camemberts deviennent :
 * DEUX BARRES À 100 % (alloué au-dessus du payé, mêmes couleurs : on voit où l'argent va par rapport à ce qui était
 * prévu) et un CLASSEMENT par nature ; le cumul payé face au rythme régulier a SON graphique, à sa propre échelle.
 */
export function GraphiquesMarketing({ vue, vueToutes, couleurCat, couleurs, registre, comparer, anneeN1, moisCourant }: {
  /** La sélection (période + catégorie). */
  vue: VueFiltree;
  /** La même période, toutes catégories (les barres à 100 % grisent ce qui n'est pas sélectionné). */
  vueToutes: VueFiltree;
  couleurCat: (id: string) => string;
  couleurs: Couleurs;
  registre: RegistreExports;
  comparer: boolean;
  anneeN1: number | null;
  /** Le mois du jour (« 2026-10 ») : le repère d'aujourd'hui, et la fin du cumul. */
  moisCourant: string;
}) {
  const cat = vue.filtres.cat;
  const grise = (id: string) => (cat !== null && id !== cat ? couleurs.border : couleurCat(id));

  // 1. Alloué et payé : deux barres à 100 %, une couleur par catégorie (« Sans catégorie » en neutre, côté payé).
  const nomCat = new Map([...vueToutes.barres.map((b) => [b.id, b.nom] as const), ...vueToutes.repartition.map((p) => [p.id, p.nom] as const), [CLE_SANS, LIBELLE_SANS] as const]);
  const idsRep = [...new Set([...vueToutes.repartition.map((p) => p.id), ...vueToutes.payeParCat.map((p) => p.id)])]
    .sort((a, b) => (a === CLE_SANS ? 1 : b === CLE_SANS ? -1 : 0));
  const alloueDe = new Map(vueToutes.repartition.map((p) => [p.id, p.valeur]));
  const payeDe = new Map(vueToutes.payeParCat.map((p) => [p.id, p.valeur]));
  const totalAlloue = vueToutes.repartition.reduce((a, p) => a + p.valeur, 0);
  const totalPaye = vueToutes.payeParCat.reduce((a, p) => a + p.valeur, 0);
  const donneesRep = [
    { ligne: "Alloué", ...Object.fromEntries(idsRep.map((id) => [id, alloueDe.get(id) ?? 0])) },
    { ligne: "Payé", ...Object.fromEntries(idsRep.map((id) => [id, payeDe.get(id) ?? 0])) },
  ];
  const couleurRep = (id: string) => (id === CLE_SANS ? (cat === null ? OTHER_COLOR : couleurs.border) : grise(id));
  const legRep = idsRep.map((id) => ({ label: nomCat.get(id) ?? "—", color: couleurRep(id), valeur: `${fmtM(alloueDe.get(id) ?? 0)} · ${fmtM(payeDe.get(id) ?? 0)}` }));

  // 2. La nature : un classement, du plus gros au plus petit.
  const donneesNature = vue.natures.map((n) => ({ nom: n.nature, montant: n.montant }));
  const totalNature = vue.natures.reduce((a, n) => a + n.montant, 0);
  const legNature: EntreeLegende[] = [{ label: "Payé sur la période", color: couleurs.primary, valeur: `${fmt(totalNature)} DZD` }];

  // 3. Alloué / payé / engagé par catégorie.
  const legBarres: EntreeLegende[] = [
    { label: "Alloué", color: couleurs.border }, { label: "Payé", color: couleurs.primary }, { label: "Engagé", color: couleurs.warning },
    ...(comparer && anneeN1 ? [{ label: `Payé ${anneeN1}`, color: couleurs.violet }] : []),
  ];
  // 4. Payé par mois et par catégorie (barres empilées seules : le cumul a son graphique).
  const catsDuMois = [...new Set(vue.mois.flatMap((m) => Object.keys(m.parCat)))]
    .sort((a, b) => (a === CLE_SANS ? 1 : b === CLE_SANS ? -1 : 0));
  const donneesMois = vue.mois.map((m) => ({ libelle: m.libelle, ...m.parCat }));
  const legMois: EntreeLegende[] = catsDuMois.map((id) => ({ label: nomCat.get(id) ?? "—", color: couleurCat(id) }));
  const libelleDuJour = vue.mois.find((m) => m.mois === moisCourant)?.libelle ?? null;
  // 5. Le cumul payé face au rythme régulier — le cumul s'arrête au mois du jour (l'avenir n'est pas payé).
  const donneesCumul = vue.mois.map((m) => ({
    libelle: m.libelle, rythme: Math.round(m.rythme),
    ...(m.mois <= moisCourant ? { cumul: m.cumul } : {}),
    ...(m.cumulN1 !== undefined ? { cumulN1: m.cumulN1 } : {}),
  }));
  const dernier = [...vue.mois].reverse().find((m) => m.mois <= moisCourant);
  const base = vue.mois.length ? vue.mois[vue.mois.length - 1].rythme : 0;
  const legCumul: EntreeLegende[] = [
    { label: "Payé cumulé", color: couleurs.primary, valeur: dernier ? `${fmtM(dernier.cumul)} fin ${dernier.libelle}` : undefined },
    { label: "Rythme régulier", color: couleurs.muted, valeur: `${fmtM(base)} sur ${vue.mois.length} mois` },
    ...(comparer && anneeN1 ? [{ label: `Cumul ${anneeN1}`, color: couleurs.violet }] : []),
  ];
  // 6. Les plus grosses demandes.
  const donneesTop = vue.top.map((d) => ({ nom: court(d.libelle, 38), paye: d.paye, engage: d.engage }));
  const legTop: EntreeLegende[] = [{ label: "Payé", color: couleurs.primary }, { label: "Engagé", color: couleurs.warning }];

  const axe = { stroke: couleurs.muted, fontSize: 11, tickLine: false, axisLine: false } as const;
  const tip = infobulle(couleurs);
  const repere = (yAxisId?: string) => (libelleDuJour
    ? <ReferenceLine x={libelleDuJour} {...(yAxisId ? { yAxisId } : {})} stroke={couleurs.fg} strokeDasharray="3 3" strokeOpacity={0.6} label={{ value: "aujourd'hui", position: "insideTopRight", fill: couleurs.muted, fontSize: 10 }} />
    : null);

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <CarteGraphique id="repartition" titre="Répartition : alloué et payé" legende={legRep} couleurs={couleurs} registre={registre} hauteur={150} vide={totalAlloue <= 0.5 && totalPaye <= 0.5}>
        <BarChart data={donneesRep} layout="vertical" stackOffset="expand" margin={{ top: 4, right: 12, left: 4, bottom: 4 }} barCategoryGap="28%">
          <XAxis type="number" tickFormatter={(v: number) => `${Math.round(v * 100)} %`} {...axe} />
          <YAxis type="category" dataKey="ligne" width={52} {...axe} stroke={couleurs.fg} />
          <Tooltip {...tip} cursor={{ fill: couleurs.border, opacity: 0.4 }} />
          {idsRep.map((id) => <Bar key={id} dataKey={id} name={nomCat.get(id) ?? "—"} stackId="r" fill={couleurRep(id)} isAnimationActive={false} />)}
        </BarChart>
      </CarteGraphique>

      <CarteGraphique id="nature" titre="Par nature de dépense" legende={legNature} couleurs={couleurs} registre={registre} hauteur={Math.max(150, 30 + donneesNature.length * 30)} vide={donneesNature.length === 0}>
        <BarChart data={donneesNature} layout="vertical" margin={{ top: 4, right: 16, left: 4, bottom: 4 }} barCategoryGap="25%">
          <CartesianGrid horizontal={false} stroke={couleurs.border} />
          <XAxis type="number" tickFormatter={fmtM} {...axe} />
          <YAxis type="category" dataKey="nom" width={150} tickFormatter={(s: string) => court(s, 22)} {...axe} stroke={couleurs.fg} />
          <Tooltip {...tip} cursor={{ fill: couleurs.border, opacity: 0.4 }} />
          <Bar dataKey="montant" name="Payé" fill={couleurs.primary} radius={[0, 4, 4, 0]} isAnimationActive={false} />
        </BarChart>
      </CarteGraphique>

      <CarteGraphique id="mois" titre="Payé par mois et par catégorie" legende={legMois} couleurs={couleurs} registre={registre} hauteur={260} vide={donneesMois.length === 0}>
        <BarChart data={donneesMois} margin={{ top: 14, right: 8, left: 4, bottom: 4 }}>
          <CartesianGrid vertical={false} stroke={couleurs.border} />
          <XAxis dataKey="libelle" {...axe} />
          <YAxis tickFormatter={fmtM} width={52} {...axe} />
          <Tooltip {...tip} cursor={{ fill: couleurs.border, opacity: 0.4 }} />
          {catsDuMois.map((id) => (
            <Bar key={id} dataKey={id} name={nomCat.get(id) ?? "—"} stackId="m" fill={couleurCat(id)} isAnimationActive={false} />
          ))}
          {repere()}
        </BarChart>
      </CarteGraphique>

      <CarteGraphique id="cumul" titre="Cumul payé face au rythme régulier" legende={legCumul} couleurs={couleurs} registre={registre} hauteur={260} vide={donneesCumul.length === 0}>
        <ComposedChart data={donneesCumul} margin={{ top: 14, right: 8, left: 4, bottom: 4 }}>
          <CartesianGrid vertical={false} stroke={couleurs.border} />
          <XAxis dataKey="libelle" {...axe} />
          <YAxis tickFormatter={fmtM} width={52} {...axe} />
          <Tooltip {...tip} />
          <Area type="linear" dataKey="cumul" name="Payé cumulé" stroke={couleurs.primary} strokeWidth={2.2} fill={couleurs.primary} fillOpacity={0.1} dot={{ r: 2.5, fill: couleurs.primary }} connectNulls={false} isAnimationActive={false} />
          <Line type="linear" dataKey="rythme" name="Rythme régulier" stroke={couleurs.muted} strokeDasharray="5 4" dot={false} isAnimationActive={false} />
          {comparer && anneeN1 && <Line type="monotone" dataKey="cumulN1" name={`Cumul ${anneeN1}`} stroke={couleurs.violet} strokeWidth={2} dot={false} isAnimationActive={false} />}
          {repere()}
        </ComposedChart>
      </CarteGraphique>

      <CarteGraphique id="categories" titre="Alloué, payé et engagé par catégorie" legende={legBarres} couleurs={couleurs} registre={registre} hauteur={Math.max(180, 56 + vue.barres.length * (comparer ? 56 : 42))} large vide={vue.barres.length === 0}>
        <BarChart data={vue.barres} layout="vertical" margin={{ top: 4, right: 16, left: 8, bottom: 4 }} barCategoryGap="22%">
          <CartesianGrid horizontal={false} stroke={couleurs.border} />
          <XAxis type="number" tickFormatter={fmtM} {...axe} />
          <YAxis type="category" dataKey="nom" width={170} tickFormatter={(s: string) => court(s, 26)} {...axe} stroke={couleurs.fg} />
          <Tooltip {...tip} cursor={{ fill: couleurs.border, opacity: 0.4 }} />
          <Bar dataKey="alloue" name="Alloué" stackId="a" fill={couleurs.border} radius={[0, 4, 4, 0]} isAnimationActive={false} />
          <Bar dataKey="paye" name="Payé" stackId="b" fill={couleurs.primary} isAnimationActive={false} />
          <Bar dataKey="engage" name="Engagé" stackId="b" fill={couleurs.warning} radius={[0, 4, 4, 0]} isAnimationActive={false} />
          {comparer && anneeN1 && <Bar dataKey="payeN1" name={`Payé ${anneeN1}`} stackId="c" fill={couleurs.violet} radius={[0, 4, 4, 0]} isAnimationActive={false} />}
        </BarChart>
      </CarteGraphique>

      <CarteGraphique id="demandes" titre="Les 8 demandes qui pèsent le plus" legende={legTop} couleurs={couleurs} registre={registre} hauteur={Math.max(160, 40 + donneesTop.length * 36)} large vide={donneesTop.length === 0}>
        <BarChart data={donneesTop} layout="vertical" margin={{ top: 4, right: 16, left: 8, bottom: 4 }} barCategoryGap="25%">
          <CartesianGrid horizontal={false} stroke={couleurs.border} />
          <XAxis type="number" tickFormatter={fmtM} {...axe} />
          <YAxis type="category" dataKey="nom" width={190} tickFormatter={(s: string) => court(s, 30)} {...axe} stroke={couleurs.fg} />
          <Tooltip {...tip} cursor={{ fill: couleurs.border, opacity: 0.4 }} />
          <Bar dataKey="paye" name="Payé" stackId="t" fill={couleurs.primary} isAnimationActive={false} />
          <Bar dataKey="engage" name="Engagé" stackId="t" fill={couleurs.warning} radius={[0, 4, 4, 0]} isAnimationActive={false} />
        </BarChart>
      </CarteGraphique>
    </div>
  );
}
