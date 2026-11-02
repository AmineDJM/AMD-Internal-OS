"use client";

import * as React from "react";
import { Loader2, Send, Check, X, CalendarCheck, Plus, Trash2, Undo2, CalendarPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea, Label } from "@/components/ui/input";
import {
  requestConsultingValidation, decideConsultingContract, closeConsultingContract, prolongerConsultingContract,
  addConsultingTask, toggleConsultingTask, deleteConsultingTask,
} from "@/lib/actions/consulting-actions";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";
import { Retour } from "@/components/ui/retour";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";

export interface ContractTask { id: string; label: string; dueDate: string | null; doneAt: string | null }

/**
 * LES GESTES D'UN CONTRAT — et uniquement ceux qui ont un sens ici.
 *
 * Chaque bouton correspond à une transition réelle du cycle de vie (`lib/ad-pro/consulting.ts`).
 * On n'affiche pas un bouton que le serveur refusera : proposer « Valider » sur un brouillon,
 * c'est promettre une action qui échouera, et faire douter de tout le reste de l'écran.
 */
export function ConsultingActions({
  id, status, canSubmit, canDecide, canProlong = false, endDate = null, resubmission = false, validateurActuel = null,
  canClose, canEditTasks, validators, tasks, transfer = null,
}: {
  id: string;
  status: string;
  canSubmit: boolean;
  canDecide: boolean;
  /** Prolonger un contrat en cours — le droit de la validation (`prolongerConsultingContract`). */
  canProlong?: boolean;
  /** La fin actuelle (AAAA-MM-JJ) : la nouvelle doit la suivre. */
  endDate?: string | null;
  /** Le contrat revient d'un renvoi pour correction : il se RE-soumet. */
  resubmission?: boolean;
  /**
   * Le validateur DÉJÀ désigné : présélectionné, parce qu'une correction revient à la personne qui l'a
   * demandée. Repartir sur « — Direction — » la faisait juger par quelqu'un d'autre, sans que personne
   * l'ait choisi.
   */
  validateurActuel?: string | null;
  canClose: boolean;
  canEditTasks: boolean;
  validators: { id: string; name: string }[];
  tasks: ContractTask[];
  /** Le transfert de pôle (§118.150) — rendu par la page, qui seule sait si la personne y a droit. */
  transfer?: React.ReactNode;
}) {
  const { rafraichir } = useRafraichir();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [annonce, setAnnonce] = React.useState<string | null>(null);
  const [validatorId, setValidatorId] = React.useState(validateurActuel ?? "");
  const [note, setNote] = React.useState("");
  const [taskLabel, setTaskLabel] = React.useState("");
  const [taskDue, setTaskDue] = React.useState("");
  const [nouvelleFin, setNouvelleFin] = React.useState("");
  const [motifProlongation, setMotifProlongation] = React.useState("");
  const [motifAnnulation, setMotifAnnulation] = React.useState("");

  const run = async (key: string, fn: (fd: FormData) => Promise<{ ok: boolean; error?: string; message?: string }>, fields: Record<string, string>) => {
    setBusy(key); setErr(null); setAnnonce(null);
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    let r: Awaited<ReturnType<typeof fn>>;
    try {
      r = await fn(fd);
    } catch {
      setErr(actionFailureMessage("THROWN"));
      return;
    } finally {
      setBusy(null);
    }
    if (!r.ok) { setErr(r.error ?? "L'opération a échoué."); return; }
    setNote(""); setTaskLabel(""); setTaskDue(""); setNouvelleFin(""); setMotifProlongation(""); setMotifAnnulation("");
    // Ce que le geste a fait AILLEURS (la porte du centre, la date prolongée) se DIT : l'écran ne jette
    // pas la phrase de l'action (§118.168).
    if (r.message) setAnnonce(r.message);
    rafraichir();
  };

  return (
    <div className="space-y-4">
      {canSubmit && (
        <div className="surface space-y-2 p-4">
          <h3 className="text-sm font-semibold">{resubmission ? "Renvoyer pour validation" : "Soumettre à validation"}</h3>
          <p className="text-xs text-muted-foreground">
            Désignez la personne qui doit trancher. Sans désignation, la Direction est prévenue.
          </p>
          <Select value={validatorId} onChange={(e) => setValidatorId(e.target.value)}>
            <option value="">— Direction —</option>
            {validators.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </Select>
          <Button
            className="w-full" disabled={busy !== null}
            onClick={() => run("submit", requestConsultingValidation, { id, validatorId })}
          >
            {busy === "submit" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Envoyer pour validation
          </Button>
        </div>
      )}

      {canDecide && (
        <div className="surface space-y-2 p-4">
          <h3 className="text-sm font-semibold">Décision</h3>
          {/* TROIS ISSUES (audit 360°, R11) : le motif est EXIGÉ pour renvoyer et pour refuser — l'action
              le revérifie, l'écran évite seulement l'aller-retour. */}
          <Textarea
            value={note} onChange={(e) => setNote(e.target.value)} rows={2} aria-label="Motif de la décision"
            placeholder="Motif — obligatoire pour renvoyer ou refuser"
          />
          {/* Trois colonnes seulement quand le panneau a la largeur de l'écran (tablette) ; dans la
              colonne latérale du bureau, « Renvoyer pour correction » n'y tient pas. */}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 lg:grid-cols-1">
            <BoutonDecisif
              disabled={busy !== null}
              onClick={() => run("approve", decideConsultingContract, { id, decision: "VALIDER", note })}
            >
              {busy === "approve" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Valider
            </BoutonDecisif>
            <BoutonDecisif
              variant="outline" disabled={busy !== null || !note.trim()}
              onClick={() => run("return", decideConsultingContract, { id, decision: "RENVOYER", note })}
            >
              {busy === "return" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Undo2 className="h-4 w-4" />} Renvoyer pour correction
            </BoutonDecisif>
            <BoutonDecisif
              variant="outline" className="text-destructive" disabled={busy !== null || !note.trim()}
              onClick={() => run("refuse", decideConsultingContract, { id, decision: "REFUSER", note })}
            >
              {busy === "refuse" ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />} Refuser
            </BoutonDecisif>
          </div>
        </div>
      )}

      {canProlong && (
        <div className="surface space-y-2 p-4">
          <h3 className="text-sm font-semibold">Prolonger le contrat</h3>
          <p className="text-xs text-muted-foreground">
            Une nouvelle date de fin, et ce qui la fonde (l&apos;avenant, l&apos;accord du consultant) — c&apos;est ce qu&apos;on cherchera plus tard.
          </p>
          <Input type="date" value={nouvelleFin} min={endDate ?? undefined} onChange={(e) => setNouvelleFin(e.target.value)} aria-label="Nouvelle date de fin" />
          <Input value={motifProlongation} onChange={(e) => setMotifProlongation(e.target.value)} aria-label="Ce qui fonde la prolongation" placeholder="Avenant n°…, accord du… (obligatoire)" />
          <BoutonDecisif
            variant="outline" className="w-full" disabled={busy !== null || !nouvelleFin || !motifProlongation.trim()}
            onClick={() => run("prolong", prolongerConsultingContract, { id, endDate: nouvelleFin, note: motifProlongation })}
          >
            {busy === "prolong" ? <Loader2 className="h-4 w-4 animate-spin" /> : <CalendarPlus className="h-4 w-4" />} Prolonger
          </BoutonDecisif>
        </div>
      )}

      {canClose && (
        <div className="surface space-y-2 p-4">
          <h3 className="text-sm font-semibold">Clore le contrat</h3>
          <p className="text-xs text-muted-foreground">
            {/* Deux fins, et elles ne se confondent pas : l'une a produit ses effets, l'autre non. */}
            « Arrivé à terme » clôt une relation qui est allée jusqu'au bout ; « Annuler » la rompt.
          </p>
          <Input
            value={motifAnnulation} onChange={(e) => setMotifAnnulation(e.target.value)} aria-label="Motif de l'annulation"
            placeholder="Motif — obligatoire pour annuler"
          />
          <div className="flex flex-wrap gap-2">
            {status === "ACTIVE" && (
              <BoutonDecisif
                variant="outline" className="flex-1" disabled={busy !== null}
                onClick={() => run("expire", closeConsultingContract, { id, cancel: "0", note: motifAnnulation })}
              >
                {busy === "expire" ? <Loader2 className="h-4 w-4 animate-spin" /> : <CalendarCheck className="h-4 w-4" />} Arrivé à terme
              </BoutonDecisif>
            )}
            <BoutonDecisif
              variant="outline" className="flex-1 text-destructive" disabled={busy !== null || !motifAnnulation.trim()}
              onClick={() => run("cancel", closeConsultingContract, { id, cancel: "1", note: motifAnnulation })}
            >
              {busy === "cancel" ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />} Annuler
            </BoutonDecisif>
          </div>
        </div>
      )}

      <div className="surface space-y-3 p-4">
        <h3 className="text-sm font-semibold">Tâches attendues</h3>
        {tasks.length === 0 ? (
          <p className="text-xs text-muted-foreground">Aucune tâche listée pour l&apos;instant.</p>
        ) : (
          <ul className="space-y-1">
            {tasks.map((t) => (
              <li key={t.id} className="flex items-start gap-2 rounded-lg px-1.5 py-1.5 text-sm hover:bg-secondary/50 sm:py-1">
                <input
                  type="checkbox" checked={Boolean(t.doneAt)} disabled={!canEditTasks || busy !== null}
                  onChange={() => run(`task-${t.id}`, toggleConsultingTask, { taskId: t.id })}
                  className="mt-0.5 h-4 w-4 shrink-0 rounded border-input"
                />
                <span className={`min-w-0 flex-1 break-words ${t.doneAt ? "text-muted-foreground line-through" : ""}`}>
                  {t.label}
                  {t.dueDate && <span className="ml-1.5 text-xs text-muted-foreground">· {t.dueDate}</span>}
                </span>
                {canEditTasks && (
                  <button
                    type="button" aria-label="Supprimer la tâche" disabled={busy !== null}
                    onClick={() => run(`del-${t.id}`, deleteConsultingTask, { taskId: t.id })}
                    className="-my-1.5 shrink-0 rounded p-2.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive sm:my-0 sm:p-1"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}

        {canEditTasks && (
          <div className="space-y-2 border-t border-border pt-3">
            <Label htmlFor="task-label">Ajouter une tâche</Label>
            <Input id="task-label" value={taskLabel} onChange={(e) => setTaskLabel(e.target.value)} placeholder="Ex. Rapport d'audit intermédiaire" />
            <Input type="date" value={taskDue} onChange={(e) => setTaskDue(e.target.value)} />
            <Button
              variant="outline" className="w-full" disabled={busy !== null || !taskLabel.trim()}
              onClick={() => run("add-task", addConsultingTask, { contractId: id, label: taskLabel, dueDate: taskDue })}
            >
              {busy === "add-task" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Ajouter
            </Button>
          </div>
        )}
      </div>

      {transfer}

      {annonce && <p role="status" className="break-words rounded-lg bg-success/10 px-3 py-2 text-sm">{annonce}</p>}
      <Retour ton="erreur">{err}</Retour>
    </div>
  );
}
