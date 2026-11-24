"use client";

import * as React from "react";
import Link from "next/link";
import { DocumentPreview } from "@/components/documents/document-preview";
import { cn, formatCurrency, formatDate } from "@/lib/utils";
import {
  alertesDeLaDemande, phraseAvantApres, phraseEcheance, segmentsBv,
  type BlocBv, type LigneCentre,
} from "@/lib/validations/centre-affichage";

/**
 * LA FICHE D'UNE DEMANDE (maquette validée le 24/11/2026) — dans l'ordre où on la lit : la nature et la référence, l'objet,
 * qui demande ; le montant et l'échéance ; les ALERTES ; les faits ; le budget d'un BV avant → après ; ce qui est déjà
 * validé et les pièces (aperçu sur place). Les gestes arrivent par `decision` (le tableau les porte, avec les actions).
 *
 * Lecture seule : tout vient du chargeur (`queries/centre-validations.ts`), rien n'est recalculé ici.
 */

function Titre({ children }: { children: React.ReactNode }) {
  return <h3 className="text-[13px] font-semibold uppercase tracking-wide text-muted-foreground">{children}</h3>;
}

function Coche() {
  return <span aria-hidden className="inline-flex h-5 w-5 flex-none items-center justify-center rounded-full bg-success/15 text-xs font-bold text-success">✓</span>;
}

const COULEUR_SEGMENT: Record<string, string> = {
  consomme: "bg-foreground/70",
  engage: "bg-primary/40",
  demande: "bg-primary",
  disponible: "bg-secondary",
};

/** LE BUDGET D'UN BV : la barre consommé / engagé / cette demande / disponible après, et le 75 % qui suivra. */
function BudgetBv({ bv }: { bv: BlocBv }) {
  if (bv.etat === "SANS_ENVELOPPE") return null; // l'alerte le dit déjà
  if (bv.etat === "NON_VISIBLE") {
    return (
      <div className="rounded-[10px] bg-secondary/50 p-3.5 text-sm">
        <p className="text-[13px] text-muted-foreground">Budget BV {bv.part} % · {bv.categorie}</p>
        <p className="mt-1">Enveloppe non ouverte à votre compte.</p>
      </div>
    );
  }
  const segments = segmentsBv(bv);
  return (
    <div className="flex flex-col gap-2.5 rounded-[10px] bg-secondary/50 p-3.5" data-budget-bv>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-[13px] text-muted-foreground">Budget {bv.categorie} · {bv.periode} · {formatCurrency(bv.alloue)}</p>
        <p className={cn("text-[15px] font-bold tabular-nums", bv.disponibleApres < 0 && "text-destructive")}>{phraseAvantApres(bv)}</p>
      </div>
      <div
        role="img"
        aria-label={segments.map((s) => `${s.label} ${formatCurrency(s.valeur)}`).join(", ")}
        className="flex h-3.5 overflow-hidden rounded-full bg-border"
      >
        {segments.map((s) => <span key={s.cle} className={cn("block h-full", COULEUR_SEGMENT[s.cle])} style={{ width: `${s.pct}%` }} />)}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-[13px] text-muted-foreground">
        {segments.map((s) => (
          <span key={s.cle} className="inline-flex items-center gap-1.5">
            <span aria-hidden className={cn("inline-block h-2.5 w-2.5 rounded-[3px] border border-border", COULEUR_SEGMENT[s.cle])} />
            {s.label} <strong className="tabular-nums text-foreground">{formatCurrency(s.valeur)}</strong>
          </span>
        ))}
      </div>
      {bv.prevision75 && (
        <p className="text-[13px] text-muted-foreground">
          À prévoir ensuite : BV 75 % de ce dossier, {formatCurrency(bv.prevision75.montant)}
          {bv.prevision75.disponible !== null ? ` · budget BV 75 % disponible ${formatCurrency(bv.prevision75.disponible)}` : ""}.
        </p>
      )}
    </div>
  );
}

export function FicheValidation({ l, now, decision, pied }: { l: LigneCentre; now: Date; decision: React.ReactNode; pied: React.ReactNode }) {
  const alertes = alertesDeLaDemande(l, now);
  const rouge = alertes.some((a) => a.ton === "rouge");
  const faits: { label: string; valeur: React.ReactNode }[] = [
    ...(l.description ? [{ label: "Détails", valeur: <span className="whitespace-pre-wrap font-normal">{l.description}</span> }] : []),
    ...(l.lienObjet ? [{ label: "Objet concerné", valeur: <Link href={l.lienObjet} className="text-primary hover:underline">Ouvrir</Link> }] : []),
    ...(l.suivant ? [{ label: "Après vous", valeur: l.suivant }] : []),
    ...(l.societe ? [{ label: "Société", valeur: l.societe }] : []),
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-[1_1_320px]">
          <p className="text-[13px] text-muted-foreground [overflow-wrap:anywhere]">{l.nature} · {l.reference}</p>
          <h2 id="fiche-validation" className="mt-1 text-xl font-bold [overflow-wrap:anywhere]">{l.objet}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Demandé par <strong className="text-foreground">{l.demandeur || "—"}</strong> · le {formatDate(l.demandeLe, { day: "numeric", month: "short" })}
          </p>
        </div>
        <div className="text-right">
          {l.montant !== null && <p className="whitespace-nowrap text-2xl font-bold tabular-nums">{formatCurrency(l.montant)}</p>}
          <p className="text-[13px] text-muted-foreground">{phraseEcheance(l.echeance, now)}</p>
          {l.seuilBC !== null && <p className="text-xs text-muted-foreground">Au-dessus du seuil BC de {formatCurrency(l.seuilBC)}</p>}
        </div>
      </div>

      {alertes.length > 0 && (
        <ul
          data-alertes
          className={cn(
            "flex flex-col gap-1.5 rounded-[10px] border px-3.5 py-3",
            rouge ? "border-destructive/40 bg-destructive/10 text-destructive" : "border-warning/40 bg-warning/10 text-foreground",
          )}
        >
          {alertes.map((a, i) => <li key={i} className="text-sm [overflow-wrap:anywhere]"><strong>{a.titre}</strong> — {a.detail}</li>)}
        </ul>
      )}

      {faits.length > 0 && (
        <dl className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-x-5 gap-y-3">
          {faits.map((f) => (
            <div key={f.label} className="min-w-0">
              <dt className="text-[13px] text-muted-foreground">{f.label}</dt>
              <dd className="mt-0.5 text-sm font-semibold [overflow-wrap:anywhere]">{f.valeur}</dd>
            </div>
          ))}
        </dl>
      )}

      {l.bv && <BudgetBv bv={l.bv} />}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {l.chaine.length > 0 && (
          <section className="flex flex-col gap-2">
            <Titre>Déjà validé</Titre>
            <ul className="flex flex-col gap-1.5">
              {l.chaine.map((c, i) => (
                <li key={i} className="flex gap-2 text-sm">
                  <Coche />
                  <span className="min-w-0"><strong>{c.etape}</strong><br /><span className="text-[13px] text-muted-foreground">{c.detail}</span></span>
                </li>
              ))}
            </ul>
          </section>
        )}
        <section className="flex flex-col gap-2">
          <Titre>Pièces</Titre>
          {l.pieces.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aucune pièce jointe.</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {l.pieces.map((p) => (
                <li key={p.id} className="flex min-w-0 items-start gap-2 text-sm">
                  <Coche />
                  <span className="min-w-0 flex-1 [overflow-wrap:anywhere]"><DocumentPreview id={p.id} name={p.nom} hasFile={p.hasFile} /></span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {decision}
      {pied}
    </div>
  );
}
