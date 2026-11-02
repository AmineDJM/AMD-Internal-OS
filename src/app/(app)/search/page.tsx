import Link from "next/link";
import { requireUser } from "@/lib/session";
import { globalSearch, type SearchResult } from "@/lib/queries/search";
import { Icon } from "@/components/ui/icon";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export default async function SearchPage(props: { searchParams: Promise<{ q?: string }> }) {
  const searchParams = await props.searchParams;
  const user = await requireUser();
  const q = (searchParams.q ?? "").trim();

  if (!q) {
    return (
      <div className="space-y-5">
        <PageHeader title="Recherche" description="Astuce : ⌘K ouvre la recherche partout." />
        <EmptyState icon="Search" title="Saisissez un terme de recherche" description="DCI, dossier, institution, fichier, employé, écriture…" />
      </div>
    );
  }

  const results = await globalSearch(user, q, 12);
  const groups = new Map<string, SearchResult[]>();
  for (const r of results) {
    if (!groups.has(r.group)) groups.set(r.group, []);
    groups.get(r.group)!.push(r);
  }

  return (
    <div className="space-y-5">
      <PageHeader title="Recherche" description={`${results.length} résultat${results.length > 1 ? "s" : ""} pour « ${q} »`} />
      {results.length === 0 ? (
        <EmptyState icon="SearchX" title="Aucun résultat" description="Essayez un autre terme." />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {[...groups.entries()].map(([group, items]) => (
            <Card key={group}>
              <CardHeader className="flex-row items-center justify-between">
                <CardTitle>{group}</CardTitle>
                <Badge tone="neutral">{items.length}</Badge>
              </CardHeader>
              <CardContent className="divide-y divide-border">
                {items.map((r) => (
                  <Link key={`${group}-${r.id}`} href={r.href} className="flex min-h-11 items-center gap-2.5 py-2 hover:bg-secondary/40 sm:min-h-0">
                    <Icon name={r.icon} className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{r.title}</span>
                      {r.subtitle && <span className="block truncate text-xs text-muted-foreground">{r.subtitle}</span>}
                    </span>
                  </Link>
                ))}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
