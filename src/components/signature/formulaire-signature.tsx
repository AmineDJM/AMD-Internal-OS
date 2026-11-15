"use client";

import * as React from "react";
import Link from "next/link";
import { Loader2, PenLine, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { CHEMIN_MA_SIGNATURE, type SignaturePrete } from "@/lib/signature-en-ligne/partage";


/**
 * SIGNER ET CACHETER EN LIGNE (Direction, 15/11/2026) — le même petit formulaire pour la Direction Marketing et les Finances :
 * « J'ai relu », le mot de passe du compte, le code de l'application d'authentification. Tant que la signature, le cachet ou
 * le code ne sont pas préparés, le formulaire le dit et mène à « Ma signature » : on ne découvre pas le manque au clic.
 */
export function FormulaireSignature({ titre, bouton, pret, apercu, busy, onSigner, onCancel }: {
  titre: string;
  bouton: string;
  pret: SignaturePrete;
  /** Le lien du PDF à relire avant de signer. */
  apercu?: string | null;
  busy: boolean;
  onSigner: (fd: FormData) => void;
  onCancel?: () => void;
}) {
  const [lu, setLu] = React.useState(false);
  const manque = [!pret.signature && "votre signature", !pret.cachet && "votre cachet", !pret.code && "votre code de signature"].filter(Boolean) as string[];
  if (manque.length > 0) {
    return (
      <div className="space-y-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
        <p className="font-medium">Avant de signer en ligne, préparez {manque.join(", ")}.</p>
        <p className="text-muted-foreground">Une seule fois : vous déposez l&apos;image de votre signature et de votre cachet, et vous activez le code de votre téléphone.</p>
        <Link href={CHEMIN_MA_SIGNATURE} className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90 sm:h-8">
          <ShieldCheck className="h-4 w-4" /> Préparer ma signature
        </Link>
      </div>
    );
  }
  return (
    <form
      className="space-y-3 rounded-lg border border-border bg-secondary/40 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        fd.set("lu", lu ? "oui" : "non");
        onSigner(fd);
      }}
    >
      <p className="flex items-center gap-2 text-sm font-semibold"><PenLine className="h-4 w-4 text-primary" /> {titre}</p>
      {apercu && (
        <a href={apercu} target="_blank" rel="noreferrer" className="inline-block text-sm font-medium text-primary underline-offset-2 hover:underline">
          Ouvrir le bon de commande (PDF)
        </a>
      )}
      <label className="flex items-start gap-2 text-sm">
        <input id="signature-lu" type="checkbox" checked={lu} onChange={(e) => setLu(e.target.checked)} className="mt-0.5 h-4 w-4" />
        <span>J&apos;ai relu ce bon de commande et j&apos;en approuve le contenu.</span>
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="signature-mdp">Mot de passe de votre compte</Label>
          <Input id="signature-mdp" name="motDePasse" type="password" autoComplete="current-password" required />
        </div>
        <div className="space-y-1">
          <Label htmlFor="signature-code">Code de l&apos;application (6 chiffres)</Label>
          <Input id="signature-code" name="code" inputMode="numeric" pattern="[0-9 ]{6,7}" maxLength={7} autoComplete="one-time-code" required className="tracking-[0.3em]" />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">Votre signature et votre cachet sont incrustés dans le PDF, scellé et vérifiable par QR code. Le geste est journalisé à votre nom.</p>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={!lu || busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />} {bouton}
        </Button>
        {onCancel && <Button type="button" size="sm" variant="ghost" onClick={onCancel}>Annuler</Button>}
      </div>
    </form>
  );
}
