"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, X, ShieldAlert, CheckCircle2, ArrowUpRight, Loader2, FlaskConical, PencilLine, AlertTriangle } from "lucide-react";
import { champsCorriges, saisiesInitiales, verifierFormulaire, type FormulaireCarte, type Saisie, type Saisies } from "@/platform/ia/capacites/formulaire";
import { texteARessaisir } from "../domaine/capacites";
import { chercherReferenceCarteAssistantIA } from "../actions";
import { FormulaireCarteCapacite } from "./formulaire-carte";
import { PanneauLateral } from "./panneau-lateral";
import { apercuChamps, avertissementsUniques, etatSimulationAffiche, libelleOuverture } from "../domaine/ui/carte-action";
import type { VueSimulation } from "../domaine/simulation";

export interface ActionIntentCardProps {
  intentId: string;
  kind: string;
  title: string;
  summary?: string;
  fields?: { label: string; value: string }[];
  /** Ce que la personne doit savoir AVANT de confirmer (doublon, seuil, pièce, budget). */
  warnings?: string[];
  /** CRITIQUE : la valeur à ressaisir pour armer le bouton (le serveur la revérifie). */
  confirmText?: string;
  /** Le libellé du bouton quand « Confirmer » ne dit pas le geste. */
  libelleBouton?: string;
  /** J7 : ce que la simulation (transaction annulée) a réellement écrit — ou « non simulable », dit. */
  simulation?: VueSimulation;
  initialStatus?: "PROPOSED" | "CONFIRMED" | "EXECUTING" | "EXECUTED" | "CANCELLED";
  resultLink?: string;
  resultMessage?: string;
  /** J11 (décision 0030) : le formulaire généré depuis le contrat — la personne corrige, puis signe. */
  formulaire?: FormulaireCarte;
  /** P1 (décision 0047) : l'APERÇU RÉEL des mails (le rendu du gabarit, celui qui part) — affiché isolé (iframe sans script). */
  apercus?: { titre: string; html: string }[];
  onConfirm: (intentId: string, confirmTyped?: string, corrections?: Record<string, unknown>) => Promise<{ ok: boolean; message?: string; link?: string; error?: string }>;
}

