"use client";

import * as React from "react";
import { FolderTree, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { synchroniserDriveRegulatory } from "@/lib/actions/regulatory-drive-actions";
import { useConfirmer } from "@/components/ui/dialogue";
import { actionFailureMessage } from "@/lib/action-outcome";

/**
 * « RANGER LES DOSSIERS DANS LE DRIVE » — Super Admin seul (Direction, 06/10). Chaque dossier du suivi
 * reçoit son dossier dans la catégorie Drive « Regulatory », organisé comme le modèle, et ses pièces y
 * sont rangées. L'action est bornée dans le temps : on la rappelle avec le curseur rendu jusqu'à la fin.
 */
export function RangerDansLeDrive() {
  const confirmer = useConfirmer();
  const [envoi, setEnvoi] = React.useState(false);
  const [msg, setMsg] = React.useState<{ ok: boolean; text: string } | null>(null);
  async function lancer() {
    if (!await confirmer("Ranger tous les dossiers du suivi dans la catégorie Drive « Regulatory » ?\n\nChaque dossier y reçoit l'arborescence modèle, et ses pièces déjà déposées y sont rangées. Rien n'est supprimé ni déplacé ; relancer n'ajoute que ce qui manque.")) return;
    setEnvoi(true); setMsg(null);
    let curseur: string | null = null;
    const cumul = { dossiers: 0, crees: 0, fichiers: 0 };
    try {
      for (let tour = 0; tour < 200; tour++) {
        const r = await synchroniserDriveRegulatory(curseur);
        if (!r.ok) { setMsg({ ok: false, text: r.error ?? "Impossible." }); break; }
        cumul.dossiers += r.dossiers ?? 0; cumul.crees += r.dossiersCrees ?? 0; cumul.fichiers += r.fichiers ?? 0;
        curseur = r.curseur ?? null;
        if (!curseur) { setMsg({ ok: true, text: tour === 0 ? (r.message ?? "Fait.") : `${cumul.dossiers} dossier(s) parcouru(s) : ${cumul.crees} dossier(s) Drive créé(s), ${cumul.fichiers} fichier(s) rangé(s).` }); break; }
        setMsg({ ok: true, text: `En cours… ${cumul.dossiers} dossier(s) parcouru(s), ${r.restants ?? 0} restant(s).` });
      }
    } catch {
      setMsg({ ok: false, text: actionFailureMessage("THROWN") });
    } finally {
      setEnvoi(false);
    }
  }
  return (
    <span className="inline-flex max-w-full flex-wrap items-center gap-2">
      <Button variant="outline" size="sm" disabled={envoi} onClick={() => void lancer()} title="Crée le dossier Drive de chaque dossier du suivi (catégorie « Regulatory ») et y range ses pièces">
        {envoi ? <Loader2 className="h-4 w-4 animate-spin" /> : <FolderTree className="h-4 w-4" />} Ranger les dossiers dans le Drive
      </Button>
      {msg && <span className={`min-w-0 text-xs ${msg.ok ? "text-muted-foreground" : "text-destructive"}`}>{msg.text}</span>}
    </span>
  );
}
