"use client";

import * as React from "react";
import { useActionState } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Loader2, AlertCircle, Lock } from "lucide-react";
import { updateRegulatoryProduct, type ActionResult } from "@/lib/actions/regulatory-actions";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { TextField, TextAreaField, SelectField, optionsFromMap } from "@/components/shared/form-fields";
import { DciAssociationField } from "./dci-field";
import { MANUFACTURING_STATUS, REGULATORY_CATEGORY, PRODUCT_CHANNEL, PRIORITY, REGULATORY_STATUS, ROLE_LABELS, PHARMA_FORM, DOSAGE_UNIT } from "@/lib/labels";

interface UserOption {
  id: string;
  name: string;
  role: string;
}

export interface EditProductValues {
  companyId?: string | null;
  id: string;
  molecules: string[];
  brandName: string | null;
  dosage: string | null;
  dosageUnit: string | null;
  pharmaceuticalForm: string | null;
  packaging: string | null;
  therapeuticClass: string | null;
  partnerLab: string | null;
  supplierId: string | null;
  countryOfOrigin: string | null;
  category: string;
  channel: string;
  manufacturingStatus: string;
  status: string;
  priority: string;
  responsibleId: string | null;
  assistantId: string | null;
  targetDate: string | null;
  comments: string | null;
  deHolder: string | null;
  manufacturingVariation: string | null;
  manufacturer: string | null;
  variationDate: string | null;
}

/**
 * UN CHAMP RÉSERVÉ AU SUPER ADMIN — montré, jamais soumis.
 *
 * On affiche la valeur (la cacher obligerait à ouvrir un autre écran pour la lire) sans poser
 * d'`input` : le champ est alors ABSENT du formulaire, et le serveur, qui ne compare que ce qui
 * lui est transmis, laisse la valeur telle quelle. Un `<select disabled>` aurait fait la même
 * chose visuellement, mais un champ grisé donne envie de cliquer — celui-ci dit pourquoi.
 */
