"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BookUser, Plus, Pencil, Trash2, Loader2, Lock, Users } from "lucide-react";
import {
  createMedicalDirectory, updateMedicalDirectory, deleteMedicalDirectory, setDirectoryAccess,
} from "@/lib/actions/medical-directory-crud-actions";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useAction } from "@/components/shared/use-action";
import { Retour } from "@/components/ui/retour";

import type { DirectoryRow } from "@/lib/annuaires/types";

export type { DirectoryRow };

/**
 * LES ANNUAIRES — plusieurs listes nommées, pas une seule.
 *
 * « Cardiologues Centre », « Prescripteurs Oncologie », « Congrès 2026 » : une entreprise en tient
 * plusieurs, et les fondre en un seul annuaire les rend tous inutilisables. On importe trois cents
 * noms pour une campagne, et la liste de tout le monde est polluée pour six mois.
 *
 * Le compte de praticiens s'affiche sur chaque annuaire : sans lui, on les ouvre un par un pour
 * trouver celui qui n'est pas vide.
 *
 * ⚠️ Un annuaire RANGE, il n'AUTORISE pas : le cloisonnement par entité et la portée du délégué
 * restent les seules règles d'accès.
 */
export function DirectoryBar({
  directories, current, companies, generalCount, canManage, people = [], basePath = "/medical/annuaire",
}: {
  directories: DirectoryRow[];
  /**
   * L'ADRESSE de la feuille sur laquelle la barre est montée. La même barre sert l'onglet Annuaire
   * de la Promotion médicale et les onglets Médecins / Pharmaciens du module « Annuaires » : un
   * lien écrit en dur renverrait la personne dans l'autre module à chaque clic.
   */
  basePath?: string;
  /** Annuaire ouvert : `null` = tous, `"general"` = ceux qui ne sont dans aucun annuaire. */
  current: string | null;
  companies: { id: string; label: string }[];
  generalCount: number;
  canManage: boolean;
  /** Personnes désignables pour l'accès. Vide → le réglage d'accès n'apparaît pas. */
  people?: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [adding, setAdding] = React.useState(false);
  const [editing, setEditing] = React.useState<DirectoryRow | null>(null);
  const [accessFor, setAccessFor] = React.useState<DirectoryRow | null>(null);
  // Les fiches (créer, renommer, accès) disent leur erreur dans la fiche ; la corbeille d'une
  // pastille n'a pas de place pour parler : son refus part en avis flottant.
  const fiche = useAction();
  const suppression = useAction({ signalerErreurs: true });
  const busy = fiche.busy || suppression.busy;
  const { err, setErr, run } = fiche;

  const href = (id: string | null) => (id ? `${basePath}?annuaire=${id}` : basePath);

  const remove = async (d: DirectoryRow) => {
    const fd = new FormData(); fd.set("id", d.id);
    const ok = await suppression.run(() => deleteMedicalDirectory(fd), undefined, {
      confirmer: `Supprimer l'annuaire « ${d.name} » ?\n\n${d.doctorCount} praticien(s) repasseront dans l'annuaire général — aucun n'est supprimé.`,
    });
    if (ok && current === d.id) router.push(basePath);
  };

  return (
    <section className="surface space-y-3 p-3 sm:p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <BookUser className="h-4 w-4 text-primary" /> Annuaires
        </h2>
        {canManage && (
          // Discret : le geste principal de l'écran est dans la feuille (ajouter une fiche) — Direction, 07/10.
          <Button size="sm" variant="ghost" className="ml-auto h-10 sm:h-8" onClick={() => { setErr(null); setAdding(true); }}>
            <Plus className="h-4 w-4" /> Nouvel annuaire
          </Button>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <Link
          href={basePath}
          className={cn(
            "inline-flex min-h-9 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-sm transition-colors sm:min-h-0",
            !current ? "border-primary bg-primary/5 font-medium text-primary" : "border-border hover:bg-secondary",
          )}
        >
          Tous les praticiens
        </Link>

        {directories.map((d) => (
          <span
            key={d.id}
            className={cn(
              "group inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-sm transition-colors",
              d.id === current ? "border-primary bg-primary/5" : "border-border hover:bg-secondary",
            )}
          >
            <Link href={href(d.id)} className="inline-flex min-h-8 min-w-0 items-center gap-1.5">
              <span className="truncate">{d.name}</span>
              <span className="text-xs text-muted-foreground">({d.doctorCount})</span>
              {d.companyLabel && <span className="text-[0.6875rem] text-muted-foreground">· {d.companyLabel}</span>}
              {/* Le cadenas dit qu'un accès est réglé — sans lui, un collègue qui ne voit pas
                  l'annuaire croirait à un bug et demanderait pourquoi. */}
              {d.accessUserIds.length > 0 && <Lock className="h-3 w-3 shrink-0 text-warning" aria-label="Accès restreint" />}
            </Link>
            {canManage && (
              // Au doigt, pas de survol : les actions restent visibles ; à la souris, elles n'apparaissent qu'au survol.
              <span className="inline-flex shrink-0 items-center gap-0.5 [@media(hover:hover)]:hidden [@media(hover:hover)]:group-focus-within:inline-flex [@media(hover:hover)]:group-hover:inline-flex">
                <button type="button" title="Renommer" aria-label="Renommer" onClick={() => { setErr(null); setEditing(d); }} className="inline-flex h-9 w-9 items-center justify-center rounded text-muted-foreground hover:text-foreground sm:h-7 sm:w-7">
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                {people.length > 0 && (
                  <button type="button" title="Gérer l'accès" aria-label="Gérer l'accès" onClick={() => { setErr(null); setAccessFor(d); }} className="inline-flex h-9 w-9 items-center justify-center rounded text-muted-foreground hover:text-foreground sm:h-7 sm:w-7">
                    <Users className="h-3.5 w-3.5" />
                  </button>
                )}
                <button type="button" title="Supprimer" aria-label="Supprimer" disabled={busy} onClick={() => void remove(d)} className="inline-flex h-9 w-9 items-center justify-center rounded text-muted-foreground hover:text-destructive sm:h-7 sm:w-7">
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                </button>
              </span>
            )}
          </span>
        ))}

        {/* L'ANNUAIRE GÉNÉRAL a sa porte : sans elle, un praticien saisi vite et jamais rangé
            devient invisible dès qu'on prend l'habitude d'ouvrir un annuaire nommé. */}
        <Link
          href={`${basePath}?annuaire=general`}
          className={cn(
            "inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-dashed px-2.5 py-1.5 text-sm transition-colors sm:min-h-0",
            current === "general" ? "border-primary bg-primary/5 text-primary" : "border-border text-muted-foreground hover:bg-secondary",
          )}
        >
          Annuaire général <span className="text-xs">({generalCount})</span>
        </Link>
      </div>

      {adding && (
        <DirectorySheet
          title="Nouvel annuaire" companies={companies} defaults={{}} busy={busy} err={err}
          onClose={() => setAdding(false)}
          onSubmit={async (fd) => {
            await run(() => createMedicalDirectory(undefined, fd), () => setAdding(false));
          }}
        />
      )}

      {editing && (
        <DirectorySheet
          title={`Annuaire — ${editing.name}`} companies={companies}
          defaults={{ name: editing.name, companyId: editing.companyId ?? "" }}
          busy={busy} err={err}
          onClose={() => setEditing(null)}
          onSubmit={async (fd) => {
            fd.set("id", editing.id);
            await run(() => updateMedicalDirectory(fd), () => setEditing(null));
          }}
        />
      )}

      {accessFor && (
        <AccessSheet
          directory={accessFor} people={people} busy={busy} err={err}
          onClose={() => setAccessFor(null)}
          onSubmit={async (fd) => {
            fd.set("id", accessFor.id);
            await run(() => setDirectoryAccess(fd), () => setAccessFor(null));
          }}
        />
      )}
    </section>
  );
}

/**
 * QUI PEUT OUVRIR CET ANNUAIRE — des cases à cocher, pas un jargon de rôles.
 *
 * Aucune case cochée = ouvert à tout le module, le cas normal. Cocher des noms FERME l'annuaire
 * à tous les autres (hors vue globale) : celui qui règle l'accès reste dedans d'office — le
 * serveur l'y garde même s'il oublie sa propre case.
 */
function AccessSheet({
  directory, people, busy, err, onClose, onSubmit,
}: {
  directory: DirectoryRow;
  people: { id: string; name: string }[];
  busy: boolean;
  err: string | null;
  onClose: () => void;
  onSubmit: (fd: FormData) => Promise<void>;
}) {
  const initial = new Set(directory.accessUserIds);
  return (
    <Sheet
      open onClose={() => !busy && onClose()} width="md" title={`Accès — ${directory.name}`}
      description="Aucun nom coché : ouvert à tout le module."
    >
      <form action={onSubmit} className="space-y-4">
        <div className="max-h-72 space-y-1 overflow-y-auto rounded-lg border border-border p-2">
          {people.map((p) => (
            <label key={p.id} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm hover:bg-secondary sm:py-1">
              <input type="checkbox" name="userId" value={p.id} defaultChecked={initial.has(p.id)} className="h-4 w-4 shrink-0 accent-primary" />
              <span className="min-w-0 truncate">{p.name}</span>
            </label>
          ))}
        </div>
        <Retour ton="erreur">{err}</Retour>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" onClick={onClose} disabled={busy} className="w-full sm:w-auto">Annuler</Button>
          <Button type="submit" disabled={busy} className="w-full sm:w-auto">{busy && <Loader2 className="h-4 w-4 animate-spin" />} Enregistrer l&apos;accès</Button>
        </div>
      </form>
    </Sheet>
  );
}

function DirectorySheet({
  title, companies, defaults, busy, err, onClose, onSubmit,
}: {
  title: string;
  companies: { id: string; label: string }[];
  defaults: { name?: string; companyId?: string };
  busy: boolean;
  err: string | null;
  onClose: () => void;
  onSubmit: (fd: FormData) => Promise<void>;
}) {
  return (
    <Sheet open onClose={() => !busy && onClose()} width="md" title={title}>
      <form action={onSubmit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="md-name">Nom de l&apos;annuaire</Label>
          <Input id="md-name" name="name" required defaultValue={defaults.name} placeholder="Cardiologues Centre, Congrès 2026…" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="md-company">Entité</Label>
          <Select id="md-company" name="companyId" defaultValue={defaults.companyId ?? ""}>
            <option value="">Commun au groupe</option>
            {companies.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="md-desc">Description (facultative)</Label>
          <Textarea id="md-desc" name="description" rows={2} />
        </div>
        <Retour ton="erreur">{err}</Retour>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" onClick={onClose} disabled={busy} className="w-full sm:w-auto">Annuler</Button>
          <Button type="submit" disabled={busy} className="w-full sm:w-auto">{busy && <Loader2 className="h-4 w-4 animate-spin" />} Enregistrer</Button>
        </div>
      </form>
    </Sheet>
  );
}
