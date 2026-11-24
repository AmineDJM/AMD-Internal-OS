"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowUpRight, Clock, Download, FileText, Loader2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DocumentUpload } from "@/components/documents/document-upload";
import { useAction } from "@/components/shared/use-action";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { cn, formatCurrency, formatDate } from "@/lib/utils";
import { ouvrirDeclarationDepuisAdPro } from "@/lib/actions/medical-info-actions";
import { ETAPE_DECLARATION_PARTAGEE } from "@/lib/medical-info/etape-ad-pro-partage";
import {
  TITRE_TOUR, TOURS_DU_PHARMACIEN, type LigneAVenir, type LigneDeclarationAFaire, type TourDeclaration,
} from "@/lib/medical-info/parcours";
import { AuthorityForm, DeclareDecisionCard, RelancerPieceButton, ValidateButton } from "./[id]/panels";

/**
 * « DÉCLARATIONS » DE L'ÉCRAN « À FAIRE » (Direction, 23/11/2026) — rangées par TOUR (`medical-info/parcours.ts`) : d'abord ce qui
 * est au pharmacien (sa lecture, le dépôt ANPP, sa validation, ses bons), puis ce qu'il attend des autres (pièces — à
 * relancer), puis ce qui est chez le Directeur des Opérations ou en paiement. Chaque ligne : UNE phrase, UN geste, ses
 * fichiers. « À venir » : les demandes accordées dont la déclaration attend encore des postes, et pourquoi. Aucune phrase
 * d'aide sous les titres (Super Admin, 24/11/2026) : la consigne de la ligne suffit.
 */

function Fichiers({ fichiers }: { fichiers: LigneDeclarationAFaire["fichiers"] }) {
  if (fichiers.length === 0) return null;
  return (
    <ul className="space-y-1">
      {fichiers.map((f) => (
        <li key={f.id} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <a href={`/api/documents/${f.id}`} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate text-primary hover:underline">{f.nom}</a>
          <span className="shrink-0 text-muted-foreground">{formatDate(f.le, { day: "numeric", month: "short" })}{f.partagee ? "" : " · interne"}</span>
          <a href={`/api/documents/${f.id}?dl=1`} className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-0.5 font-medium hover:bg-secondary" aria-label={`Télécharger ${f.nom}`}>
            <Download className="h-3 w-3" /> Télécharger
          </a>
        </li>
      ))}
    </ul>
  );
}

function Geste({ l, gestionnaire }: { l: LigneDeclarationAFaire; gestionnaire: boolean }) {
  const { rafraichir } = useRafraichir();
  if (!gestionnaire) return null;
  switch (l.tour) {
    case "LECTURE":
      return <DeclareDecisionCard id={l.id} state={l.declare} authorityRef={l.authorityRef} canRequest={l.peutDemander} validationHref={l.validationHref} />;
    case "DEPOT":
      return (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="min-w-0 space-y-1.5">
            <p className="text-xs font-medium">Déclaration et récépissé ANPP</p>
            <DocumentUpload entityType="MEDICAL_INFO_DECLARATION" entityId={l.id} categories={["SUPPORTING_DOC", "OTHER"]} compact stepKey={ETAPE_DECLARATION_PARTAGEE} onUploaded={rafraichir} />
          </div>
          <div className="min-w-0 space-y-1.5">
            <AuthorityForm id={l.id} authorityRef={l.authorityRef} authorityNotes={l.authorityNotes} />
          </div>
        </div>
      );
    case "VALIDER":
      return <ValidateButton id={l.id} hasPending={l.piecesEnAttente} />;
    case "PIECES":
      return (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {l.pieces.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
              <span className="min-w-0">
                <span className="font-medium">{p.label}</span>
                <span className="block text-xs text-muted-foreground">Chez {p.chez ?? "—"}{p.jours != null ? ` · demandée il y a ${p.jours} j` : ""}</span>
              </span>
              <RelancerPieceButton id={p.id} refus={p.refusRelance} />
            </li>
          ))}
        </ul>
      );
    case "BONS":
      return (
        <Link href={`/information-medicale/${l.id}`} className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground">
          Ouvrir les bons de versement <ArrowUpRight className="h-4 w-4" />
        </Link>
      );
    case "CHEZ_DO":
      return l.validationHref && l.declare.validationStatus === "PENDING"
        ? <Link href={l.validationHref} className="text-xs text-primary hover:underline">Voir la demande de validation</Link>
        : null;
    case "AILLEURS":
      return null;
  }
}

