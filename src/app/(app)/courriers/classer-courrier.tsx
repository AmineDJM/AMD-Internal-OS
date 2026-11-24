"use client";

import * as React from "react";
import { FolderInput, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Label, Select } from "@/components/ui/input";
import { Retour } from "@/components/ui/retour";
import { useAction } from "@/components/shared/use-action";
import { moveMailEntries } from "@/lib/actions/mail-folder-actions";

/**
 * « CLASSER » — ranger le pli dans un dossier (ou l'en sortir), sans rouvrir tout le formulaire.
 *
 * Les dossiers proposés sont ceux qui acceptent l'entité du pli (calculés au serveur) ; l'action
 * revérifie le périmètre et refuse franchement un dossier d'une autre entité.
 */
export function ClasserCourrier({ entryId, dossierActuel, dossiers }: {
  entryId: string;
  dossierActuel: string | null;
  dossiers: { value: string; label: string }[];
}) {
  const [open, setOpen] = React.useState(false);
  const [choix, setChoix] = React.useState(dossierActuel ?? "");
  const { busy, err, setErr, run } = useAction();

  const ranger = async () => {
    const fd = new FormData();
    fd.append("entryId", entryId);
    fd.set("folderId", choix);
    await run(() => moveMailEntries(fd), () => setOpen(false));
  };

  return (
    <>
      <Button variant="ghost" size="sm" className="justify-start" onClick={() => { setErr(null); setChoix(dossierActuel ?? ""); setOpen(true); }}>
        <FolderInput className="h-4 w-4" /> Classer
      </Button>
      <Sheet open={open} onClose={() => !busy && setOpen(false)} title="Classer le courrier">
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="classer-dossier">Dossier</Label>
            <Select id="classer-dossier" value={choix} onChange={(e) => setChoix(e.target.value)}>
              <option value="">— Non classé —</option>
              {dossiers.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
            </Select>
          </div>
          {err && <Retour ton="erreur">{err}</Retour>}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>Annuler</Button>
            <Button onClick={() => void ranger()} disabled={busy || choix === (dossierActuel ?? "")}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />} Ranger
            </Button>
          </div>
        </div>
      </Sheet>
    </>
  );
}
