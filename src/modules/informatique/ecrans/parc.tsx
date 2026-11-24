"use client";

import * as React from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Retour } from "@/components/ui/retour";
import { Label, Select } from "@/components/ui/input";
import { DataTable, type Column } from "@/components/shared/data-table";
import { SelectField, TextAreaField, TextField } from "@/components/shared/form-fields";
import { StatusBadge } from "@/components/shared/status-badge";
import { useAction } from "@/components/shared/use-action";
import { ETAT_MATERIEL, LIBELLE_TYPE_MATERIEL } from "../partage";
import { creerMateriel, modifierMateriel } from "../actions-parc";
import type { LigneMateriel, VueParc } from "../infra/requetes";

/** Le parc informatique : une table cherchable, une fiche pour enregistrer ou corriger un matériel. */

const GARANTIE: Record<string, string> = { SOUS_GARANTIE: "", BIENTOT: " (expire bientôt)", EXPIREE: " (expirée)" };

function FicheMateriel({ vue, ligne, onFermer }: { vue: VueParc; ligne: LigneMateriel | null; onFermer: () => void }) {
  const { saving, err, run } = useAction();
  const [societe, setSociete] = React.useState(ligne?.companyId ?? vue.societes[0]?.id ?? "");
  const personnes = vue.personnes.filter((p) => !p.companyId || p.companyId === societe);
  const departements = vue.departements.filter((d) => !d.companyId || d.companyId === societe);
  return (
    <Sheet open onClose={onFermer} title={ligne ? ligne.reference : "Nouveau matériel"} width="lg">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          const fd = new FormData(e.currentTarget);
          void run(() => (ligne ? modifierMateriel(fd) : creerMateriel(fd)), onFermer, { succes: ligne ? "Matériel mis à jour." : "Matériel enregistré." });
        }}
      >
        {ligne ? <input type="hidden" name="id" value={ligne.id} /> : (
          <div className="space-y-1.5">
            <Label htmlFor="companyId">Société<span className="ml-0.5 text-destructive">*</span></Label>
            <Select id="companyId" name="companyId" required value={societe} onChange={(e) => setSociete(e.target.value)}>
              {vue.societes.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </Select>
          </div>
        )}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <SelectField label="Type" name="type" required defaultValue={ligne?.type ?? ""} placeholder="Choisir…" options={Object.entries(LIBELLE_TYPE_MATERIEL).map(([value, label]) => ({ value, label }))} />
          <TextField label="Référence (marque, modèle)" name="reference" required defaultValue={ligne?.reference} />
          <TextField label="N° de série" name="numeroSerie" defaultValue={ligne?.numeroSerie ?? ""} />
          <SelectField label="État" name="etat" defaultValue={ligne?.etat ?? "EN_SERVICE"} options={Object.entries(ETAT_MATERIEL).map(([value, v]) => ({ value, label: v.label }))} />
          <SelectField label="Affecté à (personne)" name="employeeId" defaultValue={ligne?.employeeId ?? ""} placeholder="Personne" options={personnes.map((p) => ({ value: p.id, label: p.label }))} />
          <SelectField label="ou au département" name="departmentId" defaultValue={ligne?.departmentId ?? ""} placeholder="Aucun" options={departements.map((d) => ({ value: d.id, label: d.label }))} />
          <TextField label="Date d'achat" name="dateAchat" type="date" defaultValue={ligne?.dateAchat ?? ""} />
          <TextField label="Fin de garantie" name="finGarantie" type="date" defaultValue={ligne?.finGarantie ?? ""} />
        </div>
        <TextAreaField label="Notes" name="notes" defaultValue={ligne?.notes ?? ""} />
        <Retour>{err}</Retour>
        <div className="flex justify-end"><Button type="submit" disabled={saving}>{ligne ? "Enregistrer" : "Ajouter"}</Button></div>
      </form>
    </Sheet>
  );
}

export function RegistreParc({ vue, peutCreer, peutModifier }: { vue: VueParc; peutCreer: boolean; peutModifier: boolean }) {
  const [fiche, setFiche] = React.useState<LigneMateriel | "nouveau" | null>(null);
  const colonnes: Column<LigneMateriel>[] = [
    { key: "type", header: "Type", sortable: true, accessor: (m) => LIBELLE_TYPE_MATERIEL[m.type as keyof typeof LIBELLE_TYPE_MATERIEL] ?? m.type },
    { key: "reference", header: "Référence", sortable: true, render: (m) => <span className="font-medium">{m.reference}</span> },
    { key: "numeroSerie", header: "N° de série" },
    { key: "affectation", header: "Affectation", sortable: true, accessor: (m) => m.affectation ?? "—" },
    { key: "societe", header: "Société", sortable: true },
    { key: "dateAchat", header: "Achat", sortable: true, accessor: (m) => m.dateAchat ?? "—" },
    { key: "finGarantie", header: "Garantie", sortable: true, accessor: (m) => (m.finGarantie ? `${m.finGarantie}${GARANTIE[m.garantie ?? ""] ?? ""}` : "—") },
    { key: "etat", header: "État", accessor: (m) => ETAT_MATERIEL[m.etat as keyof typeof ETAT_MATERIEL]?.label ?? m.etat, render: (m) => <StatusBadge map={ETAT_MATERIEL} value={m.etat} /> },
    ...(peutModifier ? [{ key: "geste", header: "", render: (m: LigneMateriel) => <Button size="sm" variant="ghost" onClick={() => setFiche(m)}>Modifier</Button> }] : []),
  ];
  return (
    <>
      <DataTable
        columns={colonnes} rows={vue.lignes} filename="parc-informatique" searchPlaceholder="Rechercher une référence, une personne…"
        emptyTitle="Aucun matériel enregistré"
        emptyDescription={peutCreer ? "Ajoutez le premier : type, référence, affectation." : "L'équipe Informatique l'enregistre ici."}
        toolbar={peutCreer && vue.societes.length > 0 ? <Button size="sm" onClick={() => setFiche("nouveau")}><Plus className="mr-1 h-4 w-4" />Nouveau matériel</Button> : undefined}
      />
      {fiche && <FicheMateriel vue={vue} ligne={fiche === "nouveau" ? null : fiche} onFermer={() => setFiche(null)} />}
    </>
  );
}
