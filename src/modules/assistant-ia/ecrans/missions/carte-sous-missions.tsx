"use client";

import React, { useEffect, useState } from "react";
import { CheckCircle2, ChevronRight, Loader2, Rocket } from "lucide-react";
import { avancement, LIBELLE_MISSION, missionVivante, usd } from "../../domaine/sous-missions";
import { useMissions } from "./use-missions";
import { BarreAvancement, useGestesMission } from "./tableau-missions";

/**
 * LA CARTE DES SOUS-MISSIONS DANS LA CONVERSATION (K3, décision 0033) — sous la réponse qui les a lancées. Elle SE MET À
 * JOUR en temps réel (le même flux que le tableau de bord) : état, étape en cours, avancement, coût. Un plan qui attend
 * s'approuve ici (un par un, ou « Tout approuver ») ; « Suivre » ouvre le tableau sur la mission. À la fin, la synthèse
 * s'écrit comme une réponse de l'assistant, juste dessous.
 */
export function CarteSousMissions({ ids, onSuivre }: { ids: string[]; onSuivre?: (id?: string) => void }) {
  const { tableau, relire } = useMissions(ids.length > 0);
  const gestes = useGestesMission(relire);
  // L'ÉTAT FRAIS d'abord : le flux peut encore porter, une seconde, l'état « à approuver » d'un plan que la fin du tour
  // vient de démarrer d'office — « Approuver » ne s'affiche qu'après une relecture faite APRÈS l'apparition de la carte.
  const [frais, setFrais] = useState(false);
  useEffect(() => { void relire().finally(() => setFrais(true)); }, [relire]);
  const missions = ids.map((id) => tableau?.missions.find((m) => m.id === id)).filter((m): m is NonNullable<typeof m> => !!m);
  if (!ids.length) return null;
  const aApprouver = frais ? missions.filter((m) => m.etat === "A_APPROUVER") : [];
  const vivantes = missions.filter((m) => missionVivante(m.etat)).length;
  const toutApprouver = async () => { for (const m of aApprouver) await gestes.approuver(m.id); };
  // `adventum-ia contents` : les jetons du thème, aussi dans l'ERP (où la conversation ne les porte pas).
  return (
    <div className="adventum-ia contents">
    <section className="mt-2 rounded-[var(--aia-rayon,14px)] border border-[var(--aia-filet)] bg-[var(--aia-panneau)] p-3 text-[var(--aia-texte)]" data-testid="carte-sous-missions" aria-label="Sous-missions lancées">
      <header className="mb-2 flex items-center gap-2">
        <Rocket aria-hidden className="h-4 w-4 text-[var(--aia-accent)]" />
        <h4 className="min-w-0 flex-1 text-[13.5px] font-semibold">
          {ids.length > 1 ? `${ids.length} sous-missions` : "Mission en arrière-plan"}
          {vivantes > 0 && <span className="ml-1.5 font-normal text-[var(--aia-discret)]">· {vivantes} en cours</span>}
        </h4>
        {onSuivre && (
          <button type="button" onClick={() => onSuivre()} className="inline-flex h-11 items-center gap-0.5 rounded-lg px-2 text-[12.5px] text-[var(--aia-accent)] hover:bg-[var(--aia-survol)] sm:h-8">
            Tableau <ChevronRight aria-hidden className="h-3.5 w-3.5" />
          </button>
        )}
      </header>
      {!tableau && <p className="flex items-center gap-1.5 text-[12.5px] text-[var(--aia-discret)]"><Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" /> Lecture de l&apos;état…</p>}
      <ul className="flex flex-col gap-2">
        {missions.map((m) => {
          const enCours = m.etapes.find((e) => e.etat === "EN_COURS");
          const part = m.etat === "TERMINE" ? 100 : avancement(m.etapes);
          return (
            <li key={m.id} className="flex flex-col gap-1.5" data-testid="sous-mission" data-mission={m.id} data-etat={m.etat}>
              <button type="button" onClick={() => onSuivre?.(m.id)} className="flex items-baseline gap-2 text-left">
                <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">{m.titre}</span>
                <span className="shrink-0 font-mono text-[11px] text-[var(--aia-discret)]">{LIBELLE_MISSION[m.etat] ?? m.etat} · {part} %</span>
              </button>
              <BarreAvancement part={part} vivante={missionVivante(m.etat)} libelle={`Avancement de ${m.titre}`} />
              <p className="truncate text-[12px] text-[var(--aia-discret)]" data-testid="etape-courante">
                {m.attente ?? (enCours ? `En cours : ${enCours.titre}` : m.etat === "A_APPROUVER" ? (frais ? `${m.etapes.length} étapes — attend votre accord` : "Préparation…") : `${m.avancement.faites}/${m.avancement.total} étapes · ${usd(m.coutUsd)}`)}
              </p>
              {m.etat === "A_APPROUVER" && aApprouver.length === 1 && (
                <button type="button" disabled={!!gestes.occupe} onClick={() => void gestes.approuver(m.id)}
                  className="inline-flex h-11 items-center gap-1.5 self-start rounded-[10px] bg-[var(--aia-accent)] px-3 text-[13px] font-semibold text-[var(--aia-accent-fg)] disabled:opacity-50 sm:h-9">
                  {gestes.occupe ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : <CheckCircle2 aria-hidden className="h-4 w-4" />} Approuver et lancer
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {aApprouver.length > 1 && (
        <button type="button" disabled={!!gestes.occupe} onClick={() => void toutApprouver()}
          className="mt-2.5 inline-flex h-11 items-center gap-1.5 rounded-[10px] bg-[var(--aia-accent)] px-3 text-[13px] font-semibold text-[var(--aia-accent-fg)] disabled:opacity-50 sm:h-9">
          {gestes.occupe ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : <CheckCircle2 aria-hidden className="h-4 w-4" />} Tout approuver ({aApprouver.length})
        </button>
      )}
      {gestes.avis && <p role="status" className="mt-1.5 text-[12px] text-[var(--aia-discret)]">{gestes.avis}</p>}
    </section>
    </div>
  );
}

/** L'INDICATEUR DISCRET de l'en-tête de la conversation : « 3 missions en cours » — ouvre le tableau de bord. */
export function IndicateurMissions({ onOuvrir, actif = true }: { onOuvrir: () => void; actif?: boolean }) {
  const { tableau } = useMissions(actif);
  const enCours = tableau?.enCours ?? 0;
  const aApprouver = tableau?.aApprouver ?? 0;
  const libelle = enCours ? `${enCours} mission${enCours > 1 ? "s" : ""} en cours` : aApprouver ? `${aApprouver} à approuver` : "Missions";
  return (
    <span className="adventum-ia contents">
    <button type="button" onClick={onOuvrir} data-testid="indicateur-missions" data-en-cours={enCours} aria-label={`Missions — ${libelle}`} title="Tableau de bord des missions"
      className={`inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[12.5px] hover:bg-[var(--aia-survol)] ${enCours ? "bg-[var(--aia-voix-doux)] text-[var(--aia-voix)]" : aApprouver ? "bg-[var(--aia-prive-doux)] text-[var(--aia-prive)]" : "text-[var(--aia-discret)]"}`}>
      {enCours ? <span aria-hidden className="h-2 w-2 animate-pulse rounded-full bg-current" /> : <Rocket aria-hidden className="h-4 w-4" />}
      {enCours || aApprouver ? (
        <>
          <span className="sm:hidden">{enCours ? `${enCours} en cours` : `${aApprouver} à approuver`}</span>
          <span className="hidden sm:inline">{libelle}</span>
        </>
      ) : <span className="sr-only">{libelle}</span>}
    </button>
    </span>
  );
}
