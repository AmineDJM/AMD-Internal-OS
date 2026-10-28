"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, MessageSquare } from "lucide-react";
import { Sheet } from "@/components/ui/sheet";
import { createDirect } from "@/lib/actions/messaging-actions";
import { sansBloquer } from "@/lib/journal";

/**
 * LES MORCEAUX CLIQUABLES DU PILOTAGE — une ligne de délégué qui ouvre sa fiche, la fiche elle-même (panneau latéral),
 * et le bouton « Écrire » (la conversation directe existante, comme dans Mon équipe). Les données arrivent toutes
 * calculées du serveur : ce module n'importe que des actions serveur.
 */

/** Une ligne de tableau qui mène quelque part — au clic, à Entrée. */
export function RangeeLien({ href, label, className, children }: { href: string; label: string; className?: string; children: React.ReactNode }) {
  const router = useRouter();
  return (
    <tr
      tabIndex={0}
      aria-label={label}
      className={className}
      onClick={(e) => { if (!(e.target as HTMLElement).closest("a,button")) router.push(href, { scroll: false }); }}
      onKeyDown={(e) => { if (e.key === "Enter") router.push(href, { scroll: false }); }}
    >
      {children}
    </tr>
  );
}

/** Le panneau latéral, ouvert par l'adresse (`?kam=` / `?liste=`) : le fermer retire le paramètre. */
export function PanneauAdresse({ titre, description, fermer, children }: { titre: string; description?: string; fermer: string; children: React.ReactNode }) {
  const router = useRouter();
  return (
    <Sheet open onClose={() => router.push(fermer, { scroll: false })} title={titre} description={description} width="md">
      {children}
    </Sheet>
  );
}

/** « Écrire » — ouvre (ou retrouve) la conversation directe avec ce délégué. */
export function BoutonEcrire({ userId }: { userId: string }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [erreur, setErreur] = React.useState<string | null>(null);
  return (
    <span className="inline-flex flex-col">
      <button
        type="button" disabled={busy}
        onClick={async () => {
          setBusy(true); setErreur(null);
          const fd = new FormData();
          fd.set("userId", userId);
          const r = await createDirect(fd).catch(sansBloquer("pilotage-client.BoutonEcrire.createDirect", null));
          setBusy(false);
          if (r?.ok && r.id) router.push(`/messages?c=${r.id}`);
          else setErreur(r?.error ?? "La conversation n'a pas pu s'ouvrir.");
        }}
        className="inline-flex h-9 items-center gap-1.5 rounded-[var(--radius)] border border-border bg-card px-3 text-[13px] font-medium hover:bg-secondary disabled:opacity-60 sm:h-8"
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MessageSquare className="h-3.5 w-3.5" />} Écrire
      </button>
      {erreur && <span className="mt-1 text-xs text-destructive">{erreur}</span>}
    </span>
  );
}

/** Un lien d'action de la fiche (principal ou secondaire). */
export function LienAction({ href, principal, children }: { href: string; principal?: boolean; children: React.ReactNode }) {
  return (
    <Link href={href}
      className={principal
        ? "inline-flex h-9 items-center rounded-[var(--radius)] bg-primary px-3 text-[13px] font-medium text-primary-foreground hover:opacity-90 sm:h-8"
        : "inline-flex h-9 items-center rounded-[var(--radius)] border border-border bg-card px-3 text-[13px] font-medium hover:bg-secondary sm:h-8"}>
      {children}
    </Link>
  );
}
