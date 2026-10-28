import * as React from "react";
import dynamic from "next/dynamic";
import type { LucideIcon, LucideProps } from "lucide-react";
import { ICONES_COQUE } from "./icones-coque";

/**
 * Le jeu COMPLET (`ui/icon.tsx`), chargé à la demande — et seulement si un nom manque à la table : le
 * filet de sécurité d'un oubli que `icones-coque.test.ts` aurait dû attraper. Jamais dans le bundle de
 * la coque.
 */
const IconeHorsTable = dynamic(() => import("./icon").then((m) => m.Icon));

/**
 * Une icône de la COQUE par son nom (menu, pôles, onglets, palette de commandes) — la table statique
 * `ICONES_COQUE`, sans tirer les ~1 400 icônes de Lucide dans chaque page (audit performance PERF-05).
 * Hors coque, pour un nom qui vient de la base, `Icon` (`ui/icon.tsx`) reste la porte.
 */
export function IconeCoque({ name, ...props }: LucideProps & { name: string }) {
  const Composant: LucideIcon | undefined = Object.hasOwn(ICONES_COQUE, name)
    ? ICONES_COQUE[name as keyof typeof ICONES_COQUE]
    : undefined;
  if (Composant) return <Composant {...props} />;
  return <IconeHorsTable name={name} {...props} />;
}