function LigneDeclaration({ l, gestionnaire }: { l: LigneDeclarationAFaire; gestionnaire: boolean }) {
  const aLui = TOURS_DU_PHARMACIEN.includes(l.tour);
  return (
    <li id={`dim-${l.id}`} className={cn("scroll-mt-20 space-y-3 rounded-xl border p-3 sm:p-4", aLui ? "border-primary/40 bg-primary/[0.03]" : "border-border bg-card")}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-0.5">
          <Link href={`/information-medicale/${l.id}`} className="font-medium hover:underline [overflow-wrap:anywhere]">
            <span className="font-mono text-xs text-muted-foreground">{l.reference}</span> · {l.label}
          </Link>
          <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
            {l.nature}{l.beneficiaire ? ` · ${l.beneficiaire}` : ""}{l.montant != null ? ` · ${formatCurrency(l.montant)}` : ""}
            {l.sourceHref && <> · <Link href={l.sourceHref} className="text-primary hover:underline">la demande</Link></>}
          </p>
        </div>
        {l.jours != null && (
          <span className={cn("inline-flex shrink-0 items-center gap-1 text-xs", l.jours > 7 && aLui ? "text-warning" : "text-muted-foreground")}>
            <Clock className="h-3.5 w-3.5" /> {l.jours ? `depuis ${l.jours} j` : "aujourd'hui"}
          </span>
        )}
      </div>
      <p className="text-sm">{l.consigne}</p>
      <Geste l={l} gestionnaire={gestionnaire} />
      <Fichiers fichiers={l.fichiers} />
    </li>
  );
}

function OuvrirDeclaration({ v }: { v: LigneAVenir }) {
  const { saving, err, run } = useAction();
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <Button
        size="sm" disabled={saving}
        onClick={() => { const fd = new FormData(); fd.set("sourceType", v.type); fd.set("sourceId", v.id); void run(() => ouvrirDeclarationDepuisAdPro(fd), undefined, { succes: "Déclaration ouverte." }); }}
      >
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />} Ouvrir la déclaration
      </Button>
      {err && <span className="text-xs text-destructive">{err}</span>}
    </span>
  );
}

export function DeclarationsAFaire({ tours, aVenir, gestionnaire }: {
  tours: { tour: TourDeclaration; lignes: LigneDeclarationAFaire[] }[]; aVenir: LigneAVenir[]; gestionnaire: boolean;
}) {
  return (
    <section className="space-y-4" aria-label="Déclarations">
      {tours.length === 0 && (
        <p className="rounded-lg border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
          Aucune déclaration en cours{gestionnaire ? " — « Nouvelle déclaration » pour en ouvrir une." : "."}
        </p>
      )}
      {tours.map(({ tour, lignes }) => (
        <div key={tour} className="space-y-2">
          <h3 className="text-sm font-semibold">{TITRE_TOUR[tour]} <span className="font-normal text-muted-foreground">({lignes.length})</span></h3>
          <ul className="space-y-3">{lignes.map((l) => <LigneDeclaration key={l.id} l={l} gestionnaire={gestionnaire} />)}</ul>
        </div>
      ))}
      {aVenir.length > 0 && (
        <details className="rounded-lg border border-border px-3 py-2" open={tours.length === 0}>
          <summary className="cursor-pointer text-sm font-semibold">À venir ({aVenir.length})</summary>
          <ul className="mt-2 divide-y divide-border">
            {aVenir.map((v) => (
              <li key={v.cle} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                <span className="min-w-0">
                  {v.href ? <Link href={v.href} className="font-medium hover:underline">{v.nom}</Link> : <span className="font-medium">{v.nom}</span>}
                  <span className="text-muted-foreground"> · {v.nature}</span>
                  <span className="block text-xs text-muted-foreground">
                    {v.total ? `${v.valides}/${v.total} postes prêts` : "Aucun poste"}
                    {v.ouvrable ? " — prête à ouvrir" : v.blocages.length ? ` — ${v.blocages.join(", ")}` : ""}
                    {v.brouillons ? ` · ${v.brouillons} brouillon${v.brouillons > 1 ? "s" : ""} non soumis (non déclaré${v.brouillons > 1 ? "s" : ""})` : ""}
                  </span>
                </span>
                {v.ouvrable && gestionnaire && <OuvrirDeclaration v={v} />}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
