"use client";

import * as React from "react";
import { actionFailureMessage } from "@/lib/action-outcome";
import { usePathname } from "next/navigation";
import { Loader2, Check } from "lucide-react";
import { saveCustomValues } from "@/lib/actions/custom-field-actions";
import { Button } from "@/components/ui/button";
import { Input, Select, Label } from "@/components/ui/input";
import Link from "next/link";
import { DrivePickerField } from "@/components/drive/drive-picker";
import { fileCustomValue } from "@/lib/custom-field-values";

export interface CustomFieldDefDTO {
  id: string;
  key: string;
  label: string;
  type: string; // TEXT | NUMBER | DATE | BOOLEAN | SELECT | FILE
  options: string | null;
  /** Champ à remplir obligatoirement (décidé par l'administrateur ; le serveur fait foi). */
  required?: boolean;
}

interface Props {
  entityType: string;
  entityId: string;
  defs: CustomFieldDefDTO[];
  values: Record<string, unknown>;
  canEdit: boolean;
}

function toDateValue(v: unknown): string {
  if (!v) return "";
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}

export function CustomFieldsCard({ entityType, entityId, defs, values, canEdit }: Props) {
  const pathname = usePathname();
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  if (defs.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Aucun champ personnalisé. Un administrateur peut en ajouter dans Administration → Champs personnalisés.
      </p>
    );
  }

  if (!canEdit) {
    return (
      <div className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:gap-x-6">
        {defs.map((d) => (
          <div key={d.id} className="min-w-0">
            <p className="text-xs text-muted-foreground">{d.label}</p>
            <p className="break-words font-medium">
              {d.type === "FILE" ? (
                fileCustomValue(values[d.key]) ? (
                  <Link href={`/drive/${fileCustomValue(values[d.key])!.nodeId}`} className="text-primary underline underline-offset-2 hover:opacity-80">
                    {fileCustomValue(values[d.key])!.name}
                  </Link>
                ) : "—"
              ) : d.type === "BOOLEAN" ? (values[d.key] ? "Oui" : "Non") : String(values[d.key] ?? "—") || "—"}
            </p>
          </div>
        ))}
      </div>
    );
  }

  return (
    <form
      action={async (fd) => {
        setSaving(true);
        setError(null);
        try {
          const r = await saveCustomValues(fd);
          if (r.ok) {
            setSaved(true);
            setTimeout(() => setSaved(false), 1500);
          } else {
            setError(r.error ?? "Enregistrement impossible.");
          }
        } catch {
          setError(actionFailureMessage("THROWN"));
        } finally {
          setSaving(false);
        }
      }}
      className="space-y-3"
    >
      <input type="hidden" name="entityType" value={entityType} />
      <input type="hidden" name="entityId" value={entityId} />
      <input type="hidden" name="path" value={pathname} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {defs.map((d) => {
          const v = values[d.key];
          const name = `cf_${d.key}`;
          if (d.type === "FILE") {
            const picked = fileCustomValue(v);
            return (
              <div key={d.id} className="sm:col-span-2">
                <DrivePickerField
                  name={name}
                  label={d.required ? `${d.label} *` : d.label}
                  hint="Référence un document du Drive — jamais copié, toujours la version courante."
                  defaultValue={picked ? { id: picked.nodeId, name: picked.name, isFolder: false } : null}
                />
              </div>
            );
          }
          if (d.type === "BOOLEAN") {
            return (
              <label key={d.id} className="flex items-center gap-2 py-1 text-sm sm:col-span-2">
                <input type="checkbox" name={name} defaultChecked={Boolean(v)} className="h-4 w-4 rounded border-input" />
                {d.label}
              </label>
            );
          }
          return (
            <div key={d.id} className="space-y-1">
              <Label htmlFor={name}>
                {d.label}
                {d.required && <span className="text-destructive"> *</span>}
              </Label>
              {d.type === "SELECT" ? (
                <Select id={name} name={name} defaultValue={String(v ?? "")} required={d.required}>
                  <option value="">—</option>
                  {(d.options ?? "").split(",").map((o) => o.trim()).filter(Boolean).map((o) => (
                    <option key={o} value={o}>{o}</option>
                  ))}
                </Select>
              ) : (
                <Input
                  id={name}
                  name={name}
                  type={d.type === "NUMBER" ? "number" : d.type === "DATE" ? "date" : "text"}
                  step={d.type === "NUMBER" ? "any" : undefined}
                  defaultValue={d.type === "DATE" ? toDateValue(v) : (v as string) ?? ""}
                  required={d.required}
                />
              )}
            </div>
          );
        })}
      </div>
      {error && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={saving} className="w-full sm:w-auto">
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : saved ? <Check className="h-4 w-4 text-success" /> : null}
          {saved ? "Enregistré" : "Enregistrer"}
        </Button>
      </div>
    </form>
  );
}
