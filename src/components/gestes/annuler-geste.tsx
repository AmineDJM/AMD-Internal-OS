"use client";

import * as React from "react";
import {
  annulerMonGeste, apercevoirAnnulationDeMonGeste, listerMesGestesAnnulables, retablirMonGeste, type GesteAnnulable,
} from "@/lib/actions/gestes-reversibles-actions";
import type { CompteRenduAnnulation, DetailEffet } from "@/lib/effets/annulation";
import { EVENEMENT_ANNULABLE, type AnnulableVu } from "./annulable-signal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « ANNULER » — à l'écran de l'objet, après l'action (K10c, décision 0040).
 *
 * Trois temps, jamais deux : le PLAN (ce que l'annulation ferait, rien n'est écrit), puis l'ANNULATION (le compte
 * rendu effet par effet : annulé, compensé, impossible — et pourquoi), puis, si on le veut, RÉTABLIR. Un refus
 * « tout ou rien » montre la liste des effets qui bloquent. Rien ici ne dit « annulé » pour ce qui ne l'est pas.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

type Resultat = CompteRenduAnnulation | { refus: string; bloquants?: DetailEffet[] };
type Etat = { t: "repos" } | { t: "plan"; r: Resultat } | { t: "fait"; r: Resultat } | { t: "retabli"; r: Resultat };

const ISSUE: Record<DetailEffet["issue"], string> = { ANNULE: "annulé", COMPENSE: "compensé", IMPOSSIBLE: "impossible", SANS_OBJET: "sans objet" };

function Details({ r }: { r: Resultat }) {
  const lignes = "refus" in r ? r.bloquants ?? [] : r.details;
  if (!lignes.length) return null;
  return (
    <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
      {lignes.slice(0, 8).map((d) => (
        <li key={d.effetId}><strong>{ISSUE[d.issue]}</strong> — {d.quoi} : {d.pourquoi}{d.aLaPlace ? ` (à la place : ${d.aLaPlace})` : ""}</li>
      ))}
      {lignes.length > 8 ? <li>… et {lignes.length - 8} autre(s).</li> : null}
    </ul>
  );
}

const phrase = (r: Resultat) => ("refus" in r ? r.refus : r.resume);

/** Le bouton d'UN geste : plan → annulation → rétablir. */
export function BoutonAnnulerGeste({ gesteId, dejaAnnule = false }: { gesteId: string; dejaAnnule?: boolean }) {
  const [etat, setEtat] = React.useState<Etat>(dejaAnnule ? { t: "fait", r: { refus: "Déjà annulé." } } : { t: "repos" });
  const [occupe, setOccupe] = React.useState(false);
  const faire = async (fn: () => Promise<Resultat>, suite: (r: Resultat) => Etat) => {
    setOccupe(true);
    try { setEtat(suite(await fn())); } catch { setEtat({ t: "plan", r: { refus: "L'annulation n'a pas répondu : rechargez l'écran pour voir l'état réel." } }); } finally { setOccupe(false); }
  };
  const bouton = "h-8 rounded-md border px-2 text-xs font-medium disabled:opacity-60 focus-ring";
  if (etat.t === "repos") {
    return <button type="button" className={bouton} disabled={occupe} onClick={() => faire(() => apercevoirAnnulationDeMonGeste(gesteId), (r) => ({ t: "plan", r }))}>Annuler…</button>;
  }
  if (etat.t === "plan") {
    const refuse = "refus" in etat.r;
    return (
      <div className="space-y-1">
        <p className="text-xs">{refuse ? phrase(etat.r) : `Ce que l'annulation fera : ${phrase(etat.r)}`}</p>
        <Details r={etat.r} />
        <div className="flex gap-2">
          {!refuse ? <button type="button" className={bouton} disabled={occupe} onClick={() => faire(() => annulerMonGeste(gesteId), (r) => ({ t: "fait", r }))}>Confirmer l&apos;annulation</button> : null}
          <button type="button" className={bouton} disabled={occupe} onClick={() => setEtat({ t: "repos" })}>Garder</button>
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-1">
      <p className="text-xs">{phrase(etat.r)}</p>
      <Details r={etat.r} />
      {etat.t === "fait" ? (
        <button type="button" className={bouton} disabled={occupe} onClick={() => faire(() => retablirMonGeste(gesteId), (r) => ("refus" in r ? { t: "fait", r } : { t: "retabli", r }))}>Rétablir</button>
      ) : null}
    </div>
  );
}

/**
 * L'HISTORIQUE ANNULABLE D'UNE FICHE — mes gestes des 30 derniers jours qui ont touché ces enregistrements.
 * Rien ne s'affiche quand il n'y en a pas.
 */
export function GestesAnnulables({ ids, titre = "Mes gestes sur cette fiche" }: { ids: string[]; titre?: string }) {
  const [gestes, setGestes] = React.useState<GesteAnnulable[] | null>(null);
  const cle = ids.join(",");
  React.useEffect(() => {
    let vivant = true;
    listerMesGestesAnnulables(cle ? cle.split(",") : []).then((g) => { if (vivant) setGestes(g); }, () => { if (vivant) setGestes([]); });
    return () => { vivant = false; };
  }, [cle]);
  if (!gestes?.length) return null;
  return (
    <section className="rounded-lg border p-3" aria-label={titre}>
      <h3 className="text-sm font-semibold">{titre}</h3>
      <ul className="mt-2 space-y-2">
        {gestes.map((g) => (
          <li key={g.id} className="text-sm">
            <span>{g.libelle}</span>{" "}
            <span className="text-xs text-muted-foreground">— {new Date(g.quand).toLocaleString("fr-FR")}{g.annuleLe ? " · annulé" : ""}</span>
            <div className="mt-1"><BoutonAnnulerGeste gesteId={g.id} dejaAnnule={!!g.annuleLe} /></div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * LE BANDEAU APRÈS L'ACTION — monté une fois dans la coque (`primitives-ui.tsx`, chargé au premier geste
 * annulable) : « <action> — fait. Annuler… » pendant deux minutes, ou jusqu'à ce qu'on le ferme.
 */
export function BandeauAnnulable({ premier }: { premier: AnnulableVu }) {
  const [geste, setGeste] = React.useState<AnnulableVu | null>(premier);
  React.useEffect(() => {
    const ecouter = (e: Event) => setGeste((e as CustomEvent<AnnulableVu>).detail);
    window.addEventListener(EVENEMENT_ANNULABLE, ecouter);
    return () => window.removeEventListener(EVENEMENT_ANNULABLE, ecouter);
  }, []);
  React.useEffect(() => {
    if (!geste) return;
    const t = setTimeout(() => setGeste(null), 120_000);
    return () => clearTimeout(t);
  }, [geste]);
  if (!geste) return null;
  return (
    <div role="status" className="pointer-events-auto fixed inset-x-3 bottom-[calc(4.75rem+env(safe-area-inset-bottom))] z-[105] rounded-xl border bg-card px-3 py-2.5 text-sm shadow-lg print:hidden sm:inset-x-auto sm:left-4 sm:w-[380px] lg:bottom-4">
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1"><strong>{geste.libelle}</strong> — fait.</p>
        <button type="button" onClick={() => setGeste(null)} className="-m-1 shrink-0 rounded px-1 text-xs opacity-70 hover:opacity-100 focus-ring" aria-label="Fermer">✕</button>
      </div>
      <div className="mt-1"><BoutonAnnulerGeste key={geste.gesteId} gesteId={geste.gesteId} /></div>
    </div>
  );
}
