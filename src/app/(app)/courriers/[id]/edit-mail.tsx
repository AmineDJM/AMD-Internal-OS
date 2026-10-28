"use client";

import * as React from "react";
import { Pencil, Trash2, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { RecordForm, type FieldDef } from "@/components/shared/create-record-button";
import { editMailEntry, deleteMailEntry } from "@/lib/actions/mail-register-actions";
import { useConfirmer } from "@/components/ui/dialogue";
import { Retour } from "@/components/ui/retour";
import { actionFailureMessage } from "@/lib/action-outcome";
import { useRafraichir } from "@/components/shared/use-rafraichir";

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

/** Suppression du courrier — avec ses pièces jointes, et une confirmation qui le dit. */
export function DeleteMailButton({ id, title, attachments }: { id: string; title: string; attachments: number }) {
  const router = useRouter();
  const { rafraichir } = useRafraichir();
  const confirmer = useConfirmer();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function remove() {
    const warning = attachments > 0
      ? `Supprimer le courrier « ${title} » et ses ${attachments} pièce(s) jointe(s) ?`
      : `Supprimer le courrier « ${title} » ?`;
    if (!(await confirmer(warning))) return;
    setBusy(true); setError(null);
    const fd = new FormData();
    fd.set("id", id);
    try {
      const r = await deleteMailEntry(fd);
      if (!r.ok) { setBusy(false); setError(r.error ?? "Suppression impossible."); return; }
    } catch {
      setBusy(false);
      setError(actionFailureMessage("THROWN"));
      return;
    }
    router.push("/courriers");
    rafraichir();
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button variant="outline" size="sm" onClick={remove} disabled={busy}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />} Supprimer
      </Button>
      <Retour ton="erreur">{error}</Retour>
    </div>
  );
}
