"use client";

import * as React from "react";
import { useBackgroundUpload } from "@/components/layout/background-upload";
import { useLimitesEnvoi } from "@/components/layout/use-limites-envoi";
import { envoiDrive } from "@/components/drive/envoi-drive";

/**
 * DÉPOSER UNE NOUVELLE VERSION d'un fichier — un seul chemin, qu'on parte du bouton « Importer » ou du menu « ⋯ ».
 * L'envoi passe au gestionnaire global (non bloquant), avec les mêmes limites et le même envoi direct.
 *
 * Module à part, léger : le fichier ouvert s'en sert sans embarquer tout l'écran d'import.
 */
export function useNouvelleVersion(): (nodeId: string, file: File) => void {
  const { enqueue } = useBackgroundUpload();
  const limites = useLimitesEnvoi();
  return React.useCallback((nodeId: string, file: File) => {
    enqueue({
      label: "Nouvelle version",
      files: [file],
      ...envoiDrive({ nodeId }, limites),
      makeRequest: (f) => { const fd = new FormData(); fd.append("file", f); fd.append("nodeId", nodeId); return { url: "/api/drive/upload", formData: fd }; },
    });
  }, [enqueue, limites]);
}
