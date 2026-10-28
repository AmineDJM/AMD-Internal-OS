"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAction } from "@/components/shared/use-action";
import { FolderTree, FolderPlus, Folder, ChevronRight, Pencil, Trash2, Loader2, Home } from "lucide-react";
import { createLegalFolder, updateLegalFolder, deleteLegalFolder } from "@/lib/actions/legal-folder-actions";
import { buildFolderTree, flattenFolders, folderPath, indentedLabel, deletionSummary, type FolderLite } from "@/lib/legal/folders";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export interface FolderRow extends FolderLite {
  companyLabel: string | null;
  documentCount: number;
}

/**
 * L'ARMOIRE DE LEGAL — dossiers, fil d'Ariane, et le compte de ce qu'ils contiennent.
 *
 * Trois cents contrats dans une seule liste se cherchent au filtre, jamais au regard : on sait
 * qu'un bail existe, on ne sait pas comment il s'intitule exactement, et c'est le cas où un
 * filtre par titre ne sert à rien.
 *
 * Le nombre de documents est affiché sur chaque dossier. Sans lui, on ouvre les dossiers un par
 * un pour trouver celui qui n'est pas vide — et l'on finit par revenir à la liste complète.
 *
 * ⚠️ Un dossier ne donne AUCUN droit : un engagement restreint à ses lecteurs le reste, où
 * qu'il soit rangé.
 */
