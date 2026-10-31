"use client";

import * as React from "react";
import type { WorkspaceBlock } from "@/platform/ia/workspace/protocol";
import type { CelluleAnalyse, GraphiqueAnalyse } from "@/platform/ia/workspace/analyse";
import { enClair, estNumerique, filtrerLignes, totauxDe, trierLignes, versCsv } from "@/platform/ia/analyse/affichage";
import { Card, Chip } from "../primitives";
import { VizFigure } from "./viz-figure";
import { nomDeFichier, pngDepuisSvg, svgAutonome, telecharger } from "./export-graphique";
import "./analyse.css";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE BLOC « ANALYSE » (lot K1, décision 0031) — le tableau, ses graphiques et leur calcul, à l'écran.
 *
 * Ce qui s'affiche ici a été calculé par le code (`platform/ia/analyse/`) : l'écran ne fait que trier, filtrer et
 * additionner ce qu'il montre — sur des NOMBRES, pas sur du texte. Mobile d'abord : sur 390 px, le tableau défile
 * horizontalement DANS sa boîte (la page ne bouge pas), sa première colonne reste figée ; chaque geste est une
 * cible de 44 px ; le champ de recherche est à 16 px (iOS ne zoome pas). Chaque graphique s'exporte en PNG, en SVG,
 * et ses données en Excel ; le tableau en CSV, en Excel, ou au Drive sur le geste de la personne.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

type Bloc = Extract<WorkspaceBlock, { kind: "analyse" }>;
type Etat = { type: "ok" | "erreur"; texte: string; lien?: string } | null;

async function demanderClasseur(bloc: Bloc, corps: Record<string, unknown>): Promise<Response> {
  return fetch(bloc.exportExcel ?? "", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corps), credentials: "same-origin" });
}

/** Le bloc tel que l'export le relit — sans ce que l'écran seul utilise. */
const pourExport = (b: Bloc, lignes: CelluleAnalyse[][]) => ({
  title: b.title, source: b.source, colonnes: b.colonnes, lignes, totaux: b.totaux, graphiques: b.graphiques, journal: b.journal, total: b.total,
});

async function erreurDe(r: Response): Promise<string> {
  try { const j = (await r.json()) as { error?: string }; return j.error ?? `Export impossible (${r.status}).`; } catch { return `Export impossible (${r.status}).`; }
}

function Graphique({ b, g, i, surEtat }: { b: Bloc; g: GraphiqueAnalyse; i: number; surEtat: (e: Etat) => void }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const svg = (): SVGSVGElement | null => ref.current?.querySelector("svg.chief-viz-svg") ?? null;
  const exporter = async (format: "svg" | "png") => {
    const s = svg();
    if (!s) { surEtat({ type: "erreur", texte: "Ce graphique n'a pas de dessin exportable." }); return; }
    const texte = svgAutonome(s);
    try {
      telecharger(format === "svg" ? new Blob([texte], { type: "image/svg+xml;charset=utf-8" }) : await pngDepuisSvg(texte), nomDeFichier(g.titre, format));
    } catch (e) {
      surEtat({ type: "erreur", texte: `Export ${format.toUpperCase()} impossible : ${e instanceof Error ? e.message : "erreur"}` });
    }
  };
  const donnees = async () => {
    const r = await demanderClasseur(b, { bloc: pourExport(b, b.lignes), graphique: i });
    if (!r.ok) { surEtat({ type: "erreur", texte: await erreurDe(r) }); return; }
    telecharger(await r.blob(), nomDeFichier(`${g.titre} donnees`, "xlsx"));
  };
  const alertes = g.alertes ?? [];
  const viz = { kind: "viz" as const, title: g.titre, type: g.type, donnees: g.donnees, unite: g.unite ?? null, axeYdepartZero: g.axeYdepartZero, raison: g.raison ?? null, alertes };
  return (
    <figure className="ia-analyse-graphique" data-testid="analyse-graphique">
      <figcaption className="ia-analyse-graphique-titre">{g.titre}</figcaption>
      {alertes.length ? (
        <ul className="chief-viz-alertes chief-list">
          {alertes.map((a, k) => {
            const trompeur = /^TROMPEUR/i.test(a);
            return <li key={k}><Chip label={trompeur ? "Trompeur" : "À vérifier"} ton={trompeur ? "alerte" : "attention"} /><span>{a.replace(/^(TROMPEUR|DOUTEUX)\s*·\s*/i, "")}</span></li>;
          })}
        </ul>
      ) : null}
      <div ref={ref}><VizFigure b={viz} /></div>
      {g.raison || g.note ? <p className="chief-block-note">{[g.raison, g.note].filter(Boolean).join(" — ")}</p> : null}
      <div className="ia-analyse-gestes" role="group" aria-label={`Exporter « ${g.titre} »`}>
        <button type="button" className="ia-analyse-geste" onClick={() => void exporter("png")}>PNG</button>
        <button type="button" className="ia-analyse-geste" onClick={() => void exporter("svg")}>SVG</button>
        {b.exportExcel ? <button type="button" className="ia-analyse-geste" onClick={() => void donnees()}>Données (Excel)</button> : null}
      </div>
    </figure>
  );
}

