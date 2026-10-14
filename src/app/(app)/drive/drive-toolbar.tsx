"use client";

import * as React from "react";
import Link from "next/link";
import { MoreHorizontal, Trash2, Maximize2, MoveHorizontal, Settings2 } from "lucide-react";
import { setFocusMode } from "@/components/layout/focus-mode";
import { Sheet } from "@/components/ui/sheet";

/**
 * LA BARRE D'OUTILS DU DRIVE — discrète, parce qu'elle n'est pas le sujet.
 *
 * L'en-tête accumulait sept commandes de même poids : « Plein écran », « Nouveau dossier »,
 * « Nouveau document », « Importer », « Accès & réglages », « Corbeille », plus une phrase
 * d'explication. Sept boutons alignés, c'est zéro hiérarchie : l'œil doit tous les lire pour
 * trouver le bon, et le contenu — les fichiers — est repoussé sous la ligne de flottaison.
 *
 * Deux gestes se font tous les jours : **créer** et **importer**. Ils restent visibles. Le reste
 * (plein écran, réglages d'accès, corbeille) se fait une fois par semaine : ça va dans le menu
 * « ⋯ ». Et la phrase d'explication disparaît — on n'explique pas à quelqu'un ce qu'est un
 * dossier partagé chaque fois qu'il l'ouvre.
 */

/** Préférence « plein écran » du Drive — par navigateur, comme dans un explorateur. */
const WIDE_KEY = "amd-drive-wide";

/**
 * UN OUTIL RARE, RANGÉ DANS LE MENU — son panneau vit HORS du menu.
 *
 * C'est la leçon du commentaire ci-dessous : un panneau rendu à l'intérieur du menu déroulant
 * est démonté par le clic même qui l'ouvre. Le menu ne porte donc que l'ENTRÉE ; la feuille est
 * montée au niveau de la barre, et survit à sa fermeture.
 */
export interface ToolbarTool {
  key: string;
  label: string;
  description?: string;
  icon: React.ReactNode;
  /** Une feuille montée au niveau de la barre… */
  panel?: React.ReactNode;
  /** …ou un LIEN vers l'écran qui tient l'outil (la papeterie vit dans « Direction artistique »). */
  href?: string;
}

export function DriveToolbar({
  primary, trashHref, trashLabel, settings, tools = [],
}: {
  /** Les commandes de tous les jours : créer, importer. Rendues telles quelles. */
  primary?: React.ReactNode;
  trashHref: string;
  trashLabel: string;
  /** Bouton « Accès & réglages » de la catégorie, quand il y a lieu. */
  settings?: React.ReactNode;
  /** Outils rares (papeterie de la société…) : une entrée de menu, une feuille. */
  tools?: ToolbarTool[];
}) {
  const [open, setOpen] = React.useState(false);
  const [tool, setTool] = React.useState<string | null>(null);
  const [wide, setWide] = React.useState(false);

  React.useEffect(() => { setWide(window.localStorage.getItem(WIDE_KEY) === "1"); }, []);

  React.useEffect(() => {
    // Le plafond de 1400 px protège la lecture d'un TEXTE ; appliqué à une arborescence avec son
    // volet et six colonnes, il ne protège rien — il comprime. Reposé en quittant la page, sinon
    // un formulaire hériterait d'une largeur pensée pour des colonnes.
    const root = document.documentElement;
    if (wide) root.style.setProperty("--shell-max", "100%");
    else root.style.removeProperty("--shell-max");
    return () => { root.style.removeProperty("--shell-max"); };
  }, [wide]);

  const toggleWide = () => {
    const next = !wide;
    setWide(next);
    try { window.localStorage.setItem(WIDE_KEY, next ? "1" : "0"); } catch { /* refusé : sans mémoire */ }
  };

  // `flex-wrap` : quatre boutons font 790 px — plus du double d'un téléphone. Sans retour à la
  // ligne, les deux derniers étaient hors de l'écran, invisibles et inatteignables.
  return (
    <div className="flex flex-wrap items-center gap-2">
      {primary}
      {/* « Accès & réglages » vit ICI et non dans le menu « ⋯ » : le panneau y était rendu à
          l'intérieur du menu, et le clic qui l'ouvrait fermait le menu — donc démontait le
          panneau dans le même geste. Rien ne se passait, et c'était sans recours. */}
      {settings}
      <div className="relative">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-label="Plus d'actions"
          aria-expanded={open}
          className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-input text-muted-foreground sm:h-auto sm:w-auto sm:p-2 transition-colors hover:bg-secondary hover:text-foreground"
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
        {open && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
            {/* Au téléphone, le bouton peut tomber à gauche d'une rangée repliée : un menu
                accroché à sa droite sortirait de l'écran. Il se pose alors en bas, pleine largeur. */}
            <div className="absolute right-0 top-full z-20 mt-1 w-56 overflow-hidden rounded-xl border border-border bg-popover p-1 shadow-xl max-sm:fixed max-sm:inset-x-4 max-sm:bottom-[calc(1rem+env(safe-area-inset-bottom))] max-sm:top-auto max-sm:mt-0 max-sm:max-h-[70dvh] max-sm:w-auto max-sm:overflow-y-auto">
              <button
                type="button"
                onClick={() => { setFocusMode(true); setOpen(false); }}
                className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2.5 sm:py-2text-left text-sm hover:bg-secondary"
              >
                <Maximize2 className="h-4 w-4 text-muted-foreground" />
                Plein écran
              </button>
              <button
                type="button"
                onClick={() => { toggleWide(); setOpen(false); }}
                className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2.5 sm:py-2text-left text-sm hover:bg-secondary"
              >
                <MoveHorizontal className="h-4 w-4 text-muted-foreground" />
                {wide ? "Largeur de lecture" : "Pleine largeur"}
              </button>
              <Link
                href={trashHref}
                onClick={() => setOpen(false)}
                className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2.5 sm:py-2text-sm hover:bg-secondary"
              >
                <Trash2 className="h-4 w-4 text-muted-foreground" /> {trashLabel}
              </Link>
              {tools.map((t) => t.href ? (
                <Link
                  key={t.key}
                  href={t.href}
                  onClick={() => setOpen(false)}
                  className="flex w-full items-start gap-2.5 rounded-md px-2.5 py-2.5 sm:py-2 text-left text-sm hover:bg-secondary"
                >
                  <span className="mt-0.5 shrink-0 text-muted-foreground">{t.icon}</span>
                  <span>
                    <span className="block">{t.label}</span>
                    {t.description && <span className="block text-xs text-muted-foreground">{t.description}</span>}
                  </span>
                </Link>
              ) : (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => { setTool(t.key); setOpen(false); }}
                  className="flex w-full items-start gap-2.5 rounded-md px-2.5 py-2.5 sm:py-2text-left text-sm hover:bg-secondary"
                >
                  <span className="mt-0.5 shrink-0 text-muted-foreground">{t.icon}</span>
                  <span>
                    <span className="block">{t.label}</span>
                    {t.description && <span className="block text-xs text-muted-foreground">{t.description}</span>}
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {tools.filter((t) => !t.href).map((t) => (
        <Sheet key={t.key} open={tool === t.key} onClose={() => setTool(null)} title={t.label} description={t.description} width="md">
          {t.panel}
        </Sheet>
      ))}
    </div>
  );
}

/** Icône neutre pour les écrans qui veulent afficher « réglages » sans importer lucide. */
export const SettingsIcon = Settings2;
