"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Ban, Clock, Loader2, Pencil, Trash2 } from "lucide-react";
import { editOwnRequest, deleteOwnRequest } from "@/lib/actions/admin-request-actions";
import { FENETRE_DISCRETE_MS } from "@/lib/secretariat/porte-demandeur";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";
import { Sheet } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea, Label } from "@/components/ui/input";
import { optionsFromMap } from "@/components/shared/form-fields";
import { PRIORITY } from "@/lib/labels";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";

/** Champ spécifique au type de demande (sérialisable depuis le serveur). */
export interface EditField {
  type: string; // text | textarea | select | number | date
  name: string;
  label: string;
  full?: boolean;
  options?: { value: string; label: string }[];
}

/**
 * CE QUE LE DEMANDEUR PEUT ENCORE FAIRE DE SA DEMANDE (§118.187 — audit 360°, R08).
 *
 * L'encart disparaissait à la trente et unième minute, et avec lui tout moyen de corriger une
 * référence ou d'annuler une demande devenue sans objet. Il reste désormais tant que la demande n'est
 * ni terminée ni annulée — le SERVEUR le décide (`porteDuDemandeur`), l'écran ne fait que le montrer :
 *   • dans la fenêtre DISCRÈTE (neuve, personne ne l'a commencée), modifier et supprimer sans
 *     déranger personne, avec le temps qui reste ;
 *   • au-delà, corriger et ANNULER encore, motif à l'appui — l'assistante en est prévenue, et la
 *     discussion garde ce qui a changé.
 * Quand la modification est fermée (une validation en cours, un paiement émis), la phrase du serveur
 * remplace le bouton : un bouton que l'action refuserait n'est pas un bouton (§118.83).
 */
