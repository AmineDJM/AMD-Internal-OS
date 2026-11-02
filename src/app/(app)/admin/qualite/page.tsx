import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireUser } from "@/lib/session";
import { hasGlobalView } from "@/lib/rbac";
import {
  compterConstats, derniersBalayages, lireConstats, modulesVisibles, REGLES,
  CRITICITES, FAMILLES, LIBELLE_CRITICITE, LIBELLE_FAMILLE, type Criticite, type FamilleQualite, type StatutConstat,
} from "@/platform/in-process/quality";
import { PageHeader } from "@/components/shared/page-header";
import { KpiCard } from "@/components/shared/kpi-card";
import { EmptyState } from "@/components/shared/empty-state";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { BoutonsConstat, BoutonBalayage } from "./qualite-client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Qualité des données — Administration" };

/**
 * L'ÉCRAN DE LA QUALITÉ DES DONNÉES (mandat 4 §23) — les constats du moteur, sous les droits de
 * la personne, avec leur criticité, leur confiance, leur résolution, et le geste qui va avec.
 * Le moteur montre ; la personne tranche ; l'audit garde le nom.
 */
const STATUTS: { v: StatutConstat | "TOUS"; l: string }[] = [
  { v: "OPEN", l: "Ouverts" }, { v: "FIXED", l: "Corrigés" }, { v: "DISMISSED", l: "Écartés" }, { v: "RESOLVED", l: "Disparus" }, { v: "TOUS", l: "Tous" },
];
const TON: Record<Criticite, "danger" | "warning" | "neutral" | "info"> = { CRITIQUE: "danger", HAUTE: "warning", NORMALE: "neutral", BASSE: "info" };
const dateFr = (d: Date | null) => (d ? new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Africa/Algiers" }).format(d) : "—");

export default async function QualitePage(
  props: { searchParams?: Promise<{ statut?: string; famille?: string; criticite?: string; regle?: string }> }
) {
  const searchParams = await props.searchParams;
  const user = await requireUser();
  const visibles = modulesVisibles(user);
  if (visibles && visibles.length === 0) notFound();
  const statut = (STATUTS.find((s) => s.v === searchParams?.statut)?.v ?? "OPEN") as StatutConstat | "TOUS";
  const famille = FAMILLES.includes(searchParams?.famille as FamilleQualite) ? (searchParams?.famille as FamilleQualite) : null;
  const criticite = CRITICITES.includes(searchParams?.criticite as Criticite) ? (searchParams?.criticite as Criticite) : null;
  const regle = REGLES.some((r) => r.id === searchParams?.regle) ? (searchParams?.regle as string) : null;
  const [compte, constats, balayages] = await Promise.all([
    compterConstats(user),
    lireConstats(user, { statut, famille, criticite, regle, limite: 300 }),
    derniersBalayages(),
  ]);
  const lien = (p: Record<string, string | null>) => {
    const q = new URLSearchParams();
    const etat: Record<string, string | null> = { statut, famille, criticite, regle, ...p };
    for (const [k, v] of Object.entries(etat)) if (v && !(k === "statut" && v === "OPEN")) q.set(k, v);
    const s = q.toString();
    return `/admin/qualite${s ? `?${s}` : ""}`;
  };

  return (
    <div className="space-y-6">
      <PageHeader title="Qualité des données" description="Doublons, champs manquants, données périmées, incohérences, montants, statuts, relations, e-mails, documents, dates, valeurs aberrantes — trouvés par le moteur, tranchés par une personne.">
        <Link href="/admin" className="text-sm text-muted-foreground hover:underline"><ArrowLeft className="mr-1 inline h-4 w-4" />Administration</Link>
        {hasGlobalView(user) && <BoutonBalayage />}
      </PageHeader>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <div className="col-span-2 sm:col-span-1 [&>*]:h-full">
          <KpiCard label="Constats ouverts" value={String(compte.ouverts)} hint="sous vos droits" />
        </div>
        {CRITICITES.map((c) => (
          <KpiCard key={c} label={LIBELLE_CRITICITE[c]} value={String(compte.parCriticite[c] ?? 0)} tone={c === "CRITIQUE" && (compte.parCriticite[c] ?? 0) > 0 ? "danger" : "default"} />
        ))}
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Derniers balayages</CardTitle></CardHeader>
        <CardContent className="text-sm">
          {balayages.length === 0 ? (
            <p className="text-muted-foreground">Aucun balayage encore : le battement en lance un complet la nuit et un léger toutes les heures.</p>
          ) : (
            <ul className="space-y-1" data-testid="qualite-balayages">
              {balayages.map((b) => (
                <li key={`${b.mode}-${b.startedAt.toISOString()}`}>
                  <span className="font-medium">{b.mode === "FULL" ? "Complet" : "Léger"}</span> — {dateFr(b.startedAt)} · {b.ms ?? "—"} ms · {b.constats} constat(s), {b.nouveaux} nouveau(x), {b.corriges} corrigé(s) seul(s), {b.resolus} disparu(s){b.erreurs ? ` · ${b.erreurs} règle(s) en erreur` : ""}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <div className="flex flex-wrap gap-2 text-sm" data-testid="qualite-filtres">
        {STATUTS.map((s) => <Link key={s.v} href={lien({ statut: s.v })} className={`rounded-full border px-3 py-1.5 sm:py-1 ${statut === s.v ? "bg-primary text-primary-foreground" : "hover:bg-secondary"}`}>{s.l}</Link>)}
        <span className="mx-1 text-muted-foreground">·</span>
        <Link href={lien({ famille: null })} className={`rounded-full border px-3 py-1.5 sm:py-1 ${!famille ? "bg-secondary" : "hover:bg-secondary"}`}>Toutes familles</Link>
        {FAMILLES.filter((f) => (compte.parFamille[f] ?? 0) > 0 || f === famille).map((f) => (
          <Link key={f} href={lien({ famille: f })} className={`rounded-full border px-3 py-1.5 sm:py-1 ${famille === f ? "bg-secondary" : "hover:bg-secondary"}`}>{LIBELLE_FAMILLE[f]} <span className="text-muted-foreground">{compte.parFamille[f] ?? 0}</span></Link>
        ))}
      </div>

      {constats.length === 0 ? (
        <EmptyState title="Rien dans ce filtre" description="Le moteur n'a aucun constat à montrer ici. Un balayage complet tourne chaque nuit ; les règles financières toutes les heures." />
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <Table data-testid="qualite-table">
            <TableHeader>
              <TableRow><TableHead className="p-3">Criticité</TableHead><TableHead className="p-3">Constat</TableHead><TableHead className="p-3">Famille · règle</TableHead><TableHead className="p-3">Confiance</TableHead><TableHead className="p-3">Résolution</TableHead><TableHead className="p-3">Vu</TableHead><TableHead className="p-3">Geste</TableHead></TableRow>
            </TableHeader>
            <TableBody>
              {constats.map((c) => (
                <TableRow key={c.id} className="align-top" data-testid="qualite-ligne" data-regle={c.regle} data-status={c.status}>
                  <TableCell className="sm:p-3"><Badge tone={TON[c.criticite]}>{LIBELLE_CRITICITE[c.criticite]}</Badge></TableCell>
                  <TableCell data-sans-etiquette className="max-w-xl sm:p-3">
                    <div className="min-w-0">
                      <p className="font-medium">{c.href ? <Link href={c.href} className="hover:underline">{c.titre}</Link> : c.titre}</p>
                      <p className="mt-0.5 text-muted-foreground">{c.detail}</p>
                      {c.correction && <p className="mt-1 text-xs">Correction proposée : {c.correction.description}</p>}
                      {c.motif && <p className="mt-1 text-xs italic">Écarté : {c.motif}</p>}
                    </div>
                  </TableCell>
                  <TableCell className="text-xs sm:p-3"><div><div>{LIBELLE_FAMILLE[c.famille as FamilleQualite] ?? c.famille}</div><Link href={lien({ regle: c.regle })} className="text-muted-foreground hover:underline">{c.regle}</Link><div className="text-muted-foreground">{c.module}</div></div></TableCell>
                  <TableCell className="tabular-nums sm:p-3">{Math.round(c.confiance * 100)} %</TableCell>
                  <TableCell className="text-xs sm:p-3"><div>{c.resolution === "AUTO" ? "automatique" : c.resolution === "PROPOSE" ? "d'un clic" : "décision"}<div className="text-muted-foreground">{c.status === "OPEN" ? "ouvert" : c.status === "FIXED" ? `corrigé (${c.resolvedBy ?? "—"})` : c.status === "DISMISSED" ? `écarté (${c.resolvedBy ?? "—"})` : "disparu"}</div></div></TableCell>
                  <TableCell className="text-xs tabular-nums sm:p-3"><div>{dateFr(c.firstSeenAt)}<div className="text-muted-foreground">{c.occurrences}× {c.reopenCount ? `· rouvert ${c.reopenCount}×` : ""}</div></div></TableCell>
                  <TableCell data-sans-etiquette className="sm:p-3"><BoutonsConstat id={c.id} status={c.status} aCorrection={Boolean(c.correction)} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
