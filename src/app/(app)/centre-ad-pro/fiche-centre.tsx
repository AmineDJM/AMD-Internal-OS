"use client";

import * as React from "react";
import Link from "next/link";
import { DocumentPreview } from "@/components/documents/document-preview";
import { cn, formatCurrency, formatDate, formatMontant } from "@/lib/utils";
import {
  estFormeBC, montantsDuBC, natureDeLaDemande, natureDeLaLigne,
  type AlerteCentre, type ContexteLigneCentre, type LigneCentre,
} from "@/modules/ad-pro/partage";

/**
 * LA FICHE DE DÉCISION DU CENTRE AD & PRO (maquette validée le 24/11/2026) — dans l'ordre où on la lit : la nature
 * et la société, l'objet et le montant, les ALERTES en rouge, la demande (ou les lignes du BC) et ce qui est déjà
 * validé en amont, les postes ou les devis reçus, les pièces (ouvrables en aperçu sans quitter le centre), le budget
 * de la ligne imputée et ce qui est déjà payé. Les gestes arrivent par `decision` ; le fil des échanges et la demande
 * d'origine restent repliés en bas.
 *
 * Lecture seule : tout vient du chargeur (`contexteDuCentreAdPro`), rien n'est recalculé ici.
 */

function Titre({ children }: { children: React.ReactNode }) {
  return <h3 className="text-[13px] font-semibold uppercase tracking-wide text-muted-foreground">{children}</h3>;
}

function Coche() {
  return <span aria-hidden className="inline-flex h-5 w-5 flex-none items-center justify-center rounded-full bg-success/15 text-xs font-bold text-success">✓</span>;
}

const VOIE: Record<string, string> = { AGENCE: "Agence", DIRECT: "Direct" };