export function RequesterWindow({
  requestId, createdAt, discret, modificationFermee, values, typeFields = [],
}: {
  requestId: string;
  createdAt: string;
  discret: boolean;
  modificationFermee: string | null;
  values: { title: string; description: string | null; priority: string; deadline: string | null; fields: Record<string, string> };
  typeFields?: EditField[];
}) {
  const router = useRouter();
  // La fiche « Modifier » s'ouvre sur un instantané : ouverte avant la fin du rafraîchissement, elle
  // réécrirait l'état d'avant (§118.172).
  const { enCours, rafraichir } = useRafraichir();
  const fin = new Date(createdAt).getTime() + FENETRE_DISCRETE_MS;
  const [restant, setRestant] = React.useState(() => fin - Date.now());
  const [edit, setEdit] = React.useState(false);
  const [annuler, setAnnuler] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [note, setNote] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!discret) return;
    const t = setInterval(() => setRestant(fin - Date.now()), 1000);
    return () => clearInterval(t);
  }, [discret, fin]);

  const enFenetre = discret && restant > 0;
  const mins = Math.max(0, Math.floor(restant / 60000));
  const secs = Math.max(0, Math.floor((restant % 60000) / 1000));
  const occupe = busy || enCours;

  async function run(action: (fd: FormData) => Promise<{ ok: boolean; error?: string; message?: string }>, fd: FormData, after?: () => void) {
    setBusy(true); setErr(null); setNote(null);
    try {
      const r = await action(fd);
      if (r.ok) { setNote(r.message ?? null); after?.(); rafraichir(); } else setErr(r.error ?? "La demande n'a pas été mise à jour.");
    } catch {
      setErr(actionFailureMessage("THROWN"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-300/60 bg-amber-50 px-3 py-2 text-sm dark:border-amber-500/30 dark:bg-amber-500/10">
      <Clock className="h-4 w-4 text-amber-600" />
      <span className="text-amber-800 dark:text-amber-300">
        {enFenetre ? (
          <>Vous pouvez encore modifier ou supprimer cette demande sans prévenir personne pendant{" "}
            <strong>{mins}:{String(secs).padStart(2, "0")}</strong>.</>
        ) : (
          <>Vous pouvez encore corriger ou annuler cette demande : l'assistante en sera prévenue.</>
        )}
      </span>
      <div className="ml-auto flex items-center gap-2">
        {modificationFermee === null && (
          <Button type="button" variant="outline" size="sm" disabled={occupe} onClick={() => { setErr(null); setEdit(true); }}>
            <Pencil className="h-3.5 w-3.5" /> {enFenetre ? "Modifier" : "Corriger"}
          </Button>
        )}
        {enFenetre ? (
          <form
            action={(fd) => {
              fd.set("id", requestId);
              return run(deleteOwnRequest, fd, () => router.push("/demandes"));
            }}
          >
            <BoutonDecisif type="submit" variant="outline" size="sm" disabled={occupe}>
              <Trash2 className="h-3.5 w-3.5" /> Supprimer
            </BoutonDecisif>
          </form>
        ) : (
          <Button type="button" variant="outline" size="sm" disabled={occupe} onClick={() => { setErr(null); setAnnuler(true); }}>
            <Ban className="h-3.5 w-3.5" /> Annuler la demande
          </Button>
        )}
      </div>
      {modificationFermee && <p className="w-full text-xs text-amber-800 dark:text-amber-300">{modificationFermee}</p>}
      {note && <p className="w-full text-xs text-emerald-700 dark:text-emerald-400">{note}</p>}
      {err && <p className="w-full text-xs text-destructive">{err}</p>}

      <Sheet open={annuler} onClose={() => setAnnuler(false)} title="Annuler ma demande" description="La demande est close, pas effacée : l'assistante est prévenue, et ce qui en dépendait (une validation en attente, un paiement non réglé) est retiré avec elle." width="md">
        <form action={(fd) => { fd.set("id", requestId); return run(deleteOwnRequest, fd, () => setAnnuler(false)); }} className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="motif-annulation">Pourquoi l'annulez-vous ?</Label>
            <Textarea id="motif-annulation" name="motif" required placeholder="C'est ce que l'assistante lira." />
          </div>
          {err && <p className="text-sm text-destructive">{err}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setAnnuler(false)}>Retour</Button>
            <BoutonDecisif type="submit" disabled={occupe}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Annuler la demande</BoutonDecisif>
          </div>
        </form>
      </Sheet>

      <Sheet open={edit} onClose={() => setEdit(false)} title="Modifier ma demande" description={enFenetre ? "Dans les trente minutes, sans prévenir personne." : "L'assistante sera prévenue de ce qui change."} width="md">
        <form action={(fd) => { fd.set("id", requestId); return run(editOwnRequest, fd, () => setEdit(false)); }} className="space-y-3">
          <div className="space-y-1">
            <Label>Objet</Label>
            <Input name="title" required defaultValue={values.title} />
          </div>
          <div className="space-y-1">
            <Label>Priorité</Label>
            <Select name="priority" defaultValue={values.priority}>{optionsFromMap(PRIORITY).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select>
          </div>
          <div className="space-y-1">
            <Label>Échéance</Label>
            <Input name="deadline" type="date" defaultValue={values.deadline ?? undefined} />
          </div>
          <div className="space-y-1">
            <Label>Description</Label>
            <Textarea name="description" defaultValue={values.description ?? undefined} />
          </div>

          {/* Tous les champs saisis à la création sont modifiables (édition complète). */}
          {typeFields.length > 0 && (
            <div className="grid grid-cols-1 gap-3 border-t border-border pt-3 sm:grid-cols-2">
              {typeFields.map((f) => {
                const cur = values.fields[f.name] ?? "";
                return (
                  <div key={f.name} className={f.full ? "space-y-1 sm:col-span-2" : "space-y-1"}>
                    <Label>{f.label}</Label>
                    {f.type === "textarea" ? (
                      <Textarea name={`f_${f.name}`} defaultValue={cur} />
                    ) : f.type === "select" ? (
                      <Select name={`f_${f.name}`} defaultValue={cur}>
                        <option value="">—</option>
                        {(f.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </Select>
                    ) : (
                      <Input name={`f_${f.name}`} type={f.type === "number" ? "number" : f.type === "date" ? "date" : "text"} step={f.type === "number" ? "any" : undefined} defaultValue={cur} />
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {err && <p className="text-sm text-destructive">{err}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setEdit(false)}>Annuler</Button>
            <Button type="submit" disabled={occupe}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Enregistrer</Button>
          </div>
        </form>
      </Sheet>
    </div>
  );
}
