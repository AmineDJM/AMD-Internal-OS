"use client";

/**
 * L'ANNUAIRE — la ligne d'ajout d'un praticien.
 */
import * as React from "react";
import { Loader2, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { ANNUAIRE_COLUMNS } from "@/lib/medical/directory-grid";
import { addDirectoryDoctor } from "@/lib/actions/medical-directory-actions";
import type { EtablissementOption } from "@/lib/annuaires/types";
import { libelleEtab } from "./colonnes";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { Retour } from "@/components/ui/retour";
import { actionFailureMessage } from "@/lib/action-outcome";
import { journal } from "@/lib/journal";

/** La ligne d'ajout — un nom (ou prénom) suffit, le reste se remplit ensuite dans la feuille. */
export function AddDoctorRow({
  specialtyListId, titreParDefaut, directoryId, etablissements, specialiteImposee = null, onClose,
}: {
  specialtyListId: string; titreParDefaut?: string; directoryId: string | null; etablissements: readonly EtablissementOption[]; specialiteImposee?: string | null;
  /** La ligne s'ouvre depuis le bouton de la barre (geste principal) ; elle se referme ici. */
  onClose: () => void;
}) {
  const { rafraichir } = useRafraichir();
  const setOpen = (o: boolean) => { if (!o) onClose(); };
  const [lastName, setLastName] = React.useState("");
  const [firstName, setFirstName] = React.useState("");
  const [specialty, setSpecialty] = React.useState("");
  const [wilaya, setWilaya] = React.useState("");
  const [institutionId, setInstitutionId] = React.useState("");
  const [serviceId, setServiceId] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  const wilayaOptions = ANNUAIRE_COLUMNS.find((c) => c.field === "wilaya")?.options ?? [];
  const actifs = etablissements.filter((e) => e.isActive);
  const services = etablissements.find((e) => e.id === institutionId)?.services ?? [];

  const reset = () => { setLastName(""); setFirstName(""); setSpecialty(""); setWilaya(""); setInstitutionId(""); setServiceId(""); setErr(null); };
  const submit = () => {
    setBusy(true); setErr(null);
    void addDirectoryDoctor({
      lastName, firstName, specialty: specialiteImposee ?? specialty, wilaya, title: titreParDefaut, directoryId,
      institutionId: institutionId || null, serviceId: serviceId || null,
    }).then((r) => {
      setBusy(false);
      if (r.ok) { reset(); setOpen(false); rafraichir(); }
      else setErr(r.error ?? "Ajout impossible.");
    }).catch((e: unknown) => { journal.erreur("annuaire-grid.addDirectoryDoctor", {}, e);
      setBusy(false);
      setErr(actionFailureMessage("THROWN"));
    });
  };

  return (
    <div className="space-y-2 rounded-xl border border-border bg-card p-3">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        <Input placeholder="Nom" aria-label="Nom" value={lastName} onChange={(e) => setLastName(e.target.value)} autoFocus />
        <Input placeholder="Prénom" aria-label="Prénom" value={firstName} onChange={(e) => setFirstName(e.target.value)} />
        {/* L'annuaire D'UNE spécialité la pose lui-même : on ne la retape pas. */}
        {!specialiteImposee && <Input placeholder="Spécialité 1" aria-label="Spécialité" list={specialtyListId} value={specialty} onChange={(e) => setSpecialty(e.target.value)} />}
        <Select value={wilaya} aria-label="Wilaya" onChange={(e) => setWilaya(e.target.value)}>
          <option value="">Wilaya…</option>
          {wilayaOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </Select>
        {/* L'ÉTABLISSEMENT DÈS LA CRÉATION (§118.172) — choisi dans l'annuaire, jamais tapé. */}
        <Select value={institutionId} aria-label="Établissement" onChange={(e) => { setInstitutionId(e.target.value); setServiceId(""); }}>
          <option value="">Établissement… (déduit de la wilaya s&apos;il est seul)</option>
          {actifs.map((e) => <option key={e.id} value={e.id}>{libelleEtab(e)}</option>)}
        </Select>
        <Select value={serviceId} aria-label="Service" disabled={!institutionId || services.length === 0} onChange={(e) => setServiceId(e.target.value)}>
          <option value="">{!institutionId ? "Service (choisir l'établissement d'abord)" : services.length === 0 ? "Aucun service renseigné" : "Service…"}</option>
          {services.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </Select>
      </div>
      <Retour ton="erreur">{err}</Retour>
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={busy} onClick={submit} className="flex-1 sm:flex-none">
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Ajouter
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => { reset(); setOpen(false); }} className="flex-1 sm:flex-none">
          <X className="h-3.5 w-3.5" /> Annuler
        </Button>
      </div>
    </div>
  );
}
