"use client";

/**
 * LES FORMULAIRES DES RÉGLAGES — les limites de l'application et le seuil Ad & Pro de la Direction Générale.
 */
import * as React from "react";
import { Loader2, Check } from "lucide-react";
import { saveAppSettings, setAdProDgThreshold } from "@/lib/actions/settings-actions";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import type { AppSettings } from "@/lib/settings";

export function AdminLimitsForm({ settings }: { settings: AppSettings }) {
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  return (
    <form
      action={async (fd) => {
        setSaving(true); setError(null);
        const r = await saveAppSettings(fd);
        setSaving(false);
        if (r.ok) { setSaved(true); setTimeout(() => setSaved(false), 1500); }
        else setError(r.error ?? "Échec.");
      }}
      className="space-y-3"
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="maxUploadMb">Documents / pièces jointes — taille max (Mo)</Label>
          <Input id="maxUploadMb" name="maxUploadMb" type="number" min="1" max="256" defaultValue={settings.maxUploadMb} />
          <p className="text-xs text-muted-foreground">S'applique à TOUS les documents (Regulatory, Congrès, Sujets, RH, médical…). Jusqu'à 256 Mo ; au-delà, passez par le Drive.</p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="maxDriveUploadMb">Drive — taille max (Mo)</Label>
          <Input id="maxDriveUploadMb" name="maxDriveUploadMb" type="number" min="1" max="10240" defaultValue={settings.maxDriveUploadMb} />
          <p className="text-xs text-muted-foreground">Fichiers du Drive (gros transferts en flux), jusqu'à 2 048 Mo.</p>
        </div>
      </div>
      {error && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
      <div className="flex justify-end">
        <Button type="submit" disabled={saving}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : saved ? <Check className="h-4 w-4 text-success" /> : null}
          {saved ? "Enregistré" : "Enregistrer les limites"}
        </Button>
      </div>
    </form>
  );
}

/**
 * LE SEUIL Ad & Pro AU-DELÀ DUQUEL LE DIRECTEUR GÉNÉRAL VALIDE (§118.138).
 *
 * Un seul champ, et c'est l'essentiel : le MÊME chiffre gouverne les quatre circuits
 * configurables et le matériel promotionnel. La phrase le dit en toutes lettres — un réglage
 * dont on ne sait pas ce qu'il touche ne se règle pas, il se laisse tel quel.
 */
export function AdProDgThresholdForm({ settings }: { settings: AppSettings }) {
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  return (
    <form
      action={async (fd) => {
        setSaving(true); setError(null);
        const r = await setAdProDgThreshold(fd);
        setSaving(false);
        if (r.ok) { setSaved(true); setTimeout(() => setSaved(false), 1500); }
        else setError(r.error ?? "Échec.");
      }}
      className="space-y-3"
    >
      <div className="space-y-1">
        <Label htmlFor="adProDgThreshold">Seuil de validation du Directeur Général (DZD)</Label>
        <Input
          id="adProDgThreshold" name="adProDgThreshold" type="number" min="0" step="any"
          defaultValue={settings.adProDgThreshold}
        />
        <p className="text-xs text-muted-foreground">
          Au-delà de ce montant, la demande passe par le <strong>Centre de validation Ad &amp; Pro</strong> —
          sur les <strong>sept</strong> natures du pôle, sans exception : sponsoring, prises en charge nationales
          et internationales, événements, matériel promotionnel, consulting et autres demandes. En dessous, la
          porte est franchie automatiquement et tracée. <strong>0</strong> = aucune validation du centre.
          Ce même seuil se règle depuis le centre.
        </p>
      </div>
      {error && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
      <div className="flex justify-end">
        <Button type="submit" disabled={saving}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : saved ? <Check className="h-4 w-4 text-success" /> : null}
          {saved ? "Enregistré" : "Enregistrer le seuil"}
        </Button>
      </div>
    </form>
  );
}
