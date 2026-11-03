"use client";

import * as React from "react";
import Link from "next/link";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { lireRefusBase } from "@/modules/acces-bases/partage";

/**
 * QUAND UNE PAGE CASSE — on le dit, on propose de réessayer, on ne perd pas le menu.
 *
 * Sans ce fichier, Next affiche « Application error: a client-side exception has occurred »,
 * en anglais, plein écran, sans rien pour repartir. La personne recharge l'onglet, retombe
 * dessus, et conclut que « le logiciel est en panne » — alors que c'est UNE page, et souvent
 * UNE donnée.
 *
 * `reset()` retente le rendu du segment : c'est le bon geste pour une erreur passagère
 * (réseau, session qui expirait). Le `digest` est l'identifiant que le serveur a écrit dans ses
 * journaux : le donner, c'est permettre au support de retrouver la trace sans faire redécrire
 * la panne.
 */
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  // D4 (décision 0057) : un REFUS de l'accès par base n'est pas une panne — on dit quelle base, et à qui demander.
  const refus = lireRefusBase(error.digest);
  React.useEffect(() => {
    // Journal côté navigateur aussi : une page cassée sans trace ne se corrige pas.
    console.error("[page] rendu impossible", error);
  }, [error]);

  if (refus) {
    return (
      <div className="space-y-5" data-testid="refus-acces-base">
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-warning/30 bg-warning/5 px-6 py-14 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-warning/10 text-warning">
            <AlertTriangle className="h-6 w-6" />
          </div>
          <p className="text-sm font-medium text-foreground">Accès refusé à cette donnée.</p>
          <p className="max-w-md text-sm text-muted-foreground">{refus.phrase}</p>
          <Link href="/" className="inline-flex h-10 items-center justify-center rounded-lg border border-border bg-card px-4 text-sm font-medium hover:bg-secondary">
            Revenir à l&apos;accueil
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-destructive/30 bg-destructive/5 px-6 py-14 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
          <AlertTriangle className="h-6 w-6" />
        </div>
        <p className="text-sm font-medium text-foreground">Cette page n&apos;a pas pu s&apos;afficher.</p>
        <p className="max-w-sm text-sm text-muted-foreground">
          Le reste de l&apos;application fonctionne. Réessayez ; si cela se reproduit, signalez-le
          avec la référence ci-dessous.
        </p>
        {error.digest && (
          <p className="rounded-md bg-secondary px-2 py-1 font-mono text-xs text-muted-foreground">réf. {error.digest}</p>
        )}
        <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
          <Button onClick={() => reset()}>
            <RotateCcw className="h-4 w-4" /> Réessayer
          </Button>
          <Link href="/" className="inline-flex h-10 items-center justify-center rounded-lg border border-border bg-card px-4 text-sm font-medium hover:bg-secondary">
            Revenir à l&apos;accueil
          </Link>
          <Link href="/feedback" className="inline-flex h-10 items-center justify-center rounded-lg border border-border bg-card px-4 text-sm font-medium hover:bg-secondary">
            Signaler
          </Link>
        </div>
      </div>
    </div>
  );
}
