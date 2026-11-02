"use client";

/**
 * LES PRATICIENS — une ligne du tableau et ses cellules éditables.
 */
import * as React from "react";
import Link from "next/link";
import { Loader2, MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import { STATUT_LABELS, LETTRES_FORCABLES, affiniteAffichee, type MethodeAffinite } from "@/lib/segmentation/regles";
import { casseNom, type Colonne } from "@/lib/segmentation/tableau-praticiens";
import { LettreBadge } from "../lettre-badge";
import { type Choix, type Deplacement, type LignePraticien, type EtatCellule, fmt, libelleLettre } from "./modele";
import { EditeurChoix, EditeurTexte } from "./editeurs";

// ─────────────────────────────── Une ligne ───────────────────────────────

export interface CtxLigne {
  peut: Record<Colonne, boolean>;
  avecSelection: boolean;
  methode: MethodeAffinite;
  /** Les listes des menus, construites une fois pour tout le tableau. */
  options: Record<"secteur" | "cdr" | "specialite" | "grade" | "statut", Choix[]>;
  commencer: (id: string, col: Colonne, init?: string) => void;
  annuler: (id: string, col: Colonne, refocaliser: boolean) => void;
  valider: (id: string, col: Colonne, brut: string, dep: Deplacement) => void;
  toucheCellule: (e: React.KeyboardEvent<HTMLElement>, id: string, col: Colonne) => void;
  basculer: (ensemble: "selection" | "details", id: string) => void;
  ouvrirMenu: (id: string, ancre: HTMLElement) => void;
}

export const LigneMemo = React.memo(function Ligne({ v, ctx, colEdition, initEdition, etats, selectionne, detail, nbCols }: {
  v: LignePraticien; ctx: CtxLigne; colEdition: Colonne | null; initEdition: string | undefined;
  etats: Partial<Record<Colonne, EtatCellule>> | undefined; selectionne: boolean; detail: boolean; nbCols: number;
}) {
  const id = v.doctorId;
  const cell = (col: Colonne, affichage: React.ReactNode, editeur: () => React.ReactNode, className?: string) => (
    <Cellule key={col} id={id} col={col} editable={ctx.peut[col]} enEdition={colEdition === col} etat={etats?.[col]} ctx={ctx} className={className} editeur={editeur}>
      {affichage}
    </Cellule>
  );
  const finir = (col: Colonne) => ({
    onValider: (brut: string, dep: Deplacement) => ctx.valider(id, col, brut, dep),
    onAnnuler: (refocaliser: boolean) => ctx.annuler(id, col, refocaliser),
  });
  // Ouvert en tapant : la recherche commence par ce caractère ; un texte « à rattacher » la préremplit, sélectionné.
  // Les listes ne se construisent qu'à l'ouverture de la cellule (`options` est une fonction) : 300 lignes × 600 établissements, non.
  const choix = (col: Colonne, options: () => Choix[], courant: string, aRetrouver?: string) => function editeurChoix() {
    return <EditeurChoix options={options()} courant={courant} recherche={initEdition ?? aRetrouver ?? ""} selectionner={initEdition === undefined} {...finir(col)} />;
  };
  const texte = (col: Colonne, valeur: string, numerique = false) => function editeurTexte() {
    return <EditeurTexte initial={initEdition ?? valeur} numerique={numerique} selectionner={initEdition === undefined} {...finir(col)} />;
  };
  const vide = <span className="text-muted-foreground">—</span>;
  const pct = affiniteAffichee(v.q1, v.q2, ctx.methode);
  const spe = casseNom(v.specialite);
  const aRattacher = !v.institutionId && !!v.etablissement;

  return (
    <>
      <tr className={cn("group hover:bg-secondary/30", selectionne && "bg-primary/5")}>
        {ctx.avecSelection && (
          <td className="sticky left-0 z-[1] w-9 border-b border-border bg-card px-2 py-1.5">
            <input type="checkbox" checked={selectionne} onChange={() => ctx.basculer("selection", id)} aria-label={`Sélectionner ${v.nomFamille}`} className="h-4 w-4 align-middle" />
          </td>
        )}
        {cell("secteur", v.secteurNom ?? vide,
          choix("secteur", () => ctx.options.secteur, v.secteurPose ? v.secteurId ?? "" : ""))}
        {cell("cdr", (
          <span className="inline-flex items-center gap-1.5">
            <span className="max-w-[240px] truncate" title={v.etablissement ?? undefined}>{v.etablissement ?? vide}</span>
            {aRattacher && <span className="rounded bg-warning/10 px-1 text-[10px] text-warning" title="Texte sans lien vers l'annuaire des établissements">à rattacher</span>}
            {v.secteurId && v.inOut && <span className="text-[11px] text-muted-foreground">{v.inOut === "IN" ? "In" : "Out"}</span>}
          </span>
        ), choix("cdr", () => ctx.options.cdr, v.institutionId ?? "", aRattacher ? v.etablissement ?? undefined : undefined))}
        {cell("specialite", spe || vide,
          choix("specialite", () => ctx.options.specialite, v.specialiteId ?? "", !v.specialiteId && spe ? spe : undefined))}
        {cell("nom", <span className="font-medium">{v.nomFamille}</span>, texte("nom", v.nomFamille), cn("sticky z-[1] bg-card", ctx.avecSelection ? "left-9" : "left-0"))}
        {cell("prenom", v.prenom ?? "", texte("prenom", v.prenom ?? ""))}
        {cell("grade", v.titre === "AUTRE" && v.gradeBrut
          ? <span className="italic" title="Grade hors liste (fichier) — choisissez un grade">{v.gradeBrut}</span>
          : v.grade,
          choix("grade", () => ctx.options.grade, v.titre === "AUTRE" && v.gradeBrut ? "" : v.titre))}
        {cell("statut", v.statut ? STATUT_LABELS[v.statut] : vide,
          choix("statut", () => ctx.options.statut, v.statut ?? ""))}
        {cell("q1", v.q1 === null ? vide : fmt(v.q1), texte("q1", fmt(v.q1), true), "text-center tabular-nums")}
        {cell("q2", v.q2 === null ? vide : fmt(v.q2), texte("q2", fmt(v.q2), true), "text-center tabular-nums")}
        <td className="whitespace-nowrap border-b border-border px-2.5 py-1.5 text-right tabular-nums">{pourcent(pct)}</td>
        {cell("potentiel", v.lettre ? (
          <span className="inline-flex items-center">
            <LettreBadge lettre={v.lettre} />
            {v.forcee && <span className="ml-1 text-[11px] text-warning" title={`Forcé — calculé : ${libelleLettre(v.lettreCalculee)} · ${v.forcee.motif}`}>✎</span>}
          </span>
        ) : vide, choix("potentiel", () => [
          ...(v.forcee ? [{ valeur: "__calc", libelle: `Calculée (${libelleLettre(v.lettreCalculee)})` }] : []),
          ...LETTRES_FORCABLES.map((x) => ({ valeur: x, libelle: x === "NC" ? "Non ciblé" : x })),
        ], v.forcee?.valeur ?? ""), "text-center")}
        <td className="whitespace-nowrap border-b border-border px-1 py-1.5 text-center">
          <button type="button" aria-label={`Actions : ${v.nomFamille}`} onClick={(e) => ctx.ouvrirMenu(id, e.currentTarget)} className="rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground">
            <MoreHorizontal className="h-4 w-4" />
          </button>
        </td>
      </tr>
      {detail && (
        <tr className="bg-secondary/20">
          <td colSpan={nbCols} className="border-b border-border px-4 py-3 text-xs">
            <p className="font-semibold">
              <Link href={`/praticiens/${id}`} className="hover:underline">{[v.prenom, v.nomFamille].filter(Boolean).join(" ")}</Link>
              {v.lettreCalculee && <span className="font-normal text-muted-foreground"> · calculé : {libelleLettre(v.lettreCalculee)}</span>}
            </p>
            {v.pourquoi.length > 0
              ? <ul className="mt-1 list-disc space-y-0.5 pl-4 text-muted-foreground">{v.pourquoi.map((t, i) => <li key={i}>{t}</li>)}</ul>
              : <p className="text-muted-foreground">Règles non publiées : aucun calcul.</p>}
            {v.forcee && <p className="mt-1"><span className="text-warning">✎</span> Forcé à {libelleLettre(v.forcee.valeur)} — {v.forcee.motif}</p>}
          </td>
        </tr>
      )}
    </>
  );
});

function Cellule({ id, col, editable, enEdition, etat, ctx, className, editeur, children }: {
  id: string; col: Colonne; editable: boolean; enEdition: boolean; etat: EtatCellule | undefined; ctx: CtxLigne;
  className?: string; editeur: () => React.ReactNode; children: React.ReactNode;
}) {
  return (
    <td
      data-cellule={editable ? `${id}|${col}` : undefined}
      tabIndex={editable && !enEdition ? 0 : undefined}
      onClick={editable && !enEdition ? () => ctx.commencer(id, col) : undefined}
      onKeyDown={editable && !enEdition ? (e) => ctx.toucheCellule(e, id, col) : undefined}
      className={cn(
        "relative whitespace-nowrap border-b border-border px-2.5 py-1.5 align-middle",
        editable && !enEdition && "cursor-pointer hover:bg-secondary/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/60",
        enEdition && "p-0.5",
        etat === "erreur" && "bg-destructive/10",
        className,
      )}
    >
      {enEdition ? editeur() : children}
      {etat === "envoi" && <Loader2 className="absolute right-0.5 top-0.5 h-3 w-3 animate-spin text-muted-foreground" aria-label="Enregistrement" />}
    </td>
  );
}

/** « 8,9 % » — une décimale ; « — » quand l'affinité ne se calcule pas. */
function pourcent(a: number | null): React.ReactNode {
  if (a === null) return <span className="text-muted-foreground">—</span>;
  return `${String(Math.round(a * 1000) / 10).replace(".", ",")} %`;
}
