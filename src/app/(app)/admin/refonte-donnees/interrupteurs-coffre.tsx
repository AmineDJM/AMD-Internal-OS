"use client";

import * as React from "react";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";
import { Loader2 } from "lucide-react";
import { basculerCoffre } from "@/lib/actions/coffre-actions";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

/** Les deux interrupteurs du coffre. La règle (lecture ⇒ écriture, clé présente) est tenue par l'action. */
export function InterrupteursCoffre({ ecriture, lecture }: { ecriture: boolean; lecture: boolean }) {
  const { enCours, rafraichir } = useRafraichir();
  const [occupe, setOccupe] = React.useState<string | null>(null);
  const [erreur, setErreur] = React.useState<string | null>(null);

  async function basculer(bascule: "coffreEcriture" | "coffreLecture", actif: boolean) {
    setOccupe(bascule); setErreur(null);
    try {
      const r = await basculerCoffre(bascule, actif);
      if (!r.ok) setErreur(r.error ?? "Le réglage du coffre n'a pas été changé."); else rafraichir();
    } catch {
      setErreur(actionFailureMessage("THROWN"));
    } finally {
      setOccupe(null);
    }
  }

  const ligne = (bascule: "coffreEcriture" | "coffreLecture", libelle: string, aide: string, actif: boolean) => (
    <div className="flex flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="font-medium">{libelle} <Badge tone={actif ? "success" : "neutral"}>{actif ? "Ouverte" : "Fermée"}</Badge></p>
        <p className="text-xs text-muted-foreground">{aide}</p>
      </div>
      <Button size="sm" variant={actif ? "outline" : "primary"} disabled={occupe !== null || enCours} onClick={() => void basculer(bascule, !actif)}>
        {occupe === bascule && <Loader2 className="h-4 w-4 animate-spin" />} {actif ? "Fermer" : "Ouvrir"}
      </Button>
    </div>
  );

  return (
    <div className="space-y-2">
      {ligne("coffreEcriture", "Double écriture", "Chaque enregistrement d'un RIB, IBAN, NIN ou salaire en écrit aussi la copie chiffrée. La fermer referme la lecture.", ecriture)}
      {ligne("coffreLecture", "Double lecture", "Fiches, paie, annuaire, identités légales et pièces générées lisent par le coffre : politique d'accès, journal, masque ailleurs. Exige la double écriture.", lecture)}
      {erreur && <p className="text-sm text-destructive">{erreur}</p>}
    </div>
  );
}
