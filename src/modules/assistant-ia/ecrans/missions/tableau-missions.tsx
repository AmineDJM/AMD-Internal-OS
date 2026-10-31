"use client";

import React, { useEffect, useMemo, useState } from "react";
import {
  Ban, CheckCircle2, ChevronDown, Circle, CircleAlert, CircleDashed, Clock, FileText, Loader2, MessageSquare, Pause, Play, Radio, Rocket, X,
} from "lucide-react";
import type { MissionDuTableau } from "@/modules/assistant-ia/api";
import { approuverMonTravail, pauserMonTravail, reprendreMonTravailIA } from "@/modules/assistant-ia/actions";
import { annulerMaMission } from "@/modules/assistant-ia/actions-travaux";
import { avancement, duree, gestesPermis, LIBELLE_ETAPE, LIBELLE_MISSION, missionVivante, usd } from "../../domaine/sous-missions";
import { useMissions, type ModeFlux } from "./use-missions";
import { useEchap } from "../use-echap";
import { ReglageDOffice } from "./reglage-d-office";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE TABLEAU DE BORD « MISSIONS » (K3, décision 0033) — les sous-missions de la personne et leurs étapes, EN TEMPS
 * RÉEL. Une seule implémentation pour l'app Adventum IA (`/ia`) et l'Assistant IA de l'ERP (`/assistant`).
 *
 * Plein écran sur téléphone, tiroir à droite sur ordinateur. Trois onglets (En cours, À approuver, Terminées) ; les
 * missions lancées par un même message se regroupent sous leur conversation. Chaque mission : état, avancement (les lots
 * d'un éventail comptent à leur part), coût, durée, attente dite ; ouverte : ses étapes (en file, en cours, faite, en
 * attente, échec — durée de chacune), son journal, ses livrables ; actions : approuver, pause, reprendre, annuler,
 * ouvrir le livrable, revenir à la conversation. Le contenu s'inspire des écrans de missions d'Adam ; l'apparence est
 * celle de l'app (jetons `--aia-*`, charte Adventum).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

type Onglet = "EN_COURS" | "A_APPROUVER" | "TERMINEES";
const FINIS = ["TERMINE", "ANNULE", "ECHEC"];
const ongletDe = (e: string): Onglet => (e === "A_APPROUVER" ? "A_APPROUVER" : FINIS.includes(e) ? "TERMINEES" : "EN_COURS");

const PASTILLE: Record<string, string> = {
  A_APPROUVER: "bg-[var(--aia-prive-doux)] text-[var(--aia-prive)]",
  EN_COURS: "bg-[var(--aia-voix-doux)] text-[var(--aia-voix)]",
  EN_ATTENTE: "bg-[var(--aia-cote)] text-[var(--aia-discret)]",
  BUDGET_HOLD: "bg-[var(--aia-prive-doux)] text-[var(--aia-prive)]",
  EN_PAUSE: "bg-[var(--aia-prive-doux)] text-[var(--aia-prive)]",
  BLOQUE: "bg-[var(--aia-cote)] text-[var(--aia-danger)]",
  TERMINE: "bg-[var(--aia-accent-doux)] text-[var(--aia-accent)]",
  ANNULE: "bg-[var(--aia-cote)] text-[var(--aia-discret)]",
  ECHEC: "bg-[var(--aia-cote)] text-[var(--aia-danger)]",
};

export const MODE_FLUX: Record<ModeFlux, string> = { connexion: "Connexion…", direct: "En direct", releve: "Relève toutes les 3 s", arret: "Hors ligne" };

const btn = "inline-flex h-11 items-center gap-1.5 rounded-[10px] border border-[var(--aia-filet)] px-3 text-[13px] font-medium hover:bg-[var(--aia-survol)] disabled:opacity-50 sm:h-9";
const btnPlein = "inline-flex h-11 items-center gap-1.5 rounded-[10px] bg-[var(--aia-accent)] px-3 text-[13px] font-semibold text-[var(--aia-accent-fg)] hover:bg-[var(--aia-accent-fort)] disabled:opacity-50 sm:h-9";

