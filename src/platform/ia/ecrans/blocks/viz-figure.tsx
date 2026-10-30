"use client";

import * as React from "react";
import type { VizArbre, VizDonnees, VizType, WorkspaceBlock, WorkspaceTone } from "@/platform/ia/workspace/protocol";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA FIGURE GÉNÉRIQUE (mandat 5 §35) — UN rendu pour dix-sept formes, et pas un composant par
 * graphique. La forme est une DONNÉE (`b.type`) ; ce fichier la dessine en SVG (ou en HTML quand
 * l'HTML se lit mieux : matrice, arbre, indicateurs). Il ne connaît ni le Drive, ni la session,
 * ni Next : rien que des nombres, des libellés et des jetons de couleur du thème.
 *
 * Trois règles de dessin, tenues ici et nulle part ailleurs :
 *   • une barre part TOUJOURS de zéro — la hauteur est la valeur ; seule une courbe peut avoir un
 *     axe qui ne part pas de zéro, et alors elle le DIT sous l'axe ;
 *   • sur téléphone, les séries se lisent en liste proportionnelle (un SVG réduit n'est pas lu) ;
 *   • chaque figure porte ses données (`<details>Données</details>`) et un `<title>` par élément :
 *     ce qui se voit se relit, et un lecteur d'écran a la même information.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

type Bloc = Extract<WorkspaceBlock, { kind: "viz" }>;
type Serie = NonNullable<VizDonnees["series"]>[number];

const W = 640;
const COULEURS = [
  "hsl(var(--chief-accent, 245 72% 58%))",
  "hsl(var(--chief-success, 152 55% 38%))",
  "hsl(var(--chief-warning, 35 90% 45%))",
  "hsl(var(--chief-danger, 0 65% 52%))",
  "hsl(200 70% 45%)",
  "hsl(280 50% 55%)",
] as const;
const TON: Record<WorkspaceTone, string> = { neutre: COULEURS[0], succes: COULEURS[1], attention: COULEURS[2], alerte: COULEURS[3] };
const couleur = (i: number, ton?: WorkspaceTone | null): string => (ton ? TON[ton] : COULEURS[i % COULEURS.length] ?? COULEURS[0]);
const GRILLE = "hsl(var(--chief-border-subtle, 218 25% 93.5%))";
const AXE = "hsl(var(--chief-border, 218 22% 89%))";
const TEXTE = "hsl(var(--chief-text-secondary, 220 12% 42%))";
const TEXTE_FORT = "hsl(var(--chief-text, 220 40% 13%))";
const FOND = "hsl(var(--chief-surface, 0 0% 100%))";
const MOIS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];

const NF = new Intl.NumberFormat("fr-DZ", { maximumFractionDigits: 2 });
const fmt = (v: number): string => NF.format(v);
/** Une graduation courte : 1,2 M · 340 k · 12 — le chiffre exact est dans le `<title>`. */
const court = (v: number): string => {
  const a = Math.abs(v);
  if (a >= 1e9) return `${NF.format(Math.round(v / 1e7) / 100)} Md`;
  if (a >= 1e6) return `${NF.format(Math.round(v / 1e4) / 100)} M`;
  if (a >= 1e4) return `${NF.format(Math.round(v / 100) / 10)} k`;
  return NF.format(v);
};
const tronque = (t: string, n: number): string => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
const unite = (b: Bloc, v: number): string => `${fmt(v)}${b.unite ? ` ${b.unite}` : ""}`;

/** Une échelle lisible : bornes arrondies à un pas 1-2-2,5-5 × 10^k, cinq graduations environ. */
function echelle(min: number, max: number, n = 5): { min: number; max: number; ticks: number[] } {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1, ticks: [0, 0.5, 1] };
  if (min === max) { if (min === 0) { max = 1; } else { const m = Math.abs(min) * 0.1; min -= m; max += m; } }
  const brut = (max - min) / n;
  const p = 10 ** Math.floor(Math.log10(brut));
  const r = brut / p;
  const pas = (r <= 1 ? 1 : r <= 2 ? 2 : r <= 2.5 ? 2.5 : r <= 5 ? 5 : 10) * p;
  const lo = Math.floor(min / pas) * pas;
  const hi = Math.ceil(max / pas) * pas;
  const ticks: number[] = [];
  for (let t = lo; t <= hi + pas / 2 && ticks.length < 40; t += pas) ticks.push(Number(t.toFixed(10)));
  return { min: lo, max: hi === lo ? lo + pas : hi, ticks };
}

function Svg({ h, titre, children }: { h: number; titre: string; children: React.ReactNode }) {
  return (
    <svg className="chief-viz-svg" viewBox={`0 0 ${W} ${h}`} role="img" aria-label={titre} preserveAspectRatio="xMidYMid meet">
      <title>{titre}</title>
      {children}
    </svg>
  );
}

function Legende({ items }: { items: { label: string; couleur: string }[] }) {
  return (
    <ul className="chief-viz-legende chief-list">
      {items.map((it, i) => (
        <li key={`${it.label}-${i}`}><span className="chief-viz-pastille" style={{ backgroundColor: it.couleur }} /><span className="chief-viz-legende-label">{it.label}</span></li>
      ))}
    </ul>
  );
}

// ─────────────────────────────── LA FAMILLE « SÉRIES » ───────────────────────────────

