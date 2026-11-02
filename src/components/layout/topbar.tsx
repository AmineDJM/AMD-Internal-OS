"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bell, Menu, Search, X } from "lucide-react";
import { IconeCoque } from "@/components/ui/icone-coque";
import { UserMenu } from "@/components/layout/user-menu";
import { MessagesIndicator } from "@/components/layout/messages-indicator";
import { CompanySwitcher } from "@/components/layout/company-switcher";
import { cn } from "@/lib/utils";
import { FocusToggle } from "@/components/layout/focus-mode";
import { useScrollLock } from "@/lib/use-scroll-lock";
import type { NavItem } from "@/lib/labels";
import { groupIntoPoles, itemsOfGroup, poleOfPath, OPEN_POLES_KEY, FLAT_GROUPS } from "@/lib/navigation";

interface TopbarProps {
  navItems: NavItem[];
  /** La personne À L'ÉCRAN (visualisée en Vue exacte) — jamais l'objet de session entier. */
  user: { name: string; email: string; role: string; enVue?: boolean };
  unreadCount: number;
  canMessage: boolean;
  messagingUnread: number;
  adoption?: { score: number; tone: string; label: string } | null;
  companies: { id: string; name: string; shortName: string | null; color: string | null }[];
  companyScope: string | null;
}

// Couleur de la pastille du score d'adoption selon le palier atteint.
const ADOPTION_TONE: Record<string, string> = {
  success: "bg-success text-success-foreground",
  info: "bg-primary text-primary-foreground",
  warning: "bg-warning text-warning-foreground",
  danger: "bg-destructive text-destructive-foreground",
  neutral: "bg-muted text-muted-foreground",
};

