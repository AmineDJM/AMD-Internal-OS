"use client";

import * as React from "react";
import { Building2, Check, ChevronDown, Loader2 } from "lucide-react";
import { setCompanyScope } from "@/lib/actions/company-actions";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { useRetours } from "@/components/ui/retours-porteur";
import { actionFailureMessage } from "@/lib/action-outcome";

interface Company {
  id: string;
  name: string;
  shortName: string | null;
  color: string | null;
}

/**
 * Sélecteur d'entité de la barre supérieure. « Toutes les entités » n'applique aucun
 * filtre ; sinon les vues serveur se restreignent à l'entité choisie (cookie de portée).
 */
export function CompanySwitcher({ companies, scope }: { companies: Company[]; scope: string | null }) {
  const { rafraichir } = useRafraichir();
  const retours = useRetours();
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  if (companies.length === 0) return null;
  const current = companies.find((c) => c.id === scope) ?? null;

  // UNE SEULE ENTITÉ ⇒ AUCUN SÉLECTEUR. Quelqu'un d'Adventum n'a pas à voir un menu déroulant
  // qui laisse croire qu'il pourrait changer de société, ni une entrée « Toutes les entités »
  // qui n'ouvre rien de plus que la sienne. On affiche son entité, comme une information — et
  // le cloisonnement cesse d'être une case à cocher qu'on se demande s'il faut décocher.
  if (companies.length === 1) {
    const only = companies[0];
    return (
      <span
        className="flex h-9 items-center gap-1.5 rounded-lg border border-input bg-secondary/30 px-2.5 text-sm font-medium"
        title={`Votre entité : ${only.name}`}
      >
        <span className="flex h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: only.color ?? "#94a3b8" }} />
        <span className="hidden max-w-[9rem] truncate sm:inline">{only.shortName || only.name}</span>
      </span>
    );
  }

  async function choose(value: string) {
    setBusy(true);
    try {
      await setCompanyScope(value);
    } catch {
      retours.erreur(actionFailureMessage("THROWN"));
      return;
    } finally {
      setOpen(false);
      setBusy(false);
    }
    rafraichir();
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={busy}
        className="flex h-9 items-center gap-1.5 rounded-lg border border-input bg-background px-2.5 text-sm font-medium shadow-sm hover:bg-secondary/40 disabled:opacity-60"
        title="Entité affichée — filtre toutes les vues"
        aria-label="Changer d'entité"
      >
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
        ) : (
          <span className="flex h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: current?.color ?? "#94a3b8" }} />
        )}
        <span className="hidden max-w-[9rem] truncate sm:inline">{current ? current.shortName || current.name : "Toutes les entités"}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      </button>

      {open && (
        <div className="absolute right-0 z-40 mt-1 w-60 overflow-hidden rounded-lg border border-border bg-card py-1 shadow-lg">
          <button
            type="button"
            onClick={() => choose("ALL")}
            className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-secondary"
          >
            <Building2 className="h-4 w-4 text-muted-foreground" />
            <span className="flex-1 text-left">Toutes les entités</span>
            {scope === null && <Check className="h-4 w-4 text-primary" />}
          </button>
          <div className="my-1 h-px bg-border" />
          {companies.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => choose(c.id)}
              className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-secondary"
            >
              <span className="flex h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: c.color ?? "#94a3b8" }} />
              <span className="flex-1 truncate text-left">{c.shortName || c.name}</span>
              {scope === c.id && <Check className="h-4 w-4 text-primary" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