function Barres({ b }: { b: Bloc }) {
  const cats = b.donnees.categories ?? [];
  const series = b.donnees.series ?? [];
  const empile = b.type === "barres_empilees";
  const histo = b.type === "histogramme";
  const n = cats.length;
  const k = Math.max(1, series.length);
  const val = (s: Serie | undefined, i: number): number | null => s?.valeurs[i] ?? null;
  const horizontal = !histo && (n > 8 || cats.some((c) => c.length > 14) || (k > 2 && n > 4));

  let max = 0;
  let min = 0;
  for (let i = 0; i < n; i++) {
    if (empile) {
      let pos = 0; let neg = 0;
      for (const s of series) { const v = val(s, i); if (v === null) continue; if (v >= 0) pos += v; else neg += v; }
      max = Math.max(max, pos); min = Math.min(min, neg);
    } else {
      for (const s of series) { const v = val(s, i); if (v === null) continue; max = Math.max(max, v); min = Math.min(min, v); }
    }
  }
  const sc = echelle(min, max);
  const titreDe = (c: string, s: Serie, v: number) => `${c} · ${s.label} : ${unite(b, v)}`;
  const legende = series.length > 1 ? <Legende items={series.map((s, j) => ({ label: s.label, couleur: couleur(j, s.ton) }))} /> : null;

  if (horizontal) {
    const gauche = 150; const droite = 76; const plot = W - gauche - droite;
    const hBarre = empile || k === 1 ? 18 : Math.max(8, Math.min(14, 40 / k));
    const hCat = empile || k === 1 ? 26 : k * hBarre + 12;
    const h = n * hCat + 30;
    const x = (v: number) => gauche + ((v - sc.min) / (sc.max - sc.min)) * plot;
    return (
      <>
        <Svg h={h} titre={b.title}>
          {sc.ticks.map((t) => (
            <g key={t}>
              <line x1={x(t)} x2={x(t)} y1={0} y2={h - 26} stroke={GRILLE} />
              <text x={x(t)} y={h - 10} fontSize={11} fill={TEXTE} textAnchor="middle">{court(t)}</text>
            </g>
          ))}
          {cats.map((c, i) => {
            const y0 = i * hCat + 4;
            let posOff = 0; let negOff = 0;
            const total = empile ? series.reduce((s0, s) => s0 + Math.max(0, val(s, i) ?? 0), 0) : Math.max(0, val(series[0], i) ?? 0);
            return (
              <g key={i}>
                <text x={gauche - 8} y={y0 + hCat / 2 - 2} fontSize={12} fill={TEXTE_FORT} textAnchor="end" dominantBaseline="middle"><title>{c}</title>{tronque(c, 22)}</text>
                {series.map((s, j) => {
                  const v = val(s, i);
                  if (v === null) return null;
                  const y = empile || k === 1 ? y0 + (hCat - hBarre) / 2 : y0 + 6 + j * hBarre;
                  let x1: number; let x2: number;
                  if (empile) {
                    if (v >= 0) { x1 = x(posOff); x2 = x(posOff + v); posOff += v; } else { x1 = x(negOff + v); x2 = x(negOff); negOff += v; }
                  } else { x1 = x(Math.min(0, v)); x2 = x(Math.max(0, v)); }
                  return <rect key={j} x={Math.min(x1, x2)} y={y} width={Math.max(1, Math.abs(x2 - x1))} height={hBarre - 2} rx={3} fill={couleur(j, s.ton)}><title>{titreDe(c, s, v)}</title></rect>;
                })}
                {k === 1 || empile ? (
                  <text x={x(total) + 6} y={y0 + hCat / 2 - 2} fontSize={11} fill={TEXTE} dominantBaseline="middle">{court(empile ? total : (val(series[0], i) ?? 0))}</text>
                ) : null}
              </g>
            );
          })}
          <line x1={x(0)} x2={x(0)} y1={0} y2={h - 26} stroke={AXE} />
        </Svg>
        {legende}
      </>
    );
  }

  const gauche = 56; const droite = 12; const haut = 14; const bas = n > 6 ? 62 : 36; const plotH = 240;
  const h = haut + plotH + bas; const plot = W - gauche - droite;
  const cw = plot / Math.max(1, n); const gap = histo ? 1 : cw * 0.22;
  const bw = empile || k === 1 ? cw - gap : (cw - gap) / k;
  const y = (v: number) => haut + plotH - ((v - sc.min) / (sc.max - sc.min)) * plotH;
  return (
    <>
      <Svg h={h} titre={b.title}>
        {sc.ticks.map((t) => (
          <g key={t}>
            <line x1={gauche} x2={W - droite} y1={y(t)} y2={y(t)} stroke={GRILLE} />
            <text x={gauche - 6} y={y(t)} fontSize={11} fill={TEXTE} textAnchor="end" dominantBaseline="middle">{court(t)}</text>
          </g>
        ))}
        {cats.map((c, i) => {
          const x0 = gauche + i * cw + gap / 2; let posOff = 0; let negOff = 0;
          const total = empile ? series.reduce((s0, s) => s0 + Math.max(0, val(s, i) ?? 0), 0) : Math.max(0, val(series[0], i) ?? 0);
          const cx = x0 + (cw - gap) / 2;
          return (
            <g key={i}>
              {series.map((s, j) => {
                const v = val(s, i);
                if (v === null) return null;
                let y1: number; let y2: number;
                if (empile) {
                  if (v >= 0) { y1 = y(posOff + v); y2 = y(posOff); posOff += v; } else { y1 = y(negOff); y2 = y(negOff + v); negOff += v; }
                } else { y1 = y(Math.max(0, v)); y2 = y(Math.min(0, v)); }
                const xb = empile || k === 1 ? x0 : x0 + j * bw;
                return <rect key={j} x={xb} y={Math.min(y1, y2)} width={Math.max(1, bw - (histo ? 0 : 1))} height={Math.max(1, Math.abs(y2 - y1))} rx={histo ? 0 : 3} fill={couleur(j, s.ton)}><title>{titreDe(c, s, v)}</title></rect>;
              })}
              {n <= 12 && (k === 1 || empile) ? <text x={cx} y={y(total) - 4} fontSize={10.5} fill={TEXTE} textAnchor="middle">{court(empile ? total : (val(series[0], i) ?? 0))}</text> : null}
              <text x={cx} y={haut + plotH + 16} fontSize={11} fill={TEXTE_FORT} textAnchor={n > 6 ? "end" : "middle"} transform={n > 6 ? `rotate(-30 ${cx} ${haut + plotH + 16})` : undefined}><title>{c}</title>{tronque(c, n > 6 ? 14 : 18)}</text>
            </g>
          );
        })}
        <line x1={gauche} x2={W - droite} y1={y(0)} y2={y(0)} stroke={AXE} />
      </Svg>
      {legende}
    </>
  );
}

