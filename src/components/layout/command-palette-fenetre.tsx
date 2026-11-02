"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Search, Loader2, CornerDownLeft } from "lucide-react";
import { IconeCoque } from "@/components/ui/icone-coque";
import type { NavItem } from "@/lib/labels";

interface SearchResult { id: string; group: string; title: string; subtitle: string; href: string; icon: string }
type Item = { kind: "nav"; label: string; href: string; icon: string } | ({ kind: "result" } & SearchResult);

/**
 * LA FENÊTRE DE LA PALETTE (⌘K) — chargée après la page par `command-palette.tsx`, qui ne garde dans la
 * coque que l'écoute du raccourci : la recherche, sa liste et ses icônes ne servent qu'à l'ouverture.
 */
export function FenetrePalette({ navItems, onFermer }: { navItems: NavItem[]; onFermer: () => void }) {
  const router = useRouter();
  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState<SearchResult[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [active, setActive] = React.useState(0);
  const reqRef = React.useRef(0);
  const inputRef = React.useRef<HTMLInputElement>(null);

  // Montée à l'ouverture : le champ prend le focus.
  React.useEffect(() => { setTimeout(() => inputRef.current?.focus(), 0); }, []);

  // Debounced server search.
  React.useEffect(() => {
    if (query.trim().length < 2) { setResults([]); setLoading(false); return; }
    const id = ++reqRef.current;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(query.trim())}`);
        const json = await res.json();
        if (id === reqRef.current) { setResults(json.results ?? []); setActive(0); }
      } catch { /* ignore */ } finally { if (id === reqRef.current) setLoading(false); }
    }, 160);
    return () => clearTimeout(t);
  }, [query]);

  const navMatches = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    const items = q ? navItems.filter((n) => n.label.toLowerCase().includes(q)) : navItems;
    return items.slice(0, q ? 5 : 12);
  }, [query, navItems]);

  // « DEMANDER AU CHIEF OF STAFF » : la palette route la QUESTION telle quelle vers /chief-of-staff
  // (pré-remplie, jamais envoyée seule). Visible seulement si le module est ouvert à cette personne
  // (présent dans SA navigation) — la palette n'accorde rien.
  const chiefNav = React.useMemo(() => navItems.find((n) => n.href === "/chief-of-staff") ?? null, [navItems]);
  const askChief: Item | null = React.useMemo(() => {
    const q = query.trim();
    if (!chiefNav || q.length < 3) return null;
    return {
      kind: "nav" as const,
      label: `Demander au Chief of Staff : « ${q.slice(0, 80)} »`,
      href: `/chief-of-staff?q=${encodeURIComponent(q.slice(0, 400))}`,
      icon: chiefNav.icon,
    };
  }, [chiefNav, query]);

  const items: Item[] = React.useMemo(() => [
    ...(askChief ? [askChief] : []),
    ...navMatches.map((n) => ({ kind: "nav" as const, label: n.label, href: n.href, icon: n.icon })),
    ...results.map((r) => ({ kind: "result" as const, ...r })),
  ], [askChief, navMatches, results]);

  function go(item: Item) {
    onFermer();
    const href = item.href;
    if (href.startsWith("/api/")) window.location.href = href;
    else router.push(href);
  }

  function onInputKey(e: React.KeyboardEvent) {
    if (e.key === "Escape") onFermer();
    else if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, items.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === "Enter" && items[active]) { e.preventDefault(); go(items[active]); }
  }

  let idx = -1;
  const groups = new Map<string, Item[]>();
  if (navMatches.length) groups.set("Aller à", items.filter((i) => i.kind === "nav"));
  for (const r of results) {
    const k = r.group;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push({ kind: "result", ...r });
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center bg-black/40 p-3 pt-[8vh] sm:p-4 sm:pt-[12vh]" onClick={onFermer}>
      <div className="w-full max-w-xl overflow-hidden rounded-xl border border-border bg-card shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-border px-3">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKey}
            placeholder="Rechercher ou aller à…"
            className="h-12 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          {loading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
          <kbd className="hidden rounded border border-border px-1.5 py-0.5 text-[0.625rem] text-muted-foreground sm:block">Esc</kbd>
        </div>

        <div className="max-h-[60dvh] overflow-y-auto p-2 sm:max-h-[55vh]">
          {items.length === 0 ? (
            <p className="px-3 py-8 text-center text-sm text-muted-foreground">
              {query.trim().length < 2 ? "Tapez pour rechercher dans tout le logiciel." : "Aucun résultat."}
            </p>
          ) : (
            [...groups.entries()].map(([group, gItems]) => (
              <div key={group} className="mb-1">
                <p className="px-2 py-1 text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground">{group}</p>
                {gItems.map((item) => {
                  idx++;
                  const i = idx;
                  return (
                    <button
                      key={`${group}-${item.kind === "nav" ? item.href : item.id}-${i}`}
                      onMouseEnter={() => setActive(i)}
                      onClick={() => go(item)}
                      className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm ${i === active ? "bg-secondary" : "hover:bg-secondary/60"}`}
                    >
                      <IconeCoque name={item.icon} className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{item.kind === "nav" ? item.label : item.title}</span>
                        {item.kind === "result" && item.subtitle && <span className="block truncate text-xs text-muted-foreground">{item.subtitle}</span>}
                      </span>
                      {i === active && <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
