"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { CHEMIN_CONFORMITE } from "@/lib/chemins/ad-pro";

/**
 * LES ANCIENNES NOTIFICATIONS « BAT À CONTRÔLER » menaient à `/information-medicale#bat-<poste>` : les BAT ne vivent plus
 * que dans « Contrôles de conformité » (24/11/2026). L'ancre suit la ligne là-bas, au lieu de tomber sur un écran sans elle.
 */
export function AncreBatVersConformite() {
  const router = useRouter();
  React.useEffect(() => {
    const ancre = window.location.hash;
    if (ancre === "#bat" || ancre.startsWith("#bat-")) router.replace(`${CHEMIN_CONFORMITE}${ancre}`);
  }, [router]);
  return null;
}
