"use client";

import * as React from "react";
import Link from "next/link";
import { DocumentPreview } from "@/components/documents/document-preview";
import { Badge } from "@/components/ui/badge";
import { cn, formatCurrency, formatDate, formatDateTime, formatMontant } from "@/lib/utils";
import {
  CENTRAL_DECISION_LABEL, phraseBudget, type CentralDecision, type ContexteDecision, type EtatEtape,
} from "@/modules/finances/partage";

/**
 * LA FICHE DE DÉCISION (maquette validée le 24/11/2026) — tout ce qu'on lit avant d'autoriser, dans l'ordre où on le
 * lit : l'objet et le montant, les ALERTES en rouge, ce qui est déjà validé en amont et les pièces (ouvrables en aperçu
 * sans quitter le centre), les montants du devis à ce qu'on paie, le budget et ce qui est déjà payé, qui demande. Les
 * gestes de décision arrivent par `decision` (le tableau les porte, avec l'action) ; le fil des échanges et « demander
 * une pièce » restent repliés en bas : on les ouvre quand on en a besoin.
 *
 * Lecture seule : aucune donnée n'est recalculée ici, la forme vient du chargeur (`ContexteDecision`).
 */

const PUCE: Record<EtatEtape, { signe: string; classe: string }> = {
  OK: { signe: "✓", classe: "bg-success/15 text-success" },
  KO: { signe: "✕", classe: "bg-destructive/10 text-destructive" },
  ATTENTE: { signe: "…", classe: "bg-secondary text-muted-foreground" },
};

function Puce({ etat }: { etat: EtatEtape }) {
  const p = PUCE[etat];
  return <span aria-hidden className={cn("inline-flex h-5 w-5 flex-none items-center justify-center rounded-full text-xs font-bold", p.classe)}>{p.signe}</span>;
}

function Titre({ children }: { children: React.ReactNode }) {
  return <h3 className="text-[13px] font-semibold uppercase tracking-wide text-muted-foreground">{children}</h3>;
}

/** « À payer avant le 5 déc. », « Échéance fixe : 28 nov. » — ou rien quand aucune date n'est demandée. */
export function phraseEcheance(f: Pick<ContexteDecision, "echeance" | "echeanceFixe">, court = false): string | null {
  if (!f.echeance) return null;
  const d = formatDate(f.echeance, { day: "numeric", month: "short" });
  if (f.echeanceFixe) return court ? `fixe ${d}` : `Échéance fixe : ${d}`;
  return court ? `avant le ${d}` : `À payer avant le ${d}`;
}

