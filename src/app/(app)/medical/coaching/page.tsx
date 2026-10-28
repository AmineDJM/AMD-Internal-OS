import Link from "next/link";
import { ArrowRight, FileSpreadsheet, ListChecks, Minus, Plus, Settings2, TrendingDown, TrendingUp } from "lucide-react";
import { requireModule } from "@/lib/session";
import { PageHeader } from "@/components/shared/page-header";
import { ModuleTabs } from "@/components/shared/module-tabs";
import { KpiCard } from "@/components/shared/kpi-card";
import { EmptyState } from "@/components/shared/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { visibleTabs } from "@/lib/nav-tabs";
import { MEDICAL_TABS } from "@/lib/labels";
import { collaborateursCoachables, grilleCourante, lecteurCoaching } from "@/lib/coaching/serveur";
import { listerFichesVisibles, type FicheListee } from "@/lib/coaching/fiches";
import { syntheseParAxe, syntheseParCollaborateur } from "@/lib/coaching/synthese";
import { formaterJour } from "@/lib/coaching/dates";
import { tonsDuNiveau } from "@/components/coaching/fiche-grille";
import { cn } from "@/lib/utils";
import { EntreeMenu, MenuPlus } from "../menu-plus";

export const dynamic = "force-dynamic";
export const metadata = { title: "Coaching — AMD Internal OS" };

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE COACHING — l'onglet de la Promotion médicale (§118.157).
 *
 * Un seul écran, trois lectures selon qui regarde — ce que chacun VOIT vient de la règle
 * (`coaching/acces.ts`), pas de la route :
 *   • le directeur des opérations (et le Super Admin) : tout, brouillons compris, la synthèse de
 *     la force de vente, l'administration de la grille ;
 *   • un manager (superviseur de BU, configurateur de la force de vente) : les fiches de son
 *     équipe, ses brouillons, la synthèse de son périmètre ;
 *   • un KAM : ses propres fiches finalisées.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export default async function CoachingPage(
  props: { searchParams?: Promise<{ collaborateur?: string; statut?: string }> }
) {
  const searchParams = await props.searchParams;
  const user = await requireModule("MEDICAL");
  const l = await lecteurCoaching(user);
  const filtreCollaborateur = searchParams?.collaborateur || null;
  const filtreStatut = searchParams?.statut === "DRAFT" || searchParams?.statut === "FINALIZED" ? searchParams.statut : null;

  const [courante, liste, coachables] = await Promise.all([
    grilleCourante(),
    listerFichesVisibles(l, { collaboratorId: filtreCollaborateur, statut: filtreStatut }),
    collaborateursCoachables(l),
  ]);
  const fiches = liste.fiches;
  const mesEvaluations = fiches.filter((f) => f.collaboratorId === user.id);
  const equipe = fiches.filter((f) => f.collaboratorId !== user.id);
  const brouillons = equipe.filter((f) => f.status === "DRAFT");
  const encadre = l.administre || l.perimetre === "TOUT" || coachables.length > 0;
  const pourSynthese = equipe.flatMap((f) => (f.grille
    ? [{ collaboratorId: f.collaboratorId, collaborateur: f.collaborateur, visitDate: f.visitDate, status: f.status, grille: f.grille, notes: f.notes }]
    : []));
  const parCollaborateur = syntheseParCollaborateur(pourSynthese);
  const parAxe = syntheseParAxe(pourSynthese, courante.grille).filter((a) => a.notes > 0);
  const finalisees = equipe.filter((f) => f.status === "FINALIZED").length;
  const moyenneDernieres = parCollaborateur.length
    ? Math.round(parCollaborateur.reduce((s, c) => s + c.derniere.pct, 0) / parCollaborateur.length)
    : null;

  // Les collaborateurs proposés au filtre : ceux qu'on coache, plus ceux qui apparaissent déjà
  // dans les fiches visibles (un KAM parti d'une BU garde ses fiches).
  const optionsFiltre = new Map<string, string>(coachables.map((c) => [c.id, c.nom]));
  for (const f of equipe) optionsFiltre.set(f.collaboratorId, f.collaborateur);
  const exportHref = `/api/medical/coaching/export${filtreCollaborateur || filtreStatut
    ? `?${new URLSearchParams({ ...(filtreCollaborateur ? { collaborateur: filtreCollaborateur } : {}), ...(filtreStatut ? { statut: filtreStatut } : {}) })}`
    : ""}`;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      {/* UN GESTE PRINCIPAL (« Nouvelle fiche ») ; la grille et l'export du suivi dans « ⋯ » (Direction, 07/10).
          La version de la grille en vigueur se lit dans l'entrée du menu, plus dans un bandeau. */}
      <PageHeader title="Coaching">
        {coachables.length > 0 && (
          <Link href="/medical/coaching/nouvelle">
            <Button size="sm" className="h-10 sm:h-8"><Plus className="h-4 w-4" /> Nouvelle fiche</Button>
          </Link>
        )}
        <MenuPlus label="Autres actions du coaching">
          <EntreeMenu href="/medical/coaching/grille">
            {l.administre ? <Settings2 className="h-4 w-4" /> : <ListChecks className="h-4 w-4" />}
            {l.administre ? "Administrer la grille" : "Grille d'évaluation"}
            {courante.version > 0 && <span className="ml-auto text-xs text-muted-foreground">v{courante.version}</span>}
          </EntreeMenu>
          {(equipe.length > 0 || mesEvaluations.length > 0) && (
            <EntreeMenu href={exportHref} brut>
              <FileSpreadsheet className="h-4 w-4" /> Exporter le suivi (Excel)
            </EntreeMenu>
          )}
        </MenuPlus>
      </PageHeader>
      <ModuleTabs tabs={await visibleTabs(user, MEDICAL_TABS)} />

      {encadre && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <KpiCard label="Fiches finalisées" value={finalisees} icon="ClipboardCheck" />
          <KpiCard label="Collaborateurs coachés" value={parCollaborateur.length} icon="Users" />
          <KpiCard label="Moyenne des dernières fiches" value={moyenneDernieres === null ? "—" : `${moyenneDernieres} %`} icon="Gauge" tone={moyenneDernieres === null ? "default" : moyenneDernieres >= 75 ? "success" : moyenneDernieres >= 50 ? "info" : "warning"} />
          <KpiCard label="Brouillons en cours" value={brouillons.length} icon="PenLine" tone={brouillons.length ? "warning" : "default"} />
        </div>
      )}

      {/* ── BROUILLONS ─────────────────────────────────────────────────────────────────── */}
      {brouillons.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">À finaliser ({brouillons.length})</h2>
          <ul className="divide-y divide-border rounded-xl border border-warning/40">
            {brouillons.map((f) => (
              <li key={f.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                <span className="min-w-0 font-medium [overflow-wrap:anywhere]">{f.collaborateur}</span>
                <span className="text-muted-foreground">tournée du {formaterJour(f.visitDate)}</span>
                {f.manager && <span className="text-xs text-muted-foreground">· {f.manager}</span>}
                <ScoreBadge fiche={f} />
                <Link href={`/medical/coaching/${f.id}`} className="ml-auto inline-flex min-h-9 items-center gap-1 text-primary hover:underline">
                  Reprendre <ArrowRight className="h-3.5 w-3.5" />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ── MES ÉVALUATIONS (le collaborateur) ─────────────────────────────────────────── */}
      {(mesEvaluations.length > 0 || !encadre) && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Mes fiches de coaching</h2>
          {mesEvaluations.length === 0 ? (
            <EmptyState icon="ClipboardList" title="Aucune fiche de coaching à votre nom" />
          ) : (
            <ListeFiches fiches={mesEvaluations} colonneCollaborateur={false} />
          )}
        </section>
      )}

      {/* ── SUIVI PAR COLLABORATEUR ─────────────────────────────────────────────────────── */}
      {encadre && parCollaborateur.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Suivi par collaborateur</h2>
          <div className="surface overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Collaborateur</TableHead>
                  <TableHead className="text-right">Fiches</TableHead>
                  <TableHead>Dernière tournée</TableHead>
                  <TableHead>Dernier total</TableHead>
                  <TableHead className="text-right">Moyenne</TableHead>
                  <TableHead>Tendance</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {parCollaborateur.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell label="Collaborateur" className="font-medium">
                      <Link href={`/medical/coaching?collaborateur=${c.id}`} className="hover:underline">{c.nom}</Link>
                    </TableCell>
                    <TableCell label="Fiches" className="text-right tabular-nums">{c.fiches}</TableCell>
                    <TableCell label="Dernière tournée" className="tabular-nums">{formaterJour(c.derniere.date)}</TableCell>
                    <TableCell label="Dernier total"><Jauge total={c.derniere.total} max={c.derniere.max} /></TableCell>
                    <TableCell label="Moyenne" className="text-right tabular-nums">{c.moyennePct} %</TableCell>
                    <TableCell label="Tendance">
                      {c.tendance === "hausse" ? <span className="inline-flex items-center gap-1 text-success"><TrendingUp className="h-4 w-4" /> En hausse</span>
                        : c.tendance === "baisse" ? <span className="inline-flex items-center gap-1 text-destructive"><TrendingDown className="h-4 w-4" /> En baisse</span>
                          : c.tendance === "stable" ? <span className="inline-flex items-center gap-1 text-muted-foreground"><Minus className="h-4 w-4" /> Stable</span>
                            : <span className="text-muted-foreground">—</span>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
      )}

      {/* ── MAÎTRISE PAR AXE ────────────────────────────────────────────────────────────── */}
      {encadre && parAxe.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Niveau moyen par axe (fiches finalisées)</h2>
          <ul className="surface divide-y divide-border">
            {parAxe.map((a) => {
              const niveau = a.moyenne ?? 0;
              const arrondi = Math.min(4, Math.max(1, Math.round(niveau)));
              const n = courante.grille.niveaux[arrondi - 1];
              return (
                <li key={a.cle} className="grid grid-cols-1 gap-2 px-4 py-3 sm:grid-cols-[18rem_1fr_7rem] sm:items-center">
                  <span className="text-sm font-medium text-foreground">{a.titre}</span>
                  <span className="h-2.5 overflow-hidden rounded-full bg-muted">
                    <span className={cn("block h-full rounded-full", tonsDuNiveau(arrondi).total)} style={{ width: `${(niveau / 4) * 100}%` }} />
                  </span>
                  <span className="text-sm tabular-nums text-muted-foreground sm:text-right">
                    {niveau.toLocaleString("fr-FR", { maximumFractionDigits: 1 })} / 4 {n ? `· ${n.code}` : ""}
                    <span className="block text-[11px]">{a.notes} note(s)</span>
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {/* ── TOUTES LES FICHES ───────────────────────────────────────────────────────────── */}
      {encadre && (
        <section className="space-y-3">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Fiches de l&apos;équipe</h2>
            <form className="flex w-full flex-wrap items-end gap-2 sm:w-auto" method="get">
              <label className="min-w-0 flex-1 space-y-1 sm:flex-none">
                <span className="block text-xs text-muted-foreground">Collaborateur</span>
                <select name="collaborateur" defaultValue={filtreCollaborateur ?? ""} className="h-10 w-full rounded-[var(--radius)] border border-border bg-card px-2 text-base sm:h-9 sm:w-auto sm:text-sm">
                  <option value="">Tous</option>
                  {[...optionsFiltre].sort((a, b) => a[1].localeCompare(b[1], "fr")).map(([id, nom]) => <option key={id} value={id}>{nom}</option>)}
                </select>
              </label>
              <label className="min-w-0 flex-1 space-y-1 sm:flex-none">
                <span className="block text-xs text-muted-foreground">Statut</span>
                <select name="statut" defaultValue={filtreStatut ?? ""} className="h-10 w-full rounded-[var(--radius)] border border-border bg-card px-2 text-base sm:h-9 sm:w-auto sm:text-sm">
                  <option value="">Tous</option>
                  <option value="FINALIZED">Finalisées</option>
                  <option value="DRAFT">Brouillons</option>
                </select>
              </label>
              <Button type="submit" size="sm" variant="secondary" className="h-10 sm:h-9">Filtrer</Button>
              {(filtreCollaborateur || filtreStatut) && <Link href="/medical/coaching" className="inline-flex min-h-10 items-center text-xs text-primary hover:underline sm:min-h-0 sm:pb-2">Réinitialiser</Link>}
            </form>
          </div>
          {equipe.length === 0 ? (
            <EmptyState icon="ClipboardCheck" title="Aucune fiche de coaching" />
          ) : (
            <ListeFiches fiches={equipe} colonneCollaborateur />
          )}
          {liste.tronque && (
            <p className="text-xs text-muted-foreground">300 tournées les plus récentes — filtrez, ou exportez le suivi (⋯).</p>
          )}
        </section>
      )}
    </div>
  );
}

function ScoreBadge({ fiche }: { fiche: FicheListee }) {
  if (fiche.total === null || fiche.max === null) return <Badge tone="danger">Grille illisible</Badge>;
  return <span className="text-xs tabular-nums text-muted-foreground">{fiche.total} / {fiche.max}{fiche.complet ? "" : " (incomplet)"}</span>;
}

function Jauge({ total, max }: { total: number; max: number }) {
  const pct = max ? Math.round((total / max) * 100) : 0;
  return (
    // w-full : dans une carte mobile, la barre prend la place restante au lieu de s'écraser à zéro.
    <span className="flex w-full min-w-[8rem] max-w-[14rem] items-center gap-2 sm:max-w-none">
      <span className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
        <span className={cn("block h-full rounded-full", pct >= 75 ? "bg-success" : pct >= 50 ? "bg-primary" : pct >= 35 ? "bg-warning" : "bg-destructive")} style={{ width: `${pct}%` }} />
      </span>
      <span className="shrink-0 text-sm font-medium tabular-nums">{total} / {max}</span>
    </span>
  );
}

function ListeFiches({ fiches, colonneCollaborateur }: { fiches: FicheListee[]; colonneCollaborateur: boolean }) {
  return (
    <div className="surface overflow-hidden">
      {/* UN TABLEAU RESTE UN TABLEAU au téléphone : il défile dans son cadre (Direction, 07/10). */}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Tournée</TableHead>
            {colonneCollaborateur && <TableHead>Collaborateur</TableHead>}
            <TableHead>Manager</TableHead>
            <TableHead>Total</TableHead>
            <TableHead>Statut</TableHead>
            <TableHead className="text-right">Fiche</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {fiches.map((f) => (
            <TableRow key={f.id}>
              <TableCell label="Tournée" className="tabular-nums">{formaterJour(f.visitDate)}</TableCell>
              {colonneCollaborateur && <TableCell label="Collaborateur" className="font-medium">{f.collaborateur}</TableCell>}
              <TableCell label="Manager">{f.manager ?? "—"}</TableCell>
              <TableCell label="Total">{f.total === null || f.max === null ? <Badge tone="danger">Grille illisible</Badge> : <Jauge total={f.total} max={f.max} />}</TableCell>
              <TableCell label="Statut">
                <Badge tone={f.status === "FINALIZED" ? "success" : "warning"}>{f.status === "FINALIZED" ? "Finalisée" : "Brouillon"}</Badge>
              </TableCell>
              {/* UN GESTE PAR LIGNE : ouvrir la fiche. Son classeur Excel se télécharge depuis la fiche (⋯). */}
              <TableCell label="Fiche" className="text-right">
                <Link href={`/medical/coaching/${f.id}`} className="inline-flex min-h-10 items-center gap-1 whitespace-nowrap text-primary hover:underline sm:min-h-0">
                  Ouvrir <ArrowRight className="h-3.5 w-3.5" />
                </Link>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
