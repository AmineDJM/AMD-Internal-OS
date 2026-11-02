"use client";

import * as React from "react";
import { GraduationCap, Loader2, Send } from "lucide-react";
import { requestTraining } from "@/lib/actions/training-actions";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Input, Label, Textarea } from "@/components/ui/input";

/**
 * DEMANDER UNE FORMATION — depuis son espace, là où l'on demande déjà tout le reste.
 *
 * Le circuit existait (`requestTraining` : N+1 → RH → DG) mais sa seule porte était le module
 * « Formations », que la plupart des gens n'ouvrent jamais — on y allait pour CONSULTER un
 * catalogue, pas pour demander. Un droit dont la porte est introuvable n'est pas un droit.
 *
 * Le DEVIS n'est pas exigé ici : l'obtenir prend parfois des semaines, et bloquer la demande sur
 * sa pièce, c'est empêcher d'en parler. Le montant annoncé suffit à ouvrir la discussion ; la
 * pièce se dépose ensuite sur la fiche.
 */
/** `compact` : le bouton discret du bloc « Moi » d'Aujourd'hui (« Demander ») — même formulaire, même action. */
export function TrainingRequestButton({ managerName, compact = false }: { managerName: string | null; compact?: boolean }) {
  const { rafraichir } = useRafraichir();
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);

  return (
    <>
      {/* MÊME TAILLE QUE SES VOISINS. Ce bouton vit à côté de « Nouvelle tâche » et
          « Ajouter une note de frais », dans l'en-tête de Mon espace : trois gestes du même
          rang. En laisser un en `md` et les deux autres en `sm` donnait trois hauteurs et deux
          tailles de texte sur une même ligne — on lit alors une hiérarchie qui n'existe pas. */}
      {compact ? (
        <Button variant="outline" size="sm" onClick={() => { setMsg(null); setOpen(true); }} aria-label="Demander une formation">
          Demander
        </Button>
      ) : (
        <Button variant="outline" onClick={() => { setMsg(null); setOpen(true); }}>
          <GraduationCap className="h-4 w-4" /> Demander une formation
        </Button>
      )}

      <Sheet
        open={open}
        onClose={() => !busy && setOpen(false)}
        title="Demander une formation"
        description={managerName
          ? `Votre demande part à ${managerName}, puis aux ressources humaines, puis à la Direction. Le devis n'est pas obligatoire pour la déposer.`
          : "Votre demande part aux ressources humaines, puis à la Direction. Le devis n'est pas obligatoire pour la déposer."}
        width="md"
      >
        <form
          action={async (fd) => {
            setBusy(true); setMsg(null);
            let r: Awaited<ReturnType<typeof requestTraining>>;
            try {
              r = await requestTraining(undefined, fd);
            } catch {
              setMsg({ ok: false, text: actionFailureMessage("THROWN") });
              return;
            } finally {
              setBusy(false);
            }
            if (r.ok) {
              setOpen(false);
              setMsg(null);
              rafraichir();
            } else {
              setMsg({ ok: false, text: r.error ?? "La demande de formation n'a pas été envoyée." });
            }
          }}
          className="space-y-4"
        >
          <div className="space-y-1.5">
            <Label htmlFor="tr-title">Intitulé de la formation <span className="text-destructive">*</span></Label>
            <Input id="tr-title" name="title" required placeholder="Ex. Bonnes pratiques de fabrication — module avancé" />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="tr-provider">Organisme / formateur</Label>
              <Input id="tr-provider" name="provider" placeholder="Ex. IFP Formation" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tr-amount">Coût annoncé (DZD)</Label>
              <Input id="tr-amount" name="amount" type="number" inputMode="decimal" step="any" min="0" placeholder="0" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tr-start">Début</Label>
              <Input id="tr-start" name="startDate" type="date" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tr-end">Fin</Label>
              <Input id="tr-end" name="endDate" type="date" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tr-location">Lieu</Label>
            <Input id="tr-location" name="location" placeholder="Ex. Alger, ou en ligne" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tr-desc">En quoi elle vous servira</Label>
            <Textarea id="tr-desc" name="description" className="min-h-[80px]" placeholder="Ce que la formation apporte à votre poste — c'est ce que lira votre responsable." />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tr-files">Devis, programme… <span className="text-xs font-normal text-muted-foreground">(facultatif)</span></Label>
            <input id="tr-files" name="files" type="file" multiple className="block w-full text-sm text-muted-foreground file:mr-3 file:rounded-lg file:border-0 file:bg-secondary file:px-3 file:py-1.5 file:text-sm file:font-medium" />
          </div>
          {msg && (
            <p className={`rounded-lg px-3 py-2 text-sm ${msg.ok ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive"}`}>
              {msg.text}
            </p>
          )}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={busy}>Annuler</Button>
            <Button type="submit" disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Envoyer la demande
            </Button>
          </div>
        </form>
      </Sheet>
    </>
  );
}
