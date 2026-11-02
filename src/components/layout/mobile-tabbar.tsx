"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Sparkles, LayoutGrid, MessageSquare, Grid3x3, X, Search } from "lucide-react";
import { IconeCoque } from "@/components/ui/icone-coque";
import type { NavItem } from "@/lib/labels";
import { cn } from "@/lib/utils";
import { useScrollLock } from "@/lib/use-scroll-lock";
import { useTabBarHeight } from "@/components/layout/chrome-metrics";
import { groupIntoPoles, itemsOfGroup, poleOfPath, OPEN_POLES_KEY, FLAT_GROUPS, pastillesDesEntrees, modulesComptes, modulesPropres } from "@/lib/navigation";

/**
 * BARRE D'ONGLETS MOBILE — navigation principale sur téléphone (l'app installée depuis
 * « Ajouter à l'écran d'accueil » doit se comporter comme une vraie application).
 *
 * Des cibles au POUCE, toujours accessibles en bas de l'écran : Espace, Messages,
 * Assistant (pour qui le menu le propose), et un bouton « Tout » qui ouvre la grille COMPLÈTE des
 * modules autorisés.
 * Masquée à partir de `lg` (le desktop garde la barre latérale). Respecte la
 * `safe-area` iOS pour ne pas passer sous la barre d'accueil.
 */

/**
 * Cibles fixes de la barre : on privilégie ce qu'on ouvre 20 fois par jour.
 *
 * `suitLeMenu` — UN ONGLET FIXE N'OUVRE PAS CE QUE LE MENU FERME (§118.153). L'onglet
 * « Assistant » était dessiné pour tout le monde, en dur, alors que le menu le réserve au Super
 * Admin (`peutVoirAdam`) : la personne touchait l'onglet et tombait sur une page introuvable —
 * la porte fermée à côté de la porte ouverte (§118.71). L'onglet porte donc sa règle : il
 * n'apparaît que si le menu de la personne propose sa destination. Déclaré entrée par entrée,
 * et non « tout onglet suit le menu » : « Messages » n'est pas une entrée de menu (la messagerie
 * interne est ouverte à tous), et le faire suivre le menu le retirerait à tout le monde.
 */
const PRIMARY: { href: string; label: string; icon: React.ComponentType<{ className?: string }>; match: string[]; suitLeMenu?: true }[] = [
  { href: "/mon-espace", label: "Espace", icon: LayoutGrid, match: ["/mon-espace", "/mon-travail", "/mon-dossier", "/missions"] },
  { href: "/messages", label: "Messages", icon: MessageSquare, match: ["/messages"] },
  { href: "/assistant", label: "Assistant", icon: Sparkles, match: ["/assistant"], suitLeMenu: true },
];

const isActive = (pathname: string, targets: string[]) =>
  targets.some((t) => pathname === t || pathname.startsWith(`${t}/`));

/** Une tuile du tiroir — un module. `nested` marque un sous-module (rangé sous son parent). */
function Tile({
  item, pathname, badge, nested = false, children, onDeplier,
}: {
  item: NavItem; pathname: string; badge: number; nested?: boolean; children?: React.ReactNode;
  /** UN GROUPE (Direction, 06/10) : la tuile n'est pas un lien, elle déplie ses sous-modules. */
  onDeplier?: () => void;
}) {
  const active = isActive(pathname, [item.href, ...(item.match ?? [])]) && !onDeplier;
  const classe = cn(
    "relative flex flex-col items-center gap-1.5 rounded-2xl border px-2 py-3.5 text-center transition active:scale-95",
    active ? "border-primary/50 bg-primary/10 text-primary" : "border-border bg-card text-foreground",
    nested && "border-dashed bg-secondary/30",
  );
  if (onDeplier) {
    return (
      <button type="button" onClick={onDeplier} className={classe}>
        <IconeCoque name={item.icon} className="h-6 w-6" />
        <span className="text-[0.6875rem] font-medium leading-tight">{item.label}</span>
        {badge > 0 && (
          <span className="absolute right-1.5 top-1.5 min-w-[1.125rem] rounded-full bg-destructive px-1 text-[0.625rem] font-bold leading-[1.125rem] text-destructive-foreground">
            {badge > 99 ? "99+" : badge}
          </span>
        )}
        {children}
      </button>
    );
  }
  return (
    <Link href={item.href} className={classe}>
      <IconeCoque name={item.icon} className="h-6 w-6" />
      <span className="text-[0.6875rem] font-medium leading-tight">{item.label}</span>
      {badge > 0 && (
        <span className="absolute right-1.5 top-1.5 min-w-[1.125rem] rounded-full bg-destructive px-1 text-[0.625rem] font-bold leading-[1.125rem] text-destructive-foreground">
          {badge > 99 ? "99+" : badge}
        </span>
      )}
      {children}
    </Link>
  );
}

