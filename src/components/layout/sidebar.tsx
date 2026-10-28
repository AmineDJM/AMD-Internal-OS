"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { IconeCoque } from "@/components/ui/icone-coque";
import { cn } from "@/lib/utils";
import type { NavItem } from "@/lib/labels";
import { groupIntoPoles, itemsOfGroup, poleOfPath, OPEN_POLES_KEY, type NavPoleKey, pastillesDesEntrees, modulesComptes, modulesPropres } from "@/lib/navigation";
import { OfficePins } from "./office-pins";

interface SidebarProps {
  items: NavItem[];
  messagingUnread?: number;
  /** Notifications non lues par module → badge sur l'entrée de menu concernée. */
  moduleBadges?: Record<string, number>;
}

// Les pastilles se calculent par LISTE d'entrées sœurs (`pastillesDesEntrees`) : une entrée seule
// ne sait pas si sa sœur ou son parent compte déjà son module (§118.154).

/** Tous les chemins qui rendent une entrée « active », ses sous-modules compris. */
export function navPaths(item: NavItem): string[] {
  return [item.href, ...(item.match ?? []), ...(item.children ?? []).flatMap(navPaths)];
}

/** Pastille de compteur statique (badge de menu). */
function NavBadge({ count }: { count: number }) {
  return (
    <span className="ml-auto flex h-5 min-w-5 items-center justify-center rounded-full bg-sidebar-accent px-1.5 text-[0.6875rem] font-semibold text-sidebar">
      {count > 99 ? "99+" : count}
    </span>
  );
}

/** Badge de non-lus de la messagerie : valeur initiale serveur, puis temps réel via l'évènement global. */
function MessagesNavBadge({ initial }: { initial: number }) {
  const [count, setCount] = React.useState(initial);
  React.useEffect(() => {
    const onEvent = (e: Event) => {
      const detail = (e as CustomEvent<{ total: number }>).detail;
      if (detail && typeof detail.total === "number") setCount(detail.total);
    };
    window.addEventListener("amd:messaging-unread", onEvent);
    return () => window.removeEventListener("amd:messaging-unread", onEvent);
  }, []);
  if (count <= 0) return null;
  return (
    <span className="ml-auto flex h-5 min-w-5 items-center justify-center rounded-full bg-sidebar-accent px-1.5 text-[0.6875rem] font-semibold text-sidebar">
      {count > 99 ? "99+" : count}
    </span>
  );
}

