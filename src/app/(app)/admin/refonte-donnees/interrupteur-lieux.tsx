"use client";

import * as React from "react";
import { MapPin, Loader2 } from "lucide-react";
import { reglerDoubleEcritureLieux } from "@/lib/actions/lieux-actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useRafraichir } from "@/components/shared/use-rafraichir";

/** L'interrupteur de la double écriture des lieux (`AppSetting.lieuxDoubleEcriture`). */
export function InterrupteurLieux({ actif }: { actif: boolean }) {
  const { rafraichir } = useRafraichir();
  const [enCours, demarrer] = React.useTransition();
  const [erreur, setErreur] = React.useState<string | null>(null);
  const basculer = () =>
    demarrer(async () => {
      const r = await reglerDoubleEcritureLieux(!actif);
      setErreur(r.ok ? null : r.error ?? "Échec.");
      if (r.ok) rafraichir();
    });
  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="space-y-0.5">
            <p className="text-sm font-medium">
              Double écriture des lieux : {actif ? <span className="text-emerald-600">allumée</span> : <span className="text-amber-600">éteinte</span>}
            </p>
            <p className="text-xs text-muted-foreground">
              Allumée, chaque wilaya ou ville saisie sur un praticien, un établissement, un partenaire, un fournisseur ou un
              secteur pose aussi son code officiel de wilaya. Éteinte, seul le texte est écrit ; la reprise « lieux-wilaya »
              remet les codes en accord.
            </p>
            {erreur && <p className="text-xs text-destructive">{erreur}</p>}
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={basculer} disabled={enCours}>
          {enCours && <Loader2 className="h-4 w-4 animate-spin" />} {actif ? "Éteindre" : "Allumer"}
        </Button>
      </CardContent>
    </Card>
  );
}