export function MobileTabBar({
  items, messagingUnread = 0, moduleBadges = {},
}: {
  items: NavItem[];
  messagingUnread?: number;
  moduleBadges?: Record<string, number>;
}) {
  const pathname = usePathname();
  const [drawer, setDrawer] = React.useState(false);
  const [q, setQ] = React.useState("");
  // Où chaque module VIT dans ce menu (§118.157) — lu sur le menu ENTIER, pas sur la recherche en
  // cours : filtrer « annuaires » ne doit pas faire changer de maison une notification médicale.
  const proprietaires = React.useMemo(() => modulesPropres(items), [items]);
  /**
   * Ouvertures dépliées — MÊME mémoire que la barre latérale (clé = pôle pour un pôle, route du
   * parent pour un sous-module). Chargée après montage : le serveur ne connaît pas le
   * `localStorage`, et rendre deux arbres différents ferait sauter l'hydratation.
   */
  const [expanded, setExpanded] = React.useState<Record<string, boolean>>({});
  React.useEffect(() => {
    try {
      const raw = window.localStorage.getItem(OPEN_POLES_KEY);
      if (raw) setExpanded(JSON.parse(raw) as Record<string, boolean>);
    } catch {
      /* préférence illisible → règle par défaut */
    }
  }, []);
  const toggle = (key: string, next: boolean) => {
    setExpanded((prev) => {
      const merged = { ...prev, [key]: next };
      try { window.localStorage.setItem(OPEN_POLES_KEY, JSON.stringify(merged)); } catch { /* refusé : sans mémoire */ }
      return merged;
    });
  };
  // La hauteur RÉELLE de la barre est publiée pour les écrans pleine hauteur. Sur ordinateur
  // elle est `display: none` et vaut donc 0 — sans règle média supplémentaire à maintenir.
  const navRef = React.useRef<HTMLElement>(null);
  useTabBarHeight(navRef);

  // Le tiroir se referme à chaque navigation (comportement attendu d'une app mobile).
  React.useEffect(() => { setDrawer(false); setQ(""); }, [pathname]);

  // Verrouille le VRAI conteneur défilant. Verrouiller le `body` ne servait à rien : ce n'est
  // pas lui qui défile ici, et la page continuait donc de bouger derrière le tiroir.
  useScrollLock(drawer);

  // Les onglets fixes de CETTE personne : un onglet qui suit le menu n'existe que si le menu
  // propose sa destination (§118.153).
  const onglets = PRIMARY.filter((p) => !p.suitLeMenu || items.some((i) => i.href === p.href));
  const visible = items.filter((i) => PRIMARY.every((p) => p.href !== i.href));
  const needle = q.trim().toLowerCase();
  const hit = (i: NavItem) => i.label.toLowerCase().includes(needle);
  // Un parent reste affiché si LUI ou l'un de ses sous-modules correspond — et l'on ne garde
  // alors que les sous-modules qui correspondent vraiment.
  const filtered = needle
    ? visible.reduce<NavItem[]>((acc, i) => {
        const kids = (i.children ?? []).filter(hit);
        if (hit(i)) acc.push(i);
        else if (kids.length) acc.push({ ...i, children: kids });
        return acc;
      }, [])
    : visible;

  // LES MÊMES PÔLES QUE LA BARRE LATÉRALE. Le tiroir listait les treize modules à plat sous un
  // titre « Pôles » : c'était la carte du code, pas celle de l'entreprise, et sur un écran de
  // téléphone la liste ne tenait pas. On range par pôle, et chaque pôle se déplie par sa flèche.
  const poles = React.useMemo(() => groupIntoPoles(filtered), [filtered]);
  const activePole = React.useMemo(() => poleOfPath(poles, pathname), [poles, pathname]);
  const flatGroups = React.useMemo(
    () => FLAT_GROUPS.map((g) => [g, itemsOfGroup(filtered, g)] as const).filter(([, list]) => list.length > 0),
    [filtered],
  );

  // Une recherche ne doit RIEN cacher derrière une flèche : quand on filtre, pôles et
  // sous-modules sont dépliés d'office — sinon « pipeline » ne remonterait rien alors qu'il existe.
  const searching = q.trim().length > 0;
  // Le pôle de la page courante s'ouvre tout seul : arriver par un lien de notification sans
  // voir où l'on se trouve, c'est perdre son repère à chaque fois.
  const isPoleOpen = (key: string, defaultOpen: boolean) =>
    searching || activePole === key || (expanded[key] ?? defaultOpen);

  /** La grille de tuiles d'une section — un module par tuile, ses sous-modules dessous. */
  // LA MÊME RÈGLE QUE LA BARRE LATÉRALE (§118.154) : un module se compte une fois par liste, et
  // jamais sous un parent qui le compte déjà — sinon Finances et ses trois sous-menus affichent
  // chacun les mêmes notifications. Une seule fonction pour les deux menus.
  const renderTiles = (list: NavItem[]) => {
    const pastilles = pastillesDesEntrees(list, moduleBadges, [], proprietaires);
    return (
    <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
      {list.map((item, rang) => {
        const kids = item.children ?? [];
        const opened = searching || expanded[item.href] === true;
        const pastillesEnfants = pastillesDesEntrees(kids, moduleBadges, modulesComptes(item, proprietaires), proprietaires);
        return (
          <React.Fragment key={item.href}>
            <Tile
              item={item} pathname={pathname} badge={pastilles[rang]}
              onDeplier={item.groupe && kids.length > 0 ? () => toggle(item.href, !opened) : undefined}
            >
              {/* LA FLÈCHE, SUR MOBILE AUSSI — les sous-modules ne doivent pas être
                  réservés à l'ordinateur : c'est au téléphone qu'on cherche vite. Un groupe se déplie
                  par la tuile entière : sa flèche n'est qu'un repère (pas de bouton dans un bouton). */}
              {kids.length > 0 && item.groupe && (
                <span className="absolute bottom-1 right-1 p-1 text-muted-foreground" aria-hidden>
                  <IconeCoque name="ChevronDown" className={cn("h-3.5 w-3.5 transition-transform", opened ? "" : "-rotate-90")} />
                </span>
              )}
              {kids.length > 0 && !item.groupe && (
                <button
                  type="button"
                  onClick={(e) => { e.preventDefault(); toggle(item.href, !opened); }}
                  aria-expanded={opened}
                  aria-label={opened ? `Replier ${item.label}` : `Déplier ${item.label}`}
                  className="absolute bottom-0.5 right-0.5 rounded-lg p-1.5 text-muted-foreground"
                >
                  <IconeCoque name="ChevronDown" className={cn("h-3.5 w-3.5 transition-transform", opened ? "" : "-rotate-90")} />
                </button>
              )}
            </Tile>
            {kids.length > 0 && opened && kids.map((c, i) => (
              <Tile key={c.href} item={c} pathname={pathname} badge={pastillesEnfants[i]} nested />
            ))}
          </React.Fragment>
        );
      })}
    </div>
    );
  };

  return (
    <>
      {/* Tiroir « Tout » — grille complète des modules autorisés, avec recherche. */}
      {drawer && (
        <div className="fixed inset-0 z-[60] flex flex-col bg-background lg:hidden">
          <div className="flex items-center gap-2 border-b border-border px-4 py-3">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                autoFocus value={q} onChange={(e) => setQ(e.target.value)}
                placeholder="Rechercher un module…"
                className="w-full rounded-xl border border-border bg-secondary/40 py-2.5 pl-9 pr-3 text-base outline-none focus:border-primary/60"
              />
            </div>
            <button onClick={() => setDrawer(false)} aria-label="Fermer" className="rounded-xl p-2.5 text-muted-foreground hover:bg-secondary">
              <X className="h-5 w-5" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-4 pb-[calc(1.5rem+env(safe-area-inset-bottom))] pt-4">
            {/* Pilotage d'abord : ce qu'on ouvre le plus souvent ne se cherche pas. */}
            {flatGroups.filter(([g]) => g === "Pilotage").map(([group, list]) => (
              <div key={group} className="mb-6">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{group}</p>
                {renderTiles(list)}
              </div>
            ))}

            {/* LES PÔLES DE L'ENTREPRISE, chacun derrière sa flèche. */}
            {poles.length > 0 && (
              <div className="mb-6">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Pôles</p>
                <div className="space-y-2">
                  {poles.map((pole) => {
                    const opened = isPoleOpen(pole.key, pole.defaultOpen);
                    const badge = pastillesDesEntrees(pole.children, moduleBadges, [], proprietaires).reduce((a, n) => a + n, 0);
                    return (
                      <div key={pole.key} className="overflow-hidden rounded-2xl border border-border bg-card">
                        <button
                          type="button"
                          onClick={() => toggle(pole.key, !opened)}
                          aria-expanded={opened}
                          className="flex w-full items-center gap-2.5 px-3 py-3 text-left transition active:bg-secondary/60"
                        >
                          <IconeCoque name={pole.icon} className="h-5 w-5 shrink-0 text-primary" />
                          <span className="min-w-0 flex-1 truncate text-sm font-semibold">{pole.label}</span>
                          {badge > 0 && !opened && (
                            <span className="min-w-[1.125rem] rounded-full bg-destructive px-1 text-[0.625rem] font-bold leading-[1.125rem] text-destructive-foreground">
                              {badge > 99 ? "99+" : badge}
                            </span>
                          )}
                          <span className="shrink-0 text-[0.6875rem] text-muted-foreground">{pole.children.length}</span>
                          <IconeCoque name="ChevronDown" className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", opened ? "" : "-rotate-90")} />
                        </button>
                        {opened && <div className="border-t border-border p-2">{renderTiles(pole.children)}</div>}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {flatGroups.filter(([g]) => g !== "Pilotage").map(([group, list]) => (
              <div key={group} className="mb-6">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{group}</p>
                {renderTiles(list)}
              </div>
            ))}
            {filtered.length === 0 && <p className="py-8 text-center text-sm text-muted-foreground">Aucun module ne correspond.</p>}
          </div>
        </div>
      )}

      {/* Barre d'onglets basse — toujours visible sur mobile.
          z-40 : SOUS les couches modales (z-50). Elle était à z-60 et recouvrait donc les
          feuilles et les tiroirs : le bouton de validation en bas d'un formulaire était
          visible mais intouchable, caché derrière la barre. */}
      <nav ref={navRef} className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-card/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden">
        <div className="flex items-stretch">
          {onglets.map((tab) => {
            const active = !drawer && isActive(pathname, tab.match);
            const TabIcon = tab.icon;
            const badge = tab.href === "/messages" ? messagingUnread : 0;
            return (
              <Link
                key={tab.href} href={tab.href}
                className={cn(
                  "relative flex flex-1 flex-col items-center gap-0.5 py-2 transition active:scale-95",
                  active ? "text-primary" : "text-muted-foreground",
                )}
              >
                <TabIcon className="h-[1.375rem] w-[1.375rem]" />
                <span className="text-[0.6875rem] font-medium">{tab.label}</span>
                {badge > 0 && (
                  <span className="absolute right-[22%] top-1 min-w-[1rem] rounded-full bg-destructive px-1 text-[0.5625rem] font-bold leading-4 text-destructive-foreground">
                    {badge > 99 ? "99+" : badge}
                  </span>
                )}
                {active && <span className="absolute inset-x-5 top-0 h-0.5 rounded-full bg-primary" />}
              </Link>
            );
          })}
          <button
            onClick={() => setDrawer((v) => !v)}
            aria-label="Tous les modules"
            className={cn(
              "relative flex flex-1 flex-col items-center gap-0.5 py-2 transition active:scale-95",
              drawer ? "text-primary" : "text-muted-foreground",
            )}
          >
            <Grid3x3 className="h-[1.375rem] w-[1.375rem]" />
            <span className="text-[0.6875rem] font-medium">Tout</span>
            {drawer && <span className="absolute inset-x-5 top-0 h-0.5 rounded-full bg-primary" />}
          </button>
        </div>
      </nav>
    </>
  );
}
