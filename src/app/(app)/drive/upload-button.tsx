"use client";

import * as React from "react";
import { Upload, Search, Eye, Pencil, FolderUp, FileUp, ChevronDown, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Input, Label } from "@/components/ui/input";
import { useLimitesEnvoi } from "@/components/layout/use-limites-envoi";
import { cn } from "@/lib/utils";
import { estIOS, phraseLimite } from "@/lib/drive/depot-regles";
import { useNouvelleVersion } from "./nouvelle-version";
// L'essai « contenu déjà là », la question « existe déjà ici » et l'import d'arborescence : un seul chemin de dépôt.
import { useDepotDrive } from "./depot-drive";

type Perm = "none" | "view" | "edit";
interface UserLite { id: string; name: string }

const CATEGORY_SUGGESTIONS = ["Contrat", "Facture", "Réglementaire", "Présentation", "Analyse", "Compte rendu", "RH", "Marché PCH", "Autre"];

export function UploadButton({
  parentId, nodeId, nomActuel, label, users, spaceId,
}: {
  parentId?: string | null;
  nodeId?: string;
  /** Nouvelle version : le nom actuel, pour confirmer un dépôt d'un autre type. */
  nomActuel?: string;
  label?: string;
  /** Si fourni (import d'un nouveau fichier), ouvre le choix du type de document + permissions. */
  users?: UserLite[];
  /** Catégorie (espace partagé) de destination à la racine — hérité par les nouveaux nœuds. */
  spaceId?: string | null;
}) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const limites = useLimitesEnvoi();
  const envoyerVersion = useNouvelleVersion();
  const depot = useDepotDrive({ parentId: parentId ?? null, spaceId });

  // Mode simple (nouvelle version, ou pas de liste d'utilisateurs) : envoi en arrière-plan.
  const rich = Boolean(users) && !nodeId;

  // ───────── Mode simple (envoi non bloquant, global) ─────────
  function onChangeSimple(e: React.ChangeEvent<HTMLInputElement>) {
    const list = e.target.files;
    if (!list?.length) return;
    // Un fichier vide n'est plus écarté en silence : le gestionnaire d'envois le DIT (constat 13).
    const files = Array.from(list);
    if (nodeId) void envoyerVersion(nodeId, files[0], nomActuel);
    else void depot.deposerFichiers(files);
    if (inputRef.current) inputRef.current.value = "";
  }

  if (!rich) {
    return (
      <span className="inline-flex items-center gap-2">
        <input ref={inputRef} type="file" multiple={!nodeId} hidden onChange={onChangeSimple} />
        {/* LE GESTE PRINCIPAL est plein (audit Drive, C7) — et la limite réelle se lit au survol (C9). */}
        <Button variant={nodeId ? "outline" : "primary"} onClick={() => inputRef.current?.click()} type="button" title={phraseLimite(limites, "drive") ?? undefined}>
          <Upload className="h-4 w-4" /> {label ?? "Importer"}
        </Button>
        {depot.dialogue}
      </span>
    );
  }

  return <RichUpload parentId={parentId ?? null} users={users!} label={label} spaceId={spaceId ?? null} />;
}

