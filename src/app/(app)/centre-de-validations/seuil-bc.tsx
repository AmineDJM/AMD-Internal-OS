"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { setBcValidationThresholdCentre } from "@/lib/actions/settings-actions";

/**
 * LE SEUIL DES BONS DE COMMANDE HORS AD & PRO (Direction, 10/2026) — « les BC hors Ad & Pro passent par le centre de
 * validation ; mets-moi un seuil là-bas aussi ». Le centre Ad & Pro garde le sien pour les BC de promotion.
 */
export function SeuilBCCentre({ seuil }: { seuil: number }) {
  const [saving, setSaving] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Le seuil des bons de commande</CardTitle>
        <CardDescription>
          Un bon de commande <strong>hors Ad &amp; Pro</strong> et <strong>strictement</strong> au-dessus de ce montant
          est validé ici avant la signature (module Bons de commande). En deçà, il passe directement à la signature.
          Les bons de commande d&apos;Ad &amp; Pro suivent le seuil du centre Ad &amp; Pro.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          action={async (fd) => {
            setSaving(true); setError(null); setMessage(null);
            const r = await setBcValidationThresholdCentre(fd);
            setSaving(false);
            if (r.ok) setMessage(r.message ?? "Enregistré.");
            else setError(r.error ?? "Échec.");
          }}
          className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end"
        >
          <div className="space-y-1">
            <Label htmlFor="bcValidationThresholdCentre">Seuil des bons de commande hors Ad &amp; Pro (DZD)</Label>
            <Input id="bcValidationThresholdCentre" name="bcValidationThresholdCentre" type="number" inputMode="decimal" min="0" step="any" defaultValue={seuil} />
            <p className="text-xs text-muted-foreground">
              <strong>0</strong> = tout bon de commande hors Ad &amp; Pro passe par ce centre. Un BC <em>sans montant
              renseigné</em> y passe quand même. Les BC en cours qui changent de côté du seuil sont réaiguillés aussitôt ;
              une validation déjà donnée ou une signature ne se retirent pas.
            </p>
          </div>
          <Button type="submit" className="w-full sm:w-auto" disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Enregistrer
          </Button>
        </form>
        {message && <p className="mt-3 rounded-lg bg-success/10 px-3 py-2 text-sm text-foreground">{message}</p>}
        {error && <p className="mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}
