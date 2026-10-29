import Link from "next/link";
import type { EntityType } from "@prisma/client";
import { ExternalLink, Scale } from "lucide-react";
import type { SessionUser } from "@/lib/rbac";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DocumentList } from "@/components/documents/document-list";
import { lienFichierEmis } from "@/lib/legal/fichiers-emis";
import { formatCurrency } from "@/lib/utils";
import { chargerPiecesLegalDeLaDemande } from "@/lib/queries/pieces-legal-demande";
import { supprimerFichierDePieceDeLaDemande } from "../actions-pieces";
import { RaisonPieceNonSupprimable, SupprimerPieceLegal } from "@/components/pieces/supprimer-piece-legal";

/** Au-delà de ce nombre de pièces, la liste se replie : la fiche reste lisible. */
const REPLIE_AU_DELA = 4;

/**
 * « PIÈCES LEGAL DE LA DEMANDE » — les pièces du registre rattachées DIRECTEMENT à la demande
 * (conventions, contrats, devis d'avant les postes…), et qu'aucun poste ne porte. On peut les
 * SUPPRIMER d'ici — la pièce (réversible : corbeille) ou l'un de ses fichiers — par la même décision
 * que les actions (§118.209) ; le reste de leur gestion se fait sur la fiche Legal. Un seul composant
 * pour toutes les natures ; la lecture et ses droits vivent dans `chargerPiecesLegalDeLaDemande`.
 * Rien à montrer ⇒ rien n'est rendu.
 */
export async function PiecesLegalDeLaDemande({ spectateur, entityType, entityId }: {
  spectateur: SessionUser;
  entityType: EntityType;
  entityId: string;
}) {
  const p = await chargerPiecesLegalDeLaDemande(spectateur, entityType, entityId);
  if (p.total === 0) return null;

  const liste = (
    <ul className="divide-y divide-border">
      {p.lignes.map((l) => (
        <li key={l.id} className="py-2">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <span className="min-w-0 flex-1 basis-48">
              {l.fiche ? (
                <Link href={`/legal/${l.id}`} className="inline-flex min-w-0 items-center gap-1 font-medium hover:underline">
                  <span className="truncate">{l.titre}</span> <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />
                </Link>
              ) : (
                <span className="block truncate font-medium">{l.titre}</span>
              )}
              <span className="block text-[0.6875rem] text-muted-foreground [overflow-wrap:anywhere] sm:truncate">
                {[l.nature, l.reference, l.montant !== null ? formatCurrency(l.montant) : null].filter(Boolean).join(" · ")}
              </span>
            </span>
            <span className="ml-auto flex shrink-0 items-center gap-1">
              {l.statut && <Badge tone={l.statut.tone} dot={false}>{l.statut.label}</Badge>}
              <SupprimerPieceLegal id={l.id} nom={l.reference ? `${l.reference} — ${l.titre}` : l.titre} offert={l.suppression.piece.offert} />
            </span>
          </div>
          {/* CE QUI ENGAGE LA PIÈCE se DIT, avec le geste qui reste (§118.83) : une seule phrase par pièce — celle qui
              refuse la pièce couvre aussi ses fichiers, qui ne se ferment jamais seuls. */}
          {!l.suppression.piece.offert && <RaisonPieceNonSupprimable raison={l.suppression.piece.raison} />}
          {(l.plateforme.pdf || l.plateforme.docx) && (
            <p className="mt-1 flex flex-wrap items-center gap-2 pl-3 text-[0.6875rem] text-muted-foreground">
              Version plateforme :
              {l.plateforme.pdf && <a className="inline-flex min-h-9 items-center px-1 font-medium text-foreground hover:underline sm:min-h-0 sm:px-0" href={lienFichierEmis(l.id, "pdf")} target="_blank" rel="noreferrer">PDF</a>}
              {l.plateforme.docx && <a className="inline-flex min-h-9 items-center px-1 font-medium text-foreground hover:underline sm:min-h-0 sm:px-0" href={lienFichierEmis(l.id, "docx")} target="_blank" rel="noreferrer">Word</a>}
            </p>
          )}
          {l.documents.length > 0 && (
            <div className="mt-1.5 border-l-2 border-border pl-3">
              <DocumentList
                documents={l.documents} canDelete={l.suppression.fichiers.offert} canRename={false} canEdit={false}
                path={`/legal/${l.id}`} supprimer={supprimerFichierDePieceDeLaDemande}
              />
            </div>
          )}
        </li>
      ))}
    </ul>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Scale className="h-4 w-4 text-muted-foreground" />
          Pièces Legal de la demande
          <span className="text-sm font-normal text-muted-foreground">({p.total})</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <p className="text-xs text-muted-foreground">
          Rattachées directement à la demande, hors postes — on peut les supprimer d&apos;ici (réversible) ; le reste de leur gestion se fait dans Legal.
        </p>
        {p.lignes.length > REPLIE_AU_DELA ? (
          <details>
            <summary className="cursor-pointer py-2 text-xs font-medium text-muted-foreground sm:py-0">
              Afficher les {p.lignes.length} pièces
            </summary>
            {liste}
          </details>
        ) : liste}
        {/* CE QUI N'EST PAS RENDU SE COMPTE (§118.60) : une liste raccourcie qui se tait se lit complète. */}
        {p.masquees > 0 && (
          <p className="text-[0.6875rem] text-muted-foreground">
            {p.masquees === 1 ? "1 autre pièce ne vous est pas ouverte." : `${p.masquees} autres pièces ne vous sont pas ouvertes.`}
          </p>
        )}
        {p.nonLues > 0 && (
          <p className="text-[0.6875rem] text-muted-foreground">
            {p.nonLues === 1 ? "1 pièce plus ancienne" : `${p.nonLues} pièces plus anciennes`} — la liste complète est dans Legal.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
