"use client";

import * as React from "react";
import Link from "next/link";

import { Download, Loader2, GripVertical, ChevronUp, ChevronDown, Trash2, Share2, FolderOpen, Check, Search, ClipboardPaste, Copy, Scissors } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { FileGlyph } from "@/components/drive/file-glyph";
import { moveNode, moveNodes, copyNodes, trashNodes, shareNodesWithMany } from "@/lib/actions/drive-actions";
import {
  CLIPBOARD_KEY, parseClipboard, serializeClipboard, clipboardLabel, canPasteInto, clipShortcut,
  type Clipboard,
} from "@/lib/drive/clipboard";
import { Sheet } from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { useConfirmer } from "@/components/ui/dialogue";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";
import {
  clickSelect, selectAll, pruneSelection, allSelected, EMPTY_SELECTION, type SelectionState,
} from "@/lib/drive/selection";
import { sortRows, type SortKey, type SortDir } from "@/lib/drive/explorer";
import { NodeActions } from "./node-actions";
import { prechargerEditeur } from "@/components/documents/editeur-en-ligne";
import { BoutonTelecharger } from "@/components/telechargement/bouton-telecharger";
import { useCleParPersonne } from "@/components/layout/identite-vue";

export interface DriveRow {
  id: string;
  name: string;
  isFile: boolean;
  category: string | null;
  owner: string;
  /** Taille brute, pour trier ; `sizeLabel` est ce qu'on affiche. */
  size: number;
  sizeLabel: string;
  /** Type lisible (« Document PDF », « Dossier compressé ») — pas un type MIME. */
  typeLabel: string;
  /** Date ISO, pour trier ; `updatedLabel` est ce qu'on affiche. */
  updatedAt: string;
  updatedLabel: string;
  canEdit: boolean;
  href: string;
  /** Partages, commentaires, versions — les icônes de la ligne et l'en-tête du menu « ⋯ ». */
  counts?: { shares: number; comments: number; versions: number };
  /** « Convertir en PDF » proposé (format Office, convertisseur, droit de créer). */
  convertible?: boolean;
  /** Le fichier s'ouvre dans l'éditeur Office : son script se précharge au survol du nom. */
  office?: boolean;
}
interface MoveTarget { id: string; name: string }
interface UserLite { id: string; name: string }
interface DropCategory { id: string; name: string }

/**
 * Liste du Drive — un vrai drive : **glisser-déposer à la souris**. On attrape un fichier/dossier
 * et on le lâche sur un AUTRE dossier (pour l'y ranger) ou sur une pastille de **catégorie** (pour
 * l'y déplacer). Sélection multiple conservée (cocher → « Télécharger (ZIP) »). Chaque ligne garde
 * ses actions (télécharger, renommer, déplacer par menu, gérer l'accès, corbeille).
 */
