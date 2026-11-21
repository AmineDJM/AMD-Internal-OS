"use client";

import * as React from "react";
import { LogOut, ChevronDown } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { doSignOut } from "@/lib/actions/auth-actions";
import { ROLE_LABELS } from "@/lib/labels";
import { QuitterVueBouton } from "@/components/layout/quitter-vue-bouton";

interface UserMenuProps {
  name: string;
  email: string;
  role: string;
  /** Vue exacte : le menu est celui de la personne visualisée, sa seule sortie est « Quitter la vue ». */
  enVue?: boolean;
}

export function UserMenu({ name, email, role, enVue = false }: UserMenuProps) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 rounded-lg p-1 transition-colors hover:bg-secondary sm:pr-2"
      >
        <Avatar name={name} size="sm" />
        {/* Le nom et le rôle à partir de `lg` seulement, tronqués : entre 640 et 1 024 px, ils poussaient l'avatar hors de la
            barre (recette, 21/11/2026). L'avatar suffit en dessous ; le menu ouvert redonne le nom en entier. */}
        <div className="hidden max-w-[11rem] text-left lg:block">
          <p className="truncate text-sm font-medium leading-tight">{name}</p>
          <p className="truncate text-[0.6875rem] leading-tight text-muted-foreground">
            {ROLE_LABELS[role] ?? role}
          </p>
        </div>
        <ChevronDown className="hidden h-4 w-4 text-muted-foreground lg:block" />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1.5 w-60 animate-fade-in rounded-xl border border-border bg-popover p-1.5 shadow-lg">
          <div className="px-2.5 py-2">
            <p className="text-sm font-medium">{name}</p>
            <p className="truncate text-xs text-muted-foreground">{email}</p>
          </div>
          <div className="my-1 h-px bg-border" />
          {/* EN VUE EXACTE, le menu est celui de la personne visualisée — et « Se déconnecter » déconnecterait
              l'ADMINISTRATEUR depuis l'écran d'une autre. La seule sortie proposée est celle de la vue. */}
          {enVue ? (
            <QuitterVueBouton
              libelle="Quitter la vue"
              className="w-full justify-start gap-2 rounded-lg bg-transparent px-2.5 py-2 text-sm font-normal text-foreground hover:bg-secondary"
            />
          ) : (
          <form action={doSignOut}>
            <button
              type="submit"
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-destructive transition-colors hover:bg-destructive/10"
            >
              <LogOut className="h-4 w-4" />
              Se déconnecter
            </button>
          </form>
          )}
        </div>
      )}
    </div>
  );
}