export function ActionConfirmationCard({
  intentId,
  kind,
  title,
  summary,
  fields = [],
  warnings = [],
  confirmText,
  libelleBouton,
  simulation,
  initialStatus = "PROPOSED",
  resultLink,
  resultMessage,
  formulaire,
  apercus = [],
  onConfirm,
}: ActionIntentCardProps) {
  const [status, setStatus] = useState(initialStatus);
  const [isPending, setIsPending] = useState(false);
  const [message, setMessage] = useState(resultMessage || "");
  const [link, setLink] = useState(resultLink || "");
  const [error, setError] = useState<string | null>(null);
  const [ressaisie, setRessaisie] = useState("");
  // LE FORMULAIRE (J11) : la proposition pré-remplie ; chaque frappe revalide contre le schéma du registre.
  const [saisies, setSaisies] = useState<Saisies>(() => (formulaire ? saisiesInitiales(formulaire) : {}));
  const [tente, setTente] = useState(false);
  const verification = useMemo(() => (formulaire ? verifierFormulaire(formulaire, saisies) : null), [formulaire, saisies]);
  const corriges = useMemo(() => new Set(formulaire && verification ? champsCorriges(formulaire, verification.entree) : []), [formulaire, verification]);
  // Une carte renforcée se ressaisit sur l'entrée CORRIGÉE (un montant changé se relit changé) — le serveur recalcule pareil.
  const aRessaisir = confirmText && formulaire && verification && corriges.size ? texteARessaisir(title, verification.entree) : confirmText;
  const arme = !aRessaisir || ressaisie.trim().toLowerCase() === aRessaisir.trim().toLowerCase();
  const changer = useCallback((nom: string, valeur: Saisie) => setSaisies((s) => ({ ...s, [nom]: valeur })), []);
  const chercher = useCallback(async (champ: string, texte: string) => {
    const r = await chercherReferenceCarteAssistantIA(intentId, champ, texte);
    return r.ok ? r.options : [];
  }, [intentId]);
  const erreurs = tente && verification ? verification.erreurs : {};
  // POINT 3 (31/10/2026) : une carte À FORMULAIRE se résume dans la conversation ; le formulaire s'ouvre dans un
  // panneau (à droite sur ordinateur, plein écran sur téléphone) — la conversation reste lisible et défile.
  const [panneau, setPanneau] = useState(false);
  const zone = useRef<HTMLDivElement>(null);
  const manquants = useMemo(
    () => (formulaire && verification ? formulaire.champs.filter((c) => verification.erreurs[c.nom]).map((c) => ({ nom: c.nom, libelle: c.libelle })) : []),
    [formulaire, verification],
  );
  const avertissements = useMemo(() => avertissementsUniques(warnings, [simulation?.resume]), [warnings, simulation?.resume]);
  const etatSimulation = etatSimulationAffiche(simulation?.statut, manquants.length);
  const compacte = !!formulaire && status === "PROPOSED";
  const fermerPanneau = useCallback(() => setPanneau(false), []);
  const focaliser = useCallback((nom: string) => {
    zone.current?.querySelector<HTMLElement>(`[data-champ="${CSS.escape(nom)}"] input, [data-champ="${CSS.escape(nom)}"] select, [data-champ="${CSS.escape(nom)}"] textarea`)?.focus();
  }, []);
  const [aFocaliser, setAFocaliser] = useState<string | null>(null);
  useEffect(() => {
    if (!panneau || !aFocaliser) return;
    const t = setTimeout(() => { focaliser(aFocaliser); setAFocaliser(null); }, 60);
    return () => clearTimeout(t);
  }, [panneau, aFocaliser, focaliser]);
  const ouvrir = (champ?: string) => { setPanneau(true); setAFocaliser(champ ?? manquants[0]?.nom ?? null); };

  const handleConfirm = async () => {
    if (verification && Object.keys(verification.erreurs).length) {
      setTente(true);
      setError("Le formulaire n'est pas complet : corrigez les champs signalés, puis signez.");
      const premier = Object.keys(verification.erreurs)[0];
      if (premier) { if (panneau) focaliser(premier); else ouvrir(premier); }
      return;
    }
    setIsPending(true);
    setError(null);
    try {
      const res = await onConfirm(intentId, aRessaisir ? ressaisie : undefined, verification && corriges.size ? verification.entree : undefined);
      if (res.ok) {
        setStatus("EXECUTED");
        setPanneau(false);
        setMessage(res.message || "Action exécutée avec succès.");
        if (res.link) setLink(res.link);
      } else {
        setError(res.error || "Impossible d'exécuter l'action.");
      }
    } catch {
      setError("La connexion a été interrompue. Réessayez dans un instant.");
    } finally {
      setIsPending(false);
    }
  };

  const handleCancel = () => {
    setStatus("CANCELLED");
    setPanneau(false);
  };

  const boutonSigner = (
    <button
      type="button"
      onClick={handleConfirm}
      disabled={isPending || !arme}
      className="inline-flex h-10 items-center gap-1.5 rounded-xl bg-blue-600 px-4 text-xs font-semibold text-white shadow-md shadow-blue-500/20 hover:bg-blue-700 disabled:opacity-50"
    >
      {isPending ? (
        <>
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Enregistrement...
        </>
      ) : (
        <>
          <Check className="h-3.5 w-3.5" /> {libelleBouton ?? (formulaire ? (corriges.size ? "Signer avec mes corrections" : "Signer") : "Confirmer")}
        </>
      )}
    </button>
  );
  const boutonIgnorer = (
    <button
      type="button"
      onClick={handleCancel}
      disabled={isPending}
      className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-zinc-200/80 bg-white/50 px-3 text-xs font-medium text-zinc-600 hover:bg-zinc-100/60 dark:border-zinc-700 dark:bg-zinc-800/50 dark:text-zinc-300"
    >
      <X className="h-3.5 w-3.5" /> Ignorer
    </button>
  );
  const blocAvertissements = avertissements.length > 0 && (
    <ul className="mt-3 space-y-1.5 rounded-xl border border-amber-200 bg-amber-50/80 p-2.5 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
      {avertissements.map((w, i) => <li key={i} className="flex gap-1.5"><span aria-hidden>•</span><span className="[overflow-wrap:anywhere]">{w}</span></li>)}
    </ul>
  );
  const blocRessaisie = aRessaisir && (
    <label className="mt-3 block text-xs text-zinc-700 dark:text-zinc-300">
      Pour confirmer, ressaisissez <strong>{aRessaisir}</strong>
      <input
        value={ressaisie}
        onChange={(e) => setRessaisie(e.target.value)}
        className="mt-1 h-10 w-full rounded-lg border border-zinc-300 bg-white px-2 text-base sm:text-sm dark:border-zinc-700 dark:bg-zinc-900"
      />
    </label>
  );
  const blocErreur = error && (
    <p role="alert" className="mt-2 rounded-lg bg-destructive/10 p-2 text-xs font-medium text-destructive">
      {error}
    </p>
  );

  if (compacte && formulaire) {
    const apercu = apercuChamps(fields);
    const aVerifier = avertissements.length > 0 || !!aRessaisir || etatSimulation === "SIMULE";
    return (
      <div
        data-glass="true"
        data-testid="carte-action-compacte"
        className="my-3 overflow-hidden rounded-2xl border border-white/60 bg-white/80 p-3.5 shadow-lg backdrop-blur-xl dark:border-white/10 dark:bg-zinc-900/80"
      >
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-amber-500/10 text-amber-600 dark:bg-amber-400/10 dark:text-amber-400">
            <ShieldAlert className="h-4 w-4" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[10.5px] font-bold uppercase tracking-wider text-amber-700 dark:text-amber-400">À signer · Action de l&apos;ERP</p>
            <h4 className="text-sm font-semibold text-zinc-900 [overflow-wrap:anywhere] dark:text-zinc-100">{title}</h4>
            {summary && <p className="mt-0.5 line-clamp-2 text-xs text-zinc-600 dark:text-zinc-400">{summary}</p>}
          </div>
        </div>

        {apercu.visibles.length > 0 && (
          <dl className="mt-2.5 grid grid-cols-2 gap-x-3 gap-y-1.5 rounded-xl bg-zinc-50/70 p-2.5 text-xs dark:bg-zinc-950/40">
            {apercu.visibles.map((f, i) => (
              <div key={i} className="min-w-0">
                <dt className="truncate text-[10px] font-medium uppercase tracking-wider text-zinc-400 dark:text-zinc-500">{f.label}</dt>
                <dd className="truncate font-medium text-zinc-800 dark:text-zinc-200" title={f.value}>{f.value}</dd>
              </div>
            ))}
            {apercu.reste > 0 && <p className="col-span-2 text-[11px] text-zinc-500">+ {apercu.reste} autre{apercu.reste > 1 ? "s" : ""} champ{apercu.reste > 1 ? "s" : ""} dans le formulaire</p>}
          </dl>
        )}

        {manquants.length > 0 && (
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5" data-testid="champs-manquants">
            <span className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400">À compléter :</span>
            {manquants.map((m) => (
              <button key={m.nom} type="button" onClick={() => ouvrir(m.nom)}
                className="inline-flex min-h-[1.75rem] items-center rounded-full border border-amber-300 bg-amber-50 px-2.5 text-[11.5px] font-medium text-amber-900 hover:bg-amber-100 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
                {m.libelle}
              </button>
            ))}
          </div>
        )}

        {(etatSimulation || avertissements.length > 0) && (
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-zinc-600 dark:text-zinc-400">
            {etatSimulation && (
              <span className="inline-flex items-center gap-1"><FlaskConical className="h-3.5 w-3.5" aria-hidden />{LIBELLE_SIMULATION[etatSimulation]}</span>
            )}
            {avertissements.length > 0 && (
              <span className="inline-flex items-center gap-1 text-amber-800 dark:text-amber-300">
                <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
                {avertissements.length === 1 ? "1 point à savoir avant de signer" : `${avertissements.length} points à savoir avant de signer`}
              </span>
            )}
          </div>
        )}

        {!panneau && blocErreur}

        <div className="mt-3 flex items-center justify-between gap-3">
          {boutonIgnorer}
          <button type="button" onClick={() => ouvrir()} aria-haspopup="dialog" aria-expanded={panneau}
            className="inline-flex h-10 items-center gap-1.5 rounded-xl bg-blue-600 px-4 text-xs font-semibold text-white shadow-md shadow-blue-500/20 hover:bg-blue-700">
            <PencilLine className="h-3.5 w-3.5" aria-hidden /> {libelleOuverture(manquants.length, aVerifier)}
          </button>
        </div>

        {panneau && typeof document !== "undefined" && createPortal(
          <PanneauLateral etiquette={`Formulaire : ${title}`} titre={title} pleinEcranMobile largeur="sm:w-[520px]"
            icone={<span className="flex h-9 w-9 items-center justify-center rounded-lg bg-amber-500/10 text-amber-600 dark:text-amber-400"><ShieldAlert className="h-4 w-4" aria-hidden /></span>}
            onFermer={fermerPanneau}
            pied={<div className="flex items-center justify-between gap-3">{boutonIgnorer}{boutonSigner}</div>}>
            <div ref={zone} data-testid="panneau-formulaire-carte">
              {summary && <p className="text-xs text-zinc-600 dark:text-zinc-400">{summary}</p>}
              <FormulaireCarteCapacite formulaire={formulaire} saisies={saisies} erreurs={erreurs} corriges={corriges}
                desactive={isPending} onChange={changer} onChercher={chercher} />
              {simulation && etatSimulation === "EN_ATTENTE_DES_CHAMPS" ? (
                <p className="mt-3 flex items-center gap-1.5 rounded-xl border border-zinc-200 bg-zinc-50/80 p-2.5 text-xs text-zinc-700 dark:border-zinc-800 dark:bg-zinc-950/40 dark:text-zinc-300">
                  <FlaskConical className="h-3.5 w-3.5 shrink-0" aria-hidden /> {LIBELLE_SIMULATION.EN_ATTENTE_DES_CHAMPS} : remplissez les champs obligatoires, la signature rejoue la vérification.
                </p>
              ) : simulation ? <BlocSimulation simulation={simulation} /> : null}
              {blocAvertissements}
              {blocRessaisie}
              {blocErreur}
            </div>
          </PanneauLateral>,
          document.body,
        )}
      </div>
    );
  }

  return (
    <div
      data-glass="true"
      className="my-3 overflow-hidden rounded-2xl border border-white/60 bg-white/80 p-4 shadow-xl backdrop-blur-xl transition-all dark:border-white/10 dark:bg-zinc-900/80"
    >
      {/* En-tête de la carte de confirmation */}
      <div className="flex items-center justify-between gap-2 border-b border-zinc-200/50 pb-2.5 dark:border-zinc-800/50">
        <div className="flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-amber-500/10 text-amber-600 dark:bg-amber-400/10 dark:text-amber-400">
            <ShieldAlert className="h-3.5 w-3.5" />
          </span>
          <span className="text-[11px] font-bold uppercase tracking-wider text-amber-700 dark:text-amber-400">
            Validation Humaine Requise
          </span>
        </div>
        <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
          {kind === "create_task" ? "Tâche" : kind === "send_message" ? "Message interne" : kind === "assistant_ia_capacite" ? "Action de l'ERP" : "À confirmer"}
        </span>
      </div>

      {/* Titre & Résumé */}
      <div className="mt-3">
        <h4 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{title}</h4>
        {summary && <p className="mt-0.5 text-xs text-zinc-600 dark:text-zinc-400">{summary}</p>}
      </div>

      {/* Détails des champs */}
      {fields.length > 0 && (
        <div className="mt-3 grid grid-cols-1 gap-2 rounded-xl bg-zinc-50/70 p-2.5 text-xs dark:bg-zinc-950/40 sm:grid-cols-2">
          {fields.map((f, i) => (
            <div key={i} className="flex flex-col">
              <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
                {f.label}
              </span>
              <span className="font-medium text-zinc-800 dark:text-zinc-200">{f.value}</span>
            </div>
          ))}
        </div>
      )}

      {/* P1 — L'APERÇU RÉEL de chaque mail : le HTML que le gabarit a rendu côté serveur, isolé (aucun script, aucun lien actif). */}
      {apercus.length > 0 && status === "PROPOSED" && (
        <div className="mt-3 flex flex-col gap-2" data-testid="apercus-mail">
          {apercus.map((a, i) => (
            <details key={i} open={i === 0} className="rounded-xl border border-zinc-200 dark:border-zinc-800">
              <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-zinc-600 dark:text-zinc-300">Aperçu — {a.titre}</summary>
              <iframe title={`Aperçu du mail : ${a.titre}`} sandbox="" srcDoc={a.html} data-testid="apercu-mail"
                className="h-[420px] w-full rounded-b-xl border-0 bg-white" />
            </details>
          ))}
        </div>
      )}

      {/* J7 — CE QUE LA SIMULATION A ÉCRIT, à côté des champs proposés : le diff réel, ou « non simulable ». */}
      {simulation && status === "PROPOSED" && <BlocSimulation simulation={simulation} />}

      {/* À SAVOIR AVANT DE CONFIRMER — doublon possible, seuil, pièce, budget. */}
      {status === "PROPOSED" && blocAvertissements}

      {/* CONFIRMATION FORTE : la valeur se ressaisit, le serveur la revérifie. */}
      {status === "PROPOSED" && blocRessaisie}

      {/* Message d'erreur s'il y a lieu */}
      {blocErreur}

      {/* Pied de carte avec actions selon l'état */}
      <div className="mt-4 flex items-center justify-between gap-3 pt-1">
        {status === "PROPOSED" && (
          <>
            {boutonIgnorer}
            {boutonSigner}
          </>
        )}

        {status === "EXECUTED" && (
          <div className="flex w-full items-center justify-between">
            <div className="flex items-center gap-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="h-4 w-4" />
              <span>{message || "Action enregistrée en base."}</span>
            </div>
            {link && (
              <a
                href={link}
                className="inline-flex items-center gap-1 rounded-lg bg-emerald-500/10 px-2.5 py-1 text-xs font-semibold text-emerald-700 hover:bg-emerald-500/20 dark:text-emerald-300"
              >
                Consulter <ArrowUpRight className="h-3 w-3" />
              </a>
            )}
          </div>
        )}

        {status === "CANCELLED" && (
          <span className="text-xs font-medium text-zinc-400 dark:text-zinc-500">
            Action ignorée — aucun changement enregistré.
          </span>
        )}
      </div>
    </div>
  );
}

