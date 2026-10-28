"use client";

import * as React from "react";
import type { ActionResult } from "@/lib/actions/types";
import { actionFailureMessage, ACTION_TIMEOUT_MS } from "@/lib/action-outcome";
import { useRafraichir } from "./use-rafraichir";
import { useConfirmer } from "@/components/ui/dialogue";
import type { DemandeConfirmation } from "@/components/ui/dialogue-regle";
import { useRetours } from "@/components/ui/retour";

/**
 * Quand l'action refuse sans dire pourquoi : on dit au moins qu'elle a REFUSÉ (donc rien n'est parti),
 * ce qui la distingue d'une panne (`actionFailureMessage`, où l'enregistrement a pu aboutir).
 */
export const REFUS_SANS_MOTIF = "Le geste a été refusé sans motif précisé : rien n'a été enregistré.";

/**
 * Ce qu'un appel peut demander en plus de l'action elle-même (V3-B) — pour qu'un geste entier
 * (demander, exécuter, dire le résultat) tienne en UNE ligne au point d'appel :
 *
 *     run(() => supprimerLigne(fd), undefined, { confirmer: "Supprimer cette ligne ?", succes: "Ligne supprimée." });
 */
export interface OptionsGeste {
  /** Demandée AVANT l'action (dialogue accessible `ui/dialogue.tsx`) ; renoncer n'appelle rien. */
  confirmer?: string | DemandeConfirmation;
  /** Annoncé en avis flottant quand l'action aboutit (`ui/retour.tsx`). */
  succes?: string;
}

/** Comment le crochet dit une erreur. */
export interface OptionsAction {
  /**
   * Faux (défaut) : l'erreur est dans `err`, et c'est l'écran qui la pose près du geste
   * (`<Retour ton="erreur">{err}</Retour>`). Vrai : elle part AUSSI en avis flottant — pour les gestes
   * qui n'ont pas de place où parler (une icône dans une ligne). Remplace `alert(r.error)`.
   */
  signalerErreurs?: boolean;
}

/**
 * APPELER UNE ACTION SERVEUR SANS POUVOIR RESTER BLOQUÉ.
 *
 * ── POURQUOI CE FICHIER EXISTE ──────────────────────────────────────────────────────────────
 *
 * Ce crochet était recopié à l'identique dans six écrans (directives, projets, information
 * médicale, recrutement, regulatory, support), et les six portaient le même défaut :
 *
 *     const r = await fn();   // si `fn` LÈVE, la ligne suivante n'existe pas
 *     setSaving(false);
 *
 * Une action qui lève laissait donc le bouton tourner POUR TOUJOURS, sans message. Corriger six
 * copies aurait garanti qu'une septième renaisse : le crochet vit désormais ici, une fois.
 *
 * Deux garde-fous, et le second est indispensable — attraper la levée ne suffit pas si le
 * serveur ne répond JAMAIS (requête suspendue, conteneur redémarré au milieu) : rien ne
 * réveillerait l'attente, et c'est précisément le cas qui bloquait l'écran des courriers.
 *
 * Le message de secours est PUR et testé (`lib/action-outcome.ts`) : il n'invite jamais à
 * réessayer — ce réflexe-là fabrique les doublons.
 */
export function useAction(options: OptionsAction = {}) {
  // Le bouton reste « en cours » jusqu'à ce que les NOUVELLES données soient à l'écran : rendu
  // plus tôt, il laisse rouvrir une fiche sur l'état d'avant (§118.172, `use-rafraichir.ts`).
  const { enCours, rafraichir } = useRafraichir();
  const confirmerGeste = useConfirmer();
  const retours = useRetours();
  const signalerErreurs = !!options.signalerErreurs;
  const [saving, setSaving] = React.useState(false);
  const [err, setErrBrut] = React.useState<string | null>(null);
  const setErr = React.useCallback((e: string | null) => {
    setErrBrut(e);
    if (e && signalerErreurs) retours.erreur(e);
  }, [signalerErreurs, retours]);
  // Le composant peut disparaître pendant l'attente (panneau refermé) : écrire dans son état
  // après coup n'a plus de sens.
  const vivant = React.useRef(true);
  React.useEffect(() => () => { vivant.current = false; }, []);

  const run = React.useCallback(
    async (fn: () => Promise<ActionResult>, onOk?: () => void, geste: OptionsGeste = {}): Promise<boolean> => {
      if (geste.confirmer && !(await confirmerGeste(geste.confirmer))) return false;
      setSaving(true); setErr(null);
      // Le chronomètre court EN PARALLÈLE de l'action : on ne peut pas annuler une requête
      // serveur, mais on peut cesser de faire attendre la personne sans rien lui dire.
      let fini = false;
      const minuteur = setTimeout(() => {
        if (fini || !vivant.current) return;
        setSaving(false);
        setErr(actionFailureMessage("TIMEOUT"));
      }, ACTION_TIMEOUT_MS);
      try {
        const r = await fn();
        fini = true;
        if (!vivant.current) return r.ok;
        setSaving(false);
        if (r.ok) { onOk?.(); rafraichir(); if (geste.succes) retours.succes(geste.succes); return true; }
        setErr(r.error ?? REFUS_SANS_MOTIF);
        return false;
      } catch (e) {
        fini = true;
        console.error("[action] l'action serveur a levé", e);
        if (vivant.current) { setSaving(false); setErr(actionFailureMessage("THROWN")); }
        return false;
      } finally {
        clearTimeout(minuteur);
      }
    },
    [rafraichir, confirmerGeste, retours, setErr],
  );

  // `busy` est l'alias historique de `saving` : les six écrans repris n'utilisaient pas le même
  // nom, et les renommer tous aurait élargi ce lot sans rien corriger.
  const occupe = saving || enCours;
  return { saving: occupe, busy: occupe, err, setErr, run };
}

