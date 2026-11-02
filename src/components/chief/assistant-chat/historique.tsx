"use client";

/**
 * LA CONVERSATION — l'historique de MES conversations, regroupées par ancienneté.
 */
import { Plus, Trash2, Lock } from "lucide-react";
import type { ThreadSummary } from "@/lib/assistant-memory";

/**
 * Historique de MES conversations. Le serveur ne renvoie jamais les fils d'autrui : cette
 * liste est, par construction, strictement personnelle (cf. `src/lib/assistant-memory.ts`).
 */
/** Regroupe les conversations par ancienneté — c'est ainsi qu'on les retrouve. */
function groupThreads(threads: ThreadSummary[]): { label: string; items: ThreadSummary[] }[] {
  const now = Date.now();
  const day = 86_400_000;
  const buckets: { label: string; max: number; items: ThreadSummary[] }[] = [
    { label: "Aujourd'hui", max: day, items: [] },
    { label: "7 derniers jours", max: 7 * day, items: [] },
    { label: "30 derniers jours", max: 30 * day, items: [] },
    { label: "Plus ancien", max: Infinity, items: [] },
  ];
  for (const t of threads) {
    const age = now - new Date(t.updatedAt).getTime();
    (buckets.find((b) => age < b.max) ?? buckets[buckets.length - 1]).items.push(t);
  }
  return buckets.filter((b) => b.items.length > 0).map(({ label, items }) => ({ label, items }));
}

/**
 * Historique de MES conversations. Le serveur ne renvoie jamais les fils d'autrui : cette
 * liste est, par construction, strictement personnelle (cf. `src/lib/assistant-memory.ts`).
 *
 * Regroupées par ancienneté (aujourd'hui, 7 jours, 30 jours, plus ancien) : au bout de
 * quelques semaines, une liste à plat ne se relit plus.
 */
export function ThreadRail({
  threads, current, onNew, onOpen, onDelete, onForget,
}: {
  threads: ThreadSummary[];
  current: string | null;
  onNew: () => void;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onForget: () => void;
}) {
  const groups = groupThreads(threads);
  return (
    <div className="flex h-full flex-col overflow-hidden rounded-2xl border border-border bg-card">
      <div className="p-2">
        <button
          type="button" onClick={onNew}
          className="flex w-full items-center gap-2 rounded-xl border border-border px-3 py-2.5 text-sm font-medium transition hover:bg-secondary"
        >
          <Plus className="h-4 w-4" /> Nouvelle conversation
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {threads.length === 0 ? (
          <p className="px-2 py-3 text-xs leading-relaxed text-muted-foreground">
            Vos échanges seront conservés ici pour que l&apos;assistant se souvienne de votre contexte.
          </p>
        ) : (
          groups.map((g) => (
            <div key={g.label} className="mb-2">
              <p className="px-2 py-1 text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">{g.label}</p>
              <div className="space-y-0.5">
                {g.items.map((t) => (
                  <div key={t.id}
                    className={`group flex items-center gap-1 rounded-lg px-2 py-0.5 text-sm transition sm:py-2 ${t.id === current ? "bg-secondary font-medium text-foreground" : "hover:bg-secondary/60"}`}>
                    <button type="button" onClick={() => onOpen(t.id)} className="min-w-0 flex-1 truncate py-2 text-left sm:py-0" title={t.title}>
                      {t.title}
                    </button>
                    {/* Au doigt, la corbeille reste visible : un bouton qui n'apparaît qu'au survol n'existe pas. */}
                    <button type="button" onClick={() => onDelete(t.id)} title="Supprimer cette conversation"
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded text-muted-foreground transition hover:text-destructive sm:h-auto sm:w-auto sm:p-1 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:focus:opacity-100 [@media(hover:hover)]:group-hover:opacity-100">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </div>

      <div className="border-t border-border px-3 py-2.5">
        <p className="flex items-start gap-1.5 text-[0.6875rem] leading-snug text-muted-foreground">
          <Lock className="mt-0.5 h-3 w-3 shrink-0" />
          Mémoire strictement personnelle : personne d&apos;autre — pas même un administrateur — n&apos;y a accès.
        </p>
        {threads.length > 0 && (
          <button type="button" onClick={onForget} className="mt-1 py-1.5 text-[0.6875rem] sm:mt-1.5 sm:py-0 text-muted-foreground underline-offset-2 transition hover:text-destructive hover:underline">
            Tout effacer
          </button>
        )}
      </div>
    </div>
  );
}
