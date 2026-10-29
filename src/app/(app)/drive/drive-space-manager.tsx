"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { FolderPlus, Loader2, Check, Settings2, Trash2 } from "lucide-react";
import { createDriveSpace, updateDriveSpace, archiveDriveSpace, deleteDriveSpace } from "@/lib/actions/drive-space-actions";
import { Sheet } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { useConfirmer } from "@/components/ui/dialogue";
import { Retour } from "@/components/ui/retour";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";
import { ROLE_LABELS } from "@/lib/labels";

type UserOpt = { id: string; name: string };
export type SpaceData = {
  id: string; name: string; icon: string | null;
  accessRoles: string[]; accessUserIds: string[]; managerRoles: string[]; managerUserIds: string[];
};

// Tous les rôles sauf le Super Admin (qui gère TOUT par défaut).
const ROLE_ENTRIES = (Object.entries(ROLE_LABELS) as [string, string][]).filter(([r]) => r !== "SUPER_ADMIN");

function RoleGrid({ name, selected, max = "max-h-40" }: { name: string; selected: string[]; max?: string }) {
  return (
    <div className={`grid grid-cols-1 gap-x-4 gap-y-0.5 overflow-y-auto rounded-lg border border-input p-2.5 sm:grid-cols-2 sm:gap-y-1.5 ${max}`}>
      {ROLE_ENTRIES.map(([r, lbl]) => (
        <label key={r} className="flex min-w-0 items-center gap-1.5 py-1.5 text-sm sm:py-0">
          <input type="checkbox" name={name} value={r} defaultChecked={selected.includes(r)} className="h-4 w-4 rounded border-input" />
          {lbl}
        </label>
      ))}
    </div>
  );
}

function UserGrid({ name, users, selected, max = "max-h-40" }: { name: string; users: UserOpt[]; selected: string[]; max?: string }) {
  if (users.length === 0) return null;
  return (
    <div className={`grid grid-cols-1 gap-x-4 gap-y-0.5 overflow-y-auto rounded-lg border border-input p-2.5 sm:grid-cols-2 sm:gap-y-1.5 ${max}`}>
      {users.map((u) => (
        <label key={u.id} className="flex min-w-0 items-center gap-1.5 py-1.5 text-sm sm:py-0">
          <input type="checkbox" name={name} value={u.id} defaultChecked={selected.includes(u.id)} className="h-4 w-4 rounded border-input" />
          {u.name}
        </label>
      ))}
    </div>
  );
}

/** Champs partagés création/édition : nom, icône, listes d'accès (consultation + gestion). */
function AccessFields({ users, space }: { users: UserOpt[]; space?: SpaceData }) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {/* Le nom prend deux colonnes SUR TROIS — mais seulement quand il y en a trois. Sur une
            grille à une colonne, `col-span-2` fabriquerait une deuxième colonne implicite et
            casserait l'alignement. */}
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="name">Nom de la catégorie</Label>
          <Input id="name" name="name" required defaultValue={space?.name} placeholder="ex. Promotion Médicale" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="icon">Icône (option.)</Label>
          <Input id="icon" name="icon" defaultValue={space?.icon ?? ""} placeholder="FolderOpen" />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label>Consultation — rôles</Label>
        <RoleGrid name="accessRoles" selected={space?.accessRoles ?? []} />
      </div>
      <div className="space-y-1.5">
        <Label>Consultation — personnes</Label>
        <UserGrid name="accessUserIds" users={users} selected={space?.accessUserIds ?? []} />
      </div>

      <div className="space-y-2 rounded-lg border border-dashed border-input p-2.5">
        <Label>Gestion (déposer, organiser, supprimer, régler les accès)</Label>
        <RoleGrid name="managerRoles" selected={space?.managerRoles ?? []} max="max-h-32" />
        <UserGrid name="managerUserIds" users={users} selected={space?.managerUserIds ?? []} max="max-h-32" />
        <p className="text-xs text-muted-foreground">Les gestionnaires voient et modifient le contenu ; les personnes en consultation le voient sans le modifier.</p>
      </div>
    </div>
  );
}

/** Bouton « Nouvelle catégorie » (réservé aux créateurs autorisés par le Super Admin). */
export function CreateSpaceButton({ users }: { users: UserOpt[] }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  return (
    <>
      <Button type="button" onClick={() => { setErr(null); setOpen(true); }}><FolderPlus className="h-4 w-4" /> Nouvelle catégorie</Button>
      <Sheet open={open} onClose={() => !saving && setOpen(false)} title="Nouvelle catégorie de Drive" description="Un espace partagé présenté en onglet à côté de Drive et Documents." width="lg">
        <form
          action={async (fd) => {
            setSaving(true); setErr(null);
            try {
              const r = await createDriveSpace(fd);
              if (r.ok && r.id) { setOpen(false); router.push(`/drive/espace/${r.id}`); } else setErr(r.error ?? "La catégorie n'a pas été créée.");
            } catch {
              setErr(actionFailureMessage("THROWN"));
            } finally {
              setSaving(false);
            }
          }}
          className="space-y-4"
        >
          <AccessFields users={users} />
          <Retour ton="erreur">{err}</Retour>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={saving}>Annuler</Button>
            <Button type="submit" disabled={saving}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Créer</Button>
          </div>
        </form>
      </Sheet>
    </>
  );
}

/** Réglages d'une catégorie (nom, accès), archivage, et suppression (Super Admin). */
export function SpaceSettingsButton({ space, users, canDelete }: { space: SpaceData; users: UserOpt[]; canDelete: boolean }) {
  const router = useRouter();
  const { rafraichir } = useRafraichir();
  const confirmer = useConfirmer();
  const [open, setOpen] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) => {
    setSaving(true); setErr(null);
    try {
      const r = await fn();
      if (r.ok) { setOpen(false); after ? after() : rafraichir(); } else setErr(r.error ?? "La catégorie n'a pas été modifiée.");
    } catch {
      setErr(actionFailureMessage("THROWN"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Button variant="outline" size="sm" type="button" onClick={() => { setErr(null); setOpen(true); }}><Settings2 className="h-4 w-4" /> Accès & réglages</Button>
      <Sheet open={open} onClose={() => !saving && setOpen(false)} title={`Catégorie « ${space.name} »`} description="Renommer, régler qui y a accès, archiver ou supprimer." width="lg">
        <form action={(fd) => run(() => { fd.set("id", space.id); return updateDriveSpace(fd); })} className="space-y-4">
          <AccessFields users={users} space={space} />
          <Retour ton="erreur">{err}</Retour>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" disabled={saving}
                onClick={() => run(() => { const fd = new FormData(); fd.set("id", space.id); fd.set("archived", "1"); return archiveDriveSpace(fd); }, () => router.push("/drive"))}>
                Archiver
              </Button>
              {canDelete && (
                <Button type="button" variant="outline" size="sm" disabled={saving}
                  onClick={async () => {
                    if (!(await confirmer(`Supprimer définitivement « ${space.name} » et TOUT son contenu ? Action irréversible.`))) return;
                    run(() => { const fd = new FormData(); fd.set("id", space.id); return deleteDriveSpace(fd); }, () => router.push("/drive"));
                  }}
                  className="text-destructive hover:bg-destructive/10">
                  <Trash2 className="h-4 w-4" /> Supprimer
                </Button>
              )}
            </div>
            <div className="ml-auto flex gap-2">
              <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={saving}>Annuler</Button>
              <Button type="submit" disabled={saving}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Enregistrer</Button>
            </div>
          </div>
        </form>
      </Sheet>
    </>
  );
}
