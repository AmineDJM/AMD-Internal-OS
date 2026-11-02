"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { IconeCoque } from "@/components/ui/icone-coque";
import { cn } from "@/lib/utils";
import { OFFICE_PINS_KEY, parsePinned, pinnedApps, officeHref, type OfficeAppKey } from "@/lib/office/apps";
import { lireStockagePersonnel, useIdentiteEcran } from "@/components/layout/identite-vue";

/**
 * LES APPLICATIONS ÉPINGLÉES, dans le menu de gauche.
 *
 * Chacun met dans son menu ce qu'il ouvre tous les jours : une assistante vivra dans Word, un
 * contrôleur de gestion dans Excel. Imposer les trois à tout le monde allongerait le menu pour
 * n'être juste pour personne.
 *
 * La préférence est LOCALE au navigateur : elle ne concerne que l'affichage, ne donne aucun droit,
 * et n'a donc pas à traverser le réseau à chaque page. Elle est lue APRÈS le montage — un menu
 * rendu différemment sur le serveur et sur le client casserait l'hydratation.
 */
export function OfficePins() {
  const pathname = usePathname();
  const [pins, setPins] = React.useState<OfficeAppKey[]>([]);
  // Rangées par PERSONNE À L'ÉCRAN : en Vue exacte, les épingles de Leila, pas celles de l'administrateur.
  const ident = useIdentiteEcran();

  React.useEffect(() => {
    const read = () => setPins(parsePinned(lireStockagePersonnel(OFFICE_PINS_KEY, ident)));
    read();
    // L'écran Bureautique annonce le changement : l'entrée apparaît au clic, pas au rechargement
    // suivant. `storage` couvre les autres onglets ouverts.
    const onPins = (e: Event) => {
      const detail = (e as CustomEvent<{ pins: OfficeAppKey[] }>).detail;
      if (detail?.pins) setPins(detail.pins);
    };
    window.addEventListener("amd:office-pins", onPins);
    window.addEventListener("storage", read);
    return () => { window.removeEventListener("amd:office-pins", onPins); window.removeEventListener("storage", read); };
  }, [ident]);

  const apps = pinnedApps(pins);
  if (apps.length === 0) return null;
  // On surligne le Drive, où les documents naissent et vivent — pas l'application choisie :
  // lire `?new=` obligerait à `useSearchParams`, qui force une frontière Suspense sur TOUTES
  // les pages portant ce menu.
  const onOffice = pathname === "/drive";

  return (
    <div>
      <p className="px-3 pb-1.5 text-[0.625rem] font-semibold uppercase tracking-wider text-sidebar-muted">Bureautique</p>
      <ul className="space-y-0.5">
        {apps.map((a) => (
          <li key={a.key}>
            <Link
              href={officeHref(a.key)}
              className={cn(
                "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                onOffice ? "bg-sidebar-active text-white" : "text-sidebar-muted hover:bg-sidebar-active/60 hover:text-white",
              )}
            >
              <IconeCoque name={a.icon} className="h-4 w-4 shrink-0" />
              <span className="truncate">{a.label}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
