"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { EntityType } from "@prisma/client";
import { ArrowUpRight, FileText, Loader2, ShieldCheck, Stethoscope } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DocumentUpload } from "@/components/documents/document-upload";
import { useAction } from "@/components/shared/use-action";
import { cn, formatDate } from "@/lib/utils";
import { ouvrirDeclarationDepuisAdPro } from "@/lib/actions/medical-info-actions";
import type { EtapeDeclaration } from "@/lib/medical-info/etape-ad-pro-partage";
import { AuthorityForm, DeclareDecisionCard, ValidateButton } from "./[id]/panels";

const TON: Record<EtapeDeclaration["ton"], string> = {
  succes: "border-success/40 bg-success/10 text-success",
  info: "border-primary/30 bg-primary/5 text-primary",
  attente: "border-warning/40 bg-warning/10 text-foreground",
  neutre: "border-border bg-secondary/40 text-muted-foreground",
};

/**
 * LA DERNIÈRE ÉTAPE DU CIRCUIT, SUR LA FICHE AD & PRO — « Déclaration (information scientifique) » (Direction, 08/11/2026).
 *
 * Tout le monde y lit où en est la déclaration de l'événement. Le pharmacien responsable (et le Super Admin) y AGIT :
 * déposer les déclarations — rangées sur le dossier d'information médicale, donc visibles là-bas aussi — et
 * enregistrer la référence du ministère, une fois la lecture « à déclarer » accordée. Une demande sans déclaration
 * (accordée avant qu'un pharmacien soit réglé) s'ouvre d'ici. Le reste de l'instruction se fait dans le dossier.
 */
export function EtapeDeclarationAdPro({ etape, sourceType, sourceId }: {
  etape: EtapeDeclaration; sourceType: EntityType; sourceId: string;
}) {
  const router = useRouter();
  const { saving, err, run } = useAction();
  const d = etape.declaration;

  return (
    <section className="space-y-3 rounded-xl border border-border p-3 sm:p-4" aria-label={etape.titre}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Dernière étape du circuit</p>
          <h3 className="flex items-center gap-1.5 font-semibold"><Stethoscope className="h-4 w-4 shrink-0 text-muted-foreground" /> {etape.titre}</h3>
        </div>
        {etape.lienDossier && d && (
          <Link href={etape.lienDossier} className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
            Dossier {d.reference} <ArrowUpRight className="h-3.5 w-3.5" />
          </Link>
        )}
      </div>

      <p className={cn("rounded-lg border px-3 py-2 text-sm font-medium", TON[etape.ton])}>{etape.phrase}</p>

      {etape.peutOuvrir && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button" size="sm" disabled={saving}
            onClick={() => run(() => { const fd = new FormData(); fd.set("sourceType", sourceType); fd.set("sourceId", sourceId); return ouvrirDeclarationDepuisAdPro(fd); })}
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />} Ouvrir la déclaration
          </Button>
          <span className="text-xs text-muted-foreground">Cette demande a été accordée sans dossier d&apos;information médicale : ouvrez-le pour la déclarer.</span>
        </div>
      )}
      {err && <p className="text-sm text-destructive">{err}</p>}

      {etape.pieces.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Déclarations déposées</p>
          <ul className="space-y-1">
            {etape.pieces.map((p) => (
              <li key={p.id} className="flex min-w-0 items-center gap-2 text-sm">
                <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <a href={`/api/documents/${p.id}`} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate text-primary hover:underline">{p.nom}</a>
                <span className="shrink-0 text-xs text-muted-foreground">{formatDate(p.le, { day: "numeric", month: "short" })}{p.par ? ` · ${p.par}` : ""}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* LES GESTES DU PHARMACIEN, ICI COMME DANS LE DOSSIER (08/11/2026) : sa lecture « à déclarer / sans déclaration »
          tant qu'elle n'est pas accordée, puis sa validation, qui transmet au Directeur des Opérations. */}
      {etape.peutAgir && d && (etape.decision || etape.validation.peut) && (
        <div className="space-y-3 border-t border-border pt-3">
          {etape.decision && (
            <div className="space-y-2">
              <p className="text-sm font-medium">À déclarer au ministère, ou non ?</p>
              <DeclareDecisionCard
                id={d.id} state={etape.decision.etat} authorityRef={d.authorityRef}
                canRequest={etape.decision.peutDemander} validationHref={etape.decision.validationHref}
              />
            </div>
          )}
          {etape.validation.peut && (
            <div className="space-y-2">
              <p className="text-sm font-medium">Votre validation</p>
              <ValidateButton id={d.id} hasPending={etape.validation.piecesAttendues} />
            </div>
          )}
        </div>
      )}

      {etape.peutAgir && d && (
        <div className="grid grid-cols-1 gap-4 border-t border-border pt-3 lg:grid-cols-2">
          <div className="min-w-0 space-y-2">
            <p className="text-sm font-medium">Déposer les déclarations</p>
            <p className="text-xs text-muted-foreground">Déclaration, récépissé, courrier du ministère : rangés dans le dossier {d.reference}.</p>
            <DocumentUpload
              entityType="MEDICAL_INFO_DECLARATION" entityId={d.id} categories={["SUPPORTING_DOC", "OTHER"]} compact
              onUploaded={() => router.refresh()}
            />
          </div>
          <div className="min-w-0 space-y-2">
            <p className="text-sm font-medium">Référence du ministère</p>
            {etape.depot.ouvert ? (
              <AuthorityForm id={d.id} authorityRef={d.authorityRef} authorityNotes={d.authorityNotes} />
            ) : (
              <p className="text-xs text-muted-foreground">
                {etape.depot.motif}{" "}
                {etape.lienDossier && <Link href={etape.lienDossier} className="text-primary hover:underline">Ouvrir le dossier</Link>}
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
