"use client";

import * as React from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Retour } from "@/components/ui/retour";
import { BoutonDecisif } from "@/components/ui/bouton-decisif";
import { Input, Label, Select } from "@/components/ui/input";
import { DataTable, type Column } from "@/components/shared/data-table";
import { SelectField, TextAreaField, TextField } from "@/components/shared/form-fields";
import { StatusBadge } from "@/components/shared/status-badge";
import { useAction } from "@/components/shared/use-action";
import { formatMontant } from "@/lib/utils";
import { DEVISES, LIBELLE_PERIODICITE, STATUT_ABONNEMENT } from "../partage";
import { creerAbonnement, modifierAbonnement, resilierAbonnement } from "../actions-abonnements";
import type { LigneAbonnement, VueAbonnements } from "../infra/requetes";

/** Le registre des abonnements & licences : une table cherchable, une fiche pour saisir ou corriger. */

const echeanceLisible = (a: LigneAbonnement): string => {
  if (!a.echeance) return "—";
  if (a.statut !== "ACTIF" || a.joursAvantEcheance === null) return a.echeance;
  if (a.joursAvantEcheance < 0) return `${a.echeance} (dépassée)`;
  return a.joursAvantEcheance <= a.rappelJours ? `${a.echeance} (dans ${a.joursAvantEcheance} j)` : a.echeance;
};

function FicheAbonnement({ vue, ligne, onFermer }: { vue: VueAbonnements; ligne: LigneAbonnement | null; onFermer: () => void }) {
  const { saving, err, run } = useAction();
  const [societe, setSociete] = React.useState(ligne?.companyId ?? vue.societes[0]?.id ?? "");
  const lignesBudget = vue.lignesBudget.filter((l) => l.companyId === societe);
  const defautLigne = ligne?.budgetCategoryId ?? lignesBudget.find((l) => l.cle === "ABONNEMENTS_LICENCES")?.id ?? "";
  return (
    <Sheet open onClose={onFermer} title={ligne ? `${ligne.fournisseur} — ${ligne.objet}` : "Nouvel abonnement"} width="lg">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          const fd = new FormData(e.currentTarget);
          void run(() => (ligne ? modifierAbonnement(fd) : creerAbonnement(fd)), onFermer, { succes: ligne ? "Abonnement mis à jour." : "Abonnement enregistré." });
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
          <TextField label="Fournisseur" name="fournisseur" required defaultValue={ligne?.fournisseur} placeholder="OpenAI, Anthropic, Mistral…" />
          <TextField label="Objet" name="objet" required defaultValue={ligne?.objet} placeholder="API, licences, hébergement…" />
          <TextField label="Montant" name="montant" required inputMode="decimal" defaultValue={ligne?.montant} />
          <SelectField label="Devise" name="devise" defaultValue={ligne?.devise ?? "DZD"} options={DEVISES.map((d) => ({ value: d, label: d }))} />
          <SelectField label="Périodicité" name="periodicite" defaultValue={ligne?.periodicite ?? "MENSUEL"} options={Object.entries(LIBELLE_PERIODICITE).map(([value, label]) => ({ value, label }))} />
          <TextField label="Échéance de renouvellement" name="echeance" type="date" defaultValue={ligne?.echeance ?? ""} />
          <TextField label="Rappel (jours avant)" name="rappelJours" inputMode="numeric" defaultValue={ligne?.rappelJours ?? 30} />
          <SelectField
            label="Ligne budgétaire" name="budgetCategoryId" defaultValue={defautLigne} placeholder="Aucune"
            options={lignesBudget.map((l) => ({ value: l.id, label: l.label }))}
          />
        </div>
        <TextAreaField label="Notes" name="notes" defaultValue={ligne?.notes ?? ""} />
        <div className="space-y-1.5">
          <Label htmlFor="piece">Contrat ou facture</Label>
          <Input id="piece" name="piece" type="file" />
          {ligne && ligne.pieces.length > 0 && (
            <p className="text-xs">{ligne.pieces.map((p) => <a key={p.id} href={`/api/documents/${p.id}`} target="_blank" rel="noreferrer" className="mr-2 text-primary underline">{p.name}</a>)}</p>
          )}
        </div>
        <Retour>{err}</Retour>
        <div className="flex flex-wrap justify-between gap-2">
          {ligne && ligne.statut === "ACTIF" ? (
            <BoutonDecisif type="button" variant="outline" disabled={saving} onClick={() => {
              const fd = new FormData();
              fd.set("id", ligne.id);
              void run(() => resilierAbonnement(fd), onFermer, { succes: "Abonnement résilié." });
            }}>Résilier</BoutonDecisif>
          ) : <span />}
          <Button type="submit" disabled={saving}>{ligne ? "Enregistrer" : "Ajouter"}</Button>
        </div>
      </form>
    </Sheet>
  );
}

export function RegistreAbonnements({ vue, peutCreer, peutModifier, ouvrir }: { vue: VueAbonnements; peutCreer: boolean; peutModifier: boolean; ouvrir?: string | null }) {
  const [fiche, setFiche] = React.useState<LigneAbonnement | "nouveau" | null>(() => (ouvrir ? vue.lignes.find((l) => l.id === ouvrir) ?? null : null));
  const colonnes: Column<LigneAbonnement>[] = [
    { key: "fournisseur", header: "Fournisseur", sortable: true, render: (a) => <span className="font-medium">{a.fournisseur}</span> },
    { key: "objet", header: "Objet", sortable: true },
    { key: "societe", header: "Société", sortable: true },
    { key: "montant", header: "Coût", align: "right", accessor: (a) => a.montant, render: (a) => `${formatMontant(a.montant)} ${a.devise} / ${a.periodicite === "MENSUEL" ? "mois" : "an"}` },
    { key: "coutAnnuel", header: "Par an", align: "right", sortable: true, accessor: (a) => a.coutAnnuel, render: (a) => `${formatMontant(a.coutAnnuel)} ${a.devise}` },
    { key: "echeance", header: "Échéance", sortable: true, accessor: (a) => a.echeance, render: echeanceLisible },
    { key: "ligneBudget", header: "Ligne budgétaire", accessor: (a) => a.ligneBudget },
    { key: "statut", header: "Statut", accessor: (a) => STATUT_ABONNEMENT[a.statut as keyof typeof STATUT_ABONNEMENT]?.label ?? a.statut, render: (a) => <StatusBadge map={STATUT_ABONNEMENT} value={a.statut} /> },
    ...(peutModifier ? [{ key: "geste", header: "", render: (a: LigneAbonnement) => <Button size="sm" variant="ghost" onClick={() => setFiche(a)}>Modifier</Button> }] : []),
  ];
  return (
    <>
      <DataTable
        columns={colonnes} rows={vue.lignes} filename="abonnements-licences" searchPlaceholder="Rechercher un fournisseur, un objet…"
        emptyTitle="Aucun abonnement enregistré"
        emptyDescription={peutCreer ? "Ajoutez le premier : fournisseur, coût, échéance." : "L'équipe Informatique les enregistre ici."}
        toolbar={peutCreer && vue.societes.length > 0 ? <Button size="sm" onClick={() => setFiche("nouveau")}><Plus className="mr-1 h-4 w-4" />Nouvel abonnement</Button> : undefined}
      />
      {fiche && <FicheAbonnement vue={vue} ligne={fiche === "nouveau" ? null : fiche} onFermer={() => setFiche(null)} />}
    </>
  );
}
