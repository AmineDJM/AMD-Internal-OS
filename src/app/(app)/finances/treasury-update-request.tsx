"use client";

import * as React from "react";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";
import { Loader2, Check, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Input, Label } from "@/components/ui/input";
import { requestTreasuryUpdate } from "@/modules/finances/actions-tresorerie";

/**
 * L'ADMINISTRATION DEMANDE l'actualisation des soldes de trésorerie.
 *
 * Les Finances les mettent à jour quand elles le veulent ; l'administrateur, lui, ne saisit pas à
 * leur place — il le demande, pour l'ENTITÉ ouverte à l'écran. Les responsables Finance / Budget qui
 * la voient reçoivent une notification qui ouvre l'écran de réponse ; un second clic sur une demande
 * encore ouverte la RELANCE au lieu d'en créer une autre.
 */
export function TreasuryUpdateRequestButton({ entiteId, entite }: { entiteId: string | null; entite: string | null }) {
  const { rafraichir } = useRafraichir();
  const [open, setOpen] = React.useState(false);
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [done, setDone] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async () => {
    setBusy(true); setError(null);
    const fd = new FormData();
    if (note.trim()) fd.set("note", note.trim());
    if (entiteId) fd.set("entite", entiteId);
    try {
      const r = await requestTreasuryUpdate(fd);
      if (r.ok) {
        setDone(r.message ?? "Demande envoyée.");
        setTimeout(() => { setOpen(false); setDone(null); setNote(""); rafraichir(); }, 2500);
      } else setError(r.error ?? "La demande n'a pas été envoyée.");
    } catch {
      setError(actionFailureMessage("THROWN"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button variant="outline" className="h-auto min-h-10 max-w-full whitespace-normal py-2" onClick={() => setOpen(true)}>
        <RefreshCw className="h-4 w-4 shrink-0" /> Demander l&apos;actualisation des soldes
      </Button>
      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title="Demander l'actualisation des soldes"
        description={`Les responsables Finance / Budget${entite ? ` qui voient ${entite}` : ""} reçoivent une notification : ils saisissent le solde du relevé de chaque compte directement depuis elle, et vous êtes prévenu en retour.`}
        width="md"
      >
        <div className="space-y-3">
          {entite && <p className="rounded-lg bg-secondary/60 px-3 py-2 text-sm">Entité : <span className="font-medium">{entite}</span></p>}
          <div className="space-y-1.5">
            <Label htmlFor="treasury-note">Précision (facultatif)</Label>
            <Input
              id="treasury-note" value={note} onChange={(e) => setNote(e.target.value)}
              placeholder="Ex. avant le conseil de lundi — relevés bancaires au 10/08"
            />
          </div>
          {error && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
          {done && <p className="rounded-lg bg-success/10 px-3 py-2 text-sm text-foreground">{done}</p>}
          <Button className="w-full sm:w-auto" onClick={submit} disabled={busy || Boolean(done)}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : done ? <Check className="h-4 w-4" /> : <RefreshCw className="h-4 w-4" />}
            {done ? "Demande envoyée" : "Envoyer la demande"}
          </Button>
        </div>
      </Sheet>
    </>
  );
}