export function Sidebar({ items, messagingUnread = 0, moduleBadges = {} }: SidebarProps) {
  const pathname = usePathname();

  // Les entrées reçues sont DÉJÀ filtrées par le RBAC côté serveur : ranger n'ouvre aucun droit.
  const poles = React.useMemo(() => groupIntoPoles(items), [items]);
  // Où chaque module VIT dans ce menu (§118.157) : un onglet ne reprend pas la pastille d'une
  // notification dont le module a sa propre entrée.
  const proprietaires = React.useMemo(() => modulesPropres(items), [items]);
  const pilotage = React.useMemo(() => itemsOfGroup(items, "Pilotage"), [items]);
  const transverse = React.useMemo(() => itemsOfGroup(items, "Transverse"), [items]);
  const systeme = React.useMemo(() => itemsOfGroup(items, "Système"), [items]);

  // Ouverture : par défaut selon la règle des 5, puis la préférence de la personne l'emporte.
  // Chargée APRÈS montage — sinon le serveur et le client rendraient deux arbres différents.
  const [open, setOpen] = React.useState<Record<string, boolean>>({});
  const [restored, setRestored] = React.useState(false);
  React.useEffect(() => {
    try {
      const raw = window.localStorage.getItem(OPEN_POLES_KEY);
      if (raw) setOpen(JSON.parse(raw) as Record<string, boolean>);
    } catch {
      /* préférence illisible → règle par défaut */
    }
    setRestored(true);
  }, []);

  // Le pôle de la page courante s'ouvre tout seul : arriver par un lien de notification sans
  // voir où l'on se trouve dans le menu, c'est perdre son repère à chaque notification.
  const activePole = React.useMemo(() => poleOfPath(poles, pathname), [poles, pathname]);

  const isOpen = (key: NavPoleKey, defaultOpen: boolean): boolean => {
    if (activePole === key) return true;
    return open[key] ?? defaultOpen;
  };

  // La même mémoire sert aux pôles (clé = pôle) et aux sous-modules (clé = route du parent).
  const toggle = (key: string, next: boolean) => {
    const merged = { ...open, [key]: next };
    setOpen(merged);
    try { window.localStorage.setItem(OPEN_POLES_KEY, JSON.stringify(merged)); } catch { /* refusé : sans mémoire */ }
  };

  const renderItem = (item: NavItem, nested = false, depth = 0, badge = 0) => {
    const paths = [item.href, ...(item.match ?? [])];
    const active = paths.some((p) => pathname === p || pathname.startsWith(p + "/"));
    const kids = item.children ?? [];
    // Un parent dont un ENFANT est ouvert se déplie tout seul : sinon on atterrit sur le
    // pipeline sans voir d'où il vient, et l'on croit s'être perdu.
    const childActive = kids.some((c) => [c.href, ...(c.match ?? [])]
      .some((p) => pathname === p || pathname.startsWith(p + "/")));
    const opened = childActive || (open[item.href] ?? false);
    // UN GROUPE n'est PAS un écran (Direction, 06/10 : « le menu Ressources humaines ne devrait plus être cliquable, ce
    // sont ses modules ») : son libellé déplie ses sous-modules, la flèche suffit — aucun lien, aucun état « actif ».
    const enGroupe = Boolean(item.groupe) && kids.length > 0;
    const classeLibelle = cn(
      "flex min-w-0 flex-1 items-center gap-2.5 rounded-lg py-2 text-sm font-medium transition-colors",
      nested ? "pl-9 pr-3" : "px-3",
      depth > 1 && "pl-12",
      active && !enGroupe ? "bg-sidebar-active text-white" : "text-sidebar-muted hover:bg-sidebar-active/60 hover:text-white",
    );
    const contenuLibelle = (
      <>
        <IconeCoque name={item.icon} className="h-4 w-4 shrink-0" />
        <span className="truncate">{item.label}</span>
        {item.href === "/messages"
          ? <MessagesNavBadge initial={messagingUnread} />
          : badge > 0 ? <NavBadge count={badge} /> : null}
      </>
    );

    return (
      <li key={item.href}>
        <div className="flex items-stretch">
          {enGroupe ? (
            <button type="button" onClick={() => toggle(item.href, !opened)} aria-expanded={opened} className={cn(classeLibelle, "text-left")}>
              {contenuLibelle}
            </button>
          ) : (
            <Link href={item.href} className={classeLibelle}>{contenuLibelle}</Link>
          )}
          {/* LA FLÈCHE DES SOUS-MODULES — séparée du lien : on doit pouvoir ouvrir le parent
              SANS déplier, et déplier sans quitter la page où l'on est. */}
          {kids.length > 0 && (
            <button
              type="button"
              onClick={() => toggle(item.href, !opened)}
              aria-expanded={opened}
              aria-label={opened ? `Replier ${item.label}` : `Déplier ${item.label}`}
              className="rounded-lg px-2 text-sidebar-muted transition-colors hover:bg-sidebar-active/60 hover:text-white"
            >
              <IconeCoque name="ChevronDown" className={cn("h-3.5 w-3.5 transition-transform", opened ? "" : "-rotate-90")} />
            </button>
          )}
        </div>
        {kids.length > 0 && opened && (
          <ul className="mt-0.5 space-y-0.5">{(() => {
            // Le parent compte déjà son module : un sous-menu du même module ne le recompte pas.
            const pastilles = pastillesDesEntrees(kids, moduleBadges, modulesComptes(item, proprietaires), proprietaires);
            return kids.map((c, i) => renderItem(c, true, depth + 1, pastilles[i]));
          })()}</ul>
        )}
      </li>
    );
  };

  const renderFlat = (group: NavItem["group"], groupItems: NavItem[]) => (
    groupItems.length === 0 ? null : (
      <div key={group}>
        <p className="px-3 pb-1.5 text-[0.625rem] font-semibold uppercase tracking-wider text-sidebar-muted">{group}</p>
        <ul className="space-y-0.5">{(() => {
          const pastilles = pastillesDesEntrees(groupItems, moduleBadges, [], proprietaires);
          return groupItems.map((i, k) => renderItem(i, false, 0, pastilles[k]));
        })()}</ul>
      </div>
    )
  );

  return (
    <aside data-app-sidebar className="hidden w-64 shrink-0 flex-col bg-sidebar text-sidebar-foreground lg:flex">
      <div className="flex h-16 items-center gap-2.5 px-5">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-sidebar-accent text-sm font-bold text-sidebar">
          A
        </div>
        <div className="leading-tight">
          <p className="text-sm font-semibold">AMD Internal OS</p>
          <p className="text-[0.6875rem] text-sidebar-muted">Adventum Pharma</p>
        </div>
      </div>

      <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-3">
        {renderFlat("Pilotage", pilotage)}
        {/* Les applications bureautiques que CETTE personne a épinglées — juste sous son espace. */}
        <OfficePins />

        {poles.length > 0 && (
          <div>
            <p className="px-3 pb-1.5 text-[0.625rem] font-semibold uppercase tracking-wider text-sidebar-muted">
              Pôles
            </p>
            <ul className="space-y-1">
              {poles.map((pole) => {
                const opened = isOpen(pole.key, pole.defaultOpen);
                const anyActive = pole.children.some((c) => navPaths(c)
                  .some((p) => pathname === p || pathname.startsWith(p + "/")));
                const pastilles = pastillesDesEntrees(pole.children, moduleBadges, [], proprietaires);
                const badge = pastilles.reduce((a, n) => a + n, 0);
                return (
                  <li key={pole.key}>
                    <button
                      type="button"
                      onClick={() => toggle(pole.key, !opened)}
                      aria-expanded={opened}
                      className={cn(
                        "flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-semibold transition-colors",
                        anyActive ? "text-white" : "text-sidebar-muted hover:bg-sidebar-active/60 hover:text-white",
                      )}
                    >
                      <IconeCoque name={pole.icon} className="h-4 w-4 shrink-0" />
                      <span className="truncate">{pole.label}</span>
                      {badge > 0 && !opened && <NavBadge count={badge} />}
                      <IconeCoque
                        name="ChevronDown"
                        className={cn("ml-auto h-3.5 w-3.5 shrink-0 transition-transform", opened ? "" : "-rotate-90")}
                      />
                    </button>
                    {/* Rendu inconditionnel avant restauration de la préférence : le premier
                        rendu client doit être identique à celui du serveur. */}
                    {(opened || !restored) && (
                      <ul className={cn("mt-0.5 space-y-0.5", !opened && !restored ? "hidden" : "")}>
                        {pole.children.map((c, k) => renderItem(c, true, 0, pastilles[k]))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {renderFlat("Transverse", transverse)}
        {renderFlat("Système", systeme)}
      </nav>

      <div className="border-t border-white/[0.07] px-5 py-3">
        <p className="text-[0.6875rem] text-sidebar-muted">
          © {new Date().getFullYear()} Adventum — v0.1
        </p>
      </div>
    </aside>
  );
}
