"use client";

import React, { useCallback, useMemo, useState } from "react";
import { Check, X, ShieldAlert, CheckCircle2, ArrowUpRight, Loader2 } from "lucide-react";
import { champsCorriges, saisiesInitiales, verifierFormulaire, type FormulaireCarte, type Saisie, type Saisies } from "@/platform/ia/capacites/formulaire";
import { texteARessaisir } from "../domaine/capacites";
import { chercherReferenceCarteAssistantIA } from "../actions";
import { FormulaireCarteCapacite } from "./formulaire-carte";

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
  initialStatus?: "PROPOSED" | "CONFIRMED" | "EXECUTING" | "EXECUTED" | "CANCELLED";
  resultLink?: string;
  resultMessage?: string;
  /** J11 (décision 0030) : le formulaire généré depuis le contrat — la personne corrige, puis signe. */
  formulaire?: FormulaireCarte;
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
  initialStatus = "PROPOSED",
  resultLink,
  resultMessage,
  formulaire,
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

  const handleConfirm = async () => {
    if (verification && Object.keys(verification.erreurs).length) {
      setTente(true);
      setError("Le formulaire n'est pas complet : corrigez les champs signalés, puis signez.");
      const premier = Object.keys(verification.erreurs)[0];
      document.querySelector<HTMLElement>(`[data-champ="${premier}"] input, [data-champ="${premier}"] select, [data-champ="${premier}"] textarea`)?.focus();
      return;
    }
    setIsPending(true);
    setError(null);
    try {
      const res = await onConfirm(intentId, aRessaisir ? ressaisie : undefined, verification && corriges.size ? verification.entree : undefined);
      if (res.ok) {
        setStatus("EXECUTED");
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
  };

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

      {/* LE FORMULAIRE généré depuis le contrat (J11) — tant que la carte est à signer. */}
      {formulaire && status === "PROPOSED" && (
        <FormulaireCarteCapacite formulaire={formulaire} saisies={saisies} erreurs={erreurs} corriges={corriges}
          desactive={isPending} onChange={changer} onChercher={chercher} />
      )}

      {/* Détails des champs */}
      {fields.length > 0 && !(formulaire && status === "PROPOSED") && (
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

      {/* À SAVOIR AVANT DE CONFIRMER — doublon possible, seuil, pièce, budget. */}
      {warnings.length > 0 && status === "PROPOSED" && (
        <ul className="mt-3 space-y-1.5 rounded-xl border border-amber-200 bg-amber-50/80 p-2.5 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
          {warnings.map((w, i) => <li key={i} className="flex gap-1.5"><span aria-hidden>•</span><span className="[overflow-wrap:anywhere]">{w}</span></li>)}
        </ul>
      )}

      {/* CONFIRMATION FORTE : la valeur se ressaisit, le serveur la revérifie. */}
      {aRessaisir && status === "PROPOSED" && (
        <label className="mt-3 block text-xs text-zinc-700 dark:text-zinc-300">
          Pour confirmer, ressaisissez <strong>{aRessaisir}</strong>
          <input
            value={ressaisie}
            onChange={(e) => setRessaisie(e.target.value)}
            className="mt-1 h-10 w-full rounded-lg border border-zinc-300 bg-white px-2 text-base sm:text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
        </label>
      )}

      {/* Message d'erreur s'il y a lieu */}
      {error && (
        <p role="alert" className="mt-2 rounded-lg bg-destructive/10 p-2 text-xs font-medium text-destructive">
          {error}
        </p>
      )}

      {/* Pied de carte avec actions selon l'état */}
      <div className="mt-4 flex items-center justify-between gap-3 pt-1">
        {status === "PROPOSED" && (
          <>
            <button
              type="button"
              onClick={handleCancel}
              disabled={isPending}
              className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-zinc-200/80 bg-white/50 px-3 text-xs font-medium text-zinc-600 hover:bg-zinc-100/60 dark:border-zinc-700 dark:bg-zinc-800/50 dark:text-zinc-300"
            >
              <X className="h-3.5 w-3.5" /> Ignorer
            </button>
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
