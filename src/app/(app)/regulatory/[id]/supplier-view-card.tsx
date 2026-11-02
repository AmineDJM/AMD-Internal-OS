"use client";

import * as React from "react";

import { Loader2, Check, ExternalLink } from "lucide-react";
import { updateSupplierView } from "@/lib/actions/supplier-actions";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea, Label } from "@/components/ui/input";
import { EXTERNAL_REGULATORY_STATUS } from "@/lib/labels";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";

type Option = { value: string; label: string };

export interface SupplierViewValues {
  supplierId: string;
  portalVisible: boolean;
  externalStatus: string;
  externalComment: string;
  externalNextStep: string;
  externalActionExpected: string;
  externalDeadline: string; // yyyy-mm-dd or ""
  externalNotify: boolean;
}

export function SupplierViewCard({
  productId, suppliers, values, suggestedStatus, canUpdate,
}: {
  productId: string;
  suppliers: Option[];
  values: SupplierViewValues;
  suggestedStatus: string;
  canUpdate: boolean;
}) {
  const { rafraichir } = useRafraichir();
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  if (!canUpdate) {
    return (
      <div className="space-y-2 text-sm">
        <p className="text-muted-foreground">
          {values.portalVisible ? "Visible dans le portail fournisseur." : "Non publié dans le portail fournisseur."}
        </p>
        {values.externalStatus && <p>Statut externe : <span className="font-medium">{EXTERNAL_REGULATORY_STATUS[values.externalStatus]?.label ?? values.externalStatus}</span></p>}
      </div>
    );
  }

  return (
    <form
      action={async (fd) => {
        setSaving(true); setErr(null); setSaved(false);
        fd.set("productId", productId);
        fd.set("portalVisible", fd.get("portalVisible") ? "on" : "");
        fd.set("externalNotify", fd.get("externalNotify") ? "on" : "");
        try {
          const r = await updateSupplierView(fd);
          if (r.ok) { setSaved(true); rafraichir(); setTimeout(() => setSaved(false), 2500); }
          else setErr(r.error ?? "La vue fournisseur n'a pas été enregistrée.");
        } catch {
          setErr(actionFailureMessage("THROWN"));
        } finally {
          setSaving(false);
        }
      }}
      className="space-y-3"
    >
      <p className="text-xs text-muted-foreground">
        Le fournisseur ne voit que ces champs, et seulement si « Visible dans le portail » est coché. Jamais le statut ni les notes internes.
      </p>

      <div className="space-y-1.5">
        <Label htmlFor="supplierId">Fournisseur associé</Label>
        <Select id="supplierId" name="supplierId" defaultValue={values.supplierId}>
          <option value="">— Aucun</option>
          {suppliers.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </Select>
      </div>

      <label className="flex items-center gap-2 py-1 text-sm">
        <input type="checkbox" name="portalVisible" defaultChecked={values.portalVisible} className="h-4 w-4 rounded border-input" />
        Visible dans le portail fournisseur
      </label>

      <div className="space-y-1.5">
        <Label htmlFor="externalStatus">Statut externe (montré au fournisseur)</Label>
        <Select id="externalStatus" name="externalStatus" defaultValue={values.externalStatus || suggestedStatus}>
          {Object.entries(EXTERNAL_REGULATORY_STATUS).map(([v, d]) => <option key={v} value={v}>{d.label}</option>)}
        </Select>
        {!values.externalStatus && <p className="text-xs text-muted-foreground">Suggestion d'après le statut interne : {EXTERNAL_REGULATORY_STATUS[suggestedStatus]?.label}</p>}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="externalNextStep">Prochaine étape</Label>
        <Input id="externalNextStep" name="externalNextStep" defaultValue={values.externalNextStep} placeholder="Ex. Dépôt prévu en mars" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="externalActionExpected">Action attendue du fournisseur</Label>
        <Input id="externalActionExpected" name="externalActionExpected" defaultValue={values.externalActionExpected} placeholder="Ex. Envoyer le CPP à jour" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="externalDeadline">Échéance</Label>
        <Input id="externalDeadline" name="externalDeadline" type="date" defaultValue={values.externalDeadline} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="externalComment">Commentaire externe</Label>
        <Textarea id="externalComment" name="externalComment" defaultValue={values.externalComment} />
      </div>

      <label className="flex items-start gap-2 py-1 text-sm">
        <input type="checkbox" name="externalNotify" defaultChecked={values.externalNotify} className="mt-0.5 h-4 w-4 shrink-0 rounded border-input" />
        Notifier le fournisseur à la prochaine mise à jour (opt-in)
      </label>

      {err && <p className="text-sm text-destructive">{err}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={saving} className="w-full sm:w-auto">{saving && <Loader2 className="h-4 w-4 animate-spin" />} Enregistrer la vue fournisseur</Button>
        {saved && <span className="inline-flex items-center gap-1 text-sm text-success"><Check className="h-4 w-4" /> Enregistré</span>}
        {values.portalVisible && (
          <a href="/portail" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <ExternalLink className="h-3.5 w-3.5" /> Aperçu portail
          </a>
        )}
      </div>
    </form>
  );
}
