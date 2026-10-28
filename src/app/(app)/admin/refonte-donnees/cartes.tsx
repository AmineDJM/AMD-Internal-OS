"use client";

import * as React from "react";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";
import { apercuReprise, executerReprise } from "@/lib/actions/refonte-reprise-actions";
import { reglerDoubleEcritureOrganisations } from "@/lib/actions/organisation-actions";
import type { BilanReprise } from "@/lib/referentiels/reprises/types";
import { Button } from "@/components/ui/button";

/**
 * LES GESTES DE L'ÉCRAN « REFONTE DES DONNÉES » — aperçu à blanc, un lot, ou tous les lots à la suite (le
 * navigateur relance tant que le serveur rend un curseur, et s'arrête au premier refus ou sur demande).
 * Chaque lot passe par l'action serveur, qui revérifie le Super Admin et écrit le journal.
 */

const LIBELLES: [keyof Omit<BilanReprise, "erreurs">, string][] = [
  ["lues", "lues"], ["creees", "créées"], ["liees", "liées"], ["doublonsProposes", "doublons proposés"], ["ignorees", "ignorées"],
];

function Bilan({ titre, bilan }: { titre: string; bilan: BilanReprise }) {
  return (
    <div className="rounded-md border border-border bg-secondary/40 p-3 text-sm" data-testid="refonte-bilan">
      <div className="mb-1 font-medium">{titre}</div>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {LIBELLES.map(([k, l]) => <span key={k}><strong>{bilan[k]}</strong> {l}</span>)}
      </div>
      {bilan.erreurs.length > 0 && (
        <ul className="mt-2 list-disc pl-5 text-xs text-destructive">
          {bilan.erreurs.map((e, i) => <li key={i}>{e}</li>)}
        </ul>
      )}
    </div>
  );
}

const cumuler = (a: BilanReprise, b: BilanReprise): BilanReprise => ({
  lues: a.lues + b.lues, creees: a.creees + b.creees, liees: a.liees + b.liees,
  doublonsProposes: a.doublonsProposes + b.doublonsProposes, ignorees: a.ignorees + b.ignorees,
  erreurs: [...a.erreurs, ...b.erreurs].slice(0, 30),
});

export function GestesReprise({ cle, suiteInitiale }: { cle: string; suiteInitiale: string | null }) {
  const { enCours, rafraichir } = useRafraichir();
  const [occupe, setPending] = React.useState(false);
  const pending = occupe || enCours;
  const [apercu, setApercu] = React.useState<BilanReprise | null>(null);
  const [cumul, setCumul] = React.useState<BilanReprise | null>(null);
  const [suite, setSuite] = React.useState<string | null>(suiteInitiale);
  const [message, setMessage] = React.useState<string | null>(null);
  const arreter = React.useRef(false);

  const voir = async () => {
    setPending(true); setMessage(null);
    try {
      const r = await apercuReprise(cle);
      if (r.ok) setApercu(r.bilan);
      else setMessage(r.error);
    } catch {
      setMessage(actionFailureMessage("THROWN"));
    } finally {
      setPending(false);
    }
  };

  const lancer = async (jusquAuBout: boolean) => {
    setPending(true); setMessage(null); arreter.current = false;
    let curseur = suite;
    let total: BilanReprise | null = null;
    try {
      do {
        const r = await executerReprise(cle, curseur);
        if (!r.ok) { setMessage(r.error); break; }
        total = total ? cumuler(total, r.bilan) : r.bilan;
        setCumul(total);
        curseur = r.bilan.suite ?? null;
        setSuite(curseur);
      } while (jusquAuBout && curseur && !arreter.current);
      if (!curseur) setMessage("Reprise terminée : relancer ne refera rien de ce qui est fait.");
    } catch {
      // Le lot a pu aboutir côté serveur : le journal le dira après le rafraîchissement.
      setMessage(actionFailureMessage("THROWN"));
    } finally {
      setPending(false);
      rafraichir();
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" disabled={pending} onClick={voir} data-testid={`refonte-apercu-${cle}`}>Aperçu à blanc</Button>
        <Button size="sm" disabled={pending} onClick={() => lancer(false)} data-testid={`refonte-lot-${cle}`}>
          {suite ? "Exécuter le lot suivant" : "Exécuter un lot"}
        </Button>
        <Button size="sm" variant="secondary" disabled={pending} onClick={() => lancer(true)}>Tout exécuter</Button>
        {pending && <Button size="sm" variant="ghost" onClick={() => { arreter.current = true; }}>Arrêter après ce lot</Button>}
        {suite && !pending && <span className="text-xs text-muted-foreground">Reprend après « {suite} »</span>}
      </div>
      {message && <p className="text-xs text-muted-foreground" data-testid="refonte-message">{message}</p>}
      {apercu && <Bilan titre="Aperçu — rien n'a été écrit" bilan={apercu} />}
      {cumul && <Bilan titre="Exécuté pendant cette visite" bilan={cumul} />}
    </div>
  );
}

export function InterrupteurDoubleEcriture({ ouvert }: { ouvert: boolean }) {
  const { enCours, rafraichir } = useRafraichir();
  const [busy, setBusy] = React.useState(false);
  const pending = busy || enCours;
  const [message, setMessage] = React.useState<string | null>(null);
  const basculer = async () => {
    setBusy(true);
    const fd = new FormData();
    fd.set("actif", ouvert ? "0" : "1");
    try {
      const r = await reglerDoubleEcritureOrganisations(fd);
      setMessage(r.ok ? null : r.error ?? "Refusé.");
      if (r.ok) rafraichir();
    } catch {
      setMessage(actionFailureMessage("THROWN"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant={ouvert ? "outline" : "primary"} disabled={pending} onClick={() => void basculer()} data-testid="refonte-double-ecriture">
        {ouvert ? "Fermer la double écriture" : "Ouvrir la double écriture"}
      </Button>
      {message && <span className="text-xs text-destructive">{message}</span>}
    </div>
  );
}