function IconeEtape({ etat }: { etat: string }) {
  if (etat === "EN_COURS") return <Loader2 aria-hidden className="h-4 w-4 shrink-0 animate-spin text-[var(--aia-voix)]" />;
  if (etat === "FAITE") return <CheckCircle2 aria-hidden className="h-4 w-4 shrink-0 text-[var(--aia-accent)]" />;
  if (etat === "ATTENTE") return <Clock aria-hidden className="h-4 w-4 shrink-0 text-[var(--aia-prive)]" />;
  if (etat === "ECHEC") return <CircleAlert aria-hidden className="h-4 w-4 shrink-0 text-[var(--aia-danger)]" />;
  if (etat === "ECARTEE") return <Circle aria-hidden className="h-4 w-4 shrink-0 text-[var(--aia-discret)] opacity-60" />;
  return <CircleDashed aria-hidden className="h-4 w-4 shrink-0 text-[var(--aia-discret)]" />;
}

/** La barre d'avancement — fine, animée pendant que la mission avance. */
export function BarreAvancement({ part, vivante, libelle }: { part: number; vivante: boolean; libelle: string }) {
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-[var(--aia-cote)]" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={part} aria-label={libelle}>
      <div className={`h-full rounded-full transition-[width] duration-500 ${vivante ? "bg-[var(--aia-voix)]" : "bg-[var(--aia-accent)]"}`} style={{ width: `${Math.max(part, vivante ? 4 : 0)}%` }} />
    </div>
  );
}

/** « 2 min 10 s », en continu tant que la mission tourne. */
function useMaintenant(actif: boolean): number {
  const [n, setN] = useState(() => Date.now());
  useEffect(() => {
    if (!actif) return;
    const t = setInterval(() => setN(Date.now()), 1_000);
    return () => clearInterval(t);
  }, [actif]);
  return n;
}

export function dureeMission(m: Pick<MissionDuTableau, "demarreLe" | "finiLe">, maintenant: number): string {
  if (!m.demarreLe) return "—";
  return duree((m.finiLe ? new Date(m.finiLe).getTime() : maintenant) - new Date(m.demarreLe).getTime());
}

/** Les gestes de la personne sur une mission (approuver, pause, reprendre, annuler) — partagés avec la carte du fil. */
export function useGestesMission(relire: () => Promise<void>) {
  const [occupe, setOccupe] = useState<string | null>(null);
  const [avis, setAvis] = useState<string | null>(null);
  const agir = async (cle: string, f: () => Promise<{ ok: boolean; erreur?: string; message?: string }>) => {
    setOccupe(cle);
    try {
      const r = await f();
      setAvis(r.ok ? (r.message ?? null) : (r.erreur ?? "Opération impossible."));
    } catch {
      setAvis("L'action n'a pas abouti (connexion ou serveur). Réessayez.");
    } finally {
      setOccupe(null);
    }
    await relire();
  };
  return {
    occupe, avis, setAvis,
    approuver: (id: string) => agir(`ok-${id}`, () => approuverMonTravail(id)),
    pauser: (id: string) => agir(`pause-${id}`, () => pauserMonTravail(id)),
    reprendre: (id: string) => agir(`reprise-${id}`, () => reprendreMonTravailIA(id)),
    annuler: (id: string) => agir(`stop-${id}`, () => annulerMaMission(id)),
  };
}

