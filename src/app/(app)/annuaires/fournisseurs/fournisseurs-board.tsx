"use client";

import * as React from "react";
import { Plus, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Tableur, type ColonneDeTableur } from "@/components/grille/tableur";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { useConfirmer } from "@/components/ui/dialogue";
import { actionFailureMessage } from "@/lib/action-outcome";
import { creerFournisseurAnnuaire, modifierFournisseurAnnuaire, retirerFournisseurAnnuaire } from "@/lib/actions/fournisseurs-annuaire-actions";

export interface FournisseurVue {
  id: string; name: string; country: string | null; contactName: string | null; contactEmail: string | null;
  phone: string | null; website: string | null; address: string | null; city: string | null; notes: string | null;
  active: boolean; dossiers: number; comptes: number;
}

const CHAMPS: { name: keyof FournisseurVue; label: string }[] = [
  { name: "name", label: "Nom / raison sociale" }, { name: "country", label: "Pays" },
  { name: "contactName", label: "Personne à contacter" }, { name: "contactEmail", label: "E-mail" },
  { name: "phone", label: "Téléphone" }, { name: "website", label: "Site web" },
  { name: "city", label: "Ville" }, { name: "address", label: "Adresse" }, { name: "notes", label: "Notes" },
];

/** L'annuaire des fournisseurs Regulatory — chercher, ajouter, corriger, retirer. */
export function FournisseursBoard({ fournisseurs, canCreate, canEdit, canDelete }: { fournisseurs: FournisseurVue[]; canCreate: boolean; canEdit: boolean; canDelete: boolean }) {
  const { enCours, rafraichir } = useRafraichir();
  const confirmer = useConfirmer();
  const [edition, setEdition] = React.useState<FournisseurVue | "nouveau" | null>(null);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);
  const [envoi, setEnvoi] = React.useState(false);
  const occupe = envoi || enCours;

  async function agir(f: () => Promise<{ ok: boolean; error?: string; message?: string }>, apres?: () => void) {
    setEnvoi(true); setMsg(null);
    try {
      const r = await f();
      if (!r.ok) { setMsg({ ok: false, text: r.error ?? "Le fournisseur n'a pas été modifié." }); return; }
      if (r.message) setMsg({ ok: true, text: r.message });
      apres?.();
      rafraichir();
    } catch {
      setMsg({ ok: false, text: actionFailureMessage("THROWN") });
    } finally {
      setEnvoi(false);
    }
  }

  return (
    <div className="space-y-4">
      {msg && <p role={msg.ok ? "status" : "alert"} className={`text-sm ${msg.ok ? "text-success" : "text-destructive"}`}>{msg.text}</p>}

      {edition && (
        <form
          className="surface space-y-3 p-4"
          onSubmit={(ev) => {
            ev.preventDefault();
            const fd = new FormData(ev.currentTarget);
            if (edition === "nouveau") void agir(() => creerFournisseurAnnuaire(fd), () => setEdition(null));
            else { fd.set("id", edition.id); void agir(() => modifierFournisseurAnnuaire(fd), () => setEdition(null)); }
          }}
        >
          <p className="text-sm font-semibold">{edition === "nouveau" ? "Nouveau fournisseur" : edition.name}</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {CHAMPS.map((c) => (
              <div key={c.name}>
                <Label htmlFor={`f-${c.name}`}>{c.label}{c.name === "name" ? " *" : ""}</Label>
                <Input id={`f-${c.name}`} name={c.name} type={c.name === "contactEmail" ? "email" : c.name === "phone" ? "tel" : undefined} required={c.name === "name"} defaultValue={edition === "nouveau" ? "" : ((edition[c.name] as string | null) ?? "")} />
              </div>
            ))}
            {edition !== "nouveau" && (
              <label className="flex items-center gap-2 text-sm">
                <input type="hidden" name="active" value="0" />
                <input type="checkbox" name="active" value="1" defaultChecked={edition.active} /> Actif
              </label>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" type="submit" disabled={occupe}>Enregistrer</Button>
            <Button size="sm" type="button" variant="ghost" onClick={() => setEdition(null)}>Annuler</Button>
          </div>
        </form>
      )}

      {/* LA FEUILLE, COMME DANS EXCEL (recette du 23/11) — filtre par colonne, tri, colonnes à la carte ; Entrée ou
          double-clic ouvre la fiche en modification. Les cartes d'avant ne se triaient ni ne se filtraient par pays. */}
      <Tableur
        lignes={fournisseurs} colonnes={COLONNES} cleLigne={(f) => f.id}
        placeholder="Un fabricant, un pays, un contact…" vide="L'annuaire des fournisseurs est vide."
        estAttenuee={(f) => !f.active}
        onOuvrir={canEdit ? (f) => { if (!occupe) { setMsg(null); setEdition(f); } } : undefined}
        barre={canCreate && <Button size="sm" className="w-full sm:w-auto" onClick={() => { setMsg(null); setEdition("nouveau"); }}><Plus className="h-4 w-4" /> Nouveau fournisseur</Button>}
        actions={canEdit || canDelete ? (f) => (
          <>
            {canEdit && <button type="button" title="Modifier" disabled={occupe} onClick={() => { setMsg(null); setEdition(f); }} aria-label={`Modifier ${f.name}`} className="rounded p-2 text-muted-foreground hover:text-foreground sm:p-1"><Pencil className="h-3.5 w-3.5" /></button>}
            {canDelete && (
              <button type="button" title="Retirer" disabled={occupe}
                onClick={async () => {
                  if (!(await confirmer(`Retirer « ${f.name} » de l'annuaire ?${f.dossiers + f.comptes > 0 ? "\n\nIl porte des dossiers ou des comptes du portail : il sera désactivé, pas supprimé." : ""}`))) return;
                  const fd = new FormData(); fd.set("id", f.id);
                  void agir(() => retirerFournisseurAnnuaire(fd));
                }}
                aria-label={`Retirer ${f.name}`} className="rounded p-2 text-muted-foreground hover:text-destructive sm:p-1"><Trash2 className="h-3.5 w-3.5" /></button>
            )}
          </>
        ) : undefined}
      />
    </div>
  );
}

const lien = "text-primary hover:underline";
const texte = (v: string | null) => v ?? "";

/** Les colonnes de la feuille des fournisseurs — la valeur affichée, et un lien quand la cellule en est un. */
const COLONNES: ColonneDeTableur<FournisseurVue>[] = [
  {
    cle: "name", libelle: "Nom / raison sociale", largeur: 220, masquable: false, valeur: (f) => f.name,
    rendu: (f) => <>{f.name}{!f.active && <span className="ml-1.5 text-xs font-normal">(inactif)</span>}</>,
  },
  { cle: "country", libelle: "Pays", largeur: 120, valeur: (f) => texte(f.country) },
  { cle: "contactName", libelle: "Personne à contacter", largeur: 170, valeur: (f) => texte(f.contactName) },
  {
    cle: "contactEmail", libelle: "E-mail", largeur: 210, valeur: (f) => texte(f.contactEmail),
    rendu: (f) => f.contactEmail ? <a href={`mailto:${f.contactEmail}`} className={lien}>{f.contactEmail}</a> : null,
  },
  {
    cle: "phone", libelle: "Téléphone", largeur: 140, valeur: (f) => texte(f.phone),
    rendu: (f) => f.phone ? <a href={`tel:${f.phone.replace(/\s/g, "")}`} className={lien}>{f.phone}</a> : null,
  },
  {
    cle: "website", libelle: "Site web", largeur: 180, valeur: (f) => texte(f.website),
    rendu: (f) => f.website ? <a href={f.website.startsWith("http") ? f.website : `https://${f.website}`} target="_blank" rel="noopener noreferrer" className={lien}>{f.website}</a> : null,
  },
  { cle: "city", libelle: "Ville", largeur: 120, valeur: (f) => texte(f.city) },
  { cle: "address", libelle: "Adresse", largeur: 220, valeur: (f) => texte(f.address) },
  { cle: "dossiers", libelle: "Dossiers", largeur: 90, alignement: "droite", valeur: (f) => String(f.dossiers) },
  { cle: "comptes", libelle: "Comptes portail", largeur: 120, alignement: "droite", valeur: (f) => String(f.comptes) },
  { cle: "active", libelle: "Statut", largeur: 90, valeur: (f) => (f.active ? "Actif" : "Inactif") },
  { cle: "notes", libelle: "Notes", largeur: 240, valeur: (f) => texte(f.notes) },
];
