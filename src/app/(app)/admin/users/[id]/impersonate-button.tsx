"use client";

import * as React from "react";
import { Eye, Loader2 } from "lucide-react";
import { startImpersonation } from "@/lib/actions/impersonation-actions";
import { annoncerBasculeDeVue, annulerBasculeDeVue } from "@/components/layout/identite-vue";
import { useRetours } from "@/components/ui/retour";
import { sansBloquer } from "@/lib/journal";

export function ImpersonateButton({ userId }: { userId: string }) {
  const [pending, start] = React.useTransition();
  const retours = useRetours();
  return (
    <button
      disabled={pending}
      onClick={() =>
        start(async () => {
          const fd = new FormData();
          fd.set("userId", userId);
          // La garde d'identité se tait : c'est ce bouton qui recharge, vers l'espace de la personne.
          annoncerBasculeDeVue();
          const r = await startImpersonation(fd).catch(sansBloquer("impersonate-button.ImpersonateButton.startImpersonation", null));
          if (!r || !r.ok) { annulerBasculeDeVue(); retours.erreur(r?.error ?? "La vue de cet utilisateur n'a pas été ouverte."); return; }
          // RECHARGEMENT COMPLET : la coque (barre du haut, menu, bandeau) se rend pour la personne visualisée.
          window.location.assign(r.message ?? "/mon-espace");
        })
      }
      className="ml-auto inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-card px-4 text-sm font-medium hover:bg-secondary disabled:opacity-50"
      title="Voir l'OS exactement comme cet utilisateur"
    >
      {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />} Voir comme cet utilisateur
    </button>
  );
}
