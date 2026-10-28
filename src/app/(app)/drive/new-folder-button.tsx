"use client";

import * as React from "react";

import { FolderPlus, Loader2, Check } from "lucide-react";
import { createFolder } from "@/lib/actions/drive-actions";
import { Sheet } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Retour } from "@/components/ui/retour";
import { useFormAction } from "@/components/shared/use-action";

export function NewFolderButton({ parentId, spaceId }: { parentId: string | null; spaceId?: string | null }) {
  const [open, setOpen] = React.useState(false);
  const creation = React.useCallback((fd: FormData) => createFolder(undefined, fd), []);
  const { action, busy: saving, err } = useFormAction(creation, { onOk: () => setOpen(false) });

  return (
    <>
      <Button variant="outline" type="button" onClick={() => setOpen(true)}><FolderPlus className="h-4 w-4" /> Nouveau dossier</Button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Nouveau dossier" width="md">
        <form
          action={action}
          className="space-y-3"
        >
          {parentId && <input type="hidden" name="parentId" value={parentId} />}
          {spaceId && <input type="hidden" name="spaceId" value={spaceId} />}
          <div className="space-y-1.5">
            <Label htmlFor="name">Nom du dossier</Label>
            <Input id="name" name="name" required />
          </div>
          <Retour ton="erreur">{err}</Retour>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>Annuler</Button>
            <Button type="submit" disabled={saving}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Créer</Button>
          </div>
        </form>
      </Sheet>
    </>
  );
}
