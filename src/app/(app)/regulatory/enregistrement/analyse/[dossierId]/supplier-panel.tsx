"use client";

import * as React from "react";

import { Loader2, Plus, RefreshCw, Send, CheckCircle2, Bell, Trash2, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Retour } from "@/components/ui/retour";
import { useKeyedAction } from "@/components/shared/use-action";
import { createSupplierRequest, regenerateSupplierDraft, setSupplierStatus, remindSupplier, deleteSupplierRequest } from "@/lib/regulatory/intelligence/supplier/actions";

interface Question { id: string; ordinal: number; question: string; answer: string | null; answered: boolean }
interface Req { id: string; subject: string; supplierName: string | null; supplierEmail: string | null; emailDraft: string | null; status: string; deadline: string | null; sentAt: string | null; remindedAt: string | null; respondedAt: string | null; questions: Question[] }

const STATUS: Record<string, string> = { DRAFT: "bg-muted text-muted-foreground", SENT: "bg-blue-500/10 text-blue-600", RESPONDED: "bg-success/10 text-success", CLOSED: "bg-muted text-muted-foreground" };

/**
 * Boucle fournisseur (G8) — demande de compléments : questions, BROUILLON d'e-mail (jamais
 * envoyé automatiquement), échéance, statut, relance, réponse. L'IA ne crée qu'un brouillon.
 */
export function SupplierPanel({ dossierId, requests, canManage }: { dossierId: string; requests: Req[]; canManage: boolean }) {
  const { busy, error, run } = useKeyedAction();
  const [creating, setCreating] = React.useState(false);
  const [openDraft, setOpenDraft] = React.useState<string | null>(null);

  async function create(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget); fd.set("dossierId", dossierId);
    if (await run("create", () => createSupplierRequest(fd))) setCreating(false);
  }

  return (
    <div className="space-y-3">
      {canManage && (
        <Button type="button" size="sm" variant="outline" onClick={() => setCreating((v) => !v)}><Plus className="h-4 w-4" /> Nouvelle demande fournisseur</Button>
      )}
      <Retour ton="erreur">{error}</Retour>

      {creating && (
        <form onSubmit={create} className="space-y-2 rounded-xl border border-border bg-card p-4">
          <Input name="subject" placeholder="Objet de la demande *" required />
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Input name="supplierName" placeholder="Nom du fournisseur" />
            <Input name="supplierEmail" type="email" placeholder="E-mail du fournisseur" />
          </div>
          <label className="block text-xs text-muted-foreground">Échéance <Input name="deadline" type="date" /></label>
          <Textarea name="questions" rows={4} placeholder="Une question / complément par ligne…" />
          <p className="text-xs text-muted-foreground">Un brouillon d'e-mail est généré automatiquement (IA si configurée, sinon modèle) — <strong>il n'est jamais envoyé automatiquement</strong>.</p>
          <div className="flex justify-end gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => setCreating(false)}>Annuler</Button>
            <Button type="submit" size="sm" disabled={busy === "create"}>{busy === "create" ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Créer + brouillon</Button>
          </div>
        </form>
      )}

      {requests.map((r) => (
        <div key={r.id} className="rounded-xl border border-border p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{r.subject}</span>
            <span className={`rounded px-1.5 py-0.5 text-xs ${STATUS[r.status] ?? ""}`}>{r.status}</span>
            {r.supplierName && <span className="text-xs text-muted-foreground">{r.supplierName}</span>}
            {r.deadline && <span className="text-xs text-muted-foreground">échéance {new Date(r.deadline).toLocaleDateString("fr-FR")}</span>}
          </div>
          {r.questions.length > 0 && (
            <ol className="mt-1.5 ml-4 list-decimal text-xs text-muted-foreground">{r.questions.map((q) => <li key={q.id}>{q.question}</li>)}</ol>
          )}
          {r.emailDraft && (
            <div className="mt-2">
              <button type="button" onClick={() => setOpenDraft(openDraft === r.id ? null : r.id)} className="inline-flex items-center gap-1 text-xs text-primary hover:underline"><Mail className="h-3.5 w-3.5" /> {openDraft === r.id ? "Masquer" : "Voir"} le brouillon d'e-mail</button>
              {openDraft === r.id && <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-muted/40 p-2 text-xs">{r.emailDraft}</pre>}
            </div>
          )}
          {canManage && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
              <button type="button" disabled={busy !== null} onClick={() => run(`re-${r.id}`, () => { const fd = new FormData(); fd.set("requestId", r.id); return regenerateSupplierDraft(fd); })} className="inline-flex items-center gap-1 rounded border border-border px-2.5 py-1.5 sm:px-1.5 sm:py-0.5 hover:bg-accent"><RefreshCw className="h-3 w-3" /> Régénérer brouillon</button>
              {r.status === "DRAFT" && <button type="button" disabled={busy !== null} onClick={() => run(`sent-${r.id}`, () => { const fd = new FormData(); fd.set("requestId", r.id); fd.set("status", "SENT"); return setSupplierStatus(fd); })} className="inline-flex items-center gap-1 rounded border border-blue-500/40 px-2.5 py-1.5 sm:px-1.5 sm:py-0.5 text-blue-600"><Send className="h-3 w-3" /> Marquer envoyé</button>}
              {(r.status === "SENT") && <button type="button" disabled={busy !== null} onClick={() => run(`rem-${r.id}`, () => { const fd = new FormData(); fd.set("requestId", r.id); return remindSupplier(fd); })} className="inline-flex items-center gap-1 rounded border border-border px-2.5 py-1.5 sm:px-1.5 sm:py-0.5"><Bell className="h-3 w-3" /> Relancer</button>}
              {(r.status === "SENT" || r.status === "DRAFT") && <button type="button" disabled={busy !== null} onClick={() => run(`resp-${r.id}`, () => { const fd = new FormData(); fd.set("requestId", r.id); fd.set("status", "RESPONDED"); return setSupplierStatus(fd); })} className="inline-flex items-center gap-1 rounded border border-success/40 px-2.5 py-1.5 sm:px-1.5 sm:py-0.5 text-success"><CheckCircle2 className="h-3 w-3" /> Réponse reçue</button>}
              {r.status !== "CLOSED" && <button type="button" disabled={busy !== null} onClick={() => run(`clo-${r.id}`, () => { const fd = new FormData(); fd.set("requestId", r.id); fd.set("status", "CLOSED"); return setSupplierStatus(fd); })} className="rounded border border-border px-2.5 py-1.5 sm:px-1.5 sm:py-0.5 text-muted-foreground">Clôturer</button>}
              <button type="button" disabled={busy !== null} onClick={() => run(`del-${r.id}`, () => { const fd = new FormData(); fd.set("requestId", r.id); return deleteSupplierRequest(fd); })} className="ml-auto inline-flex items-center gap-1 text-destructive hover:underline"><Trash2 className="h-3 w-3" /> Supprimer</button>
            </div>
          )}
          {r.remindedAt && <p className="mt-1 text-[0.6875rem] text-muted-foreground">Relancé le {new Date(r.remindedAt).toLocaleDateString("fr-FR")}.</p>}
        </div>
      ))}
      {requests.length === 0 && !creating && <p className="text-sm text-muted-foreground">Aucune demande fournisseur. Créez-en une pour générer un brouillon d'e-mail de compléments.</p>}
    </div>
  );
}
