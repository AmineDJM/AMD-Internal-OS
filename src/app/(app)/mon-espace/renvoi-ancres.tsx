"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ANCRE_MES_AVANCES, LIEN_MES_AVANCES } from "@/lib/chemins/rh";

/**
 * LES ANCIENNES ANCRES DE « MON ESPACE » — une notification est écrite une fois, en base : celles qui pointaient
 * « Mes avances sur salaire » ici (`/mon-espace#mes-avances`) mènent désormais à Mon dossier RH, où la liste a
 * déménagé (écran simplifié du 24/11/2026). L'ancre ne parvient jamais au serveur : c'est le navigateur qui renvoie.
 */
export function RenvoiAncres() {
  const router = useRouter();
  React.useEffect(() => {
    const lire = () => { if (window.location.hash === `#${ANCRE_MES_AVANCES}`) router.replace(LIEN_MES_AVANCES); };
    lire();
    window.addEventListener("hashchange", lire);
    return () => window.removeEventListener("hashchange", lire);
  }, [router]);
  return null;
}
