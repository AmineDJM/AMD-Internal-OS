"use client";

import * as React from "react";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DocumentUpload } from "@/components/documents/document-upload";
import { DocumentList, type DocItem } from "@/components/documents/document-list";
import { CHEMIN_COURRIERS } from "@/lib/chemins/courriers";

/** Les natures de pièce qu'on joint à un pli — pas les 40 du référentiel complet. */
const MAIL_DOC_CATEGORIES = [
  "REQUEST_LETTER", "CONVENTION", "INVOICE", "PURCHASE_ORDER",
  "SUPPORTING_DOC", "QUOTE", "DELIVERY_NOTE", "PHOTO", "OTHER",
];

/**
 * LES DOCUMENTS D'UN COURRIER — un pli en porte souvent deux ou trois (la lettre, ses annexes,
 * l'accusé). La liste ouvre l'aperçu (où vivent téléchargement, impression, renommage) ; le dépôt,
 * plusieurs fichiers d'un coup, ne se déplie qu'à la demande.
 *
 * Les pièces passent par la table `Document` commune : même stockage, même contrôle d'accès, même
 * journalisation que partout.
 */
export function DocumentsCourrier({ entryId, documents, canUpload, canEdit, drive }: {
  entryId: string;
  documents: DocItem[];
  canUpload: boolean;
  canEdit: boolean;
  /** Le fichier du Drive référencé par le pli (déjà filtré par les droits du Drive). */
  drive?: React.ReactNode;
}) {
  const [ajout, setAjout] = React.useState(false);

  return (
    <div className="space-y-2">
      {documents.length > 0 ? (
        <DocumentList documents={documents} canDelete={canEdit} canEdit={canEdit} canRename={canEdit} path={CHEMIN_COURRIERS} />
      ) : !drive ? (
        <p className="text-sm text-muted-foreground">
          Aucun document.{canUpload ? " Ajoutez le scan du pli." : ""}
        </p>
      ) : null}
      {drive}
      {canUpload && (ajout ? (
        <div className="space-y-2 rounded-lg border border-border p-3">
          <div className="flex justify-end">
            <Button type="button" variant="ghost" size="sm" onClick={() => setAjout(false)}>
              <X className="h-4 w-4" /> Fermer
            </Button>
          </div>
          <DocumentUpload entityType="MAIL_ENTRY" entityId={entryId} categories={MAIL_DOC_CATEGORIES} />
        </div>
      ) : (
        <Button type="button" variant="outline" size="sm" onClick={() => setAjout(true)}>
          <Plus className="h-4 w-4" /> Ajouter un document
        </Button>
      ))}
    </div>
  );
}