const LIBELLE_SIMULATION = {
  SIMULE: "Simulé — rien n'a été écrit",
  ECHEC: "Simulation sans résultat",
  NON_SIMULABLE: "Non simulable",
  EN_ATTENTE_DES_CHAMPS: "Simulation en attente des champs obligatoires",
} as const;

/**
 * LE DIFF DE LA SIMULATION (J7, décision 0029) — l'action a été jouée dans une transaction annulée : voici ce qu'elle
 * a écrit, champ par champ, et ce qui serait sorti (courriel, notification) — rien n'est parti. Une capacité non
 * prouvée simulable le dit ; une simulation qui n'a pas abouti aussi.
 */
function BlocSimulation({ simulation }: { simulation: VueSimulation }) {
  const ton = simulation.statut === "SIMULE"
    ? "border-sky-200 bg-sky-50/80 text-sky-950 dark:border-sky-900/50 dark:bg-sky-950/30 dark:text-sky-100"
    : "border-zinc-200 bg-zinc-50/80 text-zinc-700 dark:border-zinc-800 dark:bg-zinc-950/40 dark:text-zinc-300";
  return (
    <section aria-label="Simulation" className={`mt-3 rounded-xl border p-2.5 text-xs ${ton}`}>
      <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider opacity-80">
        <FlaskConical className="h-3 w-3" aria-hidden />
        {LIBELLE_SIMULATION[simulation.statut]}
      </p>
      <p className="mt-1 [overflow-wrap:anywhere]">{simulation.resume}</p>
      {simulation.lignes.some((l) => l.champs.length > 0) && (
        <ul className="mt-2 space-y-1.5">
          {simulation.lignes.filter((l) => l.champs.length > 0).map((l, i) => (
            <li key={i}>
              <span className="font-medium">{l.phrase}</span>
              <ul className="mt-0.5 space-y-0.5 pl-3">
                {l.champs.map((c) => (
                  <li key={c.champ} className="[overflow-wrap:anywhere]">
                    <span className="opacity-70">{c.champ}</span>{" "}
                    {l.operation === "UPDATE" ? <><s className="opacity-60">{c.avant}</s> → <strong>{c.apres}</strong></> : <strong>{c.apres}</strong>}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
