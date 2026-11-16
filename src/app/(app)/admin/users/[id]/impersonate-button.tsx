"use client";

import * as React from "react";
import { Eye, Loader2, MousePointerClick } from "lucide-react";
import { startActingAs, startImpersonation } from "@/lib/actions/impersonation-actions";
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

/**
 * « AGIR COMME CET UTILISATEUR » (Direction, 16/11/2026) — à côté de « Voir comme » : le Super Admin agit au nom de la personne,
 * pour simuler un parcours. Chaque geste est marqué et s'annule depuis « Agir comme — vos gestes » (`/admin/agir-comme`).
 */
export function AgirCommeButton({ userId }: { userId: string }) {
  const [pending, start] = React.useTransition();
  const retours = useRetours();
  return (
    <button
      disabled={pending}
      onClick={() =>
        start(async () => {
          const fd = new FormData();
          fd.set("userId", userId);
          annoncerBasculeDeVue();
          const r = await startActingAs(fd).catch(sansBloquer("impersonate-button.AgirCommeButton.startActingAs", null));
          if (!r || !r.ok) { annulerBasculeDeVue(); retours.erreur(r?.error ?? "Le mode « Agir comme » n'a pas été ouvert."); return; }
          window.location.assign(r.message ?? "/mon-espace");
        })
      }
      className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
      title="Agir au nom de cet utilisateur pour une simulation : chaque geste est enregistré et peut être annulé."
    >
      {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <MousePointerClick className="h-4 w-4" />} Agir comme cet utilisateur
    </button>
  );
}