function LockedField({ label, value, hint = "Réservé au Super Admin." }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0 space-y-1">
      <span className="flex items-center gap-1 text-sm font-medium text-muted-foreground">
        <Lock className="h-3.5 w-3.5" /> {label}
      </span>
      <p className="truncate rounded-lg border border-dashed border-border bg-secondary/30 px-3 py-2 text-sm">{value}</p>
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

export function EditProductButton({ product, users, suppliers, companies, canSetStructural = false }: { product: EditProductValues; users: UserOption[]; suppliers: { id: string; name: string }[]; companies: { id: string; name: string; shortName: string | null }[]; canSetStructural?: boolean }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [state, formAction] = useActionState<ActionResult | undefined, FormData>(
    updateRegulatoryProduct,
    undefined,
  );
  const [submitting, setSubmitting] = React.useState(false);

  React.useEffect(() => {
    if (state?.ok) {
      setSubmitting(false);
      router.refresh();
      // UNE RÉSERVE GARDE LA FENÊTRE OUVERTE. Le reste de la fiche est enregistré, mais un champ
      // réservé a été refusé : fermer sans le dire ferait croire que tout est passé, et la
      // personne repartirait convaincue d'avoir changé le statut de fabrication.
      if (!state.message) setOpen(false);
    } else if (state?.error) {
      setSubmitting(false);
    }
  }, [state, router]);

  const userOptions = users.map((u) => ({
    value: u.id,
    label: `${u.name} — ${ROLE_LABELS[u.role] ?? u.role}`,
  }));

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Pencil className="h-4 w-4" />
        Modifier
      </Button>

      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title="Modifier le dossier réglementaire"
        description="Met à jour les informations descriptives. Le workflow et les étapes sont conservés."
        width="lg"
      >
        <form
          action={(fd) => {
            setSubmitting(true);
            formAction(fd);
          }}
          className="space-y-4"
        >
          <input type="hidden" name="id" value={product.id} />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {/* L'entité était fixée à la création et n'apparaissait plus : un produit créé sans
                entité ne pouvait donc JAMAIS en recevoir une. */}
            {/* TROIS CHAMPS DÉCIDENT DE CE QUE LE DOSSIER ENGAGE — l'entité (qui le voit), le
                statut de fabrication (ce qu'on s'engage à faire industriellement) et le chargé du
                dossier (un engagement pris au nom de quelqu'un). Ils appartiennent au Super Admin ;
                le reste de la fiche demeure ouvert. Voir `lib/regulatory/structural-fields.ts`. */}
            {canSetStructural ? (
              <SelectField label="Entité" name="companyId" required options={companies.map((c) => ({ value: c.id, label: c.shortName || c.name }))} placeholder="— Choisir l'entité —" defaultValue={product.companyId ?? (companies.length === 1 ? companies[0].id : "")} />
            ) : (
              <LockedField label="Entité" value={companies.find((c) => c.id === product.companyId)?.shortName || companies.find((c) => c.id === product.companyId)?.name || "—"} />
            )}
            <SelectField label="Catégorie" name="category" options={optionsFromMap(REGULATORY_CATEGORY)} defaultValue={product.category} />
            <SelectField label="Canal (Ville / Hôpital)" name="channel" options={optionsFromMap(PRODUCT_CHANNEL)} defaultValue={product.channel} />
            <DciAssociationField defaultMolecules={product.molecules} />
            <TextField label="Nom commercial" name="brandName" placeholder="Ex. Adventor" defaultValue={product.brandName ?? undefined} className="sm:col-span-2" />
            <TextField label="Dosage" name="dosage" placeholder="20" defaultValue={product.dosage ?? undefined} />
            <SelectField label="Unité" name="dosageUnit" options={optionsFromMap(DOSAGE_UNIT)} placeholder="—" defaultValue={product.dosageUnit ?? ""} />
            <SelectField label="Forme pharmaceutique" name="pharmaceuticalForm" options={optionsFromMap(PHARMA_FORM)} placeholder="—" defaultValue={product.pharmaceuticalForm ?? ""} />
            <TextField label="Conditionnement" name="packaging" placeholder="B/30" defaultValue={product.packaging ?? undefined} />
            <TextField label="Classe thérapeutique" name="therapeuticClass" placeholder="Hypolipémiant" defaultValue={product.therapeuticClass ?? undefined} />
            <SelectField label="Fournisseur" name="supplierId" options={suppliers.map((s) => ({ value: s.id, label: s.name }))} placeholder="— Aucun —" defaultValue={product.supplierId ?? ""} />
            <TextField label="Laboratoire partenaire (optionnel)" name="partnerLab" placeholder="Ex. Pharma Lab" defaultValue={product.partnerLab ?? undefined} />
            <TextField label="Pays d'origine" name="countryOfOrigin" placeholder="Inde" defaultValue={product.countryOfOrigin ?? undefined} />
            {canSetStructural ? (
              <SelectField label="Statut de fabrication" name="manufacturingStatus" options={optionsFromMap(MANUFACTURING_STATUS)} defaultValue={product.manufacturingStatus} />
            ) : (
              <LockedField label="Statut de fabrication" value={MANUFACTURING_STATUS[product.manufacturingStatus] ?? product.manufacturingStatus} />
            )}
            <SelectField label="Priorité" name="priority" options={optionsFromMap(PRIORITY)} defaultValue={product.priority} />
            {/* LE NIVEAU DE PROCESS NE SE SAISIT PLUS : il est déduit des étapes du processus
                d'enregistrement. Le laisser modifiable ici recréerait la divergence qu'on vient
                de fermer — l'écran disant une chose, les étapes une autre. */}
            <LockedField label="Niveau de process (déduit du processus)" value={REGULATORY_STATUS[product.status]?.label ?? product.status} />
            {canSetStructural ? (
              <SelectField label="Chargé du dossier" name="responsibleId" options={userOptions} placeholder="—" defaultValue={product.responsibleId ?? ""} />
            ) : (
              <LockedField label="Chargé du dossier" value={users.find((u) => u.id === product.responsibleId)?.name ?? "—"} />
            )}
            <SelectField label="Assistante assignée" name="assistantId" options={userOptions} placeholder="—" defaultValue={product.assistantId ?? ""} />
            <TextField label="Date cible d'enregistrement" name="targetDate" type="date" defaultValue={product.targetDate ?? undefined} className="sm:col-span-2" />

            {/* Décision d'enregistrement (les variations de fabrication se gèrent sur la fiche). */}
            <TextField label="Détenteur de DE" name="deHolder" placeholder="Titulaire de la décision d'enregistrement" defaultValue={product.deHolder ?? undefined} className="sm:col-span-2" />
            <TextField label="Fabricant" name="manufacturer" placeholder="Site de fabrication" defaultValue={product.manufacturer ?? undefined} className="sm:col-span-2" />
          </div>
          <TextAreaField label="Commentaires" name="comments" placeholder="Notes internes…" defaultValue={product.comments ?? undefined} />

          {state?.ok && state.message && (
            <div className="flex items-start gap-2 rounded-lg border border-warning/20 bg-warning/10 px-3 py-2 text-sm text-warning">
              <Lock className="mt-0.5 h-4 w-4 shrink-0" />
              {state.message}
            </div>
          )}

          {state?.error && (
            <div className="flex items-center gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <AlertCircle className="h-4 w-4" />
              {state.error}
            </div>
          )}

          <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Annuler
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              Enregistrer
            </Button>
          </div>
        </form>
      </Sheet>
    </>
  );
}
