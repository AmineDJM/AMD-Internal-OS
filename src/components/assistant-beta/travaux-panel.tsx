"use client";

import { actionFailureMessage } from "@/lib/action-outcome";
import React, { useCallback, useEffect, useState } from "react";
import { Ban, Briefcase, CheckCircle2, Clock, Loader2, Pause, Play } from "lucide-react";
import {
  annulerMonTravail, approuverMonTravail, lireMonTravail, listerMesTravaux, pauserMonTravail, reprendreMonTravailIA,
} from "@/lib/actions/assistant-ia-actions";
import { LIBELLE_ETAT, peutAnnuler, peutPauser, peutReprendre, type EtatTravail } from "@/lib/missions/travaux/regles";
import { MarkdownMessage } from "./markdown-message";
import { PanneauLateral } from "./panneau-lateral";

/**
 * LE PANNEAU « TRAVAUX » (J2, décision 0016) — les travaux longs de la personne, et la carte
 * « Approuver le plan ».
 *
 * Chaque travail : son état (en cours, en attente, plafond atteint…), l'attente en cours dite
 * (« attend « la signature du BC » depuis 2 jours »), l'avancement, le coût et son plafond. Ouvert :
 * les étapes, le carnet (trouvailles, livrables), le journal. Un plan proposé s'approuve ICI, en
 * voyant les étapes, les gestes autorisés (bornés à la console) et le plafond. Pause, reprise,
 * annulation : ici. Le travail lui-même tourne en arrière-plan — fermer l'écran n'arrête rien.
 */

type Liste = Extract<Awaited<ReturnType<typeof listerMesTravaux>>, { ok: true }>;
type Travail = Liste["travaux"][number];
type Detail = Extract<Awaited<ReturnType<typeof lireMonTravail>>, { ok: true }>["travail"];

const CLASSE: Record<EtatTravail, string> = {
  A_APPROUVER: "bg-violet-50 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300",
  EN_COURS: "bg-sky-50 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300",
  EN_ATTENTE: "bg-slate-100 text-slate-700 dark:bg-zinc-800 dark:text-zinc-300",
  BUDGET_HOLD: "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400",
  EN_PAUSE: "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400",
  BLOQUE: "bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-400",
  TERMINE: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400",
  ANNULE: "bg-slate-100 text-slate-500 dark:bg-zinc-800 dark:text-zinc-400",
  ECHEC: "bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-400",
};
const STATUT_ETAPE: Record<string, string> = {
  PENDING: "À venir", READY: "Prête", RUNNING: "En cours", WAITING: "En attente", DONE: "Faite", FAILED: "Échec", SKIPPED: "Écartée", CANCELLED: "Annulée",
};

const usd = (n: number) => `${n.toFixed(2).replace(".", ",")} $`;
const quand = (iso: string) => new Date(iso).toLocaleString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Africa/Algiers" });
const bouton = "inline-flex h-9 items-center gap-1 rounded-lg border border-slate-200 px-2.5 text-[12px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-900";

