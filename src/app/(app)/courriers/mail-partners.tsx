"use client";

import * as React from "react";

import { Users, Plus, Pencil, Trash2, Loader2, Power } from "lucide-react";
import { createMailPartner, updateMailPartner, deleteMailPartner } from "@/lib/actions/mail-partner-actions";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Retour } from "@/components/ui/retour";
import { useAction } from "@/components/shared/use-action";

export interface MailPartnerRow {
  id: string;
  name: string;
  kind: string | null;
}

/**
 * LA LISTE DES PARTENAIRES DU REGISTRE — tenue depuis le module, par qui s'en sert.
 *
 * Fournisseur, administration, client, prestataire : ce que le pli concerne à l'extérieur.
 * L'assistante l'alimente en enregistrant ses courriers ; l'envoyer en Administration pour
 * ajouter un nom qu'elle a sous les yeux, c'est garantir que la liste ne vivra pas.
 *
 * Un partenaire cité par des courriers ne se supprime pas — il se DÉSACTIVE : il quitte les
 * menus sans effacer le lien des plis déjà enregistrés. Un courrier est un fait ; il ne
 * s'efface pas parce qu'on nettoie une liste.
 */
export function MailPartnersManager({ partners }: { partners: MailPartnerRow[] }) {
  const [open, setOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<MailPartnerRow | "new" | null>(null);
  const { busy, err, setErr, run } = useAction();
  // Les icônes d'une ligne n'ont pas de place pour parler : un refus part en avis flottant.
  const { run: runLigne } = useAction({ signalerErreurs: true });

  const row = editing && editing !== "new" ? editing : null;

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    await run(() => (row ? updateMailPartner((fd.set("id", row.id), fd)) : createMailPartner(undefined, fd)), () => setEditing(null));
  }

  async function drop(p: MailPartnerRow) {
    const fd = new FormData();
    fd.set("id", p.id);
    await runLigne(() => deleteMailPartner(fd), undefined, { confirmer: `Supprimer « ${p.name} » de la liste des partenaires ?` });
  }

  async function deactivate(p: MailPartnerRow) {
    const fd = new FormData();
    fd.set("id", p.id);
    fd.set("name", p.name);
    if (p.kind) fd.set("kind", p.kind);
    fd.set("isActive", "0");
    await runLigne(() => updateMailPartner(fd));
  }

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Users className="h-4 w-4" /> Partenaires
      </Button>

      <Sheet
        open={open} onClose={() => setOpen(false)} width="md"
        title="Partenaires du registre"
        description="Fournisseurs, administrations, clients, prestataires — ce que vos courriers concernent à l'extérieur. Cette liste n'appartient qu'aux Courriers."
      >
        <div className="space-y-3">
          <div className="flex justify-end">
            <Button size="sm" onClick={() => { setErr(null); setEditing("new"); }}>
              <Plus className="h-4 w-4" /> Nouveau partenaire
            </Button>
          </div>

          {partners.length === 0 ? (
            <p className="rounded-lg border border-border p-4 text-sm text-muted-foreground">
              Aucun partenaire. Ajoutez-en un : il apparaîtra dans le menu « Partenaire concerné »
              du formulaire de courrier.
            </p>
          ) : (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {partners.map((p) => (
                <li key={p.id} className="flex items-center gap-2 px-3 py-2">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{p.name}</span>
                    {p.kind && <span className="block truncate text-[0.6875rem] text-muted-foreground">{p.kind}</span>}
                  </span>
                  <button
                    type="button" onClick={() => { setErr(null); setEditing(p); }}
                    aria-label={`Modifier ${p.name}`} title="Modifier"
                    className="shrink-0 rounded p-2 text-muted-foreground hover:bg-secondary hover:text-foreground sm:p-1.5"
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                  {/* Désactiver retire des menus SANS toucher aux courriers déjà enregistrés. */}
                  <button
                    type="button" onClick={() => void deactivate(p)}
                    aria-label={`Désactiver ${p.name}`} title="Désactiver (le retire des menus)"
                    className="shrink-0 rounded p-2 text-muted-foreground hover:bg-secondary hover:text-foreground sm:p-1.5"
                  >
                    <Power className="h-4 w-4" />
                  </button>
                  <button
                    type="button" onClick={() => void drop(p)}
                    aria-label={`Supprimer ${p.name}`} title="Supprimer"
                    className="shrink-0 rounded p-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive sm:p-1.5"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Sheet>

      {editing && (
        <Sheet
          open onClose={() => setEditing(null)} width="md"
          title={row ? `Modifier « ${row.name} »` : "Nouveau partenaire"}
        >
          <form onSubmit={submit} className="space-y-3">
            <div>
              <Label htmlFor="p-name">Nom</Label>
              <Input id="p-name" name="name" defaultValue={row?.name ?? ""} required placeholder="North Tech Construction" className="mt-1" />
            </div>
            <div>
              <Label htmlFor="p-kind">Nature (facultatif)</Label>
              <Input id="p-kind" name="kind" defaultValue={row?.kind ?? ""} placeholder="Fournisseur, Administration, Client…" className="mt-1" />
            </div>
            <div>
              <Label htmlFor="p-contact">Contact (facultatif)</Label>
              <Input id="p-contact" name="contact" placeholder="Nom, téléphone, e-mail" className="mt-1" />
            </div>
            <div>
              <Label htmlFor="p-notes">Notes</Label>
              <Textarea id="p-notes" name="notes" rows={2} className="mt-1" />
            </div>

            <Retour ton="erreur">{err}</Retour>
            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="outline" onClick={() => setEditing(null)}>Annuler</Button>
              <Button type="submit" disabled={busy}>
                {busy && <Loader2 className="h-4 w-4 animate-spin" />} {row ? "Enregistrer" : "Ajouter"}
              </Button>
            </div>
          </form>
        </Sheet>
      )}
    </>
  );
}
