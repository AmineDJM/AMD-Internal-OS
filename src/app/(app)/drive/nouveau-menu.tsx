"use client";

import * as React from "react";
import { Plus, ChevronDown, FolderPlus, FilePlus2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { LetterheadOption } from "@/lib/queries/letterheads";
import { NewFolderButton } from "./new-folder-button";
import { NewOfficeButton } from "./new-office-button";

/**
 * « NOUVEAU ▾ » — dossier et document Office rangés sous UN bouton secondaire (audit Drive, C7) :
 * trois boutons de même poids alignés, c'était zéro hiérarchie. Le geste principal, « Importer »,
 * reste seul en bouton plein. Les feuilles de création sont celles d'avant, pilotées d'ici.
 */
export function NouveauMenu({
  parentId, spaceId, officeEnabled, letterheads, companyId,
}: {
  parentId: string | null;
  spaceId?: string | null;
  officeEnabled: boolean;
  letterheads?: LetterheadOption[];
  companyId?: string | null;
}) {
  const [menu, setMenu] = React.useState(false);
  const [quoi, setQuoi] = React.useState<"dossier" | "document" | null>(null);
  const entree = "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2.5 text-left text-sm hover:bg-secondary sm:py-2";
  return (
    <div className="relative inline-flex">
      <Button variant="outline" type="button" onClick={() => setMenu((v) => !v)} aria-expanded={menu} aria-haspopup="menu">
        <Plus className="h-4 w-4" /> Nouveau <ChevronDown className="h-3.5 w-3.5 opacity-70" />
      </Button>
      {menu && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setMenu(false)} />
          <div role="menu" className="absolute left-0 top-full z-20 mt-1 w-56 rounded-xl border border-border bg-popover p-1 shadow-xl max-sm:fixed max-sm:inset-x-4 max-sm:bottom-[calc(1rem+env(safe-area-inset-bottom))] max-sm:top-auto max-sm:mt-0 max-sm:w-auto">
            <button type="button" role="menuitem" className={entree} onClick={() => { setMenu(false); setQuoi("dossier"); }}>
              <FolderPlus className="h-4 w-4 shrink-0 text-muted-foreground" /> Dossier
            </button>
            <button type="button" role="menuitem" className={entree} onClick={() => { setMenu(false); setQuoi("document"); }}>
              <FilePlus2 className="h-4 w-4 shrink-0 text-muted-foreground" /> Document Word, Excel, PowerPoint
            </button>
          </div>
        </>
      )}
      <NewFolderButton parentId={parentId} spaceId={spaceId} ouvert={quoi === "dossier"} onFermer={() => setQuoi(null)} />
      <NewOfficeButton parentId={parentId} spaceId={spaceId} officeEnabled={officeEnabled} letterheads={letterheads} companyId={companyId} ouvert={quoi === "document"} onFermer={() => setQuoi(null)} />
    </div>
  );
}
