"use client";

import * as React from "react";
import { useBackgroundUpload } from "@/components/layout/background-upload";
import { useLimitesEnvoi } from "@/components/layout/use-limites-envoi";
import { envoiDrive } from "@/components/drive/envoi-drive";
import { useConfirmer } from "@/components/ui/dialogue";
import { avertissementExtension, extensionDiffere } from "@/lib/drive/depot-regles";

/**
 * DÉPOSER UNE NOUVELLE VERSION d'un fichier — un seul chemin, qu'on parte du bouton « Importer » ou du menu « ⋯ ».
 * L'envoi passe au gestionnaire global (non bloquant), avec les mêmes limites et le même envoi direct.
 *
 * Un contenu d'un AUTRE TYPE (un .xlsx déposé sur « x.pdf ») se confirme d'abord (audit Drive, C3) :
 * le fichier prendra la nouvelle extension — on ne remplace pas un PDF par un classeur par mégarde.
 *
 * Module à part, léger : le fichier ouvert s'en sert sans embarquer tout l'écran d'import.
 */
export function useNouvelleVersion(): (nodeId: string, file: File, nomActuel?: string) => Promise<void> {
  const { enqueue } = useBackgroundUpload();
  const limites = useLimitesEnvoi();
  const confirmer = useConfirmer();
  return React.useCallback(async (nodeId: string, file: File, nomActuel?: string) => {
    if (nomActuel && extensionDiffere(nomActuel, file.name)) {
      const ok = await confirmer({ titre: "Déposer un fichier d'un autre type ?", message: avertissementExtension(nomActuel, file.name), confirmer: "Déposer la nouvelle version", ton: "neutre" });
      if (!ok) return;
    }
    enqueue({
      label: "Nouvelle version",
      files: [file],
      ...envoiDrive({ nodeId }, limites),
      makeRequest: (f) => { const fd = new FormData(); fd.append("file", f); fd.append("nodeId", nodeId); return { url: "/api/drive/upload", formData: fd }; },
    });
  }, [enqueue, limites, confirmer]);
}
