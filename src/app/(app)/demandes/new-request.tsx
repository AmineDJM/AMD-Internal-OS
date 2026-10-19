"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Plus, Loader2, ArrowLeft } from "lucide-react";
import { createRequest } from "@/lib/actions/admin-request-actions";
import { REQUEST_TYPES, REQUEST_TYPE_FIELDS } from "@/lib/admin-requests";
import { Sheet } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea, Label } from "@/components/ui/input";
import { Icon } from "@/components/ui/icon";
import { optionsFromMap } from "@/components/shared/form-fields";
import { DrivePickerField } from "@/components/drive/drive-picker";
import { PRIORITY } from "@/lib/labels";

type Option = { id: string; name: string };

export function NewRequestButton({ users, departments, articles = [] }: { users: Option[]; departments: Option[]; articles?: Option[] }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [type, setType] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  const typeFields = type ? REQUEST_TYPE_FIELDS[type] ?? [] : [];
  const typeLabel = REQUEST_TYPES.find((t) => t.value === type)?.label;

  return (
    <>
      <Button onClick={() => { setType(null); setErr(null); setOpen(true); }}><Plus className="h-4 w-4" /> Nouvelle demande</Button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Nouvelle demande" description={type ? typeLabel : "Choisissez le type de demande"} width="lg">
        {!type ? (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {REQUEST_TYPES.map((t) => (
              <button key={t.value} type="button" onClick={() => setType(t.value)} className="flex items-start gap-3 rounded-lg border border-border p-3 text-left transition-colors hover:bg-secondary">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><Icon name={t.icon} className="h-4 w-4" /></span>
                <span><span className="block text-sm font-medium">{t.label}</span><span className="block text-xs text-muted-foreground">{t.description}</span></span>
              </button>
            ))}
          </div>
        ) : (
          <form
            action={async (fd) => {
              setSaving(true); setErr(null);
              const r = await createRequest(undefined, fd);
              setSaving(false);
              if (r.ok) { setOpen(false); if (r.id) router.push(`/demandes/${r.id}`); else router.refresh(); }
              else setErr(r.error ?? "Erreur.");
            }}
            className="space-y-4"
          >
            <button type="button" onClick={() => setType(null)} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
              <ArrowLeft className="h-3.5 w-3.5" /> Changer de type
            </button>
            <input type="hidden" name="type" value={type} />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <FieldWrap full label="Titre" required><Input name="title" required placeholder="Ex. Billet délégué Oran → Alger" /></FieldWrap>
              <FieldWrap label="Priorité"><Select name="priority" defaultValue="MEDIUM">{optionsFromMap(PRIORITY).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select></FieldWrap>
              <FieldWrap label="Échéance"><Input name="deadline" type="date" /></FieldWrap>
              <FieldWrap label="Département"><Select name="departmentId" defaultValue=""><option value="">—</option>{departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select></FieldWrap>
              <FieldWrap full label="Description"><Textarea name="description" placeholder="Précisez votre besoin…" /></FieldWrap>
              {/* Tout type (Excel, PDF, Word, images, archives…) : le serveur refuse seul ce qui s'exécute. */}
              <FieldWrap full label="Pièces jointes">
                <Input name="files" type="file" multiple aria-label="Pièces jointes" />
              </FieldWrap>
              {/* La demande va directement à l'assistante de direction ; le demandeur peut y associer des participants. */}
              <FieldWrap full label="Participants">
                <div className="max-h-40 space-y-1 overflow-y-auto rounded-lg border border-input p-2">
                  {users.map((u) => (
                    <label key={u.id} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-secondary">
                      <input type="checkbox" name="participantIds" value={u.id} className="h-4 w-4 rounded border-input" />
                      {u.name}
                    </label>
                  ))}
                </div>
              </FieldWrap>

              {typeFields.map((f) => {
                const name = `f_${f.name}`;
                // Achat : l'article se choisit dans le catalogue (menu déroulant) si disponible.
                if (type === "PURCHASE" && f.name === "article" && articles.length > 0) {
                  return (
                    <FieldWrap key={f.name} full label={f.label}>
                      <Select id={name} name={name} defaultValue="">
                        <option value="">— Choisir un article (ou saisir en description)</option>
                        {articles.map((a) => <option key={a.id} value={a.name}>{a.name}</option>)}
                      </Select>
                    </FieldWrap>
                  );
                }
                return (
                  <FieldWrap key={f.name} full={f.full || f.type === "textarea"} label={f.label}>
                    {f.type === "textarea" ? (
                      <Textarea id={name} name={name} />
                    ) : f.type === "select" ? (
                      <Select id={name} name={name} defaultValue={f.defaultValue ?? ""}>
                        {f.placeholder && <option value="">{f.placeholder}</option>}
                        {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </Select>
                    ) : f.type === "multiselect" ? (
                      <div className="max-h-40 space-y-1 overflow-y-auto rounded-lg border border-input p-2">
                        {f.options.map((o) => (
                          <label key={o.value} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-secondary">
                            <input type="checkbox" name={name} value={o.value} className="h-4 w-4 rounded border-input" />
                            {o.label}
                          </label>
                        ))}
                      </div>
                    ) : f.type === "checkbox" ? null : f.type === "drivepicker" ? (
                      // Un type de demande peut désigner une pièce DÉJÀ dans le Drive plutôt
                      // que d'en téléverser une copie : l'explorateur s'ouvre par-dessus.
                      <DrivePickerField name={name} label={f.label} hint={f.hint} />
                    ) : (
                      <Input id={name} name={name} type={f.type} defaultValue={f.defaultValue} step={f.type === "number" ? "any" : undefined} />
                    )}
                  </FieldWrap>
                );
              })}
            </div>
            {err && <p className="text-sm text-destructive">{err}</p>}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>Annuler</Button>
              <Button type="submit" disabled={saving}>{saving && <Loader2 className="h-4 w-4 animate-spin" />} Créer la demande</Button>
            </div>
          </form>
        )}
      </Sheet>
    </>
  );
}

function FieldWrap({ label, full, required, children }: { label: string; full?: boolean; required?: boolean; children: React.ReactNode }) {
  return (
    <div className={full ? "sm:col-span-2 space-y-1.5" : "space-y-1.5"}>
      <Label>{label}{required && <span className="ml-0.5 text-destructive">*</span>}</Label>
      {children}
    </div>
  );
}
