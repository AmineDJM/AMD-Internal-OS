"use client";

import * as React from "react";
import { Mails, Loader2, Check } from "lucide-react";
import { Sheet } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";
import { Input, Label, Select } from "@/components/ui/input";
import { MAIL_DIRECTION } from "@/lib/labels";
import { attachDriveNodeToMail } from "@/lib/actions/mail-register-actions";

/**
 * CLASSER UN FICHIER DU DRIVE EN COURRIER — sans copie, le jumeau de « Déclarer dans Legal ».
 *
 * Le scan du pli est déjà dans le Drive ; on l'inscrit au carnet avec ce que le Drive ne sait
 * pas porter — l'objet, le sens, l'expéditeur, le destinataire. Le fichier NE BOUGE PAS : le
 * courrier le référence, et le carnet en montre toujours la version courante.
 *
 * ⚠️ Comme son jumeau Legal, ce panneau est rendu PAR LA LIGNE, hors du menu contextuel : le
 * menu est un portail démonté à la fermeture, et un panneau rendu par lui disparaît dans le
 * même clic que celui qui l'ouvre.
 */
export function SendToMailSheet({
  open, nodeId, name, onClose,
}: {
  open: boolean;
  nodeId: string;
  name: string;
  onClose: () => void;
}) {
  const { rafraichir } = useRafraichir();
  const [saving, setSaving] = React.useState(false);
  const [done, setDone] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  React.useEffect(() => { if (open) { setErr(null); setDone(false); } }, [open, nodeId]);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setSaving(true); setErr(null);
    try {
      const r = await attachDriveNodeToMail({
        driveNodeId: nodeId,
        title: String(fd.get("title") ?? ""),
        direction: String(fd.get("direction") ?? "OUTGOING"),
        sender: String(fd.get("sender") ?? ""),
        recipient: String(fd.get("recipient") ?? ""),
        reference: String(fd.get("reference") ?? ""),
      });
      if (r.ok) {
        setDone(true);
        setTimeout(() => { onClose(); setDone(false); rafraichir(); }, 900);
      } else {
        setErr(r.error ?? "Le document n'a pas été classé en courrier.");
      }
    } catch {
      setErr(actionFailureMessage("THROWN"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="Classer en courrier" width="md">
      <form onSubmit={submit} className="space-y-3">
        <p className="rounded-lg border border-border bg-secondary/30 p-2.5 text-xs text-muted-foreground [overflow-wrap:anywhere]">
          <strong>{name}</strong> reste dans le Drive : le carnet de courriers ne fait pas de copie,
          il pointe vers ce fichier.
        </p>

        <div>
          <Label htmlFor="mail-title">Objet du courrier</Label>
          <Input id="mail-title" name="title" defaultValue={name} className="mt-1" />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="mail-direction">Sens</Label>
            <Select id="mail-direction" name="direction" defaultValue="OUTGOING" className="mt-1">
              {Object.entries(MAIL_DIRECTION).map(([v, d]) => <option key={v} value={v}>{d.label}</option>)}
            </Select>
          </div>
          <div>
            <Label htmlFor="mail-ref">Référence / chrono</Label>
            <Input id="mail-ref" name="reference" className="mt-1" placeholder="Laissez vide si inconnu" />
          </div>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="mail-sender">Expéditeur</Label>
            <Input id="mail-sender" name="sender" className="mt-1" />
          </div>
          <div>
            <Label htmlFor="mail-recipient">Destinataire</Label>
            <Input id="mail-recipient" name="recipient" className="mt-1" />
          </div>
        </div>

        {err && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}

        <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" onClick={onClose}>Annuler</Button>
          <Button type="submit" disabled={saving || done}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : done ? <Check className="h-4 w-4" /> : <Mails className="h-4 w-4" />}
            {done ? "Classé" : "Classer en courrier"}
          </Button>
        </div>
      </form>
    </Sheet>
  );
}