export function LegalFolderBar({
  folders, current, companies, canManage,
}: {
  folders: FolderRow[];
  /** Dossier ouvert, `null` = racine (tout), `"none"` = les non classés. */
  current: string | null;
  companies: { id: string; label: string }[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [adding, setAdding] = React.useState(false);
  const [editing, setEditing] = React.useState<FolderRow | null>(null);
  const fiche = useAction();
  // L'icône « supprimer » n'a pas de place pour parler : un refus part en avis flottant.
  const suppression = useAction({ signalerErreurs: true });
  const busy = fiche.busy || suppression.busy;
  const { err, setErr } = fiche;

  const tree = React.useMemo(() => buildFolderTree(folders), [folders]);
  const flat = React.useMemo(() => flattenFolders(tree), [tree]);
  const byId = React.useMemo(() => new Map(folders.map((f) => [f.id, f])), [folders]);
  const path = React.useMemo(
    () => (current && current !== "none" ? folderPath(folders, current) : []),
    [folders, current],
  );
  const openFolder = current && current !== "none" ? byId.get(current) ?? null : null;
  // Les dossiers affichés : ceux du niveau courant.
  const shown = folders.filter((f) => f.parentId === (openFolder?.id ?? null));

  const href = (id: string | null) => (id ? `/legal?dossier=${id}` : "/legal");

  const remove = async (f: FolderRow) => {
    const subs = folders.filter((x) => x.parentId === f.id).length;
    const fd = new FormData(); fd.set("id", f.id);
    await suppression.run(
      async () => {
        const r = await deleteLegalFolder(fd);
        return r.ok ? r : { ...r, error: r.error ?? "Le dossier n'a pas été supprimé." };
      },
      () => { if (current === f.id) router.push("/legal"); },
      { confirmer: `Supprimer le dossier « ${f.name} » ?\n\n${deletionSummary({ subfolders: subs, documents: f.documentCount })}` },
    );
  };

  return (
    <section className="surface space-y-3 p-3 sm:p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <FolderTree className="h-4 w-4 text-primary" /> Dossiers
        </h2>
        {canManage && (
          <Button size="sm" variant="outline" className="ml-auto" onClick={() => { setErr(null); setAdding(true); }}>
            <FolderPlus className="h-4 w-4" /> Nouveau dossier
          </Button>
        )}
      </div>

      {/* FIL D'ARIANE — on doit pouvoir remonter d'un cran, pas seulement revenir tout en haut. */}
      <nav className="flex flex-wrap items-center gap-1 text-sm">
        <Link href="/legal" className={cn("inline-flex items-center gap-1 rounded-md px-2 py-1 hover:bg-secondary", !current && "font-medium text-primary")}>
          <Home className="h-3.5 w-3.5" /> Tous les engagements
        </Link>
        {path.map((f) => (
          <React.Fragment key={f.id}>
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <Link href={href(f.id)} className={cn("rounded-md px-2 py-1 hover:bg-secondary", f.id === current && "font-medium text-primary")}>
              {f.name}
            </Link>
          </React.Fragment>
        ))}
      </nav>

      <div className="flex flex-wrap gap-2">
        {shown.length === 0 && !openFolder ? (
          <p className="text-xs text-muted-foreground">
            Aucun dossier. {canManage ? "Créez « Baux », « Assurances », « Prestataires 2026 »… — un engagement se dépose vite, il se range ensuite." : "Legal n'a pas encore classé les engagements."}
          </p>
        ) : (
          shown.map((f) => (
            <span
              key={f.id}
              className={cn(
                "group inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-sm transition-colors",
                f.id === current ? "border-primary bg-primary/5" : "border-border hover:bg-secondary",
              )}
            >
              <Link href={href(f.id)} className="inline-flex min-h-7 min-w-0 items-center gap-1.5">
                <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{f.name}</span>
                <span className="text-xs text-muted-foreground">({f.documentCount})</span>
                {f.companyLabel && <span className="text-[0.6875rem] text-muted-foreground">· {f.companyLabel}</span>}
              </Link>
              {canManage && (
                <span className="inline-flex items-center gap-0.5 [@media(hover:hover)]:hidden [@media(hover:hover)]:group-hover:inline-flex">
                  <button type="button" title="Renommer / déplacer" onClick={() => { setErr(null); setEditing(f); }} aria-label="Renommer / déplacer" className="rounded p-1.5 text-muted-foreground hover:text-foreground sm:p-0.5">
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button type="button" title="Supprimer" disabled={busy} onClick={() => void remove(f)} aria-label="Supprimer" className="rounded p-1.5 text-muted-foreground hover:text-destructive sm:p-0.5">
                    {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                  </button>
                </span>
              )}
            </span>
          ))
        )}
        {/* LES NON CLASSÉS ont leur porte : sans elle, un engagement déposé vite et jamais rangé
            devient invisible dès qu'on prend l'habitude d'ouvrir un dossier. */}
        <Link
          href="/legal?dossier=none"
          className={cn(
            "inline-flex items-center gap-1.5 rounded-lg border border-dashed px-2.5 py-1.5 text-sm transition-colors",
            current === "none" ? "border-primary bg-primary/5 text-primary" : "border-border text-muted-foreground hover:bg-secondary",
          )}
        >
          Non classés
        </Link>
      </div>

      {adding && (
        <FolderSheet
          title="Nouveau dossier"
          companies={companies}
          folders={flat.map((n) => ({ id: n.id, label: indentedLabel(n) }))}
          defaults={{ parentId: openFolder?.id ?? "" }}
          busy={busy} err={err}
          onClose={() => setAdding(false)}
          onSubmit={async (fd) => {
            await fiche.run(() => createLegalFolder(undefined, fd), () => setAdding(false));
          }}
        />
      )}

      {editing && (
        <FolderSheet
          title={`Dossier — ${editing.name}`}
          companies={companies}
          folders={flat.filter((n) => n.id !== editing.id).map((n) => ({ id: n.id, label: indentedLabel(n) }))}
          defaults={{ name: editing.name, parentId: editing.parentId ?? "", companyId: editing.companyId ?? "" }}
          busy={busy} err={err}
          onClose={() => setEditing(null)}
          onSubmit={async (fd) => {
            fd.set("id", editing.id);
            await fiche.run(() => updateLegalFolder(fd), () => setEditing(null));
          }}
        />
      )}
    </section>
  );
}

function FolderSheet({
  title, companies, folders, defaults, busy, err, onClose, onSubmit,
}: {
  title: string;
  companies: { id: string; label: string }[];
  folders: { id: string; label: string }[];
  defaults: { name?: string; parentId?: string; companyId?: string };
  busy: boolean;
  err: string | null;
  onClose: () => void;
  onSubmit: (fd: FormData) => Promise<void>;
}) {
  return (
    <Sheet
      open onClose={() => !busy && onClose()} width="md" title={title}
      description="Un dossier range, il n'autorise pas : un engagement restreint à ses lecteurs le reste, où qu'il soit classé."
    >
      <form action={onSubmit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="lf-name">Nom du dossier</Label>
          <Input id="lf-name" name="name" required defaultValue={defaults.name} placeholder="Baux, Assurances, Prestataires 2026…" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="lf-parent">Rangé sous</Label>
          <Select id="lf-parent" name="parentId" defaultValue={defaults.parentId ?? ""}>
            <option value="">— Racine —</option>
            {folders.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="lf-company">Entité</Label>
          <Select id="lf-company" name="companyId" defaultValue={defaults.companyId ?? ""}>
            <option value="">Commun au groupe</option>
            {companies.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="lf-desc">Description (facultative)</Label>
          <Textarea id="lf-desc" name="description" rows={2} />
        </div>
        {err && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>Annuler</Button>
          <Button type="submit" disabled={busy}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Enregistrer</Button>
        </div>
      </form>
    </Sheet>
  );
}
