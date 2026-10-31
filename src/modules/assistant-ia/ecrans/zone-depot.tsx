"use client";

import React from "react";
import { FolderUp } from "lucide-react";
import { OCTETS_MAX_DEPOT } from "../domaine/lecture/depot";
import { PIECES_LUES_MAX } from "../domaine/lecture/regles";

/** LA ZONE DE DÉPÔT (décision 0015) — affichée dès que des FICHIERS survolent la conversation, dans l'ERP comme dans l'app. */
export function ZoneDepot({ apparence = "erp" }: { apparence?: "erp" | "app" }) {
  const couleurs = apparence === "app"
    ? "inset-3 border-[var(--aia-accent)] bg-[var(--aia-accent-doux)]/95 text-[var(--aia-accent)]"
    : "inset-2 border-violet-500 bg-violet-50/90 text-violet-900 backdrop-blur-sm sm:inset-3 dark:border-violet-400 dark:bg-violet-950/80 dark:text-violet-100";
  return (
    <div data-testid="zone-depot" className={`pointer-events-none absolute z-30 flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed text-center ${couleurs}`}>
      <FolderUp className="h-8 w-8" aria-hidden />
      <p className="text-base font-semibold">Déposez vos fichiers ou dossiers</p>
      <p className="max-w-sm px-4 text-xs opacity-80">
        Jusqu&apos;à {PIECES_LUES_MAX} pièces lues dans le message ({Math.round(OCTETS_MAX_DEPOT / 1048576)} Mo chacune) ; au-delà, tout est lu en arrière-plan. Rien n&apos;est envoyé avant que vous appuyiez sur Entrée.
      </p>
    </div>
  );
}
