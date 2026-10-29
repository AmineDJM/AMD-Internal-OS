"use client";

import * as React from "react";
import { Plus, Pencil, Trash2, Search, Mail, Phone, Globe, MapPin } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
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
  const [q, setQ] = React.useState("");
  const [edition, setEdition] = React.useState<FournisseurVue | "nouveau" | null>(null);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);
  const [envoi, setEnvoi] = React.useState(false);
  const occupe = envoi || enCours;
  const visibles = fournisseurs.filter((f) => !q || `${f.name} ${f.country ?? ""} ${f.contactName ?? ""} ${f.contactEmail ?? ""} ${f.city ?? ""}`.toLowerCase().includes(q.toLowerCase()));

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
      <div className="surface flex flex-wrap items-center gap-2 p-3">
        <div className="relative min-w-0 flex-1 basis-full sm:basis-auto">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Un fabricant, un pays, un contact…" className="pl-8" />
        </div>
        {canCreate && <Button size="sm" className="w-full sm:w-auto" onClick={() => { setMsg(null); setEdition("nouveau"); }}><Plus className="h-4 w-4" /> Nouveau fournisseur</Button>}
      </div>
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

      {visibles.length === 0 ? (
        <p className="surface p-6 text-center text-sm text-muted-foreground">{q ? "Aucun fournisseur ne correspond." : "L'annuaire des fournisseurs est vide."}</p>
      ) : (
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {visibles.map((f) => (
            <li key={f.id} className={`surface group space-y-1 p-3 ${f.active ? "" : "opacity-60"}`}>
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{f.name}{!f.active && <span className="ml-1.5 text-xs font-normal text-muted-foreground">(inactif)</span>}</p>
                  <p className="text-xs text-muted-foreground">{[f.country, `${f.dossiers} dossier(s)`, f.comptes ? `${f.comptes} compte(s) portail` : null].filter(Boolean).join(" · ")}</p>
                </div>
                <span className="flex shrink-0 gap-0.5">
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
                </span>
              </div>
              {f.contactName && <p className="text-xs">{f.contactName}</p>}
              {f.contactEmail && <p className="flex items-center gap-1.5 text-xs"><Mail className="h-3 w-3 text-muted-foreground" /><a href={`mailto:${f.contactEmail}`} className="min-w-0 truncate text-primary hover:underline">{f.contactEmail}</a></p>}
              {f.phone && <p className="flex items-center gap-1.5 text-xs"><Phone className="h-3 w-3 text-muted-foreground" /><a href={`tel:${f.phone.replace(/\s/g, "")}`} className="text-primary hover:underline">{f.phone}</a></p>}
              {f.website && <p className="flex items-center gap-1.5 text-xs"><Globe className="h-3 w-3 text-muted-foreground" /><a href={f.website.startsWith("http") ? f.website : `https://${f.website}`} target="_blank" rel="noopener noreferrer" className="min-w-0 truncate text-primary hover:underline">{f.website}</a></p>}
              {(f.city || f.address) && <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><MapPin className="h-3 w-3" /><span className="truncate">{[f.address, f.city].filter(Boolean).join(", ")}</span></p>}
              {f.notes && <p className="text-xs text-muted-foreground">{f.notes}</p>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
