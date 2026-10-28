"use client";

import * as React from "react";
import type { NavItem } from "@/lib/labels";
import { useModuleDiffere } from "@/components/ui/differe";

/**
 * LA PALETTE DE COMMANDES — ce que la coque garde : l'écoute de ⌘K / Ctrl+K et de l'événement
 * `amd:open-palette` (la loupe de la barre du haut). La fenêtre (`command-palette-fenetre.tsx`) se
 * télécharge au premier moment libre ; ouverte avant, elle s'affiche dès qu'elle arrive.
 */
export function CommandPalette({ navItems }: { navItems: NavItem[] }) {
  const [open, setOpen] = React.useState(false);
  const { module: fenetre, charger } = useModuleDiffere(() => import("./command-palette-fenetre"));

  // Open via ⌘K / Ctrl+K and via a global custom event (topbar search box).
  React.useEffect(() => {
    async function amorcer() {
      try {
        await charger();
      } catch {
        // Hors ligne : la palette ne s'ouvre pas (sa recherche ne répondrait pas non plus).
      }
    }
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
        void amorcer();
      }
    }
    function onOpen() { setOpen(true); void amorcer(); }
    window.addEventListener("keydown", onKey);
    window.addEventListener("amd:open-palette", onOpen);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("amd:open-palette", onOpen); };
  }, [charger]);

  if (!open || !fenetre) return null;
  return <fenetre.FenetrePalette navItems={navItems} onFermer={() => setOpen(false)} />;
}
