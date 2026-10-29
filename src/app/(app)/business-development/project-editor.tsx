"use client";

import * as React from "react";

import { Pencil, Loader2, AlertCircle } from "lucide-react";
import { updateBdProject } from "@/lib/actions/bd-project-actions";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Input, Select, Textarea, Label } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { BD_PROJECT_STATUS } from "@/lib/labels";
import { useFormAction } from "@/components/shared/use-action";

export function ProjectEditor({
  id, name, status, description, comment, companyId = null, companies, proposition = null,
}: {
  id: string;
  name: string;
  status: string;
  description: string;
  comment: string;
  /** L'entité du projet (§118.163) — `null` pour un projet d'avant, pas encore rattaché. */
  companyId?: string | null;
  /** Les entités que la personne VOIT. Absent : le champ n'est pas proposé (la fiche d'avant). */
  companies?: { value: string; label: string }[];
  /** L'entité que désignent TOUS ses dossiers — proposée, jamais enregistrée sans un clic. */
  proposition?: string | null;
}) {
  const [open, setOpen] = React.useState(false);
  const { action, busy: saving, err, setErr } = useFormAction(updateBdProject, { prepare: (fd) => fd.set("id", id), onOk: () => setOpen(false) });

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => { setErr(null); setOpen(true); }}>
        <Pencil className="h-4 w-4" /> Modifier
      </Button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Modifier le projet" width="lg">
        <form
          action={action}
          className="space-y-4"
        >
          <div className="space-y-1.5">
            <Label htmlFor="name">Nom du projet<span className="ml-0.5 text-destructive">*</span></Label>
            <Input id="name" name="name" required defaultValue={name} />
          </div>
          {companies && (
            <div className="space-y-1.5">
              <Label htmlFor={`companyId-${id}`}>Entité<span className="ml-0.5 text-destructive">*</span></Label>
              <Select id={`companyId-${id}`} name="companyId" required defaultValue={companyId ?? proposition ?? ""}>
                <option value="" disabled>Choisir l'entité…</option>
                {companies.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </Select>
              {/* LA PROPOSITION SE DIT : un projet d'avant reçoit l'entité de ses dossiers, et la
                  personne doit savoir que ce choix vient du classement, pas d'elle (§118.163). */}
              {!companyId && proposition && (
                <p className="text-xs text-muted-foreground">
                  Proposée d'après les dossiers classés dans ce projet — vérifiez-la avant d'enregistrer.
                </p>
              )}
              {!companyId && !proposition && (
                <p className="text-xs text-muted-foreground">
                  Ce projet n'est rattaché à aucune entité : choisissez celle à laquelle il appartient.
                </p>
              )}
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="status">Statut</Label>
            <Select id="status" name="status" defaultValue={status}>
              {Object.entries(BD_PROJECT_STATUS).map(([v, d]) => <option key={v} value={v}>{d.label}</option>)}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="description">Description / objectif</Label>
            <Textarea id="description" name="description" defaultValue={description} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="comment">Commentaire</Label>
            <Textarea id="comment" name="comment" defaultValue={comment} />
          </div>
          {err && (
            <div className="flex items-center gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <AlertCircle className="h-4 w-4" /> {err}
            </div>
          )}
          <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" onClick={() => setOpen(false)} className="w-full sm:w-auto">Annuler</Button>
            <Button type="submit" disabled={saving} className="w-full sm:w-auto">{saving && <Loader2 className="h-4 w-4 animate-spin" />} Enregistrer</Button>
          </div>
        </form>
      </Sheet>
    </>
  );
}

export function ProjectStatusBadge({ status }: { status: string }) {
  const d = BD_PROJECT_STATUS[status];
  return <Badge tone={d?.tone ?? "neutral"} dot={false}>{d?.label ?? status}</Badge>;
}
