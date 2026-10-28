"use client";

import * as React from "react";
import { Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { RecordForm, type FieldDef } from "@/components/shared/create-record-button";
import { editMailEntry } from "@/lib/actions/mail-register-actions";

/**
 * MODIFIER (ou supprimer) UN COURRIER, depuis sa fiche.
 *
 * L'identifiant est LIÉ à l'action côté serveur, jamais posé dans un champ caché : un champ
 * caché se réécrit dans le navigateur, et l'on modifierait alors le pli de quelqu'un d'autre.
 * Le serveur revérifie de toute façon le droit et le périmètre — ceci n'est que la première
 * porte, pas la serrure.
 */
export function EditMailButton({ id, fields }: { id: string; fields: FieldDef[] }) {
  const [open, setOpen] = React.useState(false);
  // `bind` fixe l'identifiant au moment du rendu : la signature qui arrive à `RecordForm` reste
  // celle qu'il attend — (état précédent, formulaire).
  const action = React.useMemo(() => editMailEntry.bind(null, id), [id]);

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Pencil className="h-4 w-4" /> Modifier
      </Button>

      <Sheet
        open={open} onClose={() => setOpen(false)} width="lg"
        title="Modifier le courrier"
        description="Chaque champ touché part au journal avec son ancienne et sa nouvelle valeur."
      >
        <RecordForm
          fields={fields}
          action={action}
          onDone={() => setOpen(false)}
          onCancel={() => setOpen(false)}
          submitLabel="Enregistrer les corrections"
        />
      </Sheet>
    </>
  );
}