export function Topbar({ navItems, user, unreadCount, canMessage, messagingUnread, adoption, companies, companyScope }: TopbarProps) {
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = React.useState(false);

  React.useEffect(() => setDrawerOpen(false), [pathname]);

  // Sans ce verrou, faire glisser le doigt dans le menu faisait défiler la PAGE derrière lui,
  // menu immobile — le tiroir n'avait aucun verrou du tout.
  useScrollLock(drawerOpen);

  // Les pôles du tiroir : mêmes groupes et MÊME mémoire d'ouverture que la barre latérale.
  // Chargée après montage — le serveur ne connaît pas le `localStorage`, et rendre deux arbres
  // différents ferait sauter l'hydratation.
  const poles = React.useMemo(() => groupIntoPoles(navItems), [navItems]);
  const activePole = React.useMemo(() => poleOfPath(poles, pathname), [poles, pathname]);
  const [open, setOpen] = React.useState<Record<string, boolean>>({});
  React.useEffect(() => {
    try {
      const raw = window.localStorage.getItem(OPEN_POLES_KEY);
      if (raw) setOpen(JSON.parse(raw) as Record<string, boolean>);
    } catch {
      /* préférence illisible → règle par défaut */
    }
  }, []);
  const toggle = (key: string, next: boolean) => {
    setOpen((prev) => {
      const merged = { ...prev, [key]: next };
      try { window.localStorage.setItem(OPEN_POLES_KEY, JSON.stringify(merged)); } catch { /* refusé : sans mémoire */ }
      return merged;
    });
  };

  return (
    <>
      <header className="sticky top-0 z-30 flex h-16 items-center gap-2 border-b border-border bg-card/80 px-3 backdrop-blur sm:gap-3 sm:px-4 lg:px-6">
        <button
          className="rounded-lg p-2 text-muted-foreground hover:bg-secondary lg:hidden"
          onClick={() => setDrawerOpen(true)}
          aria-label="Ouvrir le menu"
        >
          <Menu className="h-5 w-5" />
        </button>

        {/* RECHERCHE — bouton carré sur téléphone, vraie barre à partir de `sm`.
            Sur un écran de 390 px, la barre pleine largeur ne tenait pas : son libellé passait
            sur deux lignes (débordant d'un bouton de hauteur fixe) et elle repoussait l'avatar
            hors de l'écran. Une icône seule est le geste attendu sur mobile — et elle a l'air
            voulue, contrairement à une barre écrasée sur trois caractères. */}
        <button
          type="button"
          onClick={() => window.dispatchEvent(new CustomEvent("amd:open-palette"))}
          aria-label="Rechercher partout"
          className="flex h-9 w-9 shrink-0 items-center justify-center gap-2 rounded-lg border border-input bg-background text-sm text-muted-foreground shadow-sm hover:bg-secondary/40 sm:w-full sm:min-w-0 sm:max-w-md sm:justify-start sm:px-3"
        >
          <Search className="h-4 w-4 shrink-0" />
          <span className="hidden min-w-0 flex-1 truncate text-left sm:block">Rechercher partout…</span>
          <kbd className="hidden rounded border border-border px-1.5 py-0.5 text-[0.625rem] sm:block">⌘K</kbd>
        </button>

        {/* `shrink-0` : les actions (entité, messages, notifications, avatar) ne se laissent pas
            comprimer par la recherche — c'est la recherche qui tronque son libellé. */}
        <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-1.5">
          <CompanySwitcher companies={companies} scope={companyScope} />
          {/* Plein écran — présent ici, donc sur TOUS les écrans. Garde la barre latérale. */}
          <FocusToggle />
          {adoption && (
            <div
              title={`Mon score d'adoption : ${adoption.score}/100${adoption.label ? ` — ${adoption.label}` : ""}`}
              className={cn(
                "flex h-8 min-w-8 items-center justify-center rounded-full px-1.5 text-xs font-bold tabular-nums shadow-sm ring-1 ring-black/5",
                ADOPTION_TONE[adoption.tone] ?? ADOPTION_TONE.neutral,
              )}
              aria-label={`Score d'adoption ${adoption.score} sur 100`}
            >
              {adoption.score}
            </div>
          )}
          {canMessage && <MessagesIndicator initial={messagingUnread} />}
          <Link
            href="/notifications"
            className="relative rounded-lg p-2 text-muted-foreground hover:bg-secondary"
            aria-label="Notifications"
          >
            <Bell className="h-5 w-5" />
            {unreadCount > 0 && (
              <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[0.625rem] font-semibold text-destructive-foreground">
                {unreadCount > 9 ? "9+" : unreadCount}
              </span>
            )}
          </Link>
          <UserMenu name={user.name} email={user.email} role={user.role} enVue={user.enVue} />
        </div>
      </header>

      {/* Tiroir mobile — défilable, groupé, gère l'encoche/barres (safe-area). */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setDrawerOpen(false)} />
          <div className="absolute left-0 top-0 flex h-full w-[min(85vw,18rem)] flex-col bg-sidebar text-sidebar-foreground [padding-left:env(safe-area-inset-left)]">
            <div className="flex h-16 shrink-0 items-center justify-between px-5">
              <span className="text-sm font-semibold">AMD Internal OS</span>
              <button onClick={() => setDrawerOpen(false)} className="rounded-lg p-2 text-sidebar-muted hover:bg-white/5" aria-label="Fermer le menu">
                <X className="h-5 w-5" />
              </button>
            </div>
            <nav className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-1">
              {FLAT_GROUPS.filter((g) => g === "Pilotage").map((group) => (
                <DrawerGroup key={group} label={group} items={itemsOfGroup(navItems, group)} pathname={pathname} />
              ))}

              {/* LES PÔLES, DÉPLIABLES — comme sur l'ordinateur. Le tiroir listait les treize
                  modules à plat sous un titre « Pôles » : c'était la carte du code, pas celle de
                  l'entreprise, et sur un téléphone la liste dépassait l'écran. Même mémoire
                  d'ouverture que la barre latérale : replier Regulatory sur l'ordinateur le
                  replie ici. */}
              {poles.length > 0 && (
                <div>
                  <p className="px-3 pb-1.5 text-[0.6875rem] font-semibold uppercase tracking-wider text-sidebar-muted">Pôles</p>
                  <ul className="space-y-0.5">
                    {poles.map((pole) => {
                      const opened = activePole === pole.key || (open[pole.key] ?? pole.defaultOpen);
                      return (
                        <li key={pole.key}>
                          <button
                            type="button"
                            onClick={() => toggle(pole.key, !opened)}
                            aria-expanded={opened}
                            className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm font-semibold text-sidebar-muted hover:bg-white/5"
                          >
                            <IconeCoque name={pole.icon} className="h-4 w-4 shrink-0" />
                            <span className="min-w-0 flex-1 truncate text-left">{pole.label}</span>
                            <IconeCoque name="ChevronDown" className={cn("h-3.5 w-3.5 shrink-0 transition-transform", opened ? "" : "-rotate-90")} />
                          </button>
                          {opened && (
                            <ul className="mt-0.5 space-y-0.5">
                              {pole.children.map((item) => <DrawerItem key={item.href} item={item} pathname={pathname} nested />)}
                            </ul>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}

              {FLAT_GROUPS.filter((g) => g !== "Pilotage").map((group) => (
                <DrawerGroup key={group} label={group} items={itemsOfGroup(navItems, group)} pathname={pathname} />
              ))}
            </nav>
          </div>
        </div>
      )}
    </>
  );
}

/** Une entrée du tiroir. `nested` la décale sous son pôle. */
function DrawerItem({ item, pathname, nested = false }: { item: NavItem; pathname: string; nested?: boolean }) {
  const paths = [item.href, ...(item.match ?? [])];
  const active = paths.some((p) => pathname === p || pathname.startsWith(p + "/"));
  // UN GROUPE n'est pas un écran (Direction, 06/10) : un simple intitulé au-dessus de ses sous-modules.
  const enGroupe = Boolean(item.groupe) && (item.children ?? []).length > 0;
  return (
    <li>
      {enGroupe ? (
        <p className={cn("flex items-center gap-2.5 py-2.5 text-sm font-medium text-sidebar-muted", nested ? "pl-9 pr-3" : "px-3")}>
          <IconeCoque name={item.icon} className="h-4 w-4 shrink-0" />
          <span className="truncate">{item.label}</span>
        </p>
      ) : (
      <Link
        href={item.href}
        className={cn(
          "flex items-center gap-2.5 rounded-lg py-2.5 text-sm font-medium",
          nested ? "pl-9 pr-3" : "px-3",
          active ? "bg-white/10 text-white" : "text-sidebar-muted hover:bg-white/5",
        )}
      >
        <IconeCoque name={item.icon} className="h-4 w-4 shrink-0" />
        <span className="truncate">{item.label}</span>
      </Link>
      )}
      {/* Les SOUS-MODULES suivent leur parent : ils sont peu nombreux et toujours visibles ici —
          une flèche de plus dans un tiroir déjà déplié n'ajouterait qu'un clic. */}
      {(item.children ?? []).length > 0 && (
        <ul className="space-y-0.5">
          {item.children!.map((c) => (
            <li key={c.href}>
              <Link
                href={c.href}
                className={cn(
                  "flex items-center gap-2.5 rounded-lg py-2 pl-12 pr-3 text-sm",
                  pathname === c.href || pathname.startsWith(c.href + "/")
                    ? "bg-white/10 text-white"
                    : "text-sidebar-muted hover:bg-white/5",
                )}
              >
                <IconeCoque name={c.icon} className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{c.label}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** Un groupe historique (Pilotage / Transverse / Système) — sans flèche : il est court. */
function DrawerGroup({ label, items, pathname }: { label: string; items: NavItem[]; pathname: string }) {
  if (items.length === 0) return null;
  return (
    <div>
      <p className="px-3 pb-1.5 text-[0.6875rem] font-semibold uppercase tracking-wider text-sidebar-muted">{label}</p>
      <ul className="space-y-0.5">
        {items.map((item) => <DrawerItem key={item.href} item={item} pathname={pathname} />)}
      </ul>
    </div>
  );
}
