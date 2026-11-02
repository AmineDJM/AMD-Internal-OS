import Link from "next/link";
import { cn } from "@/lib/utils";

/**
 * LES PIÈCES D'ÉCRAN DE PRODUITS 360 — sans état, rendues côté serveur : onglets en liens (l'onglet ouvert se partage
 * par l'URL), pastille de signal, courbe de tendance, frise du cycle de vie, carte à en-tête.
 */

export function Onglets({ items, actif, label }: { items: { cle: string; label: string; href: string; n?: number }[]; actif: string; label: string }) {
  return (
    <nav aria-label={label} className="no-scrollbar flex gap-1 overflow-x-auto border-b border-border">
      {items.map((o) => (
        <Link
          key={o.cle}
          href={o.href}
          aria-current={o.cle === actif ? "page" : undefined}
          className={cn(
            "-mb-px whitespace-nowrap border-b-2 px-3.5 py-2.5 text-sm font-medium transition-colors",
            o.cle === actif ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
          {o.n !== undefined && <span className="ml-1.5 rounded-full bg-muted px-1.5 text-[11px] text-muted-foreground">{o.n}</span>}
        </Link>
      ))}
    </nav>
  );
}

const TONS = {
  danger: "bg-destructive/10 text-destructive",
  warning: "bg-warning/10 text-warning",
  success: "bg-success/10 text-success",
  info: "bg-primary/10 text-primary",
  neutral: "bg-muted text-muted-foreground",
} as const;
export type Ton = keyof typeof TONS;

export function Pastille({ ton, children }: { ton: Ton; children: React.ReactNode }) {
  return <span className={cn("inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium", TONS[ton])}>{children}</span>;
}

export function Point({ ton }: { ton: Ton }) {
  const fond = { danger: "bg-destructive", warning: "bg-warning", success: "bg-success", info: "bg-primary", neutral: "bg-muted-foreground" }[ton];
  return <i aria-hidden className={cn("inline-block h-2 w-2 shrink-0 rounded-full", fond)} />;
}

export function Carte({ titre, sousTitre, action, children, className }: { titre: string; sousTitre?: React.ReactNode; action?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn("surface min-w-0 overflow-hidden", className)}>
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h2 className="text-[15px] font-semibold">{titre}</h2>
        {(sousTitre || action) && <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">{sousTitre}{action}</div>}
      </header>
      {children}
    </section>
  );
}

/** La barre d'un contrat PCH : commandé (clair) et livré (foncé) sur l'attribué ; au-delà, le dépassement en orange. */
export function BarreContrat({ attribue, commande, livre, className }: { attribue: number; commande: number; livre: number; className?: string }) {
  const echelle = Math.max(attribue, commande, 1);
  const pc = (v: number) => `${Math.min(100, (v / echelle) * 100)}%`;
  return (
    <div className={cn("relative h-2.5 w-40 overflow-hidden rounded-full bg-secondary", className)} aria-hidden>
      <div className="absolute inset-y-0 left-0 bg-primary/35" style={{ width: pc(Math.min(commande, attribue)) }} />
      {commande > attribue && <div className="absolute inset-y-0 bg-warning" style={{ left: pc(attribue), width: pc(commande - attribue) }} />}
      <div className="absolute inset-y-0 left-0 bg-primary" style={{ width: pc(livre) }} />
      {attribue > 0 && commande > attribue && <div className="absolute inset-y-0 w-px bg-foreground/60" style={{ left: pc(attribue) }} />}
    </div>
  );
}

export function Vide({ children }: { children: React.ReactNode }) {
  return <p className="px-4 py-4 text-sm text-muted-foreground">{children}</p>;
}

/** La pastille d'une lettre de segmentation (H violet, A vert, B bleu, C orange, D rouge, NA / NC gris), avec un compte. */
const TON_LETTRE: Record<string, string> = {
  H: "bg-violet-500/10 text-violet-600 dark:text-violet-300",
  A: "bg-success/10 text-success",
  B: "bg-primary/10 text-primary",
  C: "bg-warning/10 text-warning",
  D: "bg-destructive/10 text-destructive",
};
export function LettreChip({ lettre, n, className }: { lettre: string; n?: number; className?: string }) {
  return (
    <span title={n !== undefined ? `${lettre} : ${n}` : undefined}
      className={cn("inline-flex h-5 min-w-[24px] items-center justify-center gap-1 rounded-md px-1.5 text-[11px] font-bold tabular-nums", TON_LETTRE[lettre] ?? "bg-muted text-muted-foreground", className)}>
      {n !== undefined ? <>{lettre !== "H" && lettre !== "A" && lettre !== "B" && lettre !== "C" && lettre !== "D" ? `${lettre} ` : ""}{n}</> : lettre}
    </span>
  );
}

/** Un chiffre clé de l'en-tête : libellé, valeur, une ligne de contexte. « n/d » quand la donnée manque. */
export function Chiffre({ label, valeur, contexte, ton }: { label: string; valeur: string | null; contexte?: string | null; ton?: "ok" | "ko" | "w" | null }) {
  return (
    <div className="min-w-0 border-b border-r border-border px-4 py-3">
      <span className="block truncate text-xs text-muted-foreground">{label}</span>
      <strong className={cn("block truncate text-lg font-semibold tabular-nums", valeur === null && "text-muted-foreground")}>{valeur ?? "n/d"}</strong>
      {contexte && <em className={cn("block truncate text-xs not-italic", ton === "ok" ? "text-success" : ton === "ko" ? "text-destructive" : ton === "w" ? "text-warning" : "text-muted-foreground")}>{contexte}</em>}
    </div>
  );
}
