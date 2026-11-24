"use client";

import * as React from "react";
import { Folder, FileText, ChevronRight, House, Loader2, X, Check, FolderSearch } from "lucide-react";
import { browseDrive, type BrowseNode } from "@/lib/actions/drive-browse-actions";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { MES_FICHIERS } from "@/lib/drive/explorer";

/**
 * L'EXPLORATEUR DU DRIVE, OUVERT EN PLACE — pour désigner un fichier ou un dossier existant
 * sans quitter le formulaire qu'on est en train de remplir.
 *
 * Ce qu'il désigne n'est JAMAIS recopié : c'est une référence vers le nœud du Drive. Le fichier
 * continue de s'y versionner, de s'y renommer et de s'y partager, et l'écran qui le référence en
 * montre toujours la version courante. Deux copies auraient divergé dès la première correction.
 *
 * Un DOSSIER se désigne comme un fichier : un contrat arrive souvent en liasse (l'original, ses
 * annexes, le ZIP du fournisseur), et n'accepter que des fichiers obligerait à choisir lequel des
 * cinq « fait foi ».
 */

export interface DrivePickerValue {
  id: string;
  name: string;
  isFolder: boolean;
}

/** Le champ de formulaire : un bouton, la sélection, et l'`input` caché qui la transporte. */
export function DrivePickerField({
  name, label, hint, defaultValue,
}: {
  name: string;
  label: string;
  hint?: string;
  defaultValue?: DrivePickerValue | null;
}) {
  const [open, setOpen] = React.useState(false);
  const [picked, setPicked] = React.useState<DrivePickerValue | null>(defaultValue ?? null);

  return (
    <div className="space-y-1.5">
      <span className="block text-sm font-medium">{label}</span>
      {/* La valeur voyage dans un champ caché : le formulaire reste un formulaire, et l'action
          serveur lit un identifiant comme n'importe quel autre champ. */}
      <input type="hidden" name={name} value={picked?.id ?? ""} />

      {picked ? (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-secondary/30 px-2.5 py-2">
          {picked.isFolder ? <Folder className="h-4 w-4 shrink-0 text-primary" /> : <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />}
          <span className="min-w-0 flex-1 truncate text-sm">{picked.name}</span>
          <button
            type="button" onClick={() => setPicked(null)} aria-label="Retirer l'association"
            className="shrink-0 rounded p-2 text-muted-foreground hover:bg-secondary hover:text-destructive sm:p-1"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ) : (
        <Button type="button" variant="outline" onClick={() => setOpen(true)} className="w-full justify-start">
          <FolderSearch className="h-4 w-4" /> Associer un dossier / fichier du Drive
        </Button>
      )}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}

      {open && (
        <DriveExplorerSheet
          onClose={() => setOpen(false)}
          onPick={(v) => { setPicked(v); setOpen(false); }}
        />
      )}
    </div>
  );
}

const KB = 1024;
const fmtSize = (n: number | null) =>
  n == null ? "" : n >= KB ** 3 ? `${(n / KB ** 3).toFixed(1)} Go` : n >= KB ** 2 ? `${(n / KB ** 2).toFixed(1)} Mo` : `${Math.ceil(n / KB)} Ko`;

/**
 * Le panneau d'exploration : catégories, fil d'Ariane, contenu du dossier courant.
 *
 * EXPORTÉ pour être ouvert hors d'un formulaire — la messagerie s'en sert pour joindre un
 * document du Drive sans le recopier, et un second explorateur écrit pour l'occasion aurait
 * divergé de celui-ci dès la première correction.
 */
