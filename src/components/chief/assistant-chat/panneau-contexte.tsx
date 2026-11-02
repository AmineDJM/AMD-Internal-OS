"use client";

/**
 * LA CONVERSATION — le volet CONTEXTE du Chief of Staff (sources consultées, actions du fil).
 */
import Link from "next/link";
import { Sparkles, ArrowRight, Link2 } from "lucide-react";
import type { Msg } from "./modele";

/** Le volet CONTEXTE du Chief of Staff : sources consultées + actions proposées du fil. */
export function ExecutivePanel({ sources, messages, showShortcuts = true }: {
  sources: { label: string; href: string; detail?: string }[];
  messages: Msg[];
  /**
   * LES RACCOURCIS VERS LES MODULES DE L'ERP. Ils ont leur place sur la page Assistant, qui vit
   * DANS l'ERP. Ils n'en ont aucune dans le bureau d'Adam : y remettre cinq liens de modules,
   * c'est réintroduire par la fenêtre le menu qu'on a sorti par la porte.
   */
  showShortcuts?: boolean;
}) {
  const actions = messages
    .flatMap((m) => (m.proposals ?? []).map((p, i) => ({ id: `${m.id}-${i}`, title: p.title, state: m.actionStates?.[i] ?? "pending" })))
    .slice(-6)
    .reverse();
  return (
    <aside className="hidden w-72 shrink-0 xl:block">
      <div className="flex h-full flex-col gap-3 overflow-y-auto rounded-2xl border border-border bg-card p-3">
        <div>
          <p className="flex items-center gap-1.5 px-1 text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">
            <Link2 className="h-3 w-3" /> Sources consultées
          </p>
          {sources.length === 0 ? (
            <p className="px-1 py-2 text-xs leading-relaxed text-muted-foreground">
              Les dossiers, documents et fiches que l&apos;assistant consulte apparaîtront ici, en liens cliquables.
            </p>
          ) : (
            <div className="mt-1 space-y-0.5">
              {sources.map((s) => (
                <Link key={s.href + s.label} href={s.href}
                  className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs transition hover:bg-secondary">
                  <ArrowRight className="h-3 w-3 shrink-0 text-primary" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate" title={s.label}>{s.label}</span>
                    {/* D'OÙ ET DE QUAND (F8) : famille, date propre, fraîcheur, confiance — la provenance se lit sans la demander. */}
                    {s.detail && <span className="block truncate text-[0.6875rem] text-muted-foreground" title={s.detail} data-testid="source-detail">{s.detail}</span>}
                  </span>
                </Link>
              ))}
            </div>
          )}
        </div>

        {actions.length > 0 && (
          <div>
            <p className="flex items-center gap-1.5 px-1 text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">
              <Sparkles className="h-3 w-3" /> Actions du fil
            </p>
            <div className="mt-1 space-y-1">
              {actions.map((a) => (
                <div key={a.id} className="rounded-lg border border-border/60 px-2 py-1.5 text-xs">
                  <p className="truncate font-medium" title={a.title}>{a.title}</p>
                  <p className="mt-0.5 text-muted-foreground">
                    {a.state === "done" ? "✔ Exécutée" : a.state === "cancelled" ? "Annulée"
                      : a.state === "error" ? "En échec" : a.state === "running" ? "En cours…" : "À confirmer"}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}

        {showShortcuts && (
        <div className="mt-auto border-t border-border pt-2">
          <p className="px-1 text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">Raccourcis</p>
          <div className="mt-1 space-y-0.5">
            {[
              { href: "/centre-de-paiement", label: "Centre de paiement" },
              { href: "/validations", label: "Demandes de validations" },
              { href: "/legal", label: "Legal" },
              { href: "/rh", label: "Ressources humaines" },
              { href: "/calendar", label: "Calendrier" },
            ].map((l) => (
              <Link key={l.href} href={l.href} className="block rounded-lg px-2 py-1.5 text-xs text-muted-foreground transition hover:bg-secondary hover:text-foreground">
                {l.label}
              </Link>
            ))}
          </div>
        </div>
        )}
      </div>
    </aside>
  );
}
