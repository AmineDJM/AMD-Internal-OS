"use client";

import * as React from "react";
import { Pencil, Loader2, CheckCircle2, XCircle, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Input, Textarea, Label, Select } from "@/components/ui/input";
import { updateAdProRequest } from "@/lib/actions/ad-pro-edit-actions";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";
import { EDITABLE_FIELDS, type AdProKind } from "@/lib/ad-pro-edit";

/**
 * CORRIGER UNE DEMANDE AD & PRO.
 *
 * Le formulaire est **dérivé de la liste blanche** (`EDITABLE_FIELDS`) plutôt que recopié :
 * un champ qu'on refuse d'écrire côté serveur ne doit pas pouvoir apparaître à l'écran, et
 * un champ qu'on ajoute ne doit pas exiger de retoucher trois formulaires.
 *
 * `EDITABLE_FIELDS` est une constante pure (aucun accès base, aucun module lourd) : elle peut
 * traverser la frontière client sans embarquer Prisma dans le bundle du navigateur.
 */
export function AdProEditButton({
  kind, id, values, decided,
}: {
  kind: AdProKind;
  id: string;
  /** Valeurs actuelles, déjà sérialisées (montants en nombre, dates en AAAA-MM-JJ). */
  values: Record<string, string | number | null>;
  /** La décision est-elle rendue ? (l'écran le dit — corriger un dossier tranché n'est pas anodin) */
  decided: boolean;
}) {
  const { rafraichir } = useRafraichir();
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);
  const lock = React.useRef(false);

  const fields = EDITABLE_FIELDS[kind];

  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setMsg(null);
    const fd = new FormData(e.currentTarget);
    fd.set("kind", kind);
    fd.set("id", id);
    void (async () => {
      try {
        const r = await updateAdProRequest(fd);
        setMsg({ ok: r.ok, text: r.ok ? (r.message ?? "Demande mise à jour.") : (r.error ?? "La demande n'a pas été modifiée.") });
        // Une correction qui a CHANGÉ quelque chose ailleurs (la porte du centre s'ouvre, se rouvre, se
        // retire) le DIT, et la fenêtre reste ouverte le temps de le lire : se refermer sur cette phrase
        // la jetterait — l'écran qui se ferme sans rien dire (§118.168).
        if (r.ok) { if (!r.message) setOpen(false); rafraichir(); }
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
        <Pencil className="h-4 w-4" /> Modifier
      </Button>

      <Sheet
        open={open} onClose={() => setOpen(false)}
        title="Modifier la demande"
        description="Corrigez les informations de la demande. Le circuit de validation, les montants accordés et les avis ne se modifient pas ici."
        width="md"
      >
        <form onSubmit={submit} className="space-y-4">
          {decided && (
            <p className="flex items-start gap-2 rounded-xl border border-warning/40 bg-warning/5 px-3 py-2 text-sm text-muted-foreground">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
              <span>
                La décision est <strong>déjà rendue</strong>. Une correction reste possible pour la Direction, mais
                elle porte sur un dossier tranché : elle est <strong>tracée telle quelle</strong> dans le journal.
              </span>
            </p>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {fields.map((f) => {
              const v = values[f.key];
              const defaultValue = v === null || v === undefined ? "" : String(v);
              return (
                <div key={f.key} className={f.type === "textarea" ? "space-y-1 sm:col-span-2" : "space-y-1"}>
                  <Label htmlFor={`edit-${f.key}`}>{f.label}</Label>
                  {f.type === "textarea" ? (
                    <Textarea id={`edit-${f.key}`} name={f.key} defaultValue={defaultValue} required={Boolean(f.requis)} className="min-h-[64px]" />
                  ) : f.type === "select" && f.options ? (
                    // Le MÊME menu qu'à la création : corriger un type ne doit pas rouvrir la
                    // porte aux variantes orthographiques que le formulaire d'origine interdit.
                    <Select id={`edit-${f.key}`} name={f.key} defaultValue={defaultValue} required={Boolean(f.requis)}>
                      {!f.requis && <option value="">— Non renseigné —</option>}
                      {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </Select>
                  ) : (
                    <Input
                      id={`edit-${f.key}`}
                      name={f.key}
                      defaultValue={defaultValue}
                      type={f.type === "number" ? "number" : f.type === "date" ? "date" : "text"}
                      required={Boolean(f.requis)}
                      {...(f.type === "number" ? { step: "any", min: "0", inputMode: "decimal" as const } : {})}
                    />
                  )}
                </div>
              );
            })}
          </div>

          {msg && (
            <p className={`flex items-start gap-2 rounded-xl px-3 py-2 text-sm ${msg.ok ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive"}`}>
              {msg.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0" />}
              <span className="min-w-0 [overflow-wrap:anywhere]">{msg.text}</span>
            </p>
          )}

          <div className="flex flex-col gap-2 sm:flex-row">
            <Button size="sm" type="submit" disabled={busy} className="h-10 w-full sm:h-8 sm:w-auto">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Pencil className="h-4 w-4" />} Enregistrer
            </Button>
            <Button size="sm" type="button" variant="outline" onClick={() => setOpen(false)} className="h-10 w-full sm:h-8 sm:w-auto">Annuler</Button>
          </div>
        </form>
      </Sheet>
    </>
  );
}