export function DriveTable({
  rows, moveTargets, trash, users, spaceId, categories, folderId = null, ancestorIds = [], officeApiJs = null,
}: {
  rows: DriveRow[]; moveTargets: MoveTarget[]; trash: boolean; users?: UserLite[];
  spaceId?: string | null; categories?: DropCategory[];
  /** Dossier affiché — destination du collage. `null` = racine de l'emplacement. */
  folderId?: string | null;
  /** Ancêtres du dossier affiché : c'est ce qui interdit de coller un dossier dans lui-même. */
  ancestorIds?: string[];
  /** Script de l'éditeur Office (null : éditeur non configuré) — préchargé au survol d'un fichier Office. */
  officeApiJs?: string | null;
}) {
  const { rafraichir } = useRafraichir();
  const confirmer = useConfirmer();
  // TRI PAR EN-TÊTE, comme dans un explorateur : on clique sur « Taille » pour trouver le gros
  // fichier, sur « Modifié le » pour retrouver celui d'hier. Les dossiers restent en tête dans les
  // deux sens (règle du module `explorer`, testée) — sinon l'arborescence se dissout dans la liste.
  const [sortKey, setSortKey] = React.useState<SortKey>("name");
  const [sortDir, setSortDir] = React.useState<SortDir>("asc");
  const sorted = React.useMemo(() => sortRows(rows, sortKey, sortDir), [rows, sortKey, sortDir]);
  const clickSort = (k: SortKey) => {
    if (k === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(k); setSortDir("asc"); }
  };
  const SortHead = ({ k, label, align, className }: { k: SortKey; label: string; align?: "right"; className?: string }) => (
    // aria-sort vit sur le <th> (rôle columnheader) — pas sur le bouton, qui ne le supporte pas.
    <TableHead
      className={[align === "right" ? "text-right" : "", className ?? ""].filter(Boolean).join(" ") || undefined}
      aria-sort={sortKey === k ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
    >
      <button
        type="button" onClick={() => clickSort(k)}
        className={`inline-flex items-center gap-1 hover:text-foreground ${sortKey === k ? "text-foreground" : ""}`}
      >
        {label}
        {sortKey === k && (sortDir === "asc" ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />)}
      </button>
    </TableHead>
  );

  // SÉLECTION À LA WINDOWS : clic, Ctrl+clic, Maj+clic. Le modèle est pur et testé — c'est là
  // que vivent les règles subtiles (l'ancre d'une plage ne bouge pas).
  const [sel, setSel] = React.useState<SelectionState>(EMPTY_SELECTION);
  const [zipping, setZipping] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [shareOpen, setShareOpen] = React.useState(false);
  const [dragId, setDragId] = React.useState<string | null>(null);
  const [overId, setOverId] = React.useState<string | null>(null); // cible survolée (dossier id, ou "cat:<id>", ou "root")
  const [moveMsg, setMoveMsg] = React.useState<{ ok: boolean; text: string } | null>(null);
  const [clip, setClip] = React.useState<Clipboard | null>(null);
  const [pasting, setPasting] = React.useState(false);
  const order = React.useMemo(() => sorted.map((r) => r.id), [sorted]);
  // La liste change (navigation, suppression, tri) → on oublie ce qui n'existe plus, sinon la
  // barre annoncerait « 3 éléments » et l'action suivante porterait sur des identifiants disparus.
  React.useEffect(() => { setSel((s) => pruneSelection(s, order)); }, [order]);
  const allChecked = allSelected(sel, order);
  const selectedRows = sorted.filter((r) => sel.ids.includes(r.id));
  const selectedFiles = selectedRows.filter((r) => r.isFile);
  const canActOnAll = selectedRows.length > 0 && selectedRows.every((r) => r.canEdit);
  const dndEnabled = !trash;

  const toggle = (id: string, mods: { toggle?: boolean; range?: boolean } = {}) =>
    setSel((s) => clickSelect(s, id, order, mods));
  const toggleAll = () => setSel((s) => selectAll(order, !allSelected(s, order)));
  const clear = () => setSel(EMPTY_SELECTION);

  /** Le bouton partagé suit le lien : le clic principal part en ZIP maximal (original), le chevron propose la taille réduite. */
  const urlZip = `/api/drive/zip?ids=${sel.ids.join(",")}`;
  const downloadZip = () => {
    if (sel.ids.length === 0) return;
    setZipping(true);
    window.setTimeout(() => setZipping(false), 4000);
  };

  /** Corbeille sur toute la sélection — un refus ponctuel n'annule pas le reste. */
  const bulkTrash = async () => {
    const n = sel.ids.length;
    if (n === 0 || busy) return;
    if (!(await confirmer(n === 1 ? "Mettre cet élément à la corbeille ?" : `Mettre ces ${n} éléments à la corbeille ?`))) return;
    setBusy(true);
    const fd = new FormData();
    for (const id of sel.ids) fd.append("id", id);
    try {
      const r = await trashNodes(fd);
      setMoveMsg(r.ok
        ? { ok: true, text: `${r.done} élément·s mis à la corbeille${r.denied ? `, ${r.denied} refusé·s` : ""}.` }
        : { ok: false, text: r.error ?? "Suppression impossible." });
      if (r.ok) { clear(); rafraichir(); }
    } catch {
      setMoveMsg({ ok: false, text: actionFailureMessage("THROWN") });
    } finally {
      setBusy(false);
    }
    window.setTimeout(() => setMoveMsg(null), 4000);
  };

  const rowById = React.useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);

  /** Déplace un nœud vers un dossier (targetId) ou vers la racine d'une catégorie (destSpaceId). */
  const doMove = React.useCallback(async (id: string, opts: { targetId?: string; destSpaceId?: string | null; label: string }) => {
    const dragged = rowById.get(id);
    setOverId(null); setDragId(null);
    setMoveMsg({ ok: true, text: `Déplacement de « ${dragged?.name ?? "l'élément"} »…` });
    const fd = new FormData();
    fd.set("id", id);
    fd.set("targetId", opts.targetId ?? "");
    fd.set("spaceId", opts.destSpaceId ?? ""); // catégorie de destination (racine) ; vide = Drive perso
    try {
      const r = await moveNode(fd);
      if (r.ok) {
        setMoveMsg({ ok: true, text: `« ${dragged?.name ?? "Élément"} » déplacé vers ${opts.label}.` });
        rafraichir();
      } else {
        setMoveMsg({ ok: false, text: r.error ?? "Déplacement impossible." });
      }
    } catch {
      setMoveMsg({ ok: false, text: actionFailureMessage("THROWN") });
    }
    window.setTimeout(() => setMoveMsg(null), 3500);
  }, [rowById, rafraichir]);

  /**
   * COPIER / COUPER / COLLER — le geste de l'explorateur, celui que personne n'a eu à apprendre.
   *
   * Il TRAVERSE les dossiers, et c'est tout son intérêt : on prend ici, on navigue là, on colle.
   * Un glisser-déposer ne sait pas faire cela — il exige que la source et la destination soient
   * visibles en même temps. Le presse-papiers vit donc dans le navigateur, pas en mémoire.
   */
  // Rangé par PERSONNE À L'ÉCRAN : en Vue exacte, ce que l'administrateur a coupé chez lui ne se colle pas
  // dans le Drive de Leila (Direction, 06/10 — pas de chevauchement).
  const cleClip = useCleParPersonne(CLIPBOARD_KEY);
  React.useEffect(() => {
    const read = () => { try { setClip(parseClipboard(window.localStorage.getItem(cleClip))); } catch { setClip(null); } };
    read();
    // Un autre onglet a copié : la barre du nôtre doit le savoir.
    window.addEventListener("storage", read);
    return () => window.removeEventListener("storage", read);
  }, [cleClip]);

  const putClip = React.useCallback((mode: "copy" | "cut") => {
    const picked = sorted.filter((r) => sel.ids.includes(r.id));
    if (picked.length === 0) return;
    // Couper suppose le droit de modifier — copier ne suppose que celui de lire.
    if (mode === "cut" && !picked.every((r) => r.canEdit)) {
      setMoveMsg({ ok: false, text: "Certains éléments ne vous appartiennent pas : ils ne peuvent pas être déplacés." });
      window.setTimeout(() => setMoveMsg(null), 3500);
      return;
    }
    const next: Clipboard = { mode, ids: picked.map((r) => r.id), names: picked.map((r) => r.name), fromFolderId: folderId };
    try { window.localStorage.setItem(cleClip, serializeClipboard(next)); } catch { /* refusé : presse-papiers volatil */ }
    setClip(next);
    setMoveMsg({ ok: true, text: `${clipboardLabel(next)} — collez dans le dossier de votre choix.` });
    window.setTimeout(() => setMoveMsg(null), 3500);
  }, [sorted, sel.ids, folderId, cleClip]);

  const paste = React.useCallback(async () => {
    const check = canPasteInto(clip, { folderId, ancestorIds });
    if (!clip || !check.ok) {
      if (check.reason) { setMoveMsg({ ok: false, text: check.reason }); window.setTimeout(() => setMoveMsg(null), 3500); }
      return;
    }
    setPasting(true);
    const fd = new FormData();
    for (const id of clip.ids) fd.append("id", id);
    fd.set("targetId", folderId ?? "");
    fd.set("spaceId", spaceId ?? "");
    let r: Awaited<ReturnType<typeof moveNodes>>;
    try {
      r = clip.mode === "cut" ? await moveNodes(fd) : await copyNodes(fd);
    } catch {
      setMoveMsg({ ok: false, text: actionFailureMessage("THROWN") });
      window.setTimeout(() => setMoveMsg(null), 4000);
      return;
    } finally {
      setPasting(false);
    }
    setMoveMsg({ ok: r.ok, text: r.ok ? `${r.done} élément(s) ${clip.mode === "cut" ? "déplacé(s)" : "collé(s)"}.${r.error ? ` ${r.error}` : ""}` : r.error ?? "Collage impossible." });
    window.setTimeout(() => setMoveMsg(null), 4000);
    // Couper se consomme : garder le presse-papiers ferait « déplacer » une seconde fois des
    // éléments qui ne sont plus là. Copier reste disponible pour un second collage.
    if (r.ok && clip.mode === "cut") {
      try { window.localStorage.removeItem(cleClip); } catch { /* rien à nettoyer */ }
      setClip(null);
    }
    if (r.ok) rafraichir();
  }, [clip, folderId, ancestorIds, spaceId, rafraichir, cleClip]);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Une frappe DANS un champ appartient au champ : Ctrl+C y copie du texte.
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      const move = clipShortcut(e);
      if (!move) return;
      if (move === "paste") { e.preventDefault(); void paste(); return; }
      if (sel.ids.length === 0) return;
      e.preventDefault();
      putClip(move);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [paste, putClip, sel.ids.length]);

  const onDropFolder = (targetFolderId: string) => async (e: React.DragEvent) => {
    e.preventDefault();
    setOverId(null);
    const many = (e.dataTransfer.getData("text/drive-nodes") || "").split(",").filter(Boolean);
    const ids = many.length > 0 ? many : [e.dataTransfer.getData("text/drive-node") || dragId].filter((x): x is string => Boolean(x));
    const moving = ids.filter((id) => id !== targetFolderId);
    if (moving.length === 0) return;
    const target = rowById.get(targetFolderId);
    if (moving.length === 1) { void doMove(moving[0], { targetId: targetFolderId, label: `« ${target?.name ?? "dossier"} »` }); return; }
    // Un lot passe par UNE action : cinq échecs séparés donneraient cinq messages pour un geste.
    const fd = new FormData();
    for (const id of moving) fd.append("id", id);
    fd.set("targetId", targetFolderId);
    fd.set("spaceId", spaceId ?? "");
    try {
      const r = await moveNodes(fd);
      setMoveMsg({ ok: r.ok, text: r.ok ? `${r.done} élément(s) déplacé(s) vers « ${target?.name ?? "dossier"} ».` : r.error ?? "Déplacement impossible." });
      if (r.ok) rafraichir();
    } catch {
      setMoveMsg({ ok: false, text: actionFailureMessage("THROWN") });
    }
    window.setTimeout(() => setMoveMsg(null), 3500);
  };

  return (
    <div className="space-y-2">
      {clip && dndEnabled && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
          {clip.mode === "cut" ? <Scissors className="h-3.5 w-3.5 text-primary" /> : <Copy className="h-3.5 w-3.5 text-primary" />}
          <span className="min-w-0 flex-1 truncate">{clipboardLabel(clip)}</span>
          <button
            type="button" disabled={pasting} onClick={() => void paste()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-2.5 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60 sm:py-1"
          >
            {pasting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ClipboardPaste className="h-3.5 w-3.5" />} Coller ici
          </button>
          <button
            type="button"
            onClick={() => { try { window.localStorage.removeItem(cleClip); } catch { /* rien */ } setClip(null); }}
            className="px-1 py-2 text-xs text-muted-foreground hover:text-foreground sm:p-0"
          >
            Vider
          </button>
        </div>
      )}

      {sel.ids.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
          <span className="font-medium">{sel.ids.length} sélectionné·s</span>

          {selectedFiles.length > 0 && (
            <Link
              href={`/drive/vue?ids=${selectedFiles.map((r) => r.id).join(",")}`}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-2.5 py-2 text-sm font-medium sm:py-1.5 text-primary-foreground hover:bg-primary/90"
            >
              <FolderOpen className="h-4 w-4" /> Ouvrir{selectedFiles.length > 1 ? ` (${selectedFiles.length})` : ""}
            </Link>
          )}

          <BoutonTelecharger
            href={urlZip}
            nom="selection.zip"
            archive
            onClick={downloadZip}
            ariaLabel="Télécharger la sélection"
            className={`inline-flex items-center gap-1.5 rounded-lg border border-input px-2.5 py-2 text-sm font-medium sm:py-1.5 hover:bg-secondary ${zipping ? "pointer-events-none opacity-60" : ""}`}
          >
            {zipping ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />} Télécharger
          </BoutonTelecharger>

          {!trash && users && users.length > 0 && canActOnAll && (
            <button type="button" onClick={() => setShareOpen(true)} disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-lg border border-input px-2.5 py-2 text-sm font-medium sm:py-1.5 hover:bg-secondary disabled:opacity-60">
              <Share2 className="h-4 w-4" /> Partager
            </button>
          )}

          {!trash && canActOnAll && (
            <button type="button" onClick={() => void bulkTrash()} disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-lg border border-destructive/40 px-2.5 py-2 text-sm font-medium sm:py-1.5 text-destructive hover:bg-destructive/10 disabled:opacity-60">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />} Supprimer
            </button>
          )}

          {!trash && !canActOnAll && (
            // On ne cache pas les boutons en silence : sans un mot, on croit à une panne.
            <span className="text-xs text-muted-foreground">
              Certains éléments ne vous appartiennent pas — partage et suppression indisponibles.
            </span>
          )}

          <button
            type="button" onClick={() => putClip("copy")}
            className="inline-flex items-center gap-1.5 rounded-lg border border-input px-2.5 py-2 text-sm font-medium sm:py-1.5 hover:bg-secondary"
          >
            <Copy className="h-4 w-4" /> Copier
          </button>
          {canActOnAll && (
            <button
              type="button" onClick={() => putClip("cut")}
              className="inline-flex items-center gap-1.5 rounded-lg border border-input px-2.5 py-2 text-sm font-medium sm:py-1.5 hover:bg-secondary"
            >
              <Scissors className="h-4 w-4" /> Couper
            </button>
          )}

          <button type="button" onClick={clear} className="ml-auto py-2 text-muted-foreground hover:text-foreground sm:py-0">Désélectionner</button>
        </div>
      )}

      {moveMsg && (
        <p className={`rounded-lg px-3 py-2 text-sm ${moveMsg.ok ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive"}`}>{moveMsg.text}</p>
      )}

      {shareOpen && users && (
        <BulkShareSheet
          nodes={selectedRows.map((r) => ({ id: r.id, name: r.name }))}
          users={users}
          onClose={() => setShareOpen(false)}
          onDone={(msg) => { setShareOpen(false); setMoveMsg({ ok: true, text: msg }); clear(); rafraichir(); window.setTimeout(() => setMoveMsg(null), 4000); }}
        />
      )}

      <div className="surface overflow-hidden">
        {/* TROIS COLONNES — Nom, Modifié le, et un menu.
            « Type » répétait l'icône ; « Taille » affichait « — » sur chaque dossier ; « Propriétaire »
            mangeait 11 rem pour un renseignement qu'on consulte de temps en temps — il est passé EN
            TÊTE DU MENU. Restait une colonne « Actions » de six icônes muettes qui débordait sur la
            date dès qu'un nom était long : trois icônes la remplacent (10/2026, « comme Google
            Drive ») — Partage, Commentaires, et « ⋯ » qui porte tout le reste, informations en tête.
            Résultat : le nom dispose de presque toute la largeur, et plus rien ne se chevauche.

            POLICE RÉDUITE D'ENVIRON 30 % (0,875 rem → 0,625 rem ; en-têtes 0,75 → 0,5625 rem), avec
            des lignes resserrées en proportion — sans quoi on aurait un texte petit dans des lignes
            hautes, ce qui est simplement moins lisible, pas plus dense. Les deux valeurs sont ici,
            en un seul endroit, si l'on veut les rouvrir.
            AU TÉLÉPHONE, cette densité de bureau tombait sous les 11 px : la liste y garde une
            police lisible et des lignes au pouce ; la réduction ne s'applique qu'à partir de sm. */}
        <Table className="table-fixed text-sm sm:text-[0.625rem] [&_th]:h-9 [&_th]:px-2 [&_th]:text-[0.6875rem] sm:[&_th]:h-8 sm:[&_th]:text-[0.5625rem] [&_td]:px-2 [&_td]:py-2.5 sm:[&_td]:py-1.5">
          <TableHeader>
            <TableRow>
              <TableHead className="w-9 sm:w-7">
                <input type="checkbox" checked={allChecked} onChange={toggleAll} aria-label="Tout sélectionner" className="h-5 w-5 rounded border-input sm:h-3.5 sm:w-3.5" />
              </TableHead>
              <SortHead k="name" label="Nom" className="w-auto" />
              <SortHead k="updatedAt" label="Modifié le" className="hidden w-36 sm:table-cell" />
              {/* Trois icônes — Partage, Commentaires, ⋯ : 3 × 36 px au téléphone, 3 × 28 px au bureau. */}
              <TableHead className="w-[7.25rem] text-right sm:w-[5.75rem]"><span className="sr-only">Actions</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((n) => {
              const isFolderTarget = dndEnabled && !n.isFile && dragId !== null && dragId !== n.id;
              const isOver = overId === n.id;
              return (
                <TableRow
                  key={n.id}
                  draggable={dndEnabled && n.canEdit}
                  onDragStart={(e) => {
                    // Glisser une ligne hors sélection la sélectionne d'abord — sinon on
                    // déplacerait autre chose que ce qu'on a attrapé.
                    if (!sel.ids.includes(n.id)) setSel(clickSelect(sel, n.id, order));
                    // On emmène toute la sélection : attraper une ligne parmi cinq sélectionnées
                    // et n'en déplacer qu'une seule est exactement ce qui fait dire « ça marche mal ».
                    const carried = sel.ids.includes(n.id) ? sel.ids : [n.id];
                    e.dataTransfer.setData("text/drive-node", n.id);
                    e.dataTransfer.setData("text/drive-nodes", carried.join(","));
                    e.dataTransfer.setData("text/plain", n.name);
                    e.dataTransfer.effectAllowed = "move";
                    setDragId(n.id);
                  }}
                  onDragEnd={() => { setDragId(null); setOverId(null); }}
                  onDragEnter={isFolderTarget ? (e) => { e.preventDefault(); setOverId(n.id); } : undefined}
                  onDragOver={isFolderTarget ? (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setOverId(n.id); } : undefined}
                  onDragLeave={isFolderTarget ? () => setOverId((o) => (o === n.id ? null : o)) : undefined}
                  onDrop={isFolderTarget ? onDropFolder(n.id) : undefined}
                  // Clic sur la LIGNE = sélection, comme dans un explorateur : Ctrl (ou ⌘) ajoute,
                  // Maj étend depuis l'ancre. Le nom reste un lien : on ouvre en cliquant dessus,
                  // pas en cliquant à côté.
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest("a,button,input")) return;
                    toggle(n.id, { toggle: e.ctrlKey || e.metaKey, range: e.shiftKey });
                  }}
                  className={`cursor-default select-none ${sel.ids.includes(n.id) ? "bg-accent/40" : ""} ${isOver && isFolderTarget ? "ring-2 ring-inset ring-primary bg-primary/5" : ""} ${dragId === n.id ? "opacity-50" : ""}`}
                >
                  <TableCell>
                    <input
                      type="checkbox" checked={sel.ids.includes(n.id)}
                      onChange={(e) => toggle(n.id, { toggle: true, range: (e.nativeEvent as MouseEvent).shiftKey })}
                      aria-label={`Sélectionner ${n.name}`} className="h-5 w-5 rounded border-input sm:h-3.5 sm:w-3.5"
                    />
                  </TableCell>
                  <TableCell>
                    {/* `min-w-0` à CHAQUE niveau : sans lui, `truncate` n'a aucun effet et le nom
                        pousse la ligne — c'est exactement ce qui faisait se chevaucher les colonnes. */}
                    <div className="flex min-w-0 items-center gap-1.5">
                      {/* La poignée ne sert qu'à la souris : au doigt, elle ne ferait que voler de la place au nom. */}
                      {dndEnabled && n.canEdit && <GripVertical className="hidden h-3 w-3 shrink-0 cursor-grab text-muted-foreground/40 sm:block" aria-hidden />}
                      {/* CLIQUER LE NOM, C'EST ÊTRE DANS LE FICHIER — et l'éditeur se prépare dès le survol. */}
                      <Link
                        href={n.href} draggable={false} title={n.name}
                        onMouseEnter={n.office ? () => prechargerEditeur(officeApiJs) : undefined}
                        onTouchStart={n.office ? () => prechargerEditeur(officeApiJs) : undefined}
                        className="flex min-w-0 items-center gap-1.5 font-medium hover:underline"
                      >
                        <FileGlyph name={n.name} isFile={n.isFile} />
                        <span className="truncate">{n.name}</span>
                      </Link>
                      {n.isFile && n.category && (
                        <span className="hidden shrink-0 rounded-full bg-secondary px-1.5 py-0.5 text-[0.5625rem] font-medium text-muted-foreground md:inline">{n.category}</span>
                      )}
                      {!n.isFile && isFolderTarget && <span className="shrink-0 text-[0.5625rem] font-medium text-primary">déposer ici</span>}
                    </div>
                    {/* Sous le nom, sur ÉCRAN ÉTROIT : la date n'a plus de colonne, mais elle reste
                        l'information qu'on cherche le plus après le nom. */}
                    <span className="mt-0.5 block truncate text-xs text-muted-foreground sm:hidden">{n.updatedLabel}</span>
                  </TableCell>
                  <TableCell className="hidden whitespace-nowrap text-muted-foreground sm:table-cell">{n.updatedLabel}</TableCell>
                  <TableCell className="text-right">
                    <NodeActions
                      id={n.id} name={n.name} isFile={n.isFile} canEdit={n.canEdit} owner={n.owner} trash={trash}
                      moveTargets={n.canEdit && !trash ? moveTargets : undefined} users={n.canEdit && !trash ? users : undefined} spaceId={spaceId}
                      infos={{ sizeLabel: n.sizeLabel, typeLabel: n.typeLabel, updatedLabel: n.updatedLabel }}
                      counts={n.counts} convertible={n.convertible}
                    />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