export function DriveExplorerSheet({ onClose, onPick }: { onClose: () => void; onPick: (v: DrivePickerValue) => void }) {
  const [spaceId, setSpaceId] = React.useState<string | null>(null);
  const [folderId, setFolderId] = React.useState<string | null>(null);
  const [spaces, setSpaces] = React.useState<{ id: string; name: string }[]>([]);
  const [nodes, setNodes] = React.useState<BrowseNode[]>([]);
  const [crumbs, setCrumbs] = React.useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [err, setErr] = React.useState<string | null>(null);
  const [sel, setSel] = React.useState<DrivePickerValue | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true); setErr(null);
    browseDrive({ folderId, spaceId })
      .then((r) => {
        if (cancelled) return;
        setSpaces(r.spaces);
        if (!r.ok) { setErr(r.error ?? "Lecture impossible."); setNodes([]); setCrumbs([]); return; }
        setNodes(r.nodes);
        setCrumbs(r.breadcrumb);
      })
      .catch(() => { if (!cancelled) setErr("Le Drive n'a pas répondu."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [folderId, spaceId]);

  const goto = (id: string | null) => { setSel(null); setFolderId(id); };
  const switchSpace = (id: string | null) => { setSel(null); setSpaceId(id); setFolderId(null); };

  return (
    <Sheet
      open onClose={onClose} width="lg"
      title="Explorateur du Drive"
      description="Choisissez un dossier ou un fichier. Il RESTE dans le Drive : il n'est ni copié ni déplacé, et c'est toujours sa version courante qui s'affichera."
    >
      <div className="space-y-3">
        {/* Les catégories partagées + le Drive personnel : la même porte que l'écran du Drive. */}
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button" onClick={() => switchSpace(null)}
            className={cn(
              "rounded-full border px-2.5 py-2 text-xs font-medium transition-colors sm:py-1",
              spaceId === null ? "border-primary bg-primary/10 text-primary" : "border-border hover:bg-secondary",
            )}
          >
            {MES_FICHIERS}
          </button>
          {spaces.map((s) => (
            <button
              key={s.id} type="button" onClick={() => switchSpace(s.id)}
              className={cn(
                "max-w-[12rem] truncate rounded-full border px-2.5 py-2 text-xs sm:py-1 font-medium transition-colors",
                spaceId === s.id ? "border-primary bg-primary/10 text-primary" : "border-border hover:bg-secondary",
              )}
            >
              {s.name}
            </button>
          ))}
        </div>

        {/* Fil d'Ariane — il défile SEUL sur un écran étroit, sans pousser la page. */}
        <div className="-mx-1 flex items-center gap-1 overflow-x-auto px-1 pb-1 text-xs text-muted-foreground">
          <button type="button" onClick={() => goto(null)} className="flex shrink-0 items-center gap-1 rounded px-1.5 py-2 hover:bg-secondary sm:py-1">
            <House className="h-3.5 w-3.5" /> {spaceId === null ? MES_FICHIERS : (spaces.find((s) => s.id === spaceId)?.name ?? "Racine")}
          </button>
          {crumbs.map((c) => (
            <React.Fragment key={c.id}>
              <ChevronRight className="h-3.5 w-3.5 shrink-0" />
              <button
                type="button" onClick={() => goto(c.id)}
                className="max-w-[10rem] shrink-0 truncate rounded px-1.5 py-2 hover:bg-secondary sm:py-1"
              >
                {c.name}
              </button>
            </React.Fragment>
          ))}
        </div>

        <div className="min-h-[16rem] rounded-lg border border-border">
          {loading ? (
            <p className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Lecture du Drive…
            </p>
          ) : err ? (
            <p className="px-3 py-8 text-center text-sm text-destructive">{err}</p>
          ) : nodes.length === 0 ? (
            <p className="px-3 py-8 text-center text-sm text-muted-foreground">Ce dossier est vide.</p>
          ) : (
            <ul className="max-h-[45dvh] divide-y divide-border overflow-y-auto">
              {nodes.map((n) => {
                const chosen = sel?.id === n.id;
                return (
                  <li key={n.id} className={cn("flex items-center gap-2 px-2.5 py-2", chosen && "bg-primary/5")}>
                    {/* OUVRIR et CHOISIR sont deux gestes distincts : sur un dossier, cliquer le
                        nom entre dedans, et le bouton « Choisir » le désigne. Confondre les deux
                        rendrait un dossier impossible à sélectionner. */}
                    <button
                      type="button"
                      onClick={() => (n.isFolder ? goto(n.id) : setSel({ id: n.id, name: n.name, isFolder: false }))}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    >
                      {n.isFolder
                        ? <Folder className="h-4 w-4 shrink-0 text-primary" />
                        : <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />}
                      <span className="min-w-0 flex-1 truncate text-sm">{n.name}</span>
                      {!n.isFolder && <span className="hidden shrink-0 text-[0.6875rem] text-muted-foreground sm:inline">{fmtSize(n.size)}</span>}
                    </button>
                    <Button
                      type="button" size="sm" variant={chosen ? "primary" : "outline"}
                      onClick={() => setSel({ id: n.id, name: n.name, isFolder: n.isFolder })}
                    >
                      {chosen ? <Check className="h-4 w-4" /> : null} Choisir
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2">
          {sel && <span className="mr-auto min-w-0 truncate text-xs text-muted-foreground">Sélection : <strong>{sel.name}</strong></span>}
          <Button type="button" variant="outline" onClick={onClose}>Annuler</Button>
          <Button type="button" disabled={!sel} onClick={() => sel && onPick(sel)}>Associer</Button>
        </div>
      </div>
    </Sheet>
  );
}