export function FicheCentre({ row, c, alertes, statut, decision }: {
  row: LigneCentre;
  c: ContexteLigneCentre;
  alertes: readonly AlerteCentre[];
  /** La décision prise à l'instant (avant le rechargement de la file). */
  statut: { texte: string; ton: "ok" | "ko" | "attente" } | null;
  decision: React.ReactNode;
}) {
  const bc = estFormeBC(row.forme);
  const montants = montantsDuBC(row, c);
  const demande: { k: string; v: string }[] = bc
    ? [
        { k: "Prestataire", v: row.prestataire ?? c.devis.find((d) => d.retenu)?.prestataire ?? "—" },
        { k: "Poste", v: c.poste ?? "—" },
        { k: "Opération", v: c.operation ?? "—" },
        ...(row.detail ? [{ k: "Message", v: row.detail }] : []),
      ]
    : [
        { k: "Nature", v: natureDeLaDemande(row) ?? "—" },
        { k: "Demandeur", v: row.demandeur ?? "—" },
        ...(row.reference ? [{ k: "Référence", v: row.reference }] : []),
      ];

  return (
    <div className="flex flex-col gap-4" data-testid="fiche-centre">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-[1_1_320px]">
          <p className="text-[13px] text-muted-foreground [overflow-wrap:anywhere]">{natureDeLaLigne(row)}{c.societe ? ` · ${c.societe}` : ""}</p>
          <h2 id="fiche-centre" className="mt-1 text-xl font-bold [overflow-wrap:anywhere]">{row.intitule}</h2>
          <p className="mt-1 text-sm text-muted-foreground [overflow-wrap:anywhere]">
            {row.demandeur ? `Demandée par ${row.demandeur}` : "Demandeur non renseigné"}
            {c.creeLe ? ` le ${formatDate(c.creeLe, { day: "numeric", month: "short" })}` : ""}
          </p>
        </div>
        <p className="whitespace-nowrap text-2xl font-bold tabular-nums">{row.montant != null ? formatCurrency(row.montant) : "—"}</p>
      </div>

      {alertes.length > 0 && (
        <ul className="flex flex-col gap-1.5 rounded-[10px] border border-destructive/40 bg-destructive/10 px-3.5 py-3" data-alertes>
          {alertes.map((a) => <li key={a.titre} className="text-sm text-destructive [overflow-wrap:anywhere]"><strong>{a.titre}</strong> — {a.detail}</li>)}
        </ul>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <section className="flex flex-col gap-2">
          <Titre>{bc ? "Le bon de commande" : "La demande"}</Titre>
          <dl className="flex flex-col gap-1.5">
            {demande.map((x) => (
              <div key={x.k} className="flex gap-2.5 text-sm">
                <dt className="w-[104px] flex-none text-muted-foreground">{x.k}</dt>
                <dd className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">{x.v}</dd>
              </div>
            ))}
          </dl>
        </section>
        <section className="flex flex-col gap-2">
          <Titre>Déjà validé</Titre>
          {c.chaine.length === 0 ? <p className="text-sm text-muted-foreground">Rien d&apos;enregistré en amont.</p> : (
            <ul className="flex flex-col gap-1.5">
              {c.chaine.map((e, i) => (
                <li key={i} className="flex gap-2 text-sm">
                  <Coche />
                  <span className="min-w-0 [overflow-wrap:anywhere]"><strong>{e.etape}</strong>{e.detail && <><br /><span className="text-[13px] text-muted-foreground">{e.detail}</span></>}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {c.postes.length > 0 && (
        <section className="flex flex-col gap-1.5">
          <Titre>Les postes</Titre>
          <div role="table" aria-label="Postes de la demande" className="overflow-hidden rounded-[10px] border border-border">
            <div role="row" className="flex gap-2.5 bg-secondary/50 px-3 py-2 text-xs font-semibold text-muted-foreground">
              <span role="columnheader" className="min-w-0 flex-[2_1_0]">Poste</span>
              <span role="columnheader" className="hidden flex-[0_0_64px] sm:block">Voie</span>
              <span role="columnheader" className="hidden min-w-0 flex-[2_1_0] sm:block">Devis retenu</span>
              <span role="columnheader" className="flex-[0_0_104px] text-right">Montant</span>
            </div>
            {c.postes.map((p, i) => (
              <div key={i} role="row" className={cn("flex gap-2.5 border-t border-border px-3 py-2 text-sm", p.refuse && "text-muted-foreground line-through")}>
                <span role="cell" className="min-w-0 flex-[2_1_0] [overflow-wrap:anywhere]">{p.libelle}</span>
                <span role="cell" className="hidden flex-[0_0_64px] sm:block">{p.voie ? VOIE[p.voie] : "—"}</span>
                <span role="cell" className="hidden min-w-0 flex-[2_1_0] [overflow-wrap:anywhere] sm:block">{p.refuse ? "refusé" : p.devis ?? "—"}</span>
                <span role="cell" className="flex-[0_0_104px] whitespace-nowrap text-right font-semibold tabular-nums">{p.refuse ? "non compté" : formatMontant(p.montant)}</span>
              </div>
            ))}
            <div role="row" className="flex gap-2.5 border-t border-border px-3 py-2 text-sm font-bold">
              <span role="cell" className="flex-auto">Total</span>
              <span role="cell" className="whitespace-nowrap tabular-nums">{row.montant != null ? formatCurrency(row.montant) : "—"}</span>
            </div>
          </div>
        </section>
      )}

      {bc && c.devis.length > 0 && (
        <section className="flex flex-col gap-1.5">
          <Titre>Les devis reçus</Titre>
          <ul className="overflow-hidden rounded-[10px] border border-border">
            {c.devis.map((d, i) => (
              <li key={i} className={cn("flex flex-wrap gap-x-3 gap-y-1 px-3 py-2 text-sm", i > 0 && "border-t border-border", d.retenu === true && "bg-success/10 shadow-[inset_3px_0_0_hsl(var(--success))]")}>
                <span className="min-w-0 flex-[1_1_160px] font-semibold [overflow-wrap:anywhere]">{d.prestataire}</span>
                <span className="min-w-0 flex-[2_1_120px] text-muted-foreground">{d.retenu === true ? "Retenu" : d.retenu === false ? "Écarté" : "Reçu"}</span>
                <span className="whitespace-nowrap font-semibold tabular-nums">{formatMontant(d.montant)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {montants.length > 0 && (
        <section className="flex flex-col gap-2">
          <Titre>Devis, accordé, BC</Titre>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {montants.map((m, i) => (
              <span key={m.libelle} className={cn("rounded-lg border px-2.5 py-1.5", m.ecart ? "border-destructive/40 bg-destructive/10 text-destructive" : "border-border bg-card")}>
                {i > 0 ? "→ " : ""}{m.libelle} <strong className="tabular-nums">{formatMontant(m.valeur)}</strong>
              </span>
            ))}
          </div>
        </section>
      )}

      <section className="flex flex-col gap-2">
        <Titre>Pièces</Titre>
        {c.pieces.length === 0 ? <p className="text-sm text-muted-foreground">Aucune pièce jointe.</p> : (
          <ul className="flex flex-col gap-1.5">
            {c.pieces.map((p, i) => (
              <li key={`${p.documentId ?? "x"}-${i}`} className="flex items-start justify-between gap-2 text-sm">
                {p.documentId
                  ? <span className="min-w-0 [overflow-wrap:anywhere]"><DocumentPreview id={p.documentId} name={p.nom} hasFile /></span>
                  : <><span className="min-w-0 [overflow-wrap:anywhere]">{p.nom}</span><span className="shrink-0 text-[13px] text-muted-foreground">sans fichier</span></>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="grid grid-cols-1 gap-4 rounded-[10px] bg-secondary/50 p-3.5 sm:grid-cols-2">
        <div>
          <p className="text-[13px] text-muted-foreground [overflow-wrap:anywhere]">Budget{c.budget ? ` · ${c.budget.ligne}${c.budget.autres > 0 ? ` (+${c.budget.autres} autre${c.budget.autres > 1 ? "s" : ""})` : ""}` : ""}</p>
          <p className={cn("mt-1 text-[15px] font-semibold", c.budget && c.budget.disponible < 0 && "text-destructive")}>
            {c.budget ? `Disponible ${formatCurrency(c.budget.disponible)}` : "Aucune ligne imputée"}
          </p>
        </div>
        <div>
          <p className="text-[13px] text-muted-foreground">Déjà payé sur l&apos;opération</p>
          <p className="mt-1 text-[15px] font-semibold">{c.dejaPaye > 0 ? formatCurrency(c.dejaPaye) : "Rien encore"}</p>
        </div>
      </div>

      {statut && (
        <div role="status" className={cn("rounded-[10px] px-3.5 py-3 font-semibold", statut.ton === "ok" ? "bg-success/10 text-success" : statut.ton === "ko" ? "bg-destructive/10 text-destructive" : "bg-warning/10 text-foreground")}>
          {statut.texte}
        </div>
      )}

      {decision}

      <details className="border-t border-border pt-3">
        <summary className="cursor-pointer text-sm font-semibold">Fil des échanges ({c.fil.length}) · demande d&apos;origine</summary>
        <div className="mt-3 flex flex-col gap-2 text-sm">
          {c.fil.length === 0 ? <p className="text-[13px] text-muted-foreground">Aucun échange.</p> : (
            <ul className="flex flex-col gap-2">
              {c.fil.map((m, i) => (
                <li key={i} className="rounded-lg bg-secondary/50 px-2.5 py-2">
                  <strong>{m.auteur ?? "—"}</strong> <span className="text-[13px] text-muted-foreground">· {formatDate(m.le, { day: "numeric", month: "short" })}</span>
                  <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{m.texte}</p>
                </li>
              ))}
            </ul>
          )}
          <Link href={row.href} className="font-semibold text-primary hover:underline">Ouvrir {bc && c.operation ? c.operation : row.reference ?? "le dossier"}</Link>
        </div>
      </details>
    </div>
  );
}