/**
 * PARTAGER TOUTE UNE SÉLECTION, en une fois.
 *
 * Une notification par personne pour TOUT le lot, pas une par fichier : partager douze documents
 * ne doit pas remplir douze fois la boîte de chacun — c'est le meilleur moyen de faire ignorer
 * les notifications suivantes.
 */
function BulkShareSheet({
  nodes, users, onClose, onDone,
}: {
  nodes: { id: string; name: string }[];
  users: UserLite[];
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [picked, setPicked] = React.useState<Set<string>>(new Set());
  const [access, setAccess] = React.useState<"VIEW" | "EDIT">("VIEW");
  const [q, setQ] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  const needle = q.trim().toLowerCase();
  const shown = needle ? users.filter((u) => u.name.toLowerCase().includes(needle)) : users;

  const submit = async () => {
    if (picked.size === 0) { setErr("Choisissez au moins une personne."); return; }
    setBusy(true); setErr(null);
    const fd = new FormData();
    for (const n of nodes) fd.append("nodeId", n.id);
    for (const id of picked) fd.append("userId", id);
    fd.set("access", access);
    try {
      const r = await shareNodesWithMany(fd);
      if (!r.ok) { setErr(r.error ?? "Partage impossible."); return; }
      onDone(`${r.done} élément·s partagé·s avec ${picked.size} personne·s${r.denied ? ` (${r.denied} refusé·s)` : ""}.`);
    } catch {
      setErr(actionFailureMessage("THROWN"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open onClose={() => !busy && onClose()}
      title={nodes.length === 1 ? `Partager « ${nodes[0].name} »` : `Partager ${nodes.length} éléments`}
      description="Sur un dossier, l'accès descend sur tout son contenu."
      width="md"
    >
      <div className="space-y-3">
        <div className="inline-flex overflow-hidden rounded-lg border border-border">
          {(["VIEW", "EDIT"] as const).map((a) => (
            <button
              key={a} type="button" onClick={() => setAccess(a)}
              className={`px-3 py-1.5 text-sm font-medium transition-colors ${access === a ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-secondary"}`}
            >
              {a === "VIEW" ? "Lecture" : "Modification"}
            </button>
          ))}
        </div>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Rechercher une personne…" className="pl-8" />
        </div>
        <div className="max-h-72 space-y-0.5 overflow-y-auto rounded-lg border border-border p-1">
          {shown.length === 0 ? (
            <p className="px-2 py-4 text-center text-sm text-muted-foreground">Aucune personne.</p>
          ) : shown.map((u) => (
            <label key={u.id} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-secondary/60">
              <input
                type="checkbox" className="h-4 w-4 rounded border-input" checked={picked.has(u.id)}
                onChange={() => setPicked((p) => { const n = new Set(p); if (n.has(u.id)) n.delete(u.id); else n.add(u.id); return n; })}
              />
              <span className="truncate">{u.name}</span>
            </label>
          ))}
        </div>
        {err && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">{picked.size} personne·s</span>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} disabled={busy} className="rounded-lg border border-input px-3 py-2 text-sm sm:py-1.5">Annuler</button>
            <button
              type="button" onClick={() => void submit()} disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm sm:py-1.5 font-medium text-primary-foreground disabled:opacity-60"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Partager
            </button>
          </div>
        </div>
      </div>
    </Sheet>
  );
}
