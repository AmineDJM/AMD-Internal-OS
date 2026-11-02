"use client";

import * as React from "react";

import { Building2, Loader2, AlertCircle, Check, Plus } from "lucide-react";
import { createRegulatorySupplier } from "@/lib/actions/regulatory-actions";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Sheet } from "@/components/ui/sheet";
import { TextField, TextAreaField } from "@/components/shared/form-fields";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";

export interface SupplierRow {
  id: string;
  name: string;
  country: string | null;
  contactEmail: string | null;
  active: boolean;
}

export function SuppliersManager({ suppliers }: { suppliers: SupplierRow[] }) {
  const { rafraichir } = useRafraichir();
  const [open, setOpen] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);
  const formRef = React.useRef<HTMLFormElement>(null);

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Building2 className="h-4 w-4" />
        Fournisseurs
      </Button>

      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title="Fournisseurs"
        description="Référentiel des fournisseurs / laboratoires partenaires. Ils alimentent le menu déroulant des dossiers réglementaires."
        width="lg"
      >
        <div className="space-y-6">
          <form
            ref={formRef}
            action={async (fd) => {
              setSubmitting(true);
              setError(null);
              setSaved(false);
              try {
                const r = await createRegulatorySupplier(fd);
                if (r.ok) {
                  setSaved(true);
                  formRef.current?.reset();
                  rafraichir();
                  setTimeout(() => setSaved(false), 2500);
                } else {
                  setError(r.error ?? "Le fournisseur n'a pas été créé.");
                }
              } catch {
                setError(actionFailureMessage("THROWN"));
              } finally {
                setSubmitting(false);
              }
            }}
            className="space-y-4 rounded-xl border bg-card p-4"
          >
            <p className="text-sm font-medium">Nouveau fournisseur</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <TextField label="Nom" name="name" placeholder="Ex. Pharma Lab" className="sm:col-span-2" />
              <TextField label="Pays" name="country" placeholder="Inde" />
              <TextField label="Email de contact" name="contactEmail" type="email" placeholder="contact@labo.com" />
              <TextAreaField label="Notes (optionnel)" name="notes" placeholder="Informations utiles…" className="sm:col-span-2" />
            </div>

            {error && (
              <div className="flex items-center gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
                <AlertCircle className="h-4 w-4" />
                {error}
              </div>
            )}

            <div className="flex items-center justify-end gap-2">
              {saved && (
                <span className="inline-flex items-center gap-1 text-sm text-success">
                  <Check className="h-4 w-4" /> Ajouté
                </span>
              )}
              <Button type="submit" disabled={submitting}>
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                Ajouter
              </Button>
            </div>
          </form>

          <div className="space-y-2">
            <p className="text-sm font-medium">
              Fournisseurs enregistrés <span className="text-muted-foreground">({suppliers.length})</span>
            </p>
            {suppliers.length === 0 ? (
              <p className="rounded-lg border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
                Aucun fournisseur pour le moment.
              </p>
            ) : (
              <ul className="divide-y rounded-xl border">
                {suppliers.map((s) => (
                  <li key={s.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{s.name}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {[s.country, s.contactEmail].filter(Boolean).join(" · ") || "—"}
                      </p>
                    </div>
                    {s.active ? (
                      <Badge tone="success" dot={false}>Actif</Badge>
                    ) : (
                      <Badge tone="neutral" dot={false}>Inactif</Badge>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </Sheet>
    </>
  );
}