export function FicheDecision({ f, decision, repli }: { f: ContexteDecision; decision: React.ReactNode; repli?: React.ReactNode }) {
  const echeance = phraseEcheance(f);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[13px] text-muted-foreground [overflow-wrap:anywhere]">{f.origine} · {f.reference}</p>
          <h2 id="fiche-centre" className="mt-1 text-xl font-bold [overflow-wrap:anywhere]">{f.objet}</h2>
          <p className="mt-1 text-sm text-muted-foreground [overflow-wrap:anywhere]">
            {f.beneficiaire ? <>À payer à <strong className="text-foreground">{f.beneficiaire}</strong></> : "Bénéficiaire non précisé"}
            {f.historique ? ` · ${f.historique}` : ""}
          </p>
        </div>
        <div className="text-right">
          <p className="whitespace-nowrap text-2xl font-bold tabular-nums">{formatCurrency(f.montant)}</p>
          {echeance && <p className={cn("text-[13px]", f.echeanceFixe ? "font-semibold text-destructive" : "text-muted-foreground")}>{echeance}</p>}
        </div>
      </div>

      {f.alertes.length > 0 && (
        <ul className="flex flex-col gap-1.5 rounded-[10px] border border-destructive/40 bg-destructive/10 px-3.5 py-3" data-alertes>
          {f.alertes.map((a, i) => (
            <li key={i} className="text-sm text-destructive [overflow-wrap:anywhere]"><strong>{a.titre}</strong> — {a.detail}</li>
          ))}
        </ul>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <section className="flex flex-col gap-2">
          <Titre>Déjà validé</Titre>
          {f.chaine.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aucune validation en amont connue pour cette origine.</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {f.chaine.map((c, i) => (
                <li key={i} className="flex gap-2 text-sm">
                  <Puce etat={c.etat} />
                  <span className="min-w-0 [overflow-wrap:anywhere]"><strong>{c.etape}</strong>{c.detail && <><br /><span className="text-[13px] text-muted-foreground">{c.detail}</span></>}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="flex flex-col gap-2">
          <Titre>Pièces</Titre>
          {f.pieces.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aucune pièce jointe.</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {f.pieces.map((p, i) => (
                <li key={`${p.documentId ?? "x"}-${i}`} className="flex items-start justify-between gap-2 text-sm">
                  <span className="flex min-w-0 gap-2 [overflow-wrap:anywhere]"><Puce etat={p.present ? "OK" : "KO"} /> {p.nom}</span>
                  {p.present && p.documentId
                    ? <span className="shrink-0"><DocumentPreview id={p.documentId} name={p.fichier ?? p.nom} hasFile libelle="Voir" /></span>
                    : <span className="shrink-0 text-[13px] text-muted-foreground">{p.present ? "sans fichier" : "absente"}</span>}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {f.montants.length > 0 && (
        <section className="flex flex-col gap-2">
          <Titre>Les montants, du début à la fin</Titre>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {f.montants.map((m, i) => (
              <span key={i} className={cn("rounded-lg border px-2.5 py-1.5", m.ecart ? "border-destructive/40 bg-destructive/10 text-destructive" : "border-border bg-card")}>
                {i > 0 ? "→ " : ""}{m.libelle} <strong className="tabular-nums">{formatMontant(m.valeur)}</strong>
              </span>
            ))}
          </div>
        </section>
      )}

      <div className="grid grid-cols-1 gap-4 rounded-[10px] bg-secondary/50 p-3.5 sm:grid-cols-2">
        <div>
          <p className="text-[13px] text-muted-foreground">Budget{f.budget.etat === "IMPUTE" ? ` · ${f.budget.ligne}` : ""}</p>
          <p className={cn("mt-1 text-[15px] font-semibold", f.budget.etat === "IMPUTE" && f.budget.apres < 0 && "text-destructive")}>{phraseBudget(f.budget)}</p>
        </div>
        <div>
          <p className="text-[13px] text-muted-foreground">Déjà payé sur cette demande</p>
          <p className="mt-1 text-[15px] font-semibold">{f.dejaPaye}</p>
        </div>
      </div>

      <p className="text-[13px] text-muted-foreground">
        Demandé par {f.demandeur ?? "—"} · le {formatDate(f.demandeLe, { day: "numeric", month: "short" })}
      </p>

      {decision}

      <details className="border-t border-border pt-3">
        <summary className="cursor-pointer text-sm font-semibold">Fil des échanges · ouvrir la demande d&apos;origine · demander une pièce</summary>
        <div className="mt-3 flex flex-col gap-3 text-sm">
          {f.note && (
            <p className="whitespace-pre-wrap rounded-md bg-secondary/50 px-2 py-1.5 [overflow-wrap:anywhere]"><span className="font-medium">Commentaire du demandeur : </span>{f.note}</p>
          )}
          {f.fil.length > 0 ? (
            <ul className="flex flex-col gap-1.5 border-l-2 border-border pl-3">
              {f.fil.map((m) => (
                <li key={m.id} className="text-[13px]">
                  <p className="text-muted-foreground">
                    <span className="font-medium text-foreground">{m.auteur ?? "—"}</span>
                    {m.decision && ` · ${CENTRAL_DECISION_LABEL[m.decision as CentralDecision] ?? m.decision}`} · {formatDateTime(m.le)}
                  </p>
                  <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{m.texte}</p>
                </li>
              ))}
            </ul>
          ) : <p className="text-[13px] text-muted-foreground">Aucun échange au centre sur ce paiement.</p>}
          {f.piecesReclamees.length > 0 && (
            <ul className="flex flex-col gap-1 text-[13px]" data-pieces-demandees>
              {f.piecesReclamees.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center gap-1.5 [overflow-wrap:anywhere]">
                  <Badge tone={d.deposee ? "info" : "warning"} dot={false}>{d.deposee ? "Pièce déposée, à examiner" : "Pièce demandée"}</Badge>
                  <Link href={`/pieces/${d.id}`} className="text-primary hover:underline">{d.libelle}</Link>
                  {d.a && <span className="text-muted-foreground">— à {d.a}</span>}
                </li>
              ))}
            </ul>
          )}
          <p className="flex flex-wrap gap-x-4 gap-y-1">
            {f.dossierHref && <Link href={f.dossierHref} className="font-semibold text-primary hover:underline">Ouvrir le dossier de paiement</Link>}
            {f.origineHref && f.origineHref !== f.dossierHref && <Link href={f.origineHref} className="font-semibold text-primary hover:underline">Ouvrir la demande d&apos;origine</Link>}
          </p>
          {repli}
        </div>
      </details>
    </div>
  );
}
