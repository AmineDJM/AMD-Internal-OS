"use client";

import * as React from "react";
import { Plus, X, Paperclip, ChevronRight } from "lucide-react";
import type { EntityType } from "@prisma/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DocumentUpload } from "@/components/documents/document-upload";
import { DocumentList, type DocItem } from "@/components/documents/document-list";
import { DocumentPreview } from "@/components/documents/document-preview";
import { DOCUMENT_CATEGORY } from "@/lib/labels";
import { InfoBulle } from "@/components/ui/info-bulle";
import { ConseilLuna } from "./conseil-luna";
import { NATURES_DEMANDE_CONSEIL, type NatureDemandeConseil } from "../domaine/conseil-pieces";

/**
 * LES PIÈCES JOINTES GÉNÉRALES D'UNE DEMANDE AD & PRO — lettre de demande du médecin, programme,
 * convention, engagement, courrier… (Direction, 04/10).
 *
 * Le bloc « Pièces liées » (rattacher un document Legal, sections Devis → BC → Facture, engagements,
 * courriers) a quitté la fiche : la chaîne d'achat vit désormais SUR CHAQUE POSTE, en trois cases.
 * Ce qui reste à la demande, ce sont ses pièces générales : un petit « + Pièce jointe » discret, en
 * haut à droite de la carte des détails, et leur liste compacte sous les détails. Les fichiers déjà
 * déposés restent tous visibles ici — y compris un devis ou une facture posés jadis sur la demande.
 */
export interface PiecesJointesDeLaDemande {
  entityType: EntityType;
  entityId: string;
  documents: DocItem[];
  /** Peut déposer (la règle commune `canAttachToAdPro`, calculée au serveur). */
  peutDeposer: boolean;
  /** Pourquoi on ne peut pas déposer — dit plutôt que de cacher le bouton sans un mot. */
  motif?: string | null;
  /** Les catégories du dépôt de la demande (`categoriesDuDepotDeLaDemande`). */
  categories: string[];
  canDelete: boolean;
  canRename: boolean;
  canEdit: boolean;
  path: string;
}

