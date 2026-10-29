"use client";

import * as React from "react";

import { X, Download, Printer, Pencil, Trash2, Check, Loader2, ExternalLink, Maximize2, Minimize2 } from "lucide-react";
import { ApercuUniversel } from "./apercu-universel";
import { natureApercu } from "@/lib/formats/apercu";
import { ZipViewer } from "./zip-viewer";
import { printDocument } from "@/lib/print-document";
import { deleteDocument, renameDocument } from "@/lib/actions/document-actions";
import { useScrollLock } from "@/lib/use-scroll-lock";
import { BoutonTelecharger } from "@/components/telechargement/bouton-telecharger";
import { useConfirmer } from "@/components/ui/dialogue";
import { useRetours } from "@/components/ui/retour";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { actionFailureMessage } from "@/lib/action-outcome";

// Extensions ouvrables/modifiables dans l'éditeur Office (alignées sur onlyofficeDocType côté serveur).
const OFFICE_EDIT = ["doc", "docx", "odt", "rtf", "txt", "xls", "xlsx", "ods", "csv", "ppt", "pptx", "odp"];

function extOf(name: string): string {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

const iconBtn = "rounded-lg p-2.5 text-muted-foreground sm:p-2 transition-colors hover:bg-secondary hover:text-foreground";

/**
 * Document : **nom cliquable** qui ouvre une fenêtre d'aperçu in-app (PDF, image, Word, Excel,
 * PowerPoint ; sinon message + téléchargement). Toutes les actions vivent DANS l'aperçu, en barre
 * d'outils : **imprimer, modifier (éditeur Office), renommer, enregistrer (télécharger), supprimer**
 * — selon les droits reçus. Plus d'icônes entassées dans la liste : le nom seul suffit à tout ouvrir.
 */
export function DocumentPreview({
  id, name, hasFile, canEdit, canDelete, canRename, path, srcOverride, supprimer,
}: {
  id: string;
  name: string;
  hasFile: boolean;
  canEdit?: boolean;
  canDelete?: boolean;
  canRename?: boolean;
  path?: string;
  /**
   * LA ROUTE QUI SERT LES OCTETS, quand ce n'est pas celle des `Document`.
   *
   * Toutes les pièces de l'ERP ne vivent pas dans le modèle `Document` : une FICHE DE PAIE est
   * un `EmployeeDocument`, servi par `/api/rh/document/…` parce qu'elle obéit à une règle
   * d'accès qui lui est propre (le salarié propriétaire, ou les RH). Faute de pouvoir viser
   * cette route, l'écran de la Paie se rabattait sur un lien brut — et un `.docx` cliqué se
   * TÉLÉCHARGEAIT au lieu de s'afficher, alors que cet aperçu sait le rendre depuis toujours.
   *
   * Un second composant d'aperçu aurait divergé du premier à la première correction. On lui
   * apprend donc où chercher les octets ; tout le reste — rendu PDF, Word, Excel, image,
   * impression, téléchargement — est le MÊME code.
   */
  srcOverride?: string;
  /**
   * L'ACTION QUI SUPPRIME, quand ce n'est pas `deleteDocument` — le bloc des pièces d'une demande Ad & Pro
   * passe la sienne (§118.209), qui juge la demande ET ce qui engage la pièce. Même signature : le
   * bouton, la confirmation et le rafraîchissement sont ceux de tous les documents.
   */
  supprimer?: (id: string, path?: string) => Promise<{ ok: boolean; error?: string }>;
}) {
  const { rafraichir } = useRafraichir();
  const confirmer = useConfirmer();
  const retours = useRetours();
  const [open, setOpen] = React.useState(false);
  useScrollLock(open); // l'aperçu est modal : la page ne doit pas défiler derrière
  const [renaming, setRenaming] = React.useState(false);
  const [draft, setDraft] = React.useState(name);
  const [busy, setBusy] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  // GRAND ÉCRAN (Direction, 06/10) : la fenêtre d'aperçu occupe tout l'écran, sans marge ni largeur bornée.
  const [agrandi, setAgrandi] = React.useState(false);

  const src = srcOverride ?? `/api/documents/${id}`;
  const kind = natureApercu(name);
  // Un ZIP se PARCOURT dans la fenêtre (liste des entrées, aperçu d'une entrée) — sans le télécharger.
  // Seulement pour un document ordinaire : `srcOverride` désigne une autre source, qui n'a pas cette route.
  const canPreview = hasFile && (kind !== "zip" || !srcOverride);
  const canEditFile = Boolean(canEdit) && hasFile && OFFICE_EDIT.includes(extOf(name));

  async function saveRename() {
    const v = draft.trim();
    if (!v || v === name) { setRenaming(false); setDraft(name); return; }
    setBusy(true);
    try {
      const r = await renameDocument(id, v, path);
      if (!r.ok) retours.erreur(r.error ?? "Le document n'a pas été renommé.");
    } catch {
      retours.erreur(actionFailureMessage("THROWN"));
    } finally {
      setBusy(false);
      setRenaming(false);
      rafraichir();
    }
  }
  async function onDelete() {
    if (!(await confirmer("Supprimer définitivement ce document ?"))) return;
    setDeleting(true);
    try {
      const r = await (supprimer ?? deleteDocument)(id, path);
      // Un refus se DIT (§118.83) : sans cela, la fenêtre restait ouverte sur un fichier qui n'était pas parti.
      if (!r.ok) { setDeleting(false); retours.erreur(r.error ?? "Suppression impossible."); return; }
    } catch {
      setDeleting(false);
      retours.erreur(actionFailureMessage("THROWN"));
      return;
    }
    setOpen(false);
    rafraichir();
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={name}
        className="block w-full truncate py-1 text-left text-[0.8125rem] font-medium sm:py-0 text-foreground transition-colors hover:text-primary hover:underline"
      >
        {name}
      </button>

      {open && (
        // AU TÉLÉPHONE, l'aperçu est toujours plein écran : une marge de 16 px autour d'un PDF
        // ne laisse qu'une vignette. La fenêtre bordée ne reprend qu'à partir de sm.
        <div className={`fixed inset-0 z-50 flex flex-col bg-black/60 ${agrandi ? "p-0" : "p-0 sm:p-4"}`} onClick={() => setOpen(false)}>
          <div className={`mx-auto flex max-h-full w-full flex-1 flex-col overflow-hidden bg-card shadow-2xl ${agrandi ? "max-w-none rounded-none" : "max-w-5xl rounded-none sm:rounded-xl"}`} onClick={(e) => e.stopPropagation()}>
            {/* Au téléphone, le nom prend sa ligne et la barre d'actions passe dessous, sans l'écraser. */}
            <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 border-b border-border px-3 py-2 pt-[max(0.5rem,env(safe-area-inset-top))] sm:flex-nowrap sm:pt-2">
              {renaming ? (
                <div className="flex min-w-0 flex-1 items-center gap-1.5">
                  <input
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") saveRename(); if (e.key === "Escape") { setRenaming(false); setDraft(name); } }}
                    disabled={busy}
                    className="min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1.5 text-base focus-ring sm:py-1 sm:text-sm"
                  />
                  <button onClick={saveRename} disabled={busy} className="rounded-md p-2.5 text-success hover:bg-success/10 sm:p-1.5" title="Enregistrer le nom">
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                  </button>
                  <button onClick={() => { setRenaming(false); setDraft(name); }} disabled={busy} className="rounded-md p-2.5 text-muted-foreground hover:bg-secondary sm:p-1.5" title="Annuler">
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ) : (
                <p className="min-w-0 flex-1 basis-full truncate text-sm font-medium sm:basis-0" title={name}>{name}</p>
              )}
              {!renaming && (
                <div className="ml-auto flex shrink-0 items-center gap-0.5">
                  {hasFile && kind !== "zip" && <button onClick={() => printDocument(id)} className={iconBtn} title="Imprimer"><Printer className="h-4 w-4" /></button>}
                  {canEditFile && <a href={`/documents/${id}/edit`} className={iconBtn} title="Modifier dans l'éditeur Office"><ExternalLink className="h-4 w-4" /></a>}
                  {canRename && <button onClick={() => { setDraft(name); setRenaming(true); }} className={iconBtn} title="Renommer"><Pencil className="h-4 w-4" /></button>}
                  {hasFile && <BoutonTelecharger href={`${src}?dl=1`} nom={name} sansChoix={Boolean(srcOverride)} className={iconBtn} title="Enregistrer (télécharger)"><Download className="h-4 w-4" /></BoutonTelecharger>}
                  {canDelete && (
                    <button onClick={onDelete} disabled={deleting} className="rounded-lg p-2.5 text-muted-foreground sm:p-2 transition-colors hover:bg-destructive/10 hover:text-destructive" title="Supprimer">
                      {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                    </button>
                  )}
                  <button onClick={() => setAgrandi((v) => !v)} className={iconBtn} title={agrandi ? "Réduire la fenêtre" : "Plein écran"} aria-pressed={agrandi}>
                    {agrandi ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
                  </button>
                  <button onClick={() => setOpen(false)} className={iconBtn} title="Fermer"><X className="h-4 w-4" /></button>
                </div>
              )}
            </div>
            <div className="flex-1 overflow-auto bg-muted/20 p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:p-3">
              {canPreview ? (
                kind === "zip" ? (
                  <ZipViewer id={id} name={name} zipUrl={`${src}/zip`} downloadUrl={`${src}?dl=1`} />
                ) : (
                  <ApercuUniversel src={src} name={name} telechargement={`${src}?dl=1`} cible={srcOverride ? undefined : { type: "document", id }} />
                )
              ) : (
                <div className="flex h-full min-h-[40vh] flex-col items-center justify-center gap-3 text-center">
                  <p className="text-sm text-muted-foreground">{hasFile ? "Aperçu non disponible pour ce type de fichier." : "Aucun fichier — métadonnées uniquement."}</p>
                  {hasFile && <BoutonTelecharger href={`${src}?dl=1`} nom={name} sansChoix={Boolean(srcOverride)} className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"><Download className="h-4 w-4" /> Télécharger</BoutonTelecharger>}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
