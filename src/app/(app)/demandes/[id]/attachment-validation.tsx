"use client";

import * as React from "react";
import { useAction } from "@/components/shared/use-action";
import { Retour } from "@/components/ui/retour";
import { Loader2, ShieldCheck, CheckCircle2, XCircle, Clock, Send, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { submitAttachmentValidation, cancelAttachmentValidation } from "@/lib/actions/admin-request-actions";
import { FINANCE_CATEGORY } from "@/lib/labels";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";

/**
 * VALIDATION PAR PIÈCE JOINTE — chaque pièce d'une demande peut partir en validation à n'importe
 * quel moment, vers une ou plusieurs personnes (soi-même compris), indépendamment des autres
 * pièces. La décision se prend au bureau central (/validations) ; ICI on voit l'état de chaque
 * pièce, on soumet — avec un MESSAGE d'accompagnement et, si la pièce est payable, un MONTANT et
 * une CATÉGORIE : à l'approbation, l'ordre de dépense part automatiquement aux Finances. Une
 * validation en attente peut être RETIRÉE (mauvaise pièce, mauvais validateurs). Être validateur
 * d'une pièce ouvre l'accès à toute la demande (le contexte fait partie du jugement).
 */

interface StepView { validator: string; status: string }
interface ValidationView { id: string; reference: string; documentId: string; status: string; createdAt: string; steps: StepView[] }

const STATUS_BADGES: Record<string, { label: string; cls: string }> = {
  PENDING: { label: "En attente", cls: "bg-amber-500/10 text-amber-600" },
  APPROVED: { label: "Validée", cls: "bg-success/10 text-success" },
  REJECTED: { label: "Refusée", cls: "bg-destructive/10 text-destructive" },
  CHANGES_REQUESTED: { label: "À modifier", cls: "bg-sky-500/10 text-sky-600" },
  CANCELLED: { label: "Retirée", cls: "bg-muted text-muted-foreground" },
};

// Catégories PAYABLES d'une pièce (facture, devis, note…) — le reste de l'enum (recettes,
// emprunts, paie) n'a pas sa place sur une pièce jointe du secrétariat.
const PAYABLE_CATEGORIES = ["FOURNISSEUR", "BUREAUTIQUE", "EVENEMENT", "VOYAGE", "LOYER", "CHARGES", "IMPOT", "BANQUE", "AUTRE"] as const;

export function AttachmentValidationBlock({ requestId, documents, validations, users, canSubmit }: {
  requestId: string;
  documents: { id: string; name: string }[];
  validations: ValidationView[];
  users: { id: string; name: string }[];
  canSubmit: boolean;
}) {
  const [openFor, setOpenFor] = React.useState<string | null>(null);
  const [chosen, setChosen] = React.useState<string[]>([]);
  const [note, setNote] = React.useState("");
  const [amount, setAmount] = React.useState("");
  const [category, setCategory] = React.useState("");
  const { busy, err: error, run } = useAction();

  if (documents.length === 0) return null;
  const byDoc = new Map<string, ValidationView[]>();
  for (const v of validations) byDoc.set(v.documentId, [...(byDoc.get(v.documentId) ?? []), v]);
  if (!canSubmit && validations.length === 0) return null;

  const toggle = (id: string) => setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));
  const resetForm = () => { setChosen([]); setNote(""); setAmount(""); setCategory(""); };

  const submit = async (documentId: string) => {
    if (busy || chosen.length === 0) return;
    const fd = new FormData();
    fd.set("requestId", requestId);
    fd.set("documentId", documentId);
    for (const id of chosen) fd.append("validatorIds", id);
    if (note.trim()) fd.set("note", note.trim());
    if (amount.trim()) fd.set("amount", amount.trim());
    if (category) fd.set("category", category);
    await run(() => submitAttachmentValidation(fd), () => { setOpenFor(null); resetForm(); });
  };

  const withdraw = async (v: ValidationView) => {
    if (busy) return;
    const fd = new FormData();
    fd.set("validationId", v.id);
    await run(() => cancelAttachmentValidation(fd));
  };

  return (
    <div className="space-y-2 rounded-xl border border-border/60 p-3">
      <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <ShieldCheck className="h-3.5 w-3.5" /> Validation des pièces jointes — chaque pièce se soumet à part, à une ou plusieurs personnes
      </p>
      <Retour ton="erreur">{error}</Retour>

      <ul className="space-y-1.5">
        {documents.map((d) => {
          const vals = byDoc.get(d.id) ?? [];
          const current = vals.find((v) => v.status === "PENDING") ?? vals[0];
          const isOpen = openFor === d.id;
          return (
            <li key={d.id} className="rounded-lg border border-border/50 p-2">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="min-w-0 flex-1 truncate font-medium">{d.name}</span>
                {current ? (
                  <span className={`rounded px-1.5 py-0.5 font-medium ${STATUS_BADGES[current.status]?.cls ?? "bg-muted text-muted-foreground"}`}>
                    {STATUS_BADGES[current.status]?.label ?? current.status}
                  </span>
                ) : (
                  <span className="text-muted-foreground">jamais soumise</span>
                )}
                {canSubmit && current?.status === "PENDING" && (
                  <BoutonDecisif type="button" size="sm" variant="ghost" className="text-muted-foreground hover:text-destructive" disabled={busy} onClick={() => withdraw(current)}>
                    <Undo2 className="h-3.5 w-3.5" /> Retirer
                  </BoutonDecisif>
                )}
                {canSubmit && !vals.some((v) => v.status === "PENDING") && (
                  <Button type="button" size="sm" variant="outline" onClick={() => { setOpenFor(isOpen ? null : d.id); resetForm(); }}>
                    <Send className="h-3.5 w-3.5" /> Soumettre à validation
                  </Button>
                )}
              </div>

              {current && current.steps.length > 0 && current.status !== "CANCELLED" && (
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {current.steps.map((s, i) => (
                    <span key={i} className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[0.6875rem] text-muted-foreground">
                      {s.status === "APPROVED" ? <CheckCircle2 className="h-3 w-3 text-success" /> : s.status === "REJECTED" ? <XCircle className="h-3 w-3 text-destructive" /> : <Clock className="h-3 w-3" />}
                      {s.validator}
                    </span>
                  ))}
                  <span className="text-[0.6875rem] text-muted-foreground">({current.reference})</span>
                </div>
              )}

              {isOpen && (
                <div className="mt-2 space-y-2 rounded-lg bg-muted/40 p-2">
                  <p className="text-[0.6875rem] text-muted-foreground">Validateur·s — tous saisis EN MÊME TEMPS (vous pouvez vous choisir vous-même), chacun décide au bureau des validations :</p>
                  <div className="flex max-h-36 flex-wrap gap-1.5 overflow-y-auto">
                    {users.map((u) => (
                      <button key={u.id} type="button" onClick={() => toggle(u.id)}
                        className={`rounded-full border px-2 py-0.5 text-xs ${chosen.includes(u.id) ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:border-primary/40"}`}>
                        {u.name}
                      </button>
                    ))}
                  </div>
                  <textarea
                    value={note} onChange={(e) => setNote(e.target.value)} rows={2}
                    placeholder="Message aux validateurs (contexte, ce qu'il faut vérifier…) — visible au bureau des validations"
                    className="w-full resize-y rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs outline-none focus:border-primary/60"
                  />
                  <div className="flex flex-wrap items-center gap-1.5">
                    <input
                      value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal"
                      placeholder="Montant (DZD) — facultatif"
                      className="w-40 rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs outline-none focus:border-primary/60"
                    />
                    <select
                      value={category} onChange={(e) => setCategory(e.target.value)}
                      aria-label="Catégorie de la dépense"
                      className="rounded-lg border border-border bg-background px-2 py-1.5 text-xs outline-none focus:border-primary/60"
                    >
                      <option value="">Catégorie (si payable)…</option>
                      {PAYABLE_CATEGORIES.map((c) => <option key={c} value={c}>{FINANCE_CATEGORY[c] ?? c}</option>)}
                    </select>
                  </div>
                  <p className="text-[0.6875rem] text-muted-foreground">
                    Avec un montant : dès que la pièce est validée, un <strong>ordre de dépense</strong> part automatiquement aux Finances pour paiement, dans la catégorie choisie (budget).
                  </p>
                  <Button type="button" size="sm" onClick={() => submit(d.id)} disabled={busy || chosen.length === 0}>
                    {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />} Envoyer ({chosen.length})
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