export function CarteDetailsDemande({ titre, pieces, children, contentClassName, entete, piecesRepliees = false }: {
  titre: string;
  pieces: PiecesJointesDeLaDemande;
  /** Les détails de la demande (rendus au serveur) ; absent, la carte ne porte que les pièces jointes. */
  children?: React.ReactNode;
  contentClassName?: string;
  /**
   * Ce qui précède les pièces jointes (les faits de la demande) — le reste de `children` vient APRÈS elles. Une carte longue
   * (la prise en charge, avec ses postes) garde ainsi ses pièces jointes sous les faits, pas au bout de la page.
   */
  entete?: React.ReactNode;
  /**
   * LES PIÈCES REPLIÉES (carte « La demande », Direction 07/10) : « Pièces jointes (n) » dans un repli, chaque pièce en
   * puce cliquable — le nom ouvre l'aperçu, où vivent toujours imprimer / renommer / supprimer selon les droits reçus.
   */
  piecesRepliees?: boolean;
}) {
  const [ouvert, setOuvert] = React.useState(false);
  // LES PIÈCES DÉPOSÉES DANS CETTE SESSION par « + Pièce jointe » : Luna lit chacune et dit si elle
  // est au bon endroit (les détails de la demande, ou la bonne case d'un poste) — il CONSEILLE, il ne
  // déplace rien. Un état local, jamais au rechargement : chaque montage de <ConseilLuna> appelle un
  // modèle payant. L'interrupteur général de l'IA et la bascule du conseil sont relus au serveur, et
  // la ligne dit pourquoi Luna se tait quand l'un ou l'autre est coupé.
  const [deposes, setDeposes] = React.useState<string[]>([]);
  const nature = (NATURES_DEMANDE_CONSEIL as readonly string[]).includes(pieces.entityType)
    ? (pieces.entityType as NatureDemandeConseil)
    : null;
  const surDepot = React.useCallback((ids: string[]) => {
    setDeposes((cur) => [...cur, ...ids.filter((id) => !cur.includes(id))]);
  }, []);
  const n = pieces.documents.length;
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-2">
        <CardTitle className="min-w-0 [overflow-wrap:anywhere]">{titre}</CardTitle>
        {pieces.peutDeposer && (
          <button
            type="button" onClick={() => setOuvert((v) => !v)} aria-expanded={ouvert}
            className="inline-flex min-h-9 shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-xs sm:min-h-0 font-medium text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            {ouvert ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />} {ouvert ? "Fermer" : "Pièce jointe"}
          </button>
        )}
        {/* Repliée, la carte ne dit plus en clair pourquoi le dépôt est fermé : le motif passe derrière un ⓘ. */}
        {piecesRepliees && !pieces.peutDeposer && pieces.motif && (
          <InfoBulle label="Pourquoi pas de pièce jointe">{pieces.motif}</InfoBulle>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {entete}
        {!entete && children && <div className={contentClassName}>{children}</div>}
        {ouvert && pieces.peutDeposer && (
          <DocumentUpload
            entityType={pieces.entityType} entityId={pieces.entityId} categories={pieces.categories}
            onUploaded={nature ? surDepot : undefined}
          />
        )}
        {nature && deposes.length > 0 && (
          <ul className="space-y-1.5 rounded-lg border border-border/70 bg-muted/30 p-2" aria-label="Conseil de Luna sur les pièces déposées">
            {deposes.map((id) => {
              const doc = pieces.documents.find((d) => d.id === id);
              return (
                <li key={id} className="space-y-0.5">
                  <p className="truncate text-xs font-medium">{doc?.name ?? "Pièce déposée"}</p>
                  <ConseilLuna entityType={nature} entityId={pieces.entityId} fichierId={id} emplacement={{ type: "DETAILS" }} />
                </li>
              );
            })}
          </ul>
        )}
        {/* SANS PIÈCE JOINTE, RIEN (Direction, 07/10) : le bouton « Pièce jointe » de l'en-tête suffit. */}
        {piecesRepliees && n > 0 && (
          <details className="group border-t border-border/70 pt-3">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
              <ChevronRight className="h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-90" /> Pièces jointes ({n})
            </summary>
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {pieces.documents.map((d) => (
                <li key={d.id} className="flex min-w-0 max-w-full items-center gap-1.5 rounded-lg border border-border px-2.5 py-1">
                  <span className="min-w-0 max-w-[16rem]">
                    <DocumentPreview
                      id={d.id} name={d.name} hasFile={d.hasFile} canEdit={pieces.canEdit} canDelete={pieces.canDelete}
                      canRename={pieces.canRename} path={pieces.path}
                    />
                  </span>
                  <span className="shrink-0 text-[0.6875rem] text-muted-foreground">{DOCUMENT_CATEGORY[d.category] ?? d.category}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
        {!piecesRepliees && (n > 0 || (!pieces.peutDeposer && pieces.motif)) && (
          <div className={children && !entete ? "border-t border-border/70 pt-3" : undefined}>
            {n > 0 && (
              <>
                <p className="mb-1.5 inline-flex items-center gap-1 text-xs text-muted-foreground">
                  <Paperclip className="h-3.5 w-3.5" /> Pièces jointes de la demande ({n})
                </p>
                <DocumentList
                  documents={pieces.documents} canDelete={pieces.canDelete} canRename={pieces.canRename}
                  canEdit={pieces.canEdit} path={pieces.path}
                />
              </>
            )}
            {!pieces.peutDeposer && pieces.motif && <p className="mt-1 text-xs text-muted-foreground">{pieces.motif}</p>}
          </div>
        )}
        {entete && children && <div className={contentClassName}>{children}</div>}
      </CardContent>
    </Card>
  );
}