function Calcul({ b }: { b: Bloc }) {
  const j = b.journal;
  const date = new Date(j.calculeLe);
  return (
    <details className="ia-analyse-calcul" data-testid="analyse-calcul">
      <summary>Comment c&apos;est calculé</summary>
      <dl className="ia-analyse-calcul-liste">
        <div><dt>Source</dt><dd>{j.sources.join(" · ") || b.source}</dd></div>
        <div><dt>Calculé par</dt><dd>{j.moteur} — aucun chiffre n&apos;est écrit par le modèle</dd></div>
        <div><dt>Calculé le</dt><dd>{Number.isNaN(date.getTime()) ? j.calculeLe : date.toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })}</dd></div>
      </dl>
      {j.etapes.length ? (
        <ol className="ia-analyse-etapes">
          {j.etapes.map((e, i) => (
            <li key={i}>
              <span className="ia-analyse-etape-op">{e.op}</span>
              <code className="ia-analyse-formule">{e.formule}</code>
              <span className="ia-analyse-etape-lignes">{e.avant} → {e.apres} ligne{e.apres > 1 ? "s" : ""}{e.note ? ` · ${e.note}` : ""}</span>
            </li>
          ))}
        </ol>
      ) : null}
      {j.resultats.length ? <ul className="chief-list ia-analyse-notes">{j.resultats.map((r, i) => <li key={i}><strong>{r.libelle}</strong> : {r.valeur}</li>)}</ul> : null}
      {b.totaux ? <p className="chief-block-note">Totaux : somme des lignes, calculée par le code (et en formules =SOMME() dans l&apos;Excel).</p> : null}
      {[...j.ignores.map((t) => `Ignoré — ${t}`), ...j.refusees.map((t) => `Étape refusée — ${t}`), ...j.masquees.map((t) => `Colonne masquée — ${t} (confidentielle)`)].map((t, i) => <p key={i} className="chief-block-note">{t}</p>)}
    </details>
  );
}

