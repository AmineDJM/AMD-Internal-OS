"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Eye, Loader2, Play, FastForward, Square } from "lucide-react";
import { apercuReprise, executerReprise } from "@/lib/actions/refonte-reprise-actions";
import type { BilanReprise } from "@/lib/referentiels/reprises/types";
import { Button } from "@/components/ui/button";

/**
 * UNE REPRISE À L'ÉCRAN — aperçu à blanc, puis lots. « Jusqu'au bout » enchaîne les lots tant qu'il en
 * reste et qu'on ne l'a pas arrêté : chaque lot reste une action auditée, reprise où le précédent s'est arrêté.
 */

type Bilan = BilanReprise & { suite?: string | null };

const COMPTEURS: [keyof BilanReprise, string][] = [
  ["lues", "lues"], ["creees", "créées"], ["liees", "liées"], ["doublonsProposes", "doublons proposés"], ["ignorees", "ignorées"],
];

function cumul(a: Bilan | null, b: Bilan): Bilan {
  if (!a) return b;
  return {
    lues: a.lues + b.lues, creees: a.creees + b.creees, liees: a.liees + b.liees,
    doublonsProposes: a.doublonsProposes + b.doublonsProposes, ignorees: a.ignorees + b.ignorees,
    erreurs: [...a.erreurs, ...b.erreurs], suite: b.suite,
  };
}

export function CarteReprise({ cle }: { cle: string }) {
  const router = useRouter();
  const [occupe, setOccupe] = React.useState<null | "apercu" | "lot" | "tout">(null);
  const [apercu, setApercu] = React.useState<BilanReprise | null>(null);
  const [execution, setExecution] = React.useState<Bilan | null>(null);
  const [suite, setSuite] = React.useState<string | null>(null);
  const [termine, setTermine] = React.useState(false);
  const [erreur, setErreur] = React.useState<string | null>(null);
  const arreter = React.useRef(false);

  async function voirApercu() {
    setOccupe("apercu"); setErreur(null);
    const r = await apercuReprise(cle);
    setOccupe(null);
    if (r.ok) setApercu(r.bilan); else setErreur(r.error);
  }

  async function lancer(tout: boolean) {
    setOccupe(tout ? "tout" : "lot"); setErreur(null); arreter.current = false;
    let curseur = termine ? null : suite;
    let acc: Bilan | null = termine ? null : execution;
    do {
      const r = await executerReprise(cle, curseur);
      if (!r.ok) { setErreur(r.error); break; }
      acc = cumul(acc, r.bilan);
      curseur = r.bilan.suite;
      setExecution(acc); setSuite(curseur); setTermine(curseur === null);
    } while (tout && curseur !== null && !arreter.current);
    setOccupe(null);
    router.refresh();
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={voirApercu} disabled={occupe !== null}>
          {occupe === "apercu" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />} Aperçu à blanc
        </Button>
        <Button size="sm" onClick={() => lancer(false)} disabled={occupe !== null}>
          {occupe === "lot" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />} {suite && !termine ? "Lot suivant" : "Exécuter un lot"}
        </Button>
        <Button variant="outline" size="sm" onClick={() => lancer(true)} disabled={occupe !== null}>
          {occupe === "tout" ? <Loader2 className="h-4 w-4 animate-spin" /> : <FastForward className="h-4 w-4" />} Jusqu&apos;au bout
        </Button>
        {occupe === "tout" && (
          <Button variant="ghost" size="sm" onClick={() => { arreter.current = true; }}>
            <Square className="h-4 w-4" /> Arrêter après ce lot
          </Button>
        )}
      </div>
      {erreur && <p className="text-sm text-destructive">{erreur}</p>}
      {apercu && <BilanVue titre="Aperçu (rien n'a été écrit)" bilan={apercu} />}
      {execution && (
        <BilanVue
          titre={termine ? "Exécution terminée" : `Exécution en cours — reprendra après ${suite ?? "le début"}`}
          bilan={execution}
        />
      )}
    </div>
  );
}

function BilanVue({ titre, bilan }: { titre: string; bilan: BilanReprise }) {
  return (
    <div className="rounded-md border p-3 text-sm">
      <p className="font-medium">{titre}</p>
      <p className="mt-1 text-muted-foreground">
        {COMPTEURS.map(([k, l]) => `${bilan[k] as number} ${l}`).join(" · ")}
      </p>
      {bilan.erreurs.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-warning">{bilan.erreurs.length} anomalie{bilan.erreurs.length > 1 ? "s" : ""}</summary>
          <ul className="mt-1 max-h-60 list-disc space-y-0.5 overflow-auto pl-5 text-xs text-muted-foreground">
            {bilan.erreurs.slice(0, 200).map((e, i) => <li key={i}>{e}</li>)}
          </ul>
        </details>
      )}
    </div>
  );
}
