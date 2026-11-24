"use client";

import * as React from "react";
import { CopyPlus, History } from "lucide-react";
import { Sheet } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { useBackgroundUpload } from "@/components/layout/background-upload";
import { useLimitesEnvoi } from "@/components/layout/use-limites-envoi";
import { useRetours } from "@/components/ui/retour";
import { envoiDrive, envoiArborescenceDrive, preflightDrive } from "@/components/drive/envoi-drive";
import { FICHIER_PARASITE, type EntreeDepot } from "@/components/documents/envoi-document";
import { doublonsAuDepot, ensureDriveFolders } from "@/lib/actions/drive-actions";
import { actionFailureMessage } from "@/lib/action-outcome";
import { questionDoublon, type ChoixDoublon } from "@/lib/drive/depot-regles";

/** Ce que le dépôt ajoute au fichier (feuille d'import : type de document et partages). */
export interface ExtraDepot { category?: string | null; viewers?: string[]; editors?: string[] }

/**
 * DÉPOSER DANS LE DRIVE — bouton « Importer », feuille d'import et glisser-déposer depuis le bureau
 * passent par ICI (audit Drive du 24/11, C2 et C8).
 *
 * Avant d'envoyer, on demande au serveur quels noms existent déjà à cet endroit. S'il y en a, la
 * question est posée — « Nouvelle version » (choix par défaut) ou « Garder les deux » — au lieu de
 * créer en silence un second « contrat.pdf ». Fermer la question n'envoie rien.
 */
export function useDepotDrive(cible: { parentId: string | null; spaceId?: string | null }) {
  const { enqueue } = useBackgroundUpload();
  const limites = useLimitesEnvoi();
  const retours = useRetours();
  const parentId = cible.parentId ?? null;
  const spaceId = parentId ? null : cible.spaceId ?? null;
  const [question, setQuestion] = React.useState<{ noms: string[]; repondre: (c: ChoixDoublon | null) => void } | null>(null);

  /** `undefined` : aucun doublon ; `null` : la personne a renoncé. */
  const choisir = React.useCallback(async (noms: string[]): Promise<ChoixDoublon | null | undefined> => {
    let existants: string[] = [];
    try { existants = (await doublonsAuDepot(parentId, spaceId, noms)).noms; } catch { /* la question est un confort : le dépôt part sans */ }
    if (existants.length === 0) return undefined;
    return new Promise((repondre) => setQuestion({ noms: existants, repondre }));
  }, [parentId, spaceId]);

  const deposerFichiers = React.useCallback(async (files: File[], extra: ExtraDepot = {}) => {
    if (files.length === 0) return;
    const choix = await choisir(files.map((f) => f.name));
    if (choix === null) return;
    const siExiste = choix ?? null;
    const cat = (extra.category ?? "").trim() || null;
    const viewers = extra.viewers ?? [];
    const editors = extra.editors ?? [];
    enqueue({
      label: `${files.length} fichier${files.length > 1 ? "s" : ""} (Drive)`,
      files,
      concurrency: 6,
      ...envoiDrive({ parentId, spaceId, category: cat, viewers, editors, siExiste }, limites),
      preflight: preflightDrive({ parentId, spaceId, category: cat ?? undefined, viewers, editors, siExiste }),
      makeRequest: (file) => {
        const fd = new FormData();
        fd.append("file", file);
        if (parentId) fd.append("parentId", parentId);
        if (spaceId) fd.append("spaceId", spaceId);
        if (cat) fd.append("category", cat);
        if (siExiste) fd.append("siExiste", siExiste);
        viewers.forEach((id) => fd.append("viewers", id));
        editors.forEach((id) => fd.append("editors", id));
        return { url: "/api/drive/upload", formData: fd };
      },
    });
  }, [choisir, enqueue, limites, parentId, spaceId]);

  /** Un dépôt qui porte des DOSSIERS (glisser-déposer, choix de dossier) : l'arborescence est recréée d'abord. */
  const deposerEntrees = React.useCallback(async (brutes: EntreeDepot[]) => {
    const entrees = brutes.filter((e) => !FICHIER_PARASITE.test(e.file.name));
    if (entrees.length === 0) return;
    if (entrees.every((e) => !e.path.includes("/"))) { await deposerFichiers(entrees.map((e) => e.file)); return; }
    const dirs = [...new Set(entrees.map((e) => e.path.slice(0, Math.max(0, e.path.lastIndexOf("/")))).filter(Boolean))];
    let r: Awaited<ReturnType<typeof ensureDriveFolders>>;
    try { r = await ensureDriveFolders(parentId, dirs, spaceId); } catch { retours.erreur(actionFailureMessage("THROWN")); return; }
    if (!r.ok || !r.map) { retours.erreur(r.error ?? "Import du dossier impossible."); return; }
    const racine = entrees[0].path.split("/")[0] || "dossier";
    enqueue(envoiArborescenceDrive({
      label: `Dossier « ${racine} » (${entrees.length} fichier${entrees.length > 1 ? "s" : ""})`,
      entrees, map: r.map, parentId, spaceId, limites,
    }));
  }, [deposerFichiers, enqueue, limites, parentId, spaceId, retours]);

  const repondre = (c: ChoixDoublon | null) => { question?.repondre(c); setQuestion(null); };
  const dialogue = (
    <Sheet
      open={question !== null}
      onClose={() => repondre(null)}
      title="Déjà présent ici"
      description={question ? questionDoublon(question.noms) : undefined}
      width="md"
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" onClick={() => repondre("garder")}><CopyPlus className="h-4 w-4" /> Garder les deux</Button>
          <Button type="button" autoFocus onClick={() => repondre("version")}><History className="h-4 w-4" /> Nouvelle version</Button>
        </div>
      }
    >
      <ul className="space-y-1.5 text-sm text-muted-foreground">
        <li><strong className="text-foreground">Nouvelle version</strong> — le fichier existant est mis à jour ; l&apos;ancien contenu reste dans son historique.</li>
        <li><strong className="text-foreground">Garder les deux</strong> — un second fichier est créé, numéroté « (2) ».</li>
      </ul>
    </Sheet>
  );

  return { deposerFichiers, deposerEntrees, dialogue };
}
