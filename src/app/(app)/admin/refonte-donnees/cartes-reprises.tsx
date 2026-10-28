"use client";

import * as React from "react";
import { Eye, Loader2, Play } from "lucide-react";
import { apercuReprise, executerReprise } from "@/lib/actions/refonte-reprise-actions";
import type { BilanReprise } from "@/lib/referentiels/reprises/types";
import { Button } from "@/components/ui/button";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";

export interface CarteReprise {
  cle: string;
  titre: string;
  description: string;
  /** Curseur du dernier lot exécuté (nul : au début, ou reprise terminée). */
  reprendreA: string | null;
  journal: { id: string; quand: string; qui: string | null; resume: string }[];
}

const CHIFFRES: [keyof Omit<BilanReprise, "erreurs">, string][] = [
  ["lues", "lues"], ["creees", "créées"], ["liees", "liées"], ["doublonsProposes", "doublons proposés"], ["ignorees", "ignorées"],
];

function Bilan({ titre, bilan }: { titre: string; bilan: BilanReprise }) {
  return (
    <div className="space-y-2 rounded-md border bg-muted/30 p-3 text-sm">
      <p className="font-medium">{titre}</p>
      <dl className="flex flex-wrap gap-x-5 gap-y-1">
        {CHIFFRES.map(([k, l]) => (
          <div key={k} className="flex gap-1"><dt className="text-muted-foreground">{l}</dt><dd className="font-semibold tabular-nums">{bilan[k]}</dd></div>
        ))}
      </dl>
      {bilan.erreurs.length > 0 && (
        <details>
          <summary className="cursor-pointer text-xs text-amber-700">{bilan.erreurs.length} cas à regarder</summary>
          <ul className="mt-1 max-h-64 list-disc space-y-0.5 overflow-auto pl-5 text-xs text-muted-foreground">
            {bilan.erreurs.map((e, i) => <li key={i} className="break-words">{e}</li>)}
          </ul>
        </details>
      )}
    </div>
  );
}

function Carte({ carte }: { carte: CarteReprise }) {
  const { rafraichir } = useRafraichir();
  const [enCours, demarrer] = React.useTransition();
  const [erreur, setErreur] = React.useState<string | null>(null);
  const [apercu, setApercu] = React.useState<BilanReprise | null>(null);
  const [lot, setLot] = React.useState<(BilanReprise & { suite?: string | null }) | null>(null);
  // Le curseur courant : celui du dernier lot de cette session d'écran, sinon celui du journal.
  const curseur = lot ? lot.suite ?? null : carte.reprendreA;
  const terminee = lot !== null && !lot.suite;

  const voir = () => demarrer(async () => {
    try {
      const r = await apercuReprise(carte.cle);
      setErreur(r.ok ? null : r.error ?? "L'aperçu de la reprise n'a pas été calculé.");
      if (r.ok && r.bilan) setApercu(r.bilan);
    } catch {
      setErreur(actionFailureMessage("THROWN"));
    }
  });
  const executer = () => demarrer(async () => {
    try {
      const r = await executerReprise(carte.cle, terminee ? null : curseur);
      setErreur(r.ok ? null : r.error ?? "Le lot de reprise n'a pas été exécuté.");
      if (r.ok && r.bilan) { setLot(r.bilan); rafraichir(); }
    } catch {
      setErreur(actionFailureMessage("THROWN"));
    }
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{carte.titre}</CardTitle>
        <CardDescription>{carte.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={voir} disabled={enCours}>
            {enCours ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />} Aperçu à blanc
          </Button>
          <BoutonDecisif type="button" size="sm" onClick={executer} disabled={enCours} confirmation={`exécuter un lot de « ${carte.titre} »`}>
            <Play className="h-4 w-4" /> {terminee ? "Recommencer depuis le début" : curseur ? "Exécuter le lot suivant" : "Exécuter un lot"}
          </BoutonDecisif>
          <span className="text-xs text-muted-foreground">
            {terminee ? "Reprise terminée." : curseur ? `Reprend à ${curseur}` : "Commence au début."}
          </span>
        </div>
        {erreur && <p className="text-sm text-destructive">{erreur}</p>}
        {apercu && <Bilan titre="Aperçu à blanc — rien n'a été écrit" bilan={apercu} />}
        {lot && <Bilan titre="Dernier lot exécuté" bilan={lot} />}
        {carte.journal.length > 0 && (
          <details>
            <summary className="cursor-pointer text-xs text-muted-foreground">Journal ({carte.journal.length} dernier(s) geste(s))</summary>
            <ul className="mt-1 space-y-1 text-xs">
              {carte.journal.map((j) => (
                <li key={j.id} className="break-words">
                  <span className="text-muted-foreground">{new Date(j.quand).toLocaleString("fr-DZ")}{j.qui ? ` · ${j.qui}` : ""} — </span>{j.resume}
                </li>
              ))}
            </ul>
          </details>
        )}
      </CardContent>
    </Card>
  );
}

/** Les reprises de la refonte, une carte chacune, dans l'ordre où les lancer. */
export function CartesReprises({ cartes }: { cartes: CarteReprise[] }) {
  return <div className="space-y-4">{cartes.map((c) => <Carte key={c.cle} carte={c} />)}</div>;
}