export function TravauxPanel({ ouvert, onFermer, travailInitial, onAApprouver }: {
  ouvert: boolean; onFermer: () => void; travailInitial?: string | null; onAApprouver?: (n: number) => void;
}) {
  const [travaux, setTravaux] = useState<Travail[] | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [occupe, setOccupe] = useState<string | null>(null);
  const [aAnnuler, setAAnnuler] = useState<string | null>(null);

  const charger = useCallback(async () => {
    try {
      const r = await listerMesTravaux();
      if (r.ok) { setTravaux(r.travaux); setErreur(null); onAApprouver?.(r.aApprouver); } else setErreur(r.erreur);
    } catch {
      setErreur("Les travaux n'ont pas pu être chargés (connexion ou serveur).");
    }
  }, [onAApprouver]);

  const ouvrir = useCallback(async (id: string) => {
    try {
      const r = await lireMonTravail(id);
      if (r.ok) setDetail(r.travail); else setErreur(r.erreur);
    } catch {
      setErreur(actionFailureMessage("THROWN"));
    }
  }, []);

  useEffect(() => { if (ouvert) void charger(); }, [ouvert, charger]);
  // Un travail vit en arrière-plan : le panneau ouvert se relit toutes les 15 s.
  useEffect(() => {
    if (!ouvert) return;
    const t = setInterval(() => { void charger(); if (detail) void ouvrir(detail.id); }, 15_000);
    return () => clearInterval(t);
  }, [ouvert, charger, ouvrir, detail]);
  // Arrivé par une notification (« /assistant?travail=… ») : ce travail s'ouvre.
  const [initialVu, setInitialVu] = useState(false);
  useEffect(() => {
    if (!ouvert || !travailInitial || initialVu) return;
    setInitialVu(true);
    void ouvrir(travailInitial);
  }, [ouvert, travailInitial, initialVu, ouvrir]);

  const agir = async (cle: string, id: string, f: (id: string) => Promise<{ ok: boolean; erreur?: string; message?: string }>) => {
    setOccupe(cle);
    let r: { ok: boolean; erreur?: string; message?: string };
    try {
      r = await f(id);
    } catch {
      setErreur(actionFailureMessage("THROWN"));
      return;
    } finally {
      setOccupe(null);
    }
    if (!r.ok) { setErreur(r.erreur ?? "Opération impossible."); return; }
    setErreur(null);
    setInfo(r.message ?? null);
    await charger();
    if (detail?.id === id) await ouvrir(id);
  };

  if (!ouvert) return null;

  const gestes = (t: Travail) => (
    <div className="flex flex-wrap gap-1.5">
      {t.etat === "A_APPROUVER" && (
        <button type="button" disabled={!!occupe} onClick={() => agir(`a${t.id}`, t.id, approuverMonTravail)} className="inline-flex h-9 items-center gap-1 rounded-lg bg-violet-600 px-3 text-[12px] font-semibold text-white hover:bg-violet-700 disabled:opacity-60">
          {occupe === `a${t.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />} Approuver le plan
        </button>
      )}
      {peutPauser(t.etat) && (
        <button type="button" disabled={!!occupe} onClick={() => agir(`p${t.id}`, t.id, pauserMonTravail)} className={bouton}><Pause className="h-3.5 w-3.5" /> Pause</button>
      )}
      {peutReprendre(t.etat) && (
        <button type="button" disabled={!!occupe} onClick={() => agir(`r${t.id}`, t.id, reprendreMonTravailIA)} className={bouton}><Play className="h-3.5 w-3.5" /> Reprendre</button>
      )}
      <div className="flex-1" />
      {peutAnnuler(t.etat) && (aAnnuler === t.id ? (
        <>
          <button type="button" disabled={!!occupe} onClick={async () => { await agir(`x${t.id}`, t.id, annulerMonTravail); setAAnnuler(null); }} className="h-9 rounded-lg bg-red-600 px-2.5 text-[12px] font-medium text-white disabled:opacity-60">
            {t.etat === "A_APPROUVER" ? "Écarter le plan" : "Arrêter le travail"}
          </button>
          <button type="button" onClick={() => setAAnnuler(null)} className="h-9 rounded-lg px-2.5 text-[12px] text-slate-600 hover:bg-slate-100 dark:hover:bg-zinc-800">Garder</button>
        </>
      ) : (
        <button type="button" onClick={() => setAAnnuler(t.id)} className={bouton}><Ban className="h-3.5 w-3.5" /> {t.etat === "A_APPROUVER" ? "Écarter" : "Annuler"}</button>
      ))}
    </div>
  );

  const resume = (t: Travail) => (
    <>
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 text-sm font-semibold text-slate-900 [overflow-wrap:anywhere] dark:text-zinc-100">{t.titre}</p>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${CLASSE[t.etat]}`}>{LIBELLE_ETAT[t.etat]}</span>
      </div>
      {t.attente && <p className="mt-1 flex items-center gap-1 text-[12px] text-slate-600 dark:text-zinc-400"><Clock className="h-3.5 w-3.5" /> {t.attente}</p>}
      {t.motifPause && <p className="mt-1 text-[12px] text-amber-700 dark:text-amber-400">{t.motifPause.replace(/^(BUDGET_HOLD|DROITS) — /, "")}</p>}
      <p className="mt-1 text-[12px] text-slate-500">
        {t.etapes.total > 0 ? `${t.etapes.faites}/${t.etapes.total} étapes` : "plan proposé"}
        {t.etapes.enEchec > 0 ? ` · ${t.etapes.enEchec} en échec` : ""} · {usd(t.coutUsd)}{t.plafondUsd !== null ? ` / ${usd(t.plafondUsd)}` : ""} · {quand(t.majLe)}
      </p>
    </>
  );

  return (
    <PanneauLateral
      etiquette="Mes travaux" titre={detail ? detail.titre : "Mes travaux"} icone={<Briefcase className="h-4 w-4 text-violet-600" />}
      onRetour={detail ? () => setDetail(null) : undefined} libelleRetour="Retour aux travaux" largeur="sm:w-[500px]"
      onFermer={onFermer}
      pied={detail ? null : <>Un travail tourne en arrière-plan, sous vos droits relus à chaque étape ; il reprend où il en était après un redémarrage. Vous êtes notifié à la fin, et chaque jour pour un travail long.</>}
    >
      {erreur && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-700 dark:bg-red-950/40 dark:text-red-400">{erreur}</p>}
      {info && !erreur && <p role="status" className="rounded-lg bg-emerald-50 px-3 py-2 text-[13px] text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">{info}</p>}

      {detail ? (
        <article className="space-y-4">
          {resume(detail)}
          <p className="text-[13px] text-slate-700 dark:text-zinc-300">{detail.objectif}</p>
          {detail.etat === "A_APPROUVER" && (
            <section className="space-y-2 rounded-xl border border-violet-200 bg-violet-50/50 p-3 dark:border-violet-900 dark:bg-violet-950/20">
              <h3 className="text-[13px] font-semibold text-violet-900 dark:text-violet-200">Approuver le plan</h3>
              <ol className="list-decimal space-y-0.5 pl-5 text-[13px] text-slate-700 dark:text-zinc-300">
                {(detail.carnet.plan?.etapes ?? []).map((e) => <li key={e.cle}><span className="text-slate-500">[{e.type}]</span> {e.titre}</li>)}
              </ol>
              <p className="text-[12px] text-slate-600 dark:text-zinc-400">
                Gestes autorisés pendant le travail : {detail.gestes.length ? detail.gestes.map((g) => `${g.libelle} (${g.libelleFamille})`).join(", ") : "aucun — lecture et analyse seulement"}.
                {" "}Plafond de dépense : {detail.plafondUsd !== null ? usd(detail.plafondUsd) : "celui de la console"}.
                {" "}Vos droits sont relus avant chaque étape : un accès retiré s&apos;applique aussitôt.
              </p>
            </section>
          )}
          {gestes(detail)}

          {detail.carnet.livrables.map((l) => (
            <section key={l.etape} className="space-y-1 rounded-xl border border-emerald-200 p-3 dark:border-emerald-900">
              <h3 className="text-[13px] font-semibold text-emerald-800 dark:text-emerald-300">Livrable — {l.titre}</h3>
              <div className="text-sm text-slate-800 dark:text-zinc-200"><MarkdownMessage texte={l.contenu} /></div>
            </section>
          ))}

          {detail.liste.length > 0 && (
            <section>
              <h3 className="mb-1 text-[13px] font-semibold text-slate-800 dark:text-zinc-200">Étapes</h3>
              <ul className="divide-y divide-slate-100 rounded-lg border border-slate-100 dark:divide-zinc-800 dark:border-zinc-800">
                {detail.liste.map((e) => (
                  <li key={e.cle} className="px-2.5 py-2 text-[12px]">
                    <div className="flex items-center gap-2">
                      <span className="w-16 shrink-0 text-slate-500">{e.type}</span>
                      <span className="min-w-0 flex-1 truncate text-slate-800 dark:text-zinc-200">{e.titre}</span>
                      <span className={`shrink-0 font-medium ${e.statut === "FAILED" ? "text-red-600" : e.statut === "DONE" ? "text-emerald-700 dark:text-emerald-400" : "text-slate-600 dark:text-zinc-400"}`}>{STATUT_ETAPE[e.statut] ?? e.statut}</span>
                    </div>
                    {e.erreur && e.statut === "FAILED" && <p className="mt-0.5 text-red-600 [overflow-wrap:anywhere]">{e.erreur}</p>}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {detail.carnet.trouvailles.length > 0 && (
            <section>
              <h3 className="mb-1 text-[13px] font-semibold text-slate-800 dark:text-zinc-200">Carnet — trouvailles</h3>
              <ul className="list-disc space-y-0.5 pl-5 text-[12px] text-slate-700 dark:text-zinc-300">
                {detail.carnet.trouvailles.slice(-30).map((t, i) => <li key={`${t.etape}-${i}`}>{t.texte}</li>)}
              </ul>
            </section>
          )}

          {detail.journal.length > 0 && (
            <section>
              <h3 className="mb-1 text-[13px] font-semibold text-slate-800 dark:text-zinc-200">Journal</h3>
              <ul className="space-y-0.5 text-[12px] text-slate-600 dark:text-zinc-400">
                {detail.journal.map((j, i) => <li key={i}><span className="text-slate-400">{quand(j.at)}</span> — {j.texte}</li>)}
              </ul>
            </section>
          )}
        </article>
      ) : travaux === null ? (
        <div className="flex items-center gap-2 py-6 text-[13px] text-slate-500"><Loader2 className="h-4 w-4 animate-spin" /> Chargement…</div>
      ) : travaux.length === 0 ? (
        <div className="space-y-2 py-6 text-center text-[13px] text-slate-500">
          <p>Aucun travail pour l&apos;instant.</p>
          <p>Confiez à l&apos;assistant un chantier qui dépasse une réponse : « Analyse toutes les demandes Ad &amp; Pro de l&apos;année et fais-moi un rapport », « relance l&apos;agence si le BC n&apos;est pas signé sous 48 h ».</p>
        </div>
      ) : (
        <ul className="space-y-3">
          {travaux.map((t) => (
            <li key={t.id} className={`rounded-xl border p-3 ${t.etat === "A_APPROUVER" ? "border-violet-300 dark:border-violet-800" : "border-slate-200 dark:border-zinc-800"}`}>
              <button type="button" onClick={() => ouvrir(t.id)} className="block w-full text-left">{resume(t)}</button>
              <div className="mt-2">{gestes(t)}</div>
            </li>
          ))}
        </ul>
      )}
    </PanneauLateral>
  );
}
