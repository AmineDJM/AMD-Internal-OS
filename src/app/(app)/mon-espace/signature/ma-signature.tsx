"use client";

import * as React from "react";
import { Check, Loader2, PenLine, Stamp, Smartphone } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { useAction } from "@/components/shared/use-action";
import { deposerMonVisuel, commencerMonCode, confirmerMonCode } from "@/lib/actions/bc-signature-actions";

/** Les trois préparatifs, dans l'ordre : signature, cachet, code. Chacun dit s'il est fait. */
export function MaSignature({ vueExacte, signature, cachet, codeActif }: { vueExacte: boolean; signature: string | null; cachet: string | null; codeActif: boolean }) {
  if (vueExacte) {
    return <p className="rounded-lg bg-warning/10 px-3 py-2 text-sm">Vous visualisez le compte d&apos;une autre personne : sa signature ne se prépare que depuis son propre compte.</p>;
  }
  const faits = [Boolean(signature), Boolean(cachet), codeActif].filter(Boolean).length;
  return (
    <div className="space-y-4">
      <p className={faits === 3 ? "rounded-lg bg-success/10 px-3 py-2 text-sm font-medium" : "rounded-lg bg-secondary px-3 py-2 text-sm"}>
        {faits === 3 ? "Tout est prêt : vous pouvez signer et cacheter en ligne." : `${faits} sur 3 prêts.`}
      </p>
      <Visuel nature="SIGNATURE" titre="1. Ma signature" icone={<PenLine className="h-4 w-4" />} depuis={signature}
        aide="Signez sur une feuille blanche, prenez-la en photo (ou scannez-la), puis déposez l'image. Le fond blanc devient transparent." />
      <Visuel nature="CACHET" titre="2. Mon cachet" icone={<Stamp className="h-4 w-4" />} depuis={cachet}
        aide="Apposez le cachet sur une feuille blanche et déposez sa photo ou son scan." />
      <Code actif={codeActif} />
    </div>
  );
}

function Visuel({ nature, titre, icone, depuis, aide }: { nature: "SIGNATURE" | "CACHET"; titre: string; icone: React.ReactNode; depuis: string | null; aide: string }) {
  const { saving, err, run } = useAction();
  const [version, setVersion] = React.useState(0);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">{icone} {titre} {depuis && <Check className="h-4 w-4 text-success" aria-label="Prêt" />}</CardTitle>
        <CardDescription>{aide}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {depuis && (
          // eslint-disable-next-line @next/next/no-img-element -- l'aperçu privé de son propriétaire, servi sans cache.
          <img src={`/api/signature/visuel?nature=${nature}&v=${version}`} alt={titre} className="h-24 rounded-lg border border-border bg-[repeating-conic-gradient(#eee_0_25%,#fff_0_50%)] bg-[length:16px_16px] object-contain p-2" />
        )}
        <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => {
          e.preventDefault();
          const fd = new FormData(e.currentTarget);
          fd.set("nature", nature);
          void run(() => deposerMonVisuel(fd), () => setVersion((v) => v + 1), { succes: nature === "CACHET" ? "Cachet enregistré." : "Signature enregistrée." });
        }}>
          <div className="min-w-0 flex-1 space-y-1">
            <Label htmlFor={`visuel-${nature}`}>{depuis ? "Remplacer l'image" : "Image (PNG ou JPEG)"}</Label>
            <Input id={`visuel-${nature}`} name="fichier" type="file" accept="image/png,image/jpeg,image/webp" required />
          </div>
          <Button type="submit" size="sm" disabled={saving}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Enregistrer</Button>
        </form>
        {err && <p className="text-sm text-destructive">{err}</p>}
      </CardContent>
    </Card>
  );
}

function Code({ actif }: { actif: boolean }) {
  const { saving, err, run } = useAction();
  const [qr, setQr] = React.useState<{ qr: string; secret: string } | null>(null);
  const [erreurQr, setErreurQr] = React.useState<string | null>(null);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><Smartphone className="h-4 w-4" /> 3. Mon code de signature {actif && <Check className="h-4 w-4 text-success" aria-label="Actif" />}</CardTitle>
        <CardDescription>
          Un code à 6 chiffres qui change toutes les 30 secondes, dans une application d&apos;authentification (Google Authenticator, Microsoft Authenticator…).
          Il prouve que c&apos;est bien vous, avec votre téléphone, qui signez.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {actif && !qr && <p className="text-sm">Votre code est actif.</p>}
        {!qr && (
          <Button size="sm" variant={actif ? "outline" : "primary"} onClick={async () => {
            setErreurQr(null);
            const r = await commencerMonCode();
            if (r.ok) setQr({ qr: r.qr, secret: r.secret }); else setErreurQr(r.error);
          }}>
            {actif ? "Changer de téléphone" : "Afficher le QR code"}
          </Button>
        )}
        {erreurQr && <p className="text-sm text-destructive">{erreurQr}</p>}
        {qr && (
          <div className="space-y-3">
            <ol className="list-decimal space-y-1 pl-5 text-sm">
              <li>Ouvrez l&apos;application d&apos;authentification sur votre téléphone et scannez ce QR code.</li>
              <li>Saisissez le code à 6 chiffres qu&apos;elle affiche.</li>
            </ol>
            {/* eslint-disable-next-line @next/next/no-img-element -- QR généré au serveur, en data URL. */}
            <img src={qr.qr} alt="QR code à scanner" className="h-44 w-44 rounded-lg border border-border bg-white p-2" />
            <p className="text-xs text-muted-foreground">Sans appareil photo : saisissez la clé <span className="select-all font-mono">{qr.secret}</span></p>
            <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => {
              e.preventDefault();
              const fd = new FormData(e.currentTarget);
              void run(() => confirmerMonCode(fd), () => setQr(null), { succes: "Code de signature activé." });
            }}>
              <div className="space-y-1">
                <Label htmlFor="code-confirmation">Code affiché</Label>
                <Input id="code-confirmation" name="code" inputMode="numeric" maxLength={7} autoComplete="one-time-code" required className="w-40 tracking-[0.3em]" />
              </div>
              <Button type="submit" size="sm" disabled={saving}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Activer</Button>
            </form>
            {err && <p className="text-sm text-destructive">{err}</p>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