function Courbes({ b }: { b: Bloc }) {
  const cats = b.donnees.categories ?? [];
  const series = b.donnees.series ?? [];
  const n = cats.length;
  const aires = b.type === "aires";
  const vals = series.flatMap((s) => s.valeurs.filter((v): v is number => v !== null));
  const zero = b.axeYdepartZero === true || aires;
  const sc = echelle(zero ? Math.min(0, ...vals) : Math.min(...vals), zero ? Math.max(0, ...vals) : Math.max(...vals));
  const gauche = 56; const droite = 16; const haut = 12; const bas = zero ? 34 : 46; const plotH = 220;
  const h = haut + plotH + bas; const plot = W - gauche - droite;
  const x = (i: number) => gauche + (n <= 1 ? plot / 2 : (i / (n - 1)) * plot);
  const y = (v: number) => haut + plotH - ((v - sc.min) / (sc.max - sc.min)) * plotH;
  const pas = Math.max(1, Math.ceil(n / 8));
  const base = y(Math.max(0, sc.min));
  const segments = (s: Serie): { pts: string; premier: number; dernier: number }[] => {
    const segs: { pts: string; premier: number; dernier: number }[] = [];
    let cur: string[] = []; let premier = -1; let dernier = -1;
    s.valeurs.forEach((v, i) => {
      if (v === null) { if (cur.length) segs.push({ pts: cur.join(" "), premier, dernier }); cur = []; premier = -1; return; }
      if (premier < 0) premier = i;
      dernier = i;
      cur.push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`);
    });
    if (cur.length) segs.push({ pts: cur.join(" "), premier, dernier });
    return segs;
  };
  return (
    <>
      <Svg h={h} titre={b.title}>
        {sc.ticks.map((t) => (
          <g key={t}>
            <line x1={gauche} x2={W - droite} y1={y(t)} y2={y(t)} stroke={GRILLE} />
            <text x={gauche - 6} y={y(t)} fontSize={11} fill={TEXTE} textAnchor="end" dominantBaseline="middle">{court(t)}</text>
          </g>
        ))}
        {series.map((s, j) => (
          <g key={j}>
            {aires ? segments(s).map((seg, q) => (
              <polygon key={q} points={`${x(seg.premier).toFixed(1)},${base.toFixed(1)} ${seg.pts} ${x(seg.dernier).toFixed(1)},${base.toFixed(1)}`} fill={couleur(j, s.ton)} opacity={0.16} />
            )) : null}
            {segments(s).map((seg, q) => (
              <polyline key={q} points={seg.pts} fill="none" stroke={couleur(j, s.ton)} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            ))}
            {n <= 30 ? s.valeurs.map((v, i) => (v === null ? null : (
              <circle key={i} cx={x(i)} cy={y(v)} r={3} fill={FOND} stroke={couleur(j, s.ton)} strokeWidth={2}><title>{`${cats[i] ?? ""} · ${s.label} : ${unite(b, v)}`}</title></circle>
            ))) : null}
          </g>
        ))}
        {cats.map((c, i) => (i % pas === 0 || i === n - 1 ? (
          <text key={i} x={x(i)} y={haut + plotH + 18} fontSize={11} fill={TEXTE} textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}>{tronque(c, 12)}</text>
        ) : null))}
        <line x1={gauche} x2={W - droite} y1={haut + plotH} y2={haut + plotH} stroke={AXE} />
        {!zero && sc.min > 0 ? <text x={gauche} y={h - 8} fontSize={10.5} fill={TON.attention}>axe à partir de {court(sc.min)} — il ne part pas de zéro</text> : null}
      </Svg>
      {series.length > 1 ? <Legende items={series.map((s, j) => ({ label: s.label, couleur: couleur(j, s.ton) }))} /> : null}
    </>
  );
}

function Secteurs({ b }: { b: Bloc }) {
  const cats = b.donnees.categories ?? [];
  const s0 = b.donnees.series?.[0];
  const vals = cats.map((_, i) => Math.max(0, s0?.valeurs[i] ?? 0));
  const total = vals.reduce((a, v) => a + v, 0) || 1;
  const R = 92; const r = 56; const cx = 110; const cy = 110;
  let angle = -Math.PI / 2;
  const arcs = vals.map((v, i) => { const a0 = angle; const a1 = angle + (v / total) * 2 * Math.PI; angle = a1; return { i, v, a0, a1 }; });
  const pt = (a: number, rad: number): [number, number] => [cx + rad * Math.cos(a), cy + rad * Math.sin(a)];
  const chemin = (a0: number, a1: number): string => {
    if (a1 - a0 >= 2 * Math.PI - 1e-6) {
      return `M${cx - R},${cy} A${R},${R} 0 1 1 ${cx + R},${cy} A${R},${R} 0 1 1 ${cx - R},${cy} Z M${cx - r},${cy} A${r},${r} 0 1 0 ${cx + r},${cy} A${r},${r} 0 1 0 ${cx - r},${cy} Z`;
    }
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const [x0, y0] = pt(a0, R); const [x1, y1] = pt(a1, R); const [x2, y2] = pt(a1, r); const [x3, y3] = pt(a0, r);
    return `M${x0.toFixed(2)},${y0.toFixed(2)} A${R},${R} 0 ${large} 1 ${x1.toFixed(2)},${y1.toFixed(2)} L${x2.toFixed(2)},${y2.toFixed(2)} A${r},${r} 0 ${large} 0 ${x3.toFixed(2)},${y3.toFixed(2)} Z`;
  };
  return (
    <div className="chief-viz-secteurs">
      <svg className="chief-viz-svg chief-viz-donut" viewBox="0 0 220 220" role="img" aria-label={b.title}>
        <title>{b.title}</title>
        {arcs.map((a) => (a.v > 0 ? (
          <path key={a.i} d={chemin(a.a0, a.a1)} fill={couleur(a.i)} fillRule="evenodd" stroke={FOND} strokeWidth={1.5}>
            <title>{`${cats[a.i] ?? ""} : ${unite(b, a.v)} (${Math.round((a.v / total) * 100)} %)`}</title>
          </path>
        ) : null))}
        <text x={cx} y={cy - 4} fontSize={14} fontWeight={600} fill={TEXTE_FORT} textAnchor="middle">{court(total)}</text>
        <text x={cx} y={cy + 14} fontSize={10.5} fill={TEXTE} textAnchor="middle">{b.unite ?? "total"}</text>
      </svg>
      <ul className="chief-viz-legende chief-list">
        {cats.map((c, i) => (
          <li key={i}>
            <span className="chief-viz-pastille" style={{ backgroundColor: couleur(i) }} />
            <span className="chief-viz-legende-label">{c}</span>
            <span className="chief-viz-legende-valeur">{fmt(vals[i] ?? 0)}{b.unite ? ` ${b.unite}` : ""} · {Math.round(((vals[i] ?? 0) / total) * 100)} %</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Cascade({ b }: { b: Bloc }) {
  const cats = b.donnees.categories ?? [];
  const s0 = b.donnees.series?.[0];
  const deltas = cats.map((_, i) => s0?.valeurs[i] ?? 0);
  let cumul = 0;
  const pas = deltas.map((d) => { const de = cumul; cumul += d; return { de, a: cumul, d }; });
  const total = cumul;
  const tout = [...pas.flatMap((p) => [p.de, p.a]), 0, total];
  const sc = echelle(Math.min(...tout), Math.max(...tout));
  const n = cats.length + 1;
  const gauche = 56; const droite = 12; const haut = 16; const bas = n > 7 ? 64 : 40; const plotH = 230;
  const h = haut + plotH + bas; const plot = W - gauche - droite; const cw = plot / n; const bw = cw * 0.68;
  const y = (v: number) => haut + plotH - ((v - sc.min) / (sc.max - sc.min)) * plotH;
  const barres = [
    ...pas.map((p, i) => ({ label: cats[i] ?? "", y1: y(Math.max(p.de, p.a)), y2: y(Math.min(p.de, p.a)), col: p.d >= 0 ? TON.succes : TON.alerte, v: p.d, fin: p.a, signe: true })),
    { label: "Total", y1: y(Math.max(0, total)), y2: y(Math.min(0, total)), col: TON.neutre, v: total, fin: total, signe: false },
  ];
  return (
    <Svg h={h} titre={b.title}>
      {sc.ticks.map((t) => (
        <g key={t}>
          <line x1={gauche} x2={W - droite} y1={y(t)} y2={y(t)} stroke={GRILLE} />
          <text x={gauche - 6} y={y(t)} fontSize={11} fill={TEXTE} textAnchor="end" dominantBaseline="middle">{court(t)}</text>
        </g>
      ))}
      {barres.map((bar, i) => {
        const x0 = gauche + i * cw + (cw - bw) / 2; const cx = x0 + bw / 2;
        return (
          <g key={i}>
            <rect x={x0} y={bar.y1} width={bw} height={Math.max(1.5, bar.y2 - bar.y1)} rx={3} fill={bar.col}><title>{`${bar.label} : ${unite(b, bar.v)}`}</title></rect>
            {i < barres.length - 1 ? <line x1={x0 + bw} x2={x0 + cw} y1={y(bar.fin)} y2={y(bar.fin)} stroke={AXE} strokeDasharray="3 3" /> : null}
            <text x={cx} y={bar.y1 - 4} fontSize={10.5} fill={TEXTE} textAnchor="middle">{(bar.signe && bar.v > 0 ? "+" : "") + court(bar.v)}</text>
            <text x={cx} y={haut + plotH + 16} fontSize={11} fill={TEXTE_FORT} textAnchor={n > 7 ? "end" : "middle"} transform={n > 7 ? `rotate(-30 ${cx} ${haut + plotH + 16})` : undefined}><title>{bar.label}</title>{tronque(bar.label, 14)}</text>
          </g>
        );
      })}
      <line x1={gauche} x2={W - droite} y1={y(0)} y2={y(0)} stroke={AXE} />
    </Svg>
  );
}

function Entonnoir({ b }: { b: Bloc }) {
  const cats = b.donnees.categories ?? [];
  const s0 = b.donnees.series?.[0];
  const vals = cats.map((_, i) => Math.max(0, s0?.valeurs[i] ?? 0));
  const max = Math.max(...vals, 1e-9);
  const premier = vals[0] || 1;
  const hEtape = 36; const h = cats.length * hEtape + 8; const gauche = 150; const droite = 120; const plot = W - gauche - droite;
  return (
    <Svg h={h} titre={b.title}>
      {cats.map((c, i) => {
        const v = vals[i] ?? 0; const w = (v / max) * plot; const x0 = gauche + (plot - w) / 2; const y0 = i * hEtape + 4;
        return (
          <g key={i}>
            <text x={gauche - 10} y={y0 + hEtape / 2 - 2} fontSize={12} fill={TEXTE_FORT} textAnchor="end" dominantBaseline="middle"><title>{c}</title>{tronque(c, 22)}</text>
            <rect x={x0} y={y0} width={Math.max(2, w)} height={hEtape - 8} rx={4} fill={couleur(0)} opacity={1 - i * (0.55 / Math.max(1, cats.length))}><title>{`${c} : ${unite(b, v)}`}</title></rect>
            <text x={W - droite + 10} y={y0 + hEtape / 2 - 2} fontSize={11.5} fill={TEXTE} dominantBaseline="middle">{court(v)}{i > 0 ? ` · ${Math.round((v / premier) * 100)} %` : ""}</text>
          </g>
        );
      })}
    </Svg>
  );
}

/** Sur téléphone : la même information, en liste proportionnelle — lisible sans loupe. */
function MiniSeries({ b }: { b: Bloc }) {
  const cats = b.donnees.categories ?? [];
  const series = b.donnees.series ?? [];
  const s0 = series[0];
  const max = Math.max(...series.flatMap((s) => s.valeurs.map((v) => Math.abs(v ?? 0))), 1e-9);
  const total = b.type === "secteurs" ? cats.reduce((a, _, i) => a + Math.max(0, s0?.valeurs[i] ?? 0), 0) || 1 : null;
  return (
    <ul className="chief-viz-mini chief-list">
      {cats.map((c, i) => {
        const v = s0?.valeurs[i] ?? 0;
        return (
          <li key={i}>
            <div className="chief-viz-mini-tete">
              <span>{c}</span>
              <span className="chief-viz-mini-valeur">{fmt(v)}{b.unite ? ` ${b.unite}` : ""}{total ? ` · ${Math.round((Math.max(0, v) / total) * 100)} %` : ""}</span>
            </div>
            {series.length > 1 ? (
              <div className="chief-viz-mini-series">
                {series.map((s, j) => <span key={j} style={{ width: `${(Math.abs(s.valeurs[i] ?? 0) / max) * 100}%`, backgroundColor: couleur(j, s.ton) }} title={`${s.label} : ${fmt(s.valeurs[i] ?? 0)}`} />)}
              </div>
            ) : (
              <div className="chief-viz-mini-barre"><span style={{ width: `${(Math.abs(v) / max) * 100}%`, backgroundColor: couleur(0, s0?.ton) }} /></div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function TableDonnees({ b }: { b: Bloc }) {
  const cats = b.donnees.categories ?? [];
  const series = b.donnees.series ?? [];
  return (
    <details className="chief-viz-donnees">
      <summary>Données ({cats.length} × {series.length})</summary>
      <div className="chief-table-scroll">
        <table className="chief-table">
          <thead><tr><th /> {series.map((s, j) => <th key={j} className="chief-num">{s.label}</th>)}</tr></thead>
          <tbody>
            {cats.map((c, i) => (
              <tr key={i}>
                <td className="chief-td-strong">{c}</td>
                {series.map((s, j) => { const v = s.valeurs[i]; return <td key={j} className="chief-num">{v === null || v === undefined ? "—" : fmt(v)}</td>; })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

// ─────────────────────────────── LES AUTRES FAMILLES ───────────────────────────────

function Nuage({ b }: { b: Bloc }) {
  const pts = b.donnees.points ?? [];
  const xs = pts.map((p) => p.x); const ys = pts.map((p) => p.y);
  const scx = echelle(Math.min(...xs), Math.max(...xs)); const scy = echelle(Math.min(...ys), Math.max(...ys));
  const groupes = [...new Set(pts.map((p) => p.groupe ?? null))];
  const idx = (g: string | null) => Math.max(0, groupes.indexOf(g));
  const tmax = Math.max(...pts.map((p) => p.taille ?? 0), 1e-9);
  const gauche = 56; const droite = 16; const haut = 12; const bas = 34; const plotH = 240;
  const h = haut + plotH + bas; const plot = W - gauche - droite;
  const x = (v: number) => gauche + ((v - scx.min) / (scx.max - scx.min)) * plot;
  const y = (v: number) => haut + plotH - ((v - scy.min) / (scy.max - scy.min)) * plotH;
  return (
    <>
      <Svg h={h} titre={b.title}>
        {scy.ticks.map((t) => (
          <g key={`y${t}`}>
            <line x1={gauche} x2={W - droite} y1={y(t)} y2={y(t)} stroke={GRILLE} />
            <text x={gauche - 6} y={y(t)} fontSize={11} fill={TEXTE} textAnchor="end" dominantBaseline="middle">{court(t)}</text>
          </g>
        ))}
        {scx.ticks.map((t) => <text key={`x${t}`} x={x(t)} y={h - 12} fontSize={11} fill={TEXTE} textAnchor="middle">{court(t)}</text>)}
        {pts.map((p, i) => (
          <circle key={i} cx={x(p.x)} cy={y(p.y)} r={p.taille !== null && p.taille !== undefined ? 3 + 11 * Math.sqrt(p.taille / tmax) : 4.5} fill={couleur(idx(p.groupe ?? null))} opacity={0.75}>
            <title>{`${p.label ? `${p.label} · ` : ""}${fmt(p.x)} ; ${fmt(p.y)}${p.groupe ? ` (${p.groupe})` : ""}`}</title>
          </circle>
        ))}
        {pts.length <= 20 ? pts.map((p, i) => (p.label ? <text key={`l${i}`} x={x(p.x) + 7} y={y(p.y) - 6} fontSize={10.5} fill={TEXTE}>{tronque(p.label, 16)}</text> : null)) : null}
        <line x1={gauche} x2={W - droite} y1={haut + plotH} y2={haut + plotH} stroke={AXE} />
        <line x1={gauche} x2={gauche} y1={haut} y2={haut + plotH} stroke={AXE} />
      </Svg>
      {groupes.length > 1 ? <Legende items={groupes.map((g, j) => ({ label: g ?? "—", couleur: couleur(j) }))} /> : null}
    </>
  );
}

function Heatmap({ b }: { b: Bloc }) {
  const lignes = b.donnees.lignes ?? []; const colonnes = b.donnees.colonnes ?? []; const valeurs = b.donnees.valeurs ?? [];
  const flat = valeurs.flat().filter((v): v is number => v !== null);
  const min = Math.min(...flat); const max = Math.max(...flat);
  const gauche = 140; const haut = colonnes.length > 6 ? 74 : 28;
  const cw = (W - gauche - 8) / Math.max(1, colonnes.length); const ch = 24;
  const h = haut + lignes.length * ch + 8;
  const norm = (v: number) => (max === min ? 0.6 : (v - min) / (max - min));
  return (
    <Svg h={h} titre={b.title}>
      {colonnes.map((c, j) => {
        const cx = gauche + j * cw + cw / 2;
        return <text key={j} x={cx} y={haut - 8} fontSize={11} fill={TEXTE} textAnchor={colonnes.length > 6 ? "start" : "middle"} transform={colonnes.length > 6 ? `rotate(-45 ${cx} ${haut - 8})` : undefined}><title>{c}</title>{tronque(c, 14)}</text>;
      })}
      {lignes.map((l, i) => (
        <g key={i}>
          <text x={gauche - 8} y={haut + i * ch + ch / 2} fontSize={11.5} fill={TEXTE_FORT} textAnchor="end" dominantBaseline="middle"><title>{l}</title>{tronque(l, 20)}</text>
          {colonnes.map((c, j) => {
            const v = valeurs[i]?.[j] ?? null;
            return (
              <g key={j}>
                <rect x={gauche + j * cw + 1} y={haut + i * ch + 1} width={Math.max(1, cw - 2)} height={ch - 2} rx={3} fill={v === null ? "transparent" : couleur(0)} opacity={v === null ? 1 : 0.12 + 0.83 * norm(v)} stroke={v === null ? GRILLE : "none"}>
                  <title>{`${l} × ${c} : ${v === null ? "—" : unite(b, v)}`}</title>
                </rect>
                {v !== null && cw >= 40 ? <text x={gauche + j * cw + cw / 2} y={haut + i * ch + ch / 2} fontSize={10.5} fill={norm(v) > 0.55 ? "#fff" : TEXTE_FORT} textAnchor="middle" dominantBaseline="middle">{court(v)}</text> : null}
              </g>
            );
          })}
        </g>
      ))}
    </Svg>
  );
}

function Matrice({ b }: { b: Bloc }) {
  const lignes = b.donnees.lignes ?? []; const colonnes = b.donnees.colonnes ?? []; const cellules = b.donnees.cellules ?? []; const tons = b.donnees.tons;
  return (
    <div className="chief-table-scroll">
      <table className="chief-table chief-viz-matrice">
        <thead><tr><th /> {colonnes.map((c, j) => <th key={j}>{c}</th>)}</tr></thead>
        <tbody>
          {lignes.map((l, i) => (
            <tr key={i}>
              <td className="chief-td-strong">{l}</td>
              {colonnes.map((_, j) => {
                const t = tons?.[i]?.[j] ?? null;
                return <td key={j} className={t && t !== "neutre" ? `chief-viz-cellule chief-viz-cellule-${t}` : "chief-viz-cellule"}>{cellules[i]?.[j] || "—"}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Gantt({ b }: { b: Bloc }) {
  const taches = b.donnees.taches ?? [];
  const jour = 86_400_000;
  const t0 = Math.min(...taches.map((t) => Date.parse(t.debut)));
  const t1 = Math.max(...taches.map((t) => Date.parse(t.fin) + jour), t0 + jour);
  const span = t1 - t0;
  const gauche = 170; const droite = 12; const haut = 26; const rh = 26; const plot = W - gauche - droite;
  const h = haut + taches.length * rh + 10;
  const x = (ms: number) => gauche + ((ms - t0) / span) * plot;
  const ticks: { ms: number; label: string }[] = [];
  const d0 = new Date(t0); const jours = span / jour;
  if (jours <= 45) {
    const pas = jours > 20 ? 7 : jours > 10 ? 2 : 1;
    for (let d = new Date(Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth(), d0.getUTCDate())); d.getTime() <= t1 && ticks.length < 40; d.setUTCDate(d.getUTCDate() + pas)) {
      ticks.push({ ms: d.getTime(), label: `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}` });
    }
  } else {
    const pasMois = jours > 800 ? 3 : 1;
    for (let d = new Date(Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth(), 1)); d.getTime() <= t1 && ticks.length < 40; d.setUTCMonth(d.getUTCMonth() + pasMois)) {
      ticks.push({ ms: d.getTime(), label: `${MOIS[d.getUTCMonth()] ?? ""} ${String(d.getUTCFullYear()).slice(2)}` });
    }
  }
  const groupes = [...new Set(taches.map((t) => t.groupe ?? null))];
  const aujourdhui = Date.parse(new Date().toISOString().slice(0, 10));
  return (
    <>
      <Svg h={h} titre={b.title}>
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={x(t.ms)} x2={x(t.ms)} y1={haut - 4} y2={h - 4} stroke={GRILLE} />
            <text x={x(t.ms) + 3} y={12} fontSize={10.5} fill={TEXTE}>{t.label}</text>
          </g>
        ))}
        {taches.map((t, i) => {
          const y0 = haut + i * rh; const xa = x(Date.parse(t.debut)); const xb = Math.max(xa + 3, x(Date.parse(t.fin) + jour));
          const col = couleur(Math.max(0, groupes.indexOf(t.groupe ?? null)), t.ton);
          const prog = t.progression ?? null;
          return (
            <g key={i}>
              <text x={gauche - 8} y={y0 + rh / 2} fontSize={11.5} fill={TEXTE_FORT} textAnchor="end" dominantBaseline="middle"><title>{t.label}</title>{tronque(t.label, 26)}</text>
              <rect x={xa} y={y0 + 5} width={xb - xa} height={rh - 10} rx={4} fill={col} opacity={0.35}>
                <title>{`${t.label} : ${t.debut} → ${t.fin}${prog !== null ? ` · ${Math.round(prog)} %` : ""}${t.groupe ? ` (${t.groupe})` : ""}`}</title>
              </rect>
              {prog !== null ? <rect x={xa} y={y0 + 5} width={(xb - xa) * (prog / 100)} height={rh - 10} rx={4} fill={col} /> : null}
            </g>
          );
        })}
        {aujourdhui >= t0 && aujourdhui <= t1 ? (
          <g>
            <line x1={x(aujourdhui)} x2={x(aujourdhui)} y1={haut - 6} y2={h - 4} stroke={TON.alerte} strokeDasharray="4 3" />
            <text x={x(aujourdhui) + 3} y={h - 6} fontSize={10} fill={TON.alerte}>aujourd&apos;hui</text>
          </g>
        ) : null}
      </Svg>
      {groupes.length > 1 ? <Legende items={groupes.map((g, j) => ({ label: g ?? "—", couleur: couleur(j) }))} /> : null}
    </>
  );
}

function Graphe({ b }: { b: Bloc }) {
  const noeuds = b.donnees.noeuds ?? []; const arcs = b.donnees.arcs ?? [];
  const n = noeuds.length; const cx = W / 2; const cy = 172; const R = 126; const h = 344;
  const pmax = Math.max(...noeuds.map((x) => x.poids ?? 0), 1e-9);
  const amax = Math.max(...arcs.map((a) => a.poids ?? 0), 1e-9);
  const pos = new Map(noeuds.map((x, i) => {
    const a = -Math.PI / 2 + (i / Math.max(1, n)) * 2 * Math.PI;
    return [x.id, { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a), a }] as const;
  }));
  const types = [...new Set(noeuds.map((x) => x.type ?? null))];
  const rayon = (p: number | null | undefined) => 5 + 9 * Math.sqrt((p ?? 0) / pmax);
  return (
    <>
      <Svg h={h} titre={b.title}>
        {arcs.map((a, i) => {
          const p = pos.get(a.de); const q = pos.get(a.a);
          if (!p || !q) return null;
          return (
            <line key={i} x1={p.x} y1={p.y} x2={q.x} y2={q.y} stroke={TEXTE} strokeWidth={0.8 + 3 * ((a.poids ?? 0) / amax)} opacity={0.3}>
              <title>{`${a.de} → ${a.a}${a.label ? ` · ${a.label}` : ""}${a.poids !== null && a.poids !== undefined ? ` : ${fmt(a.poids)}` : ""}`}</title>
            </line>
          );
        })}
        {noeuds.map((x, i) => {
          const p = pos.get(x.id);
          if (!p) return null;
          const r = rayon(x.poids); const droite = Math.cos(p.a) >= -0.01;
          const lx = p.x + (r + 5) * Math.cos(p.a); const ly = p.y + (r + 5) * Math.sin(p.a);
          const label = n <= 30 || i < 20 ? tronque(x.label, 18) : null;
          const contenu = (
            <g>
              <circle cx={p.x} cy={p.y} r={r} fill={couleur(Math.max(0, types.indexOf(x.type ?? null)), x.ton)} stroke={FOND} strokeWidth={1.5}>
                <title>{`${x.label}${x.type ? ` (${x.type})` : ""}${x.poids !== null && x.poids !== undefined ? ` : ${fmt(x.poids)}` : ""}`}</title>
              </circle>
              {label ? <text x={lx} y={ly} fontSize={11} fill={TEXTE_FORT} textAnchor={droite ? "start" : "end"} dominantBaseline="middle">{label}</text> : null}
            </g>
          );
          return x.href ? <a key={x.id} href={x.href}>{contenu}</a> : <React.Fragment key={x.id}>{contenu}</React.Fragment>;
        })}
      </Svg>
      {types.length > 1 ? <Legende items={types.map((t, j) => ({ label: t ?? "—", couleur: couleur(j) }))} /> : null}
    </>
  );
}

/** Un Sankey sobre : colonnes par profondeur, hauteur des nœuds et largeur des rubans proportionnelles aux flux. */
function Flux({ b }: { b: Bloc }) {
  const noeuds = b.donnees.noeuds ?? []; const arcs = b.donnees.arcs ?? [];
  const ids = noeuds.map((x) => x.id);
  const entrants = new Map<string, number>(); const sortants = new Map<string, number>();
  for (const a of arcs) { const w = a.poids ?? 1; sortants.set(a.de, (sortants.get(a.de) ?? 0) + w); entrants.set(a.a, (entrants.get(a.a) ?? 0) + w); }
  const prof = new Map(ids.map((id) => [id, 0]));
  for (let iter = 0; iter < ids.length; iter++) {
    let change = false;
    for (const a of arcs) { const d = (prof.get(a.de) ?? 0) + 1; if (d > (prof.get(a.a) ?? 0) && d < ids.length) { prof.set(a.a, d); change = true; } }
    if (!change) break;
  }
  const profondeurs = [...new Set(ids.map((id) => prof.get(id) ?? 0))].sort((a, c) => a - c);
  const colDe = (id: string) => Math.max(0, profondeurs.indexOf(prof.get(id) ?? 0));
  const nCols = profondeurs.length;
  const h = 360; const haut = 16; const bas = 16; const nw = 14;
  const colX = (c: number) => 8 + (nCols <= 1 ? (W - 16 - nw) / 2 : (c / (nCols - 1)) * (W - 16 - nw));
  const poids = (id: string) => Math.max(entrants.get(id) ?? 0, sortants.get(id) ?? 0, 1e-9);
  const parCol = profondeurs.map((_, c) => ids.filter((id) => colDe(id) === c));
  const maxParCol = Math.max(...parCol.map((c) => c.length), 1);
  const totalMax = Math.max(...parCol.map((col) => col.reduce((s0, id) => s0 + poids(id), 0)), 1e-9);
  const dispo = h - haut - bas - 8 * (maxParCol - 1);
  const hauteur = (v: number) => (v / totalMax) * dispo;
  const geo = new Map<string, { x: number; y: number; h: number; outY: number; inY: number }>();
  parCol.forEach((col, c) => {
    const totalCol = col.reduce((s0, id) => s0 + Math.max(2, hauteur(poids(id))), 0) + 8 * (col.length - 1);
    let y = haut + Math.max(0, (h - haut - bas - totalCol) / 2);
    for (const id of col) { const hh = Math.max(2, hauteur(poids(id))); geo.set(id, { x: colX(c), y, h: hh, outY: y, inY: y }); y += hh + 8; }
  });
  const parId = new Map(noeuds.map((x) => [x.id, x]));
  return (
    <Svg h={h} titre={b.title}>
      {arcs.map((a, i) => {
        const s = geo.get(a.de); const t = geo.get(a.a);
        if (!s || !t) return null;
        const th = Math.max(1, hauteur(a.poids ?? 1));
        const sx = s.x + nw; const tx = t.x; const mx = (sx + tx) / 2;
        const sy = s.outY; const ty = t.inY;
        s.outY += th; t.inY += th;
        const d = `M${sx},${sy} C${mx},${sy} ${mx},${ty} ${tx},${ty} L${tx},${ty + th} C${mx},${ty + th} ${mx},${sy + th} ${sx},${sy + th} Z`;
        return (
          <path key={i} d={d} fill={couleur(colDe(a.de))} opacity={0.28}>
            <title>{`${parId.get(a.de)?.label ?? a.de} → ${parId.get(a.a)?.label ?? a.a}${a.poids !== null && a.poids !== undefined ? ` : ${unite(b, a.poids)}` : ""}`}</title>
          </path>
        );
      })}
      {ids.map((id) => {
        const g = geo.get(id); const nd = parId.get(id);
        if (!g || !nd) return null;
        const dernier = colDe(id) === nCols - 1 && nCols > 1;
        return (
          <g key={id}>
            <rect x={g.x} y={g.y} width={nw} height={g.h} rx={2} fill={couleur(colDe(id), nd.ton)}><title>{`${nd.label} : ${unite(b, poids(id))}`}</title></rect>
            <text x={dernier ? g.x - 6 : g.x + nw + 6} y={g.y + g.h / 2} fontSize={11} fill={TEXTE_FORT} textAnchor={dernier ? "end" : "start"} dominantBaseline="middle">{tronque(nd.label, 22)}</text>
          </g>
        );
      })}
    </Svg>
  );
}

function NoeudArbre({ n, prof, u }: { n: VizArbre; prof: number; u: string | null | undefined }) {
  const contenu = (
    <span className="chief-arbre-libelle">
      <span>{n.label}</span>
      {n.valeur !== null && n.valeur !== undefined ? <span className={`chief-arbre-valeur${n.ton && n.ton !== "neutre" ? ` chief-tone-${n.ton}` : ""}`}>{fmt(n.valeur)}{u ? ` ${u}` : ""}</span> : null}
    </span>
  );
  if (!n.enfants?.length) return <li className="chief-arbre-feuille">{contenu}</li>;
  return (
    <li>
      <details open={prof < 2}>
        <summary>{contenu}<span className="chief-arbre-compte">{n.enfants.length}</span></summary>
        <ul className="chief-arbre-branche chief-list">
          {n.enfants.map((e, i) => <NoeudArbre key={i} n={e} prof={prof + 1} u={u} />)}
        </ul>
      </details>
    </li>
  );
}

function Arbre({ b }: { b: Bloc }) {
  const racine = b.donnees.racine;
  if (!racine) return null;
  return <ul className="chief-arbre chief-list"><NoeudArbre n={racine} prof={0} u={b.unite} /></ul>;
}

/** Des graduations en degrés à un pas lisible, dans l'étendue. */
function graduations(min: number, max: number): number[] {
  const brut = (max - min) / 4;
  const pas = [0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 45].find((p) => p >= brut) ?? 45;
  const out: number[] = [];
  for (let g = Math.ceil(min / pas) * pas; g <= max && out.length < 20; g += pas) out.push(Number(g.toFixed(4)));
  return out;
}

function Carte({ b }: { b: Bloc }) {
  const lieux = b.donnees.lieux ?? [];
  const lats = lieux.map((l) => l.lat); const lons = lieux.map((l) => l.lon);
  let minLat = Math.min(...lats); let maxLat = Math.max(...lats); let minLon = Math.min(...lons); let maxLon = Math.max(...lons);
  const padLat = Math.max(0.3, (maxLat - minLat) * 0.15); const padLon = Math.max(0.3, (maxLon - minLon) * 0.15);
  minLat -= padLat; maxLat += padLat; minLon -= padLon; maxLon += padLon;
  const lat0 = (minLat + maxLat) / 2; const k = Math.max(0.2, Math.cos((lat0 * Math.PI) / 180));
  const h = 340; const m = 24; const plotW = W - 2 * m; const plotH = h - 2 * m;
  const sc = Math.min(plotW / ((maxLon - minLon) * k), plotH / (maxLat - minLat));
  const x = (lon: number) => m + plotW / 2 + (lon - (minLon + maxLon) / 2) * k * sc;
  const y = (lat: number) => m + plotH / 2 - (lat - lat0) * sc;
  const vmax = Math.max(...lieux.map((l) => l.valeur ?? 0), 1e-9);
  return (
    <Svg h={h} titre={b.title}>
      <rect x={m} y={m} width={plotW} height={plotH} fill="hsl(var(--chief-surface-sunken, 220 30% 96.5%))" rx={8} />
      {graduations(minLon, maxLon).map((g) => (
        <g key={`o${g}`}><line x1={x(g)} x2={x(g)} y1={m} y2={m + plotH} stroke={GRILLE} /><text x={x(g) + 3} y={m + plotH - 6} fontSize={9.5} fill={TEXTE}>{g}°</text></g>
      ))}
      {graduations(minLat, maxLat).map((g) => (
        <g key={`a${g}`}><line x1={m} x2={m + plotW} y1={y(g)} y2={y(g)} stroke={GRILLE} /><text x={m + 4} y={y(g) - 3} fontSize={9.5} fill={TEXTE}>{g}°</text></g>
      ))}
      {lieux.map((l, i) => {
        const r = l.valeur !== null && l.valeur !== undefined ? 4 + 12 * Math.sqrt(l.valeur / vmax) : 5;
        return (
          <g key={i}>
            <circle cx={x(l.lon)} cy={y(l.lat)} r={r} fill={couleur(0, l.ton)} opacity={0.7} stroke={FOND} strokeWidth={1.5}>
              <title>{`${l.label} (${l.lat.toFixed(3)}, ${l.lon.toFixed(3)})${l.valeur !== null && l.valeur !== undefined ? ` : ${unite(b, l.valeur)}` : ""}`}</title>
            </circle>
            {lieux.length <= 30 ? <text x={x(l.lon) + r + 3} y={y(l.lat) + 4} fontSize={10.5} fill={TEXTE_FORT}>{tronque(l.label, 18)}</text> : null}
          </g>
        );
      })}
      <text x={W - m - 4} y={h - 8} fontSize={9.5} fill={TEXTE} textAnchor="end">schéma — positions relatives, sans fond de carte</text>
    </Svg>
  );
}

function Cartes({ b }: { b: Bloc }) {
  const cartes = b.donnees.cartes ?? [];
  return (
    <div className="chief-viz-cartes">
      {cartes.map((c, i) => {
        const cls = `chief-viz-carte chief-viz-carte-${c.ton ?? "neutre"}`;
        const inner = (
          <>
            <p className="chief-viz-carte-titre">{c.titre}</p>
            <p className={`chief-viz-carte-valeur${c.ton && c.ton !== "neutre" ? ` chief-tone-${c.ton}` : ""}`}>{c.valeur}</p>
            {c.detail ? <p className="chief-viz-carte-detail">{c.detail}</p> : null}
          </>
        );
        return c.href ? <a key={i} href={c.href} className={cls}>{inner}</a> : <div key={i} className={cls}>{inner}</div>;
      })}
    </div>
  );
}

// ─────────────────────────────── LA RÉPARTITION ───────────────────────────────

const SERIES: ReadonlySet<VizType> = new Set<VizType>(["barres", "barres_empilees", "courbe", "aires", "histogramme", "secteurs", "cascade", "entonnoir"]);
const HTML: ReadonlySet<VizType> = new Set<VizType>(["matrice", "arbre", "cartes"]);

function figure(b: Bloc): React.ReactNode {
  switch (b.type) {
    case "barres": case "barres_empilees": case "histogramme": return <Barres b={b} />;
    case "courbe": case "aires": return <Courbes b={b} />;
    case "secteurs": return <Secteurs b={b} />;
    case "cascade": return <Cascade b={b} />;
    case "entonnoir": return <Entonnoir b={b} />;
    case "nuage": return <Nuage b={b} />;
    case "heatmap": return <Heatmap b={b} />;
    case "matrice": return <Matrice b={b} />;
    case "gantt": return <Gantt b={b} />;
    case "graphe": return <Graphe b={b} />;
    case "flux": return <Flux b={b} />;
    case "arbre": return <Arbre b={b} />;
    case "carte": return <Carte b={b} />;
    case "cartes": return <Cartes b={b} />;
    default: return null;
  }
}

/**
 * LA FIGURE — une forme, ses données, rien d'autre. Les séries ont deux lectures (le dessin en
 * large, la liste sur téléphone) et leurs données en clair ; les autres formes défilent
 * horizontalement plutôt que de rétrécir ; l'HTML (matrice, arbre, indicateurs) se plie tout seul.
 */
export function VizFigure({ b }: { b: Bloc }) {
  if (SERIES.has(b.type)) {
    return (
      <figure className="chief-viz" data-viz={b.type}>
        <div className="chief-only-wide">{figure(b)}</div>
        <div className="chief-only-narrow"><MiniSeries b={b} /></div>
        <TableDonnees b={b} />
      </figure>
    );
  }
  if (HTML.has(b.type)) return <figure className="chief-viz" data-viz={b.type}>{figure(b)}</figure>;
  return <figure className="chief-viz" data-viz={b.type}><div className="chief-viz-scroll">{figure(b)}</div></figure>;
}