/**
 * LA VARIANTE À CLÉ — quand plusieurs boutons du même écran s'actionnent séparément.
 *
 * `busy` porte alors la clé du bouton en cours plutôt qu'un booléen : sans cela, cliquer
 * « Accepter » ferait tourner aussi « Refuser », et l'on ne saurait plus lequel on a pressé.
 */
export function useKeyedAction(options: OptionsAction = {}) {
  const { enCours, rafraichir } = useRafraichir();
  const confirmerGeste = useConfirmer();
  const retours = useRetours();
  const signalerErreurs = !!options.signalerErreurs;
  const [busy, setBusy] = React.useState<string | null>(null);
  // Le bouton pressé reste désigné jusqu'à l'arrivée des nouvelles données (§118.172).
  const [derniere, setDerniere] = React.useState<string | null>(null);
  const [error, setErrorBrut] = React.useState<string | null>(null);
  const setError = React.useCallback((e: string | null) => {
    setErrorBrut(e);
    if (e && signalerErreurs) retours.erreur(e);
  }, [signalerErreurs, retours]);
  const vivant = React.useRef(true);
  React.useEffect(() => () => { vivant.current = false; }, []);

  const run = React.useCallback(
    async (key: string, fn: () => Promise<ActionResult>, geste: OptionsGeste = {}): Promise<boolean> => {
      if (geste.confirmer && !(await confirmerGeste(geste.confirmer))) return false;
      setBusy(key); setDerniere(key); setError(null);
      let fini = false;
      const minuteur = setTimeout(() => {
        if (fini || !vivant.current) return;
        setBusy(null);
        setError(actionFailureMessage("TIMEOUT"));
      }, ACTION_TIMEOUT_MS);
      try {
        const r = await fn();
        fini = true;
        if (!vivant.current) return r.ok;
        setBusy(null);
        if (!r.ok) { setError(r.error ?? REFUS_SANS_MOTIF); return false; }
        rafraichir();
        if (geste.succes) retours.succes(geste.succes);
        return true;
      } catch (e) {
        fini = true;
        console.error("[action] l'action serveur a levé", e);
        if (vivant.current) { setBusy(null); setError(actionFailureMessage("THROWN")); }
        return false;
      } finally {
        clearTimeout(minuteur);
      }
    },
    [rafraichir, confirmerGeste, retours, setError],
  );

  return { busy: busy ?? (enCours ? derniere : null), error, run, setError };
}

/**
 * LA VARIANTE `<form action>` — remplace `action={async (fd) => { setBusy(true); const r = await f(fd); … }}`.
 *
 *     const decision = useFormAction(decidePayment, { prepare: (fd) => fd.set("id", order.id), onOk: () => setActing(null) });
 *     <form action={decision.action}> … <Retour ton="erreur">{decision.err}</Retour>
 *
 * Construit sur `useAction().run` : même chronomètre, même message de secours (jamais « réessayez »),
 * même rafraîchissement suivi (§118.172). En plus, un VERROU SYNCHRONE : un double appui sur Entrée
 * arrive avant que React ait rendu `busy` — sans lui, deux soumissions partiraient.
 */
export function useFormAction(
  fn: (fd: FormData) => Promise<ActionResult>,
  opts: OptionsGeste & OptionsAction & { onOk?: () => void; prepare?: (fd: FormData) => void } = {},
): { action: (fd: FormData) => Promise<void>; busy: boolean; err: string | null; setErr: (e: string | null) => void } {
  const { busy, err, setErr, run } = useAction({ signalerErreurs: opts.signalerErreurs });
  const verrou = React.useRef(false);
  const derniers = React.useRef(opts);
  derniers.current = opts;
  const action = React.useCallback(async (fd: FormData) => {
    if (verrou.current) return;
    verrou.current = true;
    try {
      const o = derniers.current;
      o.prepare?.(fd);
      await run(() => fn(fd), o.onOk, { confirmer: o.confirmer, succes: o.succes });
    } finally {
      verrou.current = false;
    }
  }, [fn, run]);
  return { action, busy, err, setErr };
}