export function AnalyseBlock({ b }: { b: Bloc }) {
  const [tri, setTri] = React.useState<{ j: number; sens: "asc" | "desc" } | null>(null);
  const [texte, setTexte] = React.useState("");
  const [etat, setEtat] = React.useState<Etat>(null);
  const [occupe, setOccupe] = React.useState(false);
  const id = React.useId();

  // LE FILTRE PAR VALEUR : la première colonne texte qui a peu de valeurs distinctes (un statut, une société).
  const choix = React.useMemo(() => {
    for (let j = 0; j < b.colonnes.length; j++) {
      if (b.colonnes[j].format !== "texte") continue;
      const valeurs = [...new Set(b.lignes.map((r) => r[j]).filter((v): v is string => typeof v === "string"))];
      if (valeurs.length >= 2 && valeurs.length <= 30 && valeurs.length < b.lignes.length) return { j, valeurs: valeurs.sort((x, y) => x.localeCompare(y, "fr")) };
    }
    return null;
  }, [b]);
  const [egal, setEgal] = React.useState("");

  const visibles = React.useMemo(() => {
    const f = filtrerLignes(b.lignes, b.colonnes, texte, choix && egal ? { j: choix.j, valeur: egal } : null);
    return tri ? trierLignes(f, tri.j, tri.sens) : f;
  }, [b, texte, egal, choix, tri]);
  const additives = React.useMemo(() => b.colonnes.map((_, j) => b.totaux?.[j] !== null && b.totaux?.[j] !== undefined), [b]);
  const filtre = visibles.length !== b.lignes.length;
  const totaux = b.totaux ? (filtre ? totauxDe(visibles, additives) : b.lignes.length === b.total ? b.totaux : totauxDe(visibles, additives)) : null;

  const trier = (j: number) => setTri((t) => (t?.j === j ? { j, sens: t.sens === "desc" ? "asc" : "desc" } : { j, sens: estNumerique(b.colonnes[j].format) ? "desc" : "asc" }));
  const csv = () => telecharger(new Blob([versCsv(b.colonnes, visibles)], { type: "text/csv;charset=utf-8" }), nomDeFichier(b.title, "csv"));
  const excel = async (depot: boolean) => {
    setOccupe(true); setEtat(null);
    try {
      const r = await demanderClasseur(b, { bloc: pourExport(b, visibles), depot });
      if (!r.ok) { setEtat({ type: "erreur", texte: await erreurDe(r) }); return; }
      if (depot) {
        const d = (await r.json()) as { nom: string; href: string; nodeId: string };
        setEtat({ type: "ok", texte: `Enregistré dans votre Drive (dossier « Analyses ») : ${d.nom}`, lien: `/drive/${d.nodeId}` });
      } else telecharger(await r.blob(), nomDeFichier(b.title, "xlsx"));
    } catch {
      setEtat({ type: "erreur", texte: "Export impossible : la connexion a été interrompue." });
    } finally { setOccupe(false); }
  };

  const meta = `${b.total} ligne${b.total > 1 ? "s" : ""} · ${b.source}`;
  return (
    <Card title={b.title} meta={meta}>
      <div className="ia-analyse" data-testid="analyse-bloc">
        <div className="ia-analyse-outils">
          <label className="ia-analyse-recherche">
            <span className="sr-only">Filtrer le tableau</span>
            <input type="search" inputMode="search" placeholder="Filtrer…" value={texte} onChange={(e) => setTexte(e.target.value)} aria-controls={`${id}-table`} />
          </label>
          {choix ? (
            <label className="ia-analyse-choix">
              <span className="sr-only">{b.colonnes[choix.j].libelle}</span>
              <select value={egal} onChange={(e) => setEgal(e.target.value)} aria-controls={`${id}-table`}>
                <option value="">{b.colonnes[choix.j].libelle} : tout</option>
                {choix.valeurs.map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </label>
          ) : null}
        </div>

        <div className="ia-analyse-defile" role="region" aria-label={`Tableau « ${b.title} »`} tabIndex={0}>
          <table className="ia-analyse-table" id={`${id}-table`}>
            <thead>
              <tr>
                {b.colonnes.map((c, j) => (
                  <th key={c.cle} scope="col" className={estNumerique(c.format) ? "ia-num" : undefined} aria-sort={tri?.j === j ? (tri.sens === "asc" ? "ascending" : "descending") : "none"}>
                    <button type="button" onClick={() => trier(j)} className="ia-analyse-tri">
                      {c.libelle}<span aria-hidden="true" className="ia-analyse-fleche">{tri?.j === j ? (tri.sens === "asc" ? "▲" : "▼") : "↕"}</span>
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visibles.map((r, i) => (
                <tr key={i}>
                  {b.colonnes.map((c, j) => (j === 0
                    ? <th key={c.cle} scope="row" className={estNumerique(c.format) ? "ia-num" : undefined}>{enClair(r[j] ?? null, c.format)}</th>
                    : <td key={c.cle} className={estNumerique(c.format) ? "ia-num" : undefined}>{enClair(r[j] ?? null, c.format)}</td>))}
                </tr>
              ))}
              {!visibles.length ? <tr><td colSpan={b.colonnes.length} className="ia-analyse-vide">Aucune ligne ne correspond au filtre.</td></tr> : null}
            </tbody>
            {totaux && visibles.length > 1 ? (
              <tfoot>
                <tr>
                  {b.colonnes.map((c, j) => (j === 0
                    ? <th key={c.cle} scope="row">{filtre ? "Total (filtré)" : "Total"}</th>
                    : <td key={c.cle} className={estNumerique(c.format) ? "ia-num" : undefined}>{totaux[j] === null ? "" : enClair(totaux[j], c.format)}</td>))}
                </tr>
              </tfoot>
            ) : null}
          </table>
        </div>
        <p className="chief-block-note" aria-live="polite">
          {filtre ? `${visibles.length} ligne(s) sur ${b.lignes.length} affichées. ` : ""}
          {b.total > b.lignes.length ? `${b.lignes.length} premières lignes sur ${b.total} — le classeur Excel les porte, le calcul vaut pour toutes.` : ""}
        </p>

        <div className="ia-analyse-gestes" role="group" aria-label="Exporter le tableau">
          <button type="button" className="ia-analyse-geste" onClick={csv}>CSV</button>
          {b.exportExcel ? <button type="button" className="ia-analyse-geste" disabled={occupe} onClick={() => void excel(false)}>Excel</button> : null}
          {b.exportExcel ? <button type="button" className="ia-analyse-geste" disabled={occupe} onClick={() => void excel(true)}>Enregistrer dans mon Drive</button> : null}
        </div>
        {etat ? (
          <p className={`ia-analyse-etat ia-analyse-etat-${etat.type}`} role={etat.type === "erreur" ? "alert" : "status"}>
            {etat.texte}{etat.lien ? <> — <a href={etat.lien}>ouvrir</a></> : null}
          </p>
        ) : null}

        {b.graphiques.map((g, i) => <Graphique key={i} b={b} g={g} i={i} surEtat={setEtat} />)}
        <Calcul b={b} />
      </div>
    </Card>
  );
}
