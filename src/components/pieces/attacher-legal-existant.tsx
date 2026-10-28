"use client";

import * as React from "react";
import type { EntityType } from "@prisma/client";
import { Link2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { RecordForm, type FieldDef } from "@/components/shared/create-record-button";
import { rattacherLegalAFiche } from "@/modules/ad-pro/actions-rattacher-legal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * RATTACHER UN DOCUMENT LEGAL QUI EXISTE DÉJÀ.
 *
 * Le bloc des pièces liées ne savait que CRÉER — c'est la bonne façon quand la pièce n'existe
 * pas encore. Mais dans la vraie vie elle existe souvent AVANT : la convention a été enregistrée
 * dans Legal la semaine dernière, le bon de commande est arrivé par le secrétariat. La seule
 * issue offerte était de la RECRÉER depuis la demande — donc deux lignes pour le même
 * engagement, deux montants dans les totaux, et celle qui porte les pièces jointes n'est pas
 * celle qui porte le lien.
 *
 * ── CE QUE CE BOUTON MONTRE, ET CE QU'IL NE MONTRE PAS ──────────────────────────────────
 *
 * La liste vient du SERVEUR, qui l'a déjà réduite à ce que la personne a le droit de voir : ce
 * composant ne cherche rien de lui-même. Un sélecteur qui interrogerait Legal côté client
 * proposerait des documents que le serveur refuserait ensuite — un geste offert puis retiré,
 * c'est-à-dire la pire façon de refuser.
 *
 * Aucun document rattachable : le bouton ne s'affiche PAS. Un bouton qui ouvre un menu vide fait
 * chercher ce qui n'y est pas.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export function AttacherLegalExistant({ entityType, entityId, candidats }: {
  entityType: EntityType;
  entityId: string;
  /** Les documents Legal LIBRES que la personne a le droit de voir — préparés par le serveur. */
  candidats: { value: string; label: string }[];
}) {
  const [open, setOpen] = React.useState(false);
  if (candidats.length === 0) return null;

  const fields: FieldDef[] = [
    { type: "hidden", name: "entityType", value: entityType },
    { type: "hidden", name: "entityId", value: entityId },
    {
      type: "select", name: "legalId", label: "Document à rattacher", required: true, full: true,
      options: [...candidats], placeholder: "— Choisir le document —",
      hint: "Seuls les documents que vous pouvez voir et qui ne sont rattachés à aucune autre fiche.",
    },
  ];

  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Link2 className="mr-1.5 h-3.5 w-3.5" /> Rattacher un document existant
      </Button>
      <Sheet
        open={open} onClose={() => setOpen(false)}
        title="Rattacher un document Legal existant"
        description="Le document reste où il est — seul son rattachement à cette fiche est ajouté. Rien n'est recréé, rien n'est dupliqué."
      >
        <RecordForm
          fields={fields}
          action={rattacherLegalAFiche}
          submitLabel="Rattacher"
          onDone={() => setOpen(false)}
          onCancel={() => setOpen(false)}
        />
      </Sheet>
    </>
  );
}
