"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ArrowLeftRight, Loader2, CheckCircle2, XCircle, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { transferAdProRequest } from "../actions-transfert";
import { actionFailureMessage } from "@/lib/action-outcome";

type Kind = "SPONSORING" | "CONGRESS_NATIONAL" | "CONGRESS_INTERNATIONAL";

const LABELS: Record<Kind, string> = {
  SPONSORING: "Sponsoring",
  CONGRESS_NATIONAL: "Prise en charge Nationale",
  CONGRESS_INTERNATIONAL: "Prise en charge Internationale",
};

/**
 * TRANSFÉRER UNE DEMANDE VERS LE BON MODULE.
 *
 * Un délégué saisit parfois en « Sponsoring » ce qui est en réalité une prise en charge. Sans
 * ce bouton, il faut tout ressaisir et les pièces jointes se perdent.
 *
 * L'écran énonce les deux conséquences AVANT de valider, parce qu'elles surprennent :
 * le circuit de validation **repart du début** (les modules n'ont ni les mêmes étapes ni les
 * mêmes acteurs), et la demande d'origine est **conservée** — refermée, pointant vers la
 * nouvelle. On ne réécrit pas l'histoire d'une demande réglementaire.
 */
export function AdProTransferButton({ from, sourceId, title }: { from: Kind; sourceId: string; title: string }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [to, setTo] = React.useState<Kind | "">("");
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);
  const lock = React.useRef(false);

  const targets = (Object.keys(LABELS) as Kind[]).filter((k) => k !== from);

  const submit = () => {
    if (!to || lock.current) return;
    lock.current = true;
    setBusy(true);
    setMsg(null);
    const fd = new FormData();
    fd.set("from", from);
    fd.set("to", to);
    fd.set("sourceId", sourceId);
    void (async () => {
      try {
        const r = await transferAdProRequest(undefined, fd);
        setMsg({ ok: r.ok, text: r.ok ? (r.message ?? "Transférée.") : (r.error ?? "La demande n'a pas été transférée.") });
        if (r.ok && r.id) {
          const path = to === "SPONSORING" ? "/sponsoring" : to === "CONGRESS_NATIONAL" ? "/congress-national" : "/congress-international";
          router.push(`${path}/${r.id}`);
        }
      } catch {
        setMsg({ ok: false, text: actionFailureMessage("THROWN") });
      } finally {
        setBusy(false);
        lock.current = false;
      }
    })();
  };

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <ArrowLeftRight className="h-4 w-4" /> Transférer
      </Button>

      <Sheet
        open={open} onClose={() => setOpen(false)}
        title="Transférer vers un autre module"
        description={`« ${title} » — actuellement en ${LABELS[from]}.`}
        width="md"
      >
        <div className="space-y-4">
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Destination</legend>
            {targets.map((k) => (
              <label key={k} className="flex cursor-pointer items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm hover:bg-secondary">
                <input type="radio" name="to" value={k} checked={to === k} onChange={() => setTo(k)} className="h-4 w-4 shrink-0" />
                {LABELS[k]}
              </label>
            ))}
          </fieldset>

          <div className="space-y-1.5 rounded-xl border border-warning/40 bg-warning/5 p-3 text-sm text-muted-foreground">
            <p className="flex items-center gap-2 font-medium text-foreground">
              <AlertTriangle className="h-4 w-4 shrink-0 text-warning" /> Ce qui va se passer
            </p>
            <p>• Les <strong>pièces jointes suivent</strong> la demande.</p>
            <p>• Le <strong>circuit de validation repart du début</strong> : les modules n&apos;ont ni les mêmes étapes ni les mêmes acteurs, et rejouer un avancement produirait une demande qui se croit validée par des gens qui ne l&apos;ont jamais vue.</p>
            <p>• La demande d&apos;origine est <strong>conservée</strong>, refermée et pointant vers la nouvelle.</p>
            <p>• Un transfert est <strong>refusé</strong> si un ordre de dépense a déjà été émis.</p>
          </div>

          {msg && (
            <p className={`flex items-start gap-2 rounded-xl px-3 py-2 text-sm ${msg.ok ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive"}`}>
              {msg.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0" />}
              <span className="min-w-0 [overflow-wrap:anywhere]">{msg.text}</span>
            </p>
          )}

          <div className="flex flex-col gap-2 sm:flex-row">
            <Button size="sm" className="h-10 w-full sm:h-8 sm:w-auto" onClick={submit} disabled={!to || busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowLeftRight className="h-4 w-4" />} Transférer
            </Button>
            <Button size="sm" variant="outline" className="h-10 w-full sm:h-8 sm:w-auto" onClick={() => setOpen(false)}>Annuler</Button>
          </div>
        </div>
      </Sheet>
    </>
  );
}
