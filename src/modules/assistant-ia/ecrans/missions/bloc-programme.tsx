"use client";

import React from "react";
import { GitMerge, Users } from "lucide-react";
import type { MissionDuTableau } from "@/modules/assistant-ia/api";

/**
 * O2 (décision 0059) : ce qu'un PROGRAMME montre au tableau « Missions d'Adam » — chaque tâche (son état, pourquoi elle
 * attend, ses dépendances, son travailleur), les recouvrements sérialisés, la file d'intégration et les coûts PAR NATURE
 * (sessions cloud sur l'abonnement : nombre, quota horaire, durée, tentatives ; dollars des modèles MiMo/Sol/Terra). En temps réel par le même flux que les chantiers. Une intégration qui
 * attend la carte se valide dans la conversation (« valide » / « refuse », écrit ou oral).
 */

const ETAT: Record<string, string> = {
  ATTENTE: "En attente", LANCEE: "Travailleur au travail", EN_FILE: "Vert — en file d'intégration", EN_INTEGRATION: "En intégration",
  RETOUR: "Renvoyée au travailleur", INTEGREE: "Intégrée", ECHEC: "Échec", ANNULEE: "Annulée",
};
const FILE: Record<string, string> = { EN_FILE: "en file", EN_COURS: "fusion", CI: "CI du résultat", A_VALIDER: "attend votre validation", FUSIONNEE: "intégrée", RENVOYEE: "renvoyée", ANNULEE: "annulée" };
const usd = (x: number) => `${x.toFixed(x < 1 ? 4 : 2)} $`;

export function BlocProgramme({ p }: { p: NonNullable<MissionDuTableau["programme"]> }) {
  const actifs = p.taches.filter((t) => t.travailleurEnCours).length;
  return (
    <div className="flex flex-col gap-2 rounded-lg bg-[var(--aia-cote)] px-2.5 py-2 text-[12.5px]" data-testid="programme">
      <p className="flex flex-wrap items-center gap-1.5 font-mono text-[12px]">
        <Users aria-hidden className="h-3.5 w-3.5" /> {p.depot} → {p.cible} · {actifs}/{p.concurrence} travailleur(s) · planifié par {p.planifiePar}
      </p>
      <p className="text-[var(--aia-discret)]" data-testid="couts-programme">
        Sessions cloud (abonnement) : {p.couts.sessions.lancees} lancée(s), {p.couts.sessions.derniereHeure}/{p.couts.sessions.plafondHeure} sur l&apos;heure · {p.couts.dureeMinutes} min · {p.couts.tentatives} tentative(s)
        <br />Modèles : superviseur {usd(p.couts.modelesUsd.superviseur)} · chantiers {usd(p.couts.modelesUsd.chantiers)} · infra : {p.couts.infra}
      </p>
      {p.attenteConsignes && <p className="text-[var(--aia-danger)]">Attend vos consignes : {p.attenteConsignes}</p>}
      <ul className="flex flex-col gap-1" aria-label="Tâches du programme">
        {p.taches.map((t) => (
          <li key={t.cle} className="rounded-md border border-[var(--aia-filet)] px-2 py-1" data-testid="tache-programme" data-tache={t.cle} data-etat={t.etat}>
            <span className="font-medium">{t.titre}</span> — {ETAT[t.etat] ?? t.etat}{t.renvois ? ` (${t.renvois} renvoi(s))` : ""}
            {t.dependances.length > 0 && <span className="text-[var(--aia-discret)]"> · après {t.dependances.join(", ")}</span>}
            {t.raison && <span className="block text-[11.5px] text-[var(--aia-discret)]">{t.raison}</span>}
          </li>
        ))}
      </ul>
      {p.conflits.length > 0 && (
        <p className="text-[var(--aia-discret)]">Sérialisées (elles se recouvrent) : {p.conflits.map((c) => `${c.a} ↔ ${c.b} (${c.motif})`).join(" ; ")}</p>
      )}
      {p.file.length > 0 && (
        <ol className="flex flex-col gap-0.5 font-mono text-[11.5px]" aria-label="File d'intégration" data-testid="file-integration">
          {p.file.map((f, i) => (
            <li key={`${f.tache}-${i}`} className="flex items-center gap-1"><GitMerge aria-hidden className="h-3 w-3" /> {f.tache} · {FILE[f.statut] ?? f.statut}{f.tour > 1 ? ` (tour ${f.tour})` : ""}{f.sha ? ` · ${f.sha.slice(0, 7)}` : ""}{f.raison ? ` — ${f.raison}` : ""}</li>
          ))}
        </ol>
      )}
    </div>
  );
}
