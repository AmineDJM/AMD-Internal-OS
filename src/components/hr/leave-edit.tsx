"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Pencil, Loader2 } from "lucide-react";
import { updateLeaveRequest } from "@/modules/rh/actions";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Input, Select, Textarea, Label } from "@/components/ui/input";
import { LEAVE_TYPE, LEAVE_STATUS } from "@/lib/labels";

export interface EditableLeave {
  id: string;
  employee: string;
  type: string;
  startDate: string;
  endDate: string;
  days: number;
  reason: string | null;
  status: string;
  decisionNote: string | null;
}

/**
 * Bouton RH « modifier une demande de congé » — ouvre une feuille d'édition permettant de
 * corriger TOUTE demande, y compris déjà décidée (historique) : type, dates, jours, motif,
 * statut (décision) et note. Le solde annuel est réajusté par l'action serveur.
 */
export function LeaveEditButton({ leave }: { leave: EditableLeave }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const lock = React.useRef(false);

  return (
    <>
      <button
        type="button"
        onClick={() => { lock.current = false; setOpen(true); }}
        title="Modifier (RH)"
        aria-label="Modifier (RH)"
        className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-secondary hover:text-foreground sm:h-7 sm:w-7"
      >
        <Pencil className="h-4 w-4" />
      </button>
      {open && (
        <Sheet open onClose={() => setOpen(false)} title="Modifier la demande de congé" description={`${leave.employee} — les RH peuvent corriger toute demande, même déjà décidée.`} width="md">
          <form
            action={(fd) => {
              if (lock.current) return;
              lock.current = true;
              fd.set("id", leave.id);
              setBusy(true); setErr(null);
              updateLeaveRequest(fd).then((r) => {
                setBusy(false);
                if (r.ok) { setOpen(false); router.refresh(); }
                else { setErr(r.error ?? "Échec de la modification."); lock.current = false; }
              });
            }}
            className="grid grid-cols-1 gap-3 sm:grid-cols-2"
          >
            <div className="space-y-1.5">
              <Label>Type</Label>
              <Select name="type" defaultValue={leave.type}>
                {Object.entries(LEAVE_TYPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Statut (décision)</Label>
              <Select name="status" defaultValue={leave.status}>
                {Object.entries(LEAVE_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </Select>
            </div>
            <div className="space-y-1.5"><Label>Début</Label><Input name="startDate" type="date" defaultValue={leave.startDate.slice(0, 10)} /></div>
            <div className="space-y-1.5"><Label>Fin</Label><Input name="endDate" type="date" defaultValue={leave.endDate.slice(0, 10)} /></div>
            <div className="space-y-1.5"><Label>Jours</Label><Input name="days" type="number" inputMode="decimal" step="0.5" min="0" defaultValue={leave.days} /></div>
            <div className="space-y-1.5 sm:col-span-2"><Label>Motif</Label><Textarea name="reason" defaultValue={leave.reason ?? ""} rows={2} /></div>
            <div className="space-y-1.5 sm:col-span-2"><Label>Note de décision</Label><Textarea name="decisionNote" defaultValue={leave.decisionNote ?? ""} rows={2} /></div>
            {err && <p className="text-sm text-destructive sm:col-span-2">{err}</p>}
            <div className="rounded-lg bg-secondary/40 px-3 py-2 text-xs text-muted-foreground sm:col-span-2">
              Le solde de congé annuel est réajusté automatiquement selon le statut et le nombre de jours.
            </div>
            <div className="flex flex-col-reverse gap-2 sm:col-span-2 sm:flex-row sm:justify-end">
              <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={() => setOpen(false)}>Annuler</Button>
              <Button type="submit" className="w-full sm:w-auto" disabled={busy}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Enregistrer</Button>
            </div>
          </form>
        </Sheet>
      )}
    </>
  );
}