function RichUpload({ parentId, users, label, spaceId }: { parentId: string | null; users: UserLite[]; label?: string; spaceId: string | null }) {
  const limites = useLimitesEnvoi();
  const depot = useDepotDrive({ parentId, spaceId });
  const [open, setOpen] = React.useState(false);
  const [menu, setMenu] = React.useState(false);
  const [files, setFiles] = React.useState<File[]>([]);
  const [category, setCategory] = React.useState("");
  const [perm, setPerm] = React.useState<Record<string, Perm>>({});
  const [search, setSearch] = React.useState("");
  const [err, setErr] = React.useState<string | null>(null);
  // Le choix d'un DOSSIER n'existe pas sur iOS (audit Drive, C15) : l'entrée n'y est pas proposée.
  const [ios, setIos] = React.useState(false);
  React.useEffect(() => { setIos(estIOS(navigator.userAgent, navigator.platform, navigator.maxTouchPoints)); }, []);
  const limite = phraseLimite(limites, "drive");

  // ───────── Import de DOSSIER (arborescence exacte recréée) ─────────
  const folderInputRef = React.useRef<HTMLInputElement>(null);
  const [folderBusy, setFolderBusy] = React.useState(false);
  // `webkitdirectory` n'est pas typé par React → posé sur l'élément via le ref.
  React.useEffect(() => {
    const el = folderInputRef.current;
    if (el) { el.setAttribute("webkitdirectory", ""); el.setAttribute("directory", ""); }
  }, []);

  const rel = (f: File) => (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;

  async function onImportFolder(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? []); // un fichier vide est dit par le gestionnaire, pas écarté
    if (folderInputRef.current) folderInputRef.current.value = "";
    if (picked.length === 0) return;
    setFolderBusy(true);
    try {
      // Six en parallèle, envoi direct au-delà du seuil, contenu déjà connu non retransféré, chaque
      // fichier dans SON dossier : la construction est commune avec le dépôt de la messagerie.
      await depot.deposerEntrees(picked.map((file) => ({ file, path: rel(file) })));
    } finally {
      setFolderBusy(false);
    }
  }

  const shared = Object.values(perm).filter((p) => p !== "none").length;
  const filtered = search.trim()
    ? users.filter((u) => u.name.toLowerCase().includes(search.trim().toLowerCase()))
    : users;

  function reset() {
    setFiles([]); setCategory(""); setPerm({}); setSearch(""); setErr(null);
  }

  /** Confie l'import (avec type de document + permissions) au gestionnaire global : non bloquant. */
  function submit() {
    if (files.length === 0) { setErr("Choisissez au moins un fichier."); return; }
    const viewers = Object.entries(perm).filter(([, p]) => p === "view").map(([id]) => id);
    const editors = Object.entries(perm).filter(([, p]) => p === "edit").map(([id]) => id);
    void depot.deposerFichiers(files, { category, viewers, editors });
    setOpen(false); reset();
  }

  return (
    <>
      {/* Un seul bouton « Importer » : Fichiers/ZIP OU Dossier (comme Google Drive). */}
      <input ref={folderInputRef} type="file" hidden multiple onChange={onImportFolder} />
      <div className="relative inline-flex">
        <Button type="button" onClick={() => setMenu((v) => !v)} disabled={folderBusy} title={limite ?? undefined}>
          {folderBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} {label ?? "Importer"}
          <ChevronDown className="h-3.5 w-3.5 opacity-70" />
        </Button>
        {menu && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setMenu(false)} />
            {/* Au téléphone, le bouton peut se retrouver à gauche après repli : le menu se pose en bas, pleine largeur. */}
            <div className="absolute right-0 top-full z-20 mt-1 w-60 rounded-xl border border-border bg-popover p-1 shadow-xl max-sm:fixed max-sm:inset-x-4 max-sm:bottom-[calc(1rem+env(safe-area-inset-bottom))] max-sm:top-auto max-sm:mt-0 max-sm:w-auto">
              <button type="button" onClick={() => { setMenu(false); setOpen(true); }}
                className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm hover:bg-secondary">
                <FileUp className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0"><span className="font-medium">Fichiers ou ZIP</span><span className="block text-xs text-muted-foreground">Un ou plusieurs fichiers (ZIP inclus)</span></span>
              </button>
              {!ios && (
                <button type="button" onClick={() => { setMenu(false); folderInputRef.current?.click(); }}
                  className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm hover:bg-secondary">
                  <FolderUp className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0"><span className="font-medium">Dossier</span><span className="block text-xs text-muted-foreground">Arborescence exacte recréée dans le Drive</span></span>
                </button>
              )}
            </div>
          </>
        )}
      </div>

      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title="Importer un document"
        description={`Choisissez le type de document et qui peut le voir ou le modifier. L'envoi se fait en arrière-plan${limite ? ` · ${limite}` : ""}.`}
        width="lg"
        footer={
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-xs text-muted-foreground">{files.length} fichier·s · partagé avec {shared}</span>
            <div className="flex gap-2">
              <Button variant="outline" type="button" onClick={() => setOpen(false)}>Annuler</Button>
              <Button type="button" onClick={submit} disabled={files.length === 0}>
                <Upload className="h-4 w-4" /> Importer
              </Button>
            </div>
          </div>
        }
      >
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Fichier(s)</Label>
            <input
              type="file"
              multiple
              onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
              className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-secondary file:px-3 file:py-1.5 file:text-sm file:font-medium"
            />
            {files.length > 0 && (
              <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{files.map((f) => f.name).join(", ")}</p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="category">Type de document</Label>
            <Input id="category" list="drive-cats" value={category} onChange={(e) => setCategory(e.target.value)} placeholder="ex. Contrat, Facture, Réglementaire…" />
            <datalist id="drive-cats">{CATEGORY_SUGGESTIONS.map((c) => <option key={c} value={c} />)}</datalist>
          </div>

          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5">
              <Label>Qui peut accéder ?</Label>
              <span className="text-xs text-muted-foreground">Par défaut, vous seul (propriétaire).</span>
            </div>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Rechercher une personne…" className="pl-8" />
            </div>
            <div className="max-h-72 space-y-0.5 overflow-y-auto rounded-lg border border-border p-1">
              {filtered.length === 0 ? (
                <p className="px-2 py-4 text-center text-sm text-muted-foreground">Aucune personne.</p>
              ) : filtered.map((u) => {
                const p = perm[u.id] ?? "none";
                return (
                  <div key={u.id} className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-secondary/50">
                    <span className="truncate text-sm">{u.name}</span>
                    <div className="inline-flex shrink-0 overflow-hidden rounded-md border border-border">
                      <PermBtn active={p === "none"} onClick={() => setPerm((m) => ({ ...m, [u.id]: "none" }))}>Aucun</PermBtn>
                      <PermBtn active={p === "view"} onClick={() => setPerm((m) => ({ ...m, [u.id]: "view" }))}><Eye className="h-3.5 w-3.5" /> Voir</PermBtn>
                      <PermBtn active={p === "edit"} onClick={() => setPerm((m) => ({ ...m, [u.id]: "edit" }))}><Pencil className="h-3.5 w-3.5" /> Modifier</PermBtn>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {err && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}
        </div>
      </Sheet>
      {depot.dialogue}
    </>
  );
}

function PermBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-1 px-2 py-2 text-xs font-medium transition-colors sm:py-1",
        active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-secondary",
      )}
    >
      {children}
    </button>
  );
}
