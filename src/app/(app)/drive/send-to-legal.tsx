"use client";

import * as React from "react";
import { Scale, Loader2, Check } from "lucide-react";
import { Sheet } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";
import { Input, Label, Select } from "@/components/ui/input";
import { LEGAL_DOC_KIND } from "@/lib/labels";
import { attachDriveNodeToLegal } from "@/lib/actions/legal-actions";
import { PartyPicker } from "@/components/directory/party-picker";

/**
 * DÉCLARER UN FICHIER DU DRIVE DANS LEGAL — SANS EN FAIRE DE COPIE.
 *
 * Le geste réel : le contrat est déjà dans le Drive, on veut le déclarer comme engagement et lui
 * donner ce que le Drive ne sait pas porter — le titre exact, la partie en face, les dates.
 *
 * Le fichier NE BOUGE PAS et n'est pas dupliqué : Legal garde une référence vers ce nœud. Il
 * continue donc de se versionner, de se renommer et de se partager dans le Drive, et Legal en
 * montre toujours la version courante. Deux copies auraient divergé dès la première correction,
 * et plus personne n'aurait su laquelle fait foi.
 *
 * ⚠️ CE FORMULAIRE VIT EN DEHORS DU MENU, et c'est la correction d'un bug qui rendait l'action
 * entièrement inopérante : le menu contextuel du Drive est un PORTAIL monté seulement tant qu'il
 * est ouvert. Tant que ce panneau était rendu par l'entrée de menu, cliquer dessus fermait le
 * menu — donc démontait le panneau dans le même souffle. On cliquait, et il ne se passait rien.
 * Les autres actions (renommer, déplacer, partager) ne souffraient pas du problème parce que
 * leurs panneaux sont, eux, rendus par la ligne. Celui-ci l'est désormais aussi.
 */
export function SendToLegalSheet({
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

  // Rouvrir sur un autre fichier ne doit pas hériter de l'erreur du précédent.
  React.useEffect(() => { if (open) { setErr(null); setDone(false); } }, [open, nodeId]);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setSaving(true); setErr(null);
    try {
      const r = await attachDriveNodeToLegal({
        driveNodeId: nodeId,
        title: String(fd.get("title") ?? ""),
        kind: String(fd.get("kind") ?? "CONTRACT"),
        // LA PARTIE VIENT DE L'ANNUAIRE — le sélecteur pose des champs cachés nommés.
        counterpartyIds: fd.getAll("counterpartyIds").map(String).filter(Boolean),
        reference: String(fd.get("reference") ?? ""),
        startDate: String(fd.get("startDate") ?? ""),
        endDate: String(fd.get("endDate") ?? ""),
      });
      if (r.ok) {
        setDone(true);
        setTimeout(() => { onClose(); setDone(false); rafraichir(); }, 900);
      } else {
        setErr(r.error ?? "Le document n'a pas été classé au juridique.");
      }
    } catch {
      setErr(actionFailureMessage("THROWN"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="Déclarer dans Legal" width="md">
      <form onSubmit={submit} className="space-y-3">
        <p className="rounded-lg border border-border bg-secondary/30 p-2.5 text-xs text-muted-foreground [overflow-wrap:anywhere]">
          <strong>{name}</strong> reste dans le Drive : Legal ne fait pas de copie, il pointe vers ce
          fichier. Il continuera de s&apos;y versionner et de s&apos;y renommer, et Legal en montrera
          toujours la version courante.
        </p>

        <div>
          <Label htmlFor="legal-title">Titre exact du document</Label>
          <Input id="legal-title" name="title" defaultValue={name} className="mt-1" />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="legal-kind">Nature</Label>
            <Select id="legal-kind" name="kind" defaultValue="CONTRACT" className="mt-1">
              {Object.entries(LEGAL_DOC_KIND).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
          </div>
          <div>
            <Label htmlFor="legal-ref">Référence / n°</Label>
            <Input id="legal-ref" name="reference" className="mt-1" />
          </div>
        </div>
        <div>
          <Label htmlFor="legal-party">Partie (fournisseur, client, prestataire)</Label>
          {/* Le sélecteur va chercher l'annuaire lui-même : cet écran vit dans une ligne du
              Drive, à cinq composants clients de toute page serveur. */}
          <div className="mt-1"><PartyPicker name="counterpartyIds" arity="many" /></div>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="legal-start">Date de début</Label>
            <Input id="legal-start" name="startDate" type="date" className="mt-1" />
          </div>
          <div>
            <Label htmlFor="legal-end">Date de fin</Label>
            <Input id="legal-end" name="endDate" type="date" className="mt-1" />
            {/* Sans échéance est un cas NORMAL, pas un oubli : on le dit, sinon on invente une date. */}
            <p className="mt-1 text-[0.6875rem] text-muted-foreground">
              Laissez vide si le document n&apos;a pas d&apos;échéance — il ne se périmera jamais et
              ne déclenchera aucun rappel.
            </p>
          </div>
        </div>

        {err && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}

        <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" onClick={onClose}>Annuler</Button>
          <Button type="submit" disabled={saving || done}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : done ? <Check className="h-4 w-4" /> : <Scale className="h-4 w-4" />}
            {done ? "Déclaré" : "Déclarer dans Legal"}
          </Button>
        </div>
      </form>
    </Sheet>
  );
}
