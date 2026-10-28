"use client";

import * as React from "react";
import { Plus, Loader2, AlertCircle, CalendarClock, CalendarRange, Stethoscope } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Select, Textarea, Label, Input } from "@/components/ui/input";
import { HR_REQUEST_TYPE } from "@/lib/labels";
import { useSaisir } from "@/components/ui/dialogue";
import { useAction } from "@/components/shared/use-action";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";
import { requestHrDocument, annulerDemandeRh } from "@/modules/rh/actions-documents";
import { ExpenseClaimFields } from "@/components/hr/expense-claim-form";

/** Types « congé » à jours entiers (début + fin) ; l'absence ponctuelle n'a qu'une date. */
const LEAVE_TYPES = new Set(["ANNUAL_LEAVE", "UNPAID_LEAVE", "SPECIAL_LEAVE", "MATERNITY_LEAVE", "SICK_LEAVE"]);

export function NewRequestButton() {
  const { rafraichir } = useRafraichir();
  const [open, setOpen] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [type, setType] = React.useState("WORK_CERTIFICATE");
  const [start, setStart] = React.useState("");
  const [end, setEnd] = React.useState("");
  const isLeave = LEAVE_TYPES.has(type);
  const isExit = type === "EXCEPTIONAL_EXIT";
  const isExpense = type === "EXPENSE_REPORT";
  const needsPeriod = isLeave || isExit;
  const days = React.useMemo(() => {
    if (!start || !end) return 0;
    const ms = new Date(end).getTime() - new Date(start).getTime();
    return Number.isNaN(ms) || ms < 0 ? 0 : Math.floor(ms / 86_400_000) + 1;
  }, [start, end]);

  const onSubmit = async (fd: FormData) => {
    setSaving(true); setErr(null);
    let r: Awaited<ReturnType<typeof requestHrDocument>>;
    try {
      r = await requestHrDocument(fd);
    } catch {
      setErr(actionFailureMessage("THROWN"));
      return;
    } finally {
      setSaving(false);
    }
    if (r.ok) { setOpen(false); rafraichir(); } else setErr(r.error ?? "Une erreur est survenue.");
  };

  return (
    <>
      <Button size="sm" onClick={() => { setErr(null); setOpen(true); }}><Plus className="h-4 w-4" /> Nouvelle demande</Button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Nouvelle demande RH" description="Attestation, titre de congé, ordre de mission, note de frais, entrevue… Les RH la traiteront ici." width="md">
        <form action={onSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label>Type de demande</Label>
            <Select name="type" value={type} onChange={(e) => setType(e.target.value)}>
              {Object.entries(HR_REQUEST_TYPE).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
          </div>

          {needsPeriod && (
            <div className="space-y-2 rounded-lg border border-border bg-secondary/40 p-3">
              <p className="flex items-center gap-1.5 text-xs font-medium"><CalendarRange className="h-4 w-4 text-primary" /> {isExit ? "Date de l'absence ponctuelle" : "Période du congé"}</p>
              <div className="grid grid-cols-1 gap-3 min-[400px]:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>{isExit ? "Date" : "Début"} <span className="text-destructive">*</span></Label>
                  <Input type="date" name="periodStart" value={start} onChange={(e) => setStart(e.target.value)} required />
                </div>
                {isLeave && (
                  <div className="space-y-1.5">
                    <Label>Fin <span className="text-destructive">*</span></Label>
                    <Input type="date" name="periodEnd" value={end} onChange={(e) => setEnd(e.target.value)} required />
                  </div>
                )}
              </div>
              {isLeave && days > 0 && (
                <p className="text-xs text-muted-foreground">Durée : <strong>{days} jour(s)</strong>{type === "ANNUAL_LEAVE" ? " — déduits de votre solde de congés à l'approbation." : type === "UNPAID_LEAVE" ? " — sans solde (n'entame pas votre solde de congés)." : "."}</p>
              )}
              {isExit && <p className="text-xs text-muted-foreground">Précisez l&apos;horaire (ex. « de 14h à 16h ») dans les précisions ci-dessous.</p>}
            </div>
          )}

          {type === "SICK_LEAVE" && (
            <p className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              <Stethoscope className="mt-0.5 h-4 w-4 shrink-0" />
              <span>Joignez le <strong>certificat médical / arrêt de travail</strong> en pièce jointe ci-dessous.</span>
            </p>
          )}

          {/* NOTE DE FRAIS : LES MÊMES CHAMPS QUE LE BOUTON DE « MON ESPACE ».
              Deux formulaires pour le même objet finissent par diverger — un montant exigé d'un
              côté, facultatif de l'autre — et l'on corrigerait alors une note avec des règles
              qui ne sont plus celles de son dépôt. */}
          {isExpense && <ExpenseClaimFields />}

          {type === "HR_INTERVIEW" && (
            <p className="flex items-start gap-2 rounded-lg bg-secondary px-3 py-2 text-xs text-muted-foreground">
              <CalendarClock className="mt-0.5 h-4 w-4 shrink-0" />
              <span>Décrivez l&apos;objet de l&apos;entrevue ci-dessous. Les RH vous <strong>proposeront une date</strong> : vous pourrez l&apos;accepter ou proposer un autre créneau, et échanger dans la demande.</span>
            </p>
          )}

          {/* Le motif et les pièces d'une note de frais sont déjà dans ses champs à elle : les
              répéter ici enverrait deux fois `details` et `files` dans le même envoi. */}
          {!isExpense && (
            <>
              <div className="space-y-1.5">
                <Label>Précisions {type === "HR_INTERVIEW" ? "(objet de l'entrevue)" : "(optionnel)"}</Label>
                <Textarea name="details" required={type === "HR_INTERVIEW"} placeholder={type === "HR_INTERVIEW" ? "Ex. point sur ma situation contractuelle…" : "Ex. dates de congé souhaitées, trajet et dates (mission)…"} rows={3} />
              </div>
              <div className="space-y-1.5">
                <Label>Pièces jointes (optionnel)</Label>
                <input type="file" name="files" multiple className="block w-full text-sm text-muted-foreground file:mr-3 file:rounded-lg file:border-0 file:bg-secondary file:px-3 file:py-1.5 file:text-sm file:font-medium" />
                <p className="text-xs text-muted-foreground">Ex. justificatif d&apos;arrêt maladie, formulaire signé…</p>
              </div>
            </>
          )}
          {err && <div className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> <span className="min-w-0">{err}</span></div>}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={() => setOpen(false)}>Annuler</Button>
            <Button type="submit" className="w-full sm:w-auto" disabled={saving}>{saving && <Loader2 className="h-4 w-4 animate-spin" />} Envoyer la demande</Button>
          </div>
        </form>
      </Sheet>
    </>
  );
}

export function CancelRequestButton({ id }: { id: string }) {
  const saisir = useSaisir();
  // Le bouton n'a pas de place où parler : un refus part en avis flottant (remplace `window.alert`).
  const { busy: pending, run } = useAction({ signalerErreurs: true });
  return (
    <button
      disabled={pending}
      onClick={async () => {
        const motif = await saisir({
          titre: "Annuler cette demande ?",
          message: "Les RH en seront prévenues.",
          saisie: { libelle: "Motif (facultatif)", valeur: "" },
        });
        if (motif === null) return;
        const fd = new FormData(); fd.set("id", id); if (motif.trim()) fd.set("motif", motif.trim());
        void run(() => annulerDemandeRh(fd));
      }}
      className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-secondary sm:min-h-0 sm:px-2.5"
    >
      {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null} Annuler
    </button>
  );
}