function CarteMission({ m, ouverte, onBasculer, gestes, onOuvrirLivrable, onOuvrirConversation, maintenant }: {
  m: MissionDuTableau; ouverte: boolean; onBasculer: () => void; gestes: ReturnType<typeof useGestesMission>;
  onOuvrirLivrable?: (p: { id: string; nom: string }) => void; onOuvrirConversation?: (id: string) => void; maintenant: number;
}) {
  const vivante = missionVivante(m.etat);
  const part = m.etat === "TERMINE" ? 100 : avancement(m.etapes);
  const enCours = m.etapes.find((e) => e.etat === "EN_COURS");
  const [confirmer, setConfirmer] = useState(false);
  return (
    <li className="rounded-[var(--aia-rayon)] border border-[var(--aia-filet)] bg-[var(--aia-panneau)]" data-testid="mission" data-mission={m.id} data-etat={m.etat}>
      <button type="button" onClick={onBasculer} aria-expanded={ouverte} className="flex w-full flex-col gap-2 rounded-[var(--aia-rayon)] px-3.5 py-3 text-left hover:bg-[var(--aia-survol)]/40">
        <div className="flex items-start gap-2">
          <span className="min-w-0 flex-1">
            <span className="block text-[14.5px] font-semibold leading-snug">{m.titre}</span>
            <span className="mt-0.5 block truncate text-[12.5px] text-[var(--aia-discret)]">
              {m.attente ?? (enCours ? `En cours : ${enCours.titre}` : m.etat === "A_APPROUVER" ? `${m.etapes.length} étapes à approuver` : m.objectif)}
            </span>
          </span>
          <span className={`shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-[11.5px] font-medium ${PASTILLE[m.etat]}`}>
            {vivante && <span aria-hidden className="mr-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-current align-middle" />}
            {LIBELLE_MISSION[m.etat] ?? m.etat}
          </span>
          <ChevronDown aria-hidden className={`mt-0.5 h-4 w-4 shrink-0 text-[var(--aia-discret)] transition-transform ${ouverte ? "rotate-180" : ""}`} />
        </div>
        <BarreAvancement part={part} vivante={vivante} libelle={`Avancement de ${m.titre}`} />
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[11.5px] text-[var(--aia-discret)]">
          <span data-testid="avancement">{m.avancement.faites}/{m.avancement.total} étapes · {part} %</span>
          <span>{usd(m.coutUsd)}{m.plafondUsd ? ` / ${usd(m.plafondUsd)}` : ""}</span>
          <span>{dureeMission(m, maintenant)}</span>
          {m.dOffice && <span className="inline-flex items-center gap-0.5"><Rocket aria-hidden className="h-3 w-3" /> d&apos;office</span>}
        </div>
      </button>

      {ouverte && (
        <div className="flex flex-col gap-3 border-t border-[var(--aia-filet)] px-3.5 pb-3.5 pt-3">
          <ol className="flex flex-col gap-1" aria-label={`Étapes de ${m.titre}`}>
            {m.etapes.map((e) => (
              <li key={e.cle} className="flex items-start gap-2 rounded-lg px-1.5 py-1.5" data-testid="etape" data-etape={e.cle} data-etat={e.etat}>
                <IconeEtape etat={e.etat} />
                <span className="min-w-0 flex-1">
                  <span className={`block text-[13.5px] leading-snug ${e.etat === "ECARTEE" ? "text-[var(--aia-discret)] line-through" : ""}`}>{e.titre}</span>
                  <span className="block text-[11.5px] text-[var(--aia-discret)]">
                    {e.type} · {LIBELLE_ETAPE[e.etat]}
                    {e.debut ? ` · ${duree((e.fin ? new Date(e.fin).getTime() : maintenant) - new Date(e.debut).getTime())}` : ""}
                    {e.lots && e.lots.total > 0 ? ` · lots ${e.lots.faits}/${e.lots.total}` : ""}
                  </span>
                  {e.erreur && <span className="mt-0.5 block text-[12px] text-[var(--aia-danger)]">{e.erreur}</span>}
                </span>
              </li>
            ))}
          </ol>

          {m.livrables.length > 0 && (
            <div className="flex flex-col gap-1">
              <h4 className="text-[11.5px] font-semibold uppercase tracking-wide text-[var(--aia-discret)]">Livrables</h4>
              {m.livrables.map((l) => (
                l.nodeId ? (
                  <button key={l.nodeId} type="button" onClick={() => (onOuvrirLivrable ? onOuvrirLivrable({ id: l.nodeId!, nom: l.nom ?? l.titre }) : window.open(`/drive/${l.nodeId}`, "_blank"))}
                    className="flex min-h-11 items-center gap-2 rounded-lg px-2 text-left text-[13.5px] text-[var(--aia-accent)] hover:bg-[var(--aia-survol)] sm:min-h-9">
                    <FileText aria-hidden className="h-4 w-4 shrink-0" /> <span className="min-w-0 flex-1 truncate">{l.nom ?? l.titre}</span>
                  </button>
                ) : <p key={l.titre} className="px-2 text-[13px] text-[var(--aia-discret)]">{l.titre} (au carnet)</p>
              ))}
            </div>
          )}

          {m.journal.length > 0 && (
            <details className="text-[12.5px]">
              <summary className="cursor-pointer select-none text-[var(--aia-discret)]">Journal ({m.journal.length})</summary>
              <ul className="mt-1.5 flex flex-col gap-1 border-l-2 border-[var(--aia-filet)] pl-2.5">
                {m.journal.map((j) => (
                  <li key={j.at + j.texte}>
                    <span className="font-mono text-[11px] text-[var(--aia-discret)]">{new Date(j.at).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "Africa/Algiers" })}</span>{" "}
                    {j.texte}
                  </li>
                ))}
              </ul>
            </details>
          )}

          <div className="flex flex-wrap gap-2">
            {m.etat === "A_APPROUVER" && (
              <button type="button" className={btnPlein} disabled={!!gestes.occupe} onClick={() => void gestes.approuver(m.id)}>
                {gestes.occupe === `ok-${m.id}` ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : <CheckCircle2 aria-hidden className="h-4 w-4" />} Approuver et lancer
              </button>
            )}
            {gestesPermis(m.etat).pause && (
              <button type="button" className={btn} disabled={!!gestes.occupe} onClick={() => void gestes.pauser(m.id)}><Pause aria-hidden className="h-4 w-4" /> Pause</button>
            )}
            {gestesPermis(m.etat).reprise && (
              <button type="button" className={btn} disabled={!!gestes.occupe} onClick={() => void gestes.reprendre(m.id)}><Play aria-hidden className="h-4 w-4" /> Reprendre</button>
            )}
            {gestesPermis(m.etat).annuler && (confirmer ? (
              <span className="inline-flex flex-wrap items-center gap-2">
                <button type="button" className={`${btn} border-[var(--aia-danger)] text-[var(--aia-danger)]`} disabled={!!gestes.occupe} onClick={() => { setConfirmer(false); void gestes.annuler(m.id); }}>
                  <Ban aria-hidden className="h-4 w-4" /> Oui, annuler
                </button>
                <button type="button" className={btn} onClick={() => setConfirmer(false)}>Non</button>
              </span>
            ) : (
              <button type="button" className={btn} disabled={!!gestes.occupe} onClick={() => setConfirmer(true)}><Ban aria-hidden className="h-4 w-4" /> Annuler</button>
            ))}
            {m.conversation && onOuvrirConversation && (
              <button type="button" className={btn} onClick={() => onOuvrirConversation(m.conversation!.id)}><MessageSquare aria-hidden className="h-4 w-4" /> Conversation</button>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

export function TableauMissions({ ouvert, onFermer, missionInitiale, onOuvrirLivrable, onOuvrirConversation }: {
  ouvert: boolean; onFermer: () => void; missionInitiale?: string | null;
  onOuvrirLivrable?: (p: { id: string; nom: string }) => void; onOuvrirConversation?: (filId: string) => void;
}) {
  const { tableau, mode, recuLe, relire } = useMissions(ouvert);
  const gestes = useGestesMission(relire);
  const [onglet, setOnglet] = useState<Onglet>("EN_COURS");
  const [ouvertes, setOuvertes] = useState<Set<string>>(new Set());
  useEchap(onFermer);
  const missions = useMemo(() => tableau?.missions ?? [], [tableau]);
  const maintenant = useMaintenant(ouvert && missions.some((m) => missionVivante(m.etat)));

  // Ouvert sur une mission (carte du fil, notification) : son onglet, dépliée.
  useEffect(() => {
    if (!ouvert || !missionInitiale) return;
    const m = missions.find((x) => x.id === missionInitiale);
    if (!m) return;
    setOnglet(ongletDe(m.etat));
    setOuvertes((s) => new Set(s).add(m.id));
  }, [ouvert, missionInitiale, missions]);
  // Premier affichage : rien en cours mais des plans à approuver → cet onglet.
  useEffect(() => {
    if (ouvert && tableau && !missionInitiale && !tableau.missions.some((m) => ongletDe(m.etat) === "EN_COURS") && tableau.aApprouver) setOnglet("A_APPROUVER");
  }, [ouvert, tableau, missionInitiale]);

  if (!ouvert) return null;
  const compte = (o: Onglet) => missions.filter((m) => ongletDe(m.etat) === o).length;
  const visibles = missions.filter((m) => ongletDe(m.etat) === onglet);
  // LES MISSIONS LANCÉES ENSEMBLE se regroupent sous leur conversation (même message) ; les autres, seules.
  const groupes: { cle: string; titre: string | null; filId: string | null; missions: MissionDuTableau[] }[] = [];
  for (const m of visibles) {
    const cle = m.conversation?.tourId ?? m.parentId ?? m.id;
    const g = groupes.find((x) => x.cle === cle);
    if (g) g.missions.push(m);
    else groupes.push({ cle, titre: m.conversation?.titre ?? null, filId: m.conversation?.id ?? null, missions: [m] });
  }
  const onglets: { id: Onglet; libelle: string }[] = [{ id: "EN_COURS", libelle: "En cours" }, { id: "A_APPROUVER", libelle: "À approuver" }, { id: "TERMINEES", libelle: "Terminées" }];

  return (
    <div className="adventum-ia fixed inset-0 z-50 flex justify-end bg-transparent" data-testid="tableau-missions">
      <button type="button" aria-label="Fermer le tableau des missions" onClick={onFermer} className="absolute inset-0 hidden bg-slate-950/30 lg:block" />
      <section role="dialog" aria-modal="true" aria-label="Missions" className="relative flex h-full w-full flex-col bg-[var(--aia-fond)] pt-[env(safe-area-inset-top)] shadow-2xl lg:w-[460px] lg:border-l lg:border-[var(--aia-filet)] lg:pt-0">
        <header className="flex items-center gap-2 border-b border-[var(--aia-filet)] bg-[var(--aia-panneau)] px-3.5 py-2.5">
          <Rocket aria-hidden className="h-5 w-5 text-[var(--aia-accent)]" />
          <div className="min-w-0 flex-1">
            <h2 className="text-[16px] font-semibold leading-tight">Missions</h2>
            <p className="flex items-center gap-1 text-[11.5px] text-[var(--aia-discret)]" aria-live="polite" data-testid="mode-flux" data-mode={mode}>
              <Radio aria-hidden className={`h-3 w-3 ${mode === "direct" ? "text-[var(--aia-voix)]" : ""}`} />
              {MODE_FLUX[mode]}
              {recuLe && mode !== "direct" ? ` · lu à ${new Date(recuLe).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}` : ""}
            </p>
          </div>
          <button type="button" onClick={onFermer} aria-label="Fermer" className="flex h-11 w-11 items-center justify-center rounded-[10px] hover:bg-[var(--aia-survol)] sm:h-9 sm:w-9"><X className="h-5 w-5" /></button>
        </header>

        <div role="tablist" aria-label="Missions" className="flex gap-1 border-b border-[var(--aia-filet)] bg-[var(--aia-panneau)] px-2 py-1.5">
          {onglets.map((o) => (
            <button key={o.id} type="button" role="tab" aria-selected={onglet === o.id} onClick={() => setOnglet(o.id)}
              className="flex h-11 flex-1 items-center justify-center gap-1.5 rounded-[10px] text-[13.5px] hover:bg-[var(--aia-survol)] aria-selected:bg-[var(--aia-accent-doux)] aria-selected:font-semibold aria-selected:text-[var(--aia-accent)] sm:h-9">
              {o.libelle}
              {compte(o.id) > 0 && <span className="rounded-full bg-[var(--aia-cote)] px-1.5 font-mono text-[11px]">{compte(o.id)}</span>}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
          {gestes.avis && <p role="status" className="mb-2 rounded-lg bg-[var(--aia-accent-doux)] px-3 py-2 text-[13px] text-[var(--aia-accent)]">{gestes.avis}</p>}
          {!tableau && <p className="flex items-center gap-2 px-1 py-6 text-[13.5px] text-[var(--aia-discret)]"><Loader2 aria-hidden className="h-4 w-4 animate-spin" /> Chargement des missions…</p>}
          {tableau && !visibles.length && (
            <p className="px-1 py-6 text-[13.5px] text-[var(--aia-discret)]" data-testid="missions-vide">
              {onglet === "EN_COURS" ? "Aucune mission en cours. Confiez une tâche longue à l'assistant : elle tourne en arrière-plan, et vous continuez de discuter."
                : onglet === "A_APPROUVER" ? "Aucun plan n'attend votre accord." : "Aucune mission terminée ces trois derniers jours."}
            </p>
          )}
          <div className="flex flex-col gap-4">
            {groupes.map((g) => (
              <section key={g.cle} className="flex flex-col gap-2" aria-label={g.missions.length > 1 ? `Lancées ensemble : ${g.titre ?? "conversation"}` : g.missions[0]!.titre}>
                {g.missions.length > 1 && (
                  <h3 className="flex items-center gap-1.5 px-1 text-[12px] font-semibold text-[var(--aia-discret)]">
                    <MessageSquare aria-hidden className="h-3.5 w-3.5" /> {g.missions.length} sous-missions · {g.titre ?? "conversation"}
                  </h3>
                )}
                <ul className="flex flex-col gap-2">
                  {g.missions.map((m) => (
                    <CarteMission key={m.id} m={m} ouverte={ouvertes.has(m.id)} gestes={gestes} maintenant={maintenant}
                      onBasculer={() => setOuvertes((s) => { const n = new Set(s); if (n.has(m.id)) n.delete(m.id); else n.add(m.id); return n; })}
                      onOuvrirLivrable={onOuvrirLivrable} onOuvrirConversation={onOuvrirConversation ? (id) => { onFermer(); onOuvrirConversation(id); } : undefined} />
                  ))}
                </ul>
              </section>
            ))}
          </div>
          <div className="mt-6 border-t border-[var(--aia-filet)] pt-3"><ReglageDOffice compact /></div>
        </div>
      </section>
    </div>
  );
}
