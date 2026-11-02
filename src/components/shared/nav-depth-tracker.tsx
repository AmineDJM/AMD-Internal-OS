"use client";

import * as React from "react";
import { usePathname } from "next/navigation";

/*
 * LE COMPTEUR DE NAVIGATIONS INTERNES — la part de `back-link.tsx` que monte la coque. À part, parce que
 * la coque embarque TOUS les exports d'un module client qu'elle importe : le lien « Retour » lui-même
 * ne sert qu'aux pages. La raison d'être du compteur est expliquée dans `back-link.tsx`.
 */

const KEY = "amd-nav-depth";

/** Nombre de navigations effectuées DANS l'application, pour cet onglet. */
export function depth(): number {
  try {
    return Number(sessionStorage.getItem(KEY) ?? "0") || 0;
  } catch {
    return 0; // navigation privée stricte : on retombe sur le lien écrit
  }
}

/**
 * Compte les navigations internes. Monté une fois dans la coque de l'application.
 *
 * ⚠️ Ne compte QUE les changements de chemin après le premier rendu : la page d'arrivée n'est
 * pas une navigation, sinon un lien « Retour » ouvert directement croirait pouvoir remonter.
 */
export function NavDepthTracker() {
  const pathname = usePathname();
  const first = React.useRef(true);

  React.useEffect(() => {
    if (first.current) {
      first.current = false;
      // Nouvel onglet / rechargement : l'historique interne repart de zéro.
      try { sessionStorage.setItem(KEY, "0"); } catch { /* stockage indisponible */ }
      return;
    }
    try { sessionStorage.setItem(KEY, String(depth() + 1)); } catch { /* stockage indisponible */ }
  }, [pathname]);

  return null;
}
