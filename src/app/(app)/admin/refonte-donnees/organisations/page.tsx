import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DefaireFusion, TrancherDoublon } from "./gestes";

export const dynamic = "force-dynamic";
export const metadata = { title: "Doublons d'organisations — Refonte des données" };

const RANG: Record<string, number> = { CERTAIN: 3, PROBABLE: 2, POSSIBLE: 1 };
const TON: Record<string, "danger" | "warning" | "neutral"> = { CERTAIN: "danger", PROBABLE: "warning", POSSIBLE: "neutral" };
const AFFICHEES = 200;

/**
 * LES DOUBLONS D'ORGANISATIONS À TRANCHER — Super Admin seul (décision 2 de la Direction en attente). Une paire
 * par ligne, ses raisons et ses réserves, et trois gestes : garder la première, garder la seconde, ou dire que ce
 * ne sont pas les mêmes. Les paires dont une organisation a déjà été fusionnée ailleurs ne sont plus montrées.
 */
export default async function DoublonsOrganisationsPage() {
  const user = await requireUser();
  if (user.role !== "SUPER_ADMIN") redirect("/dashboard?denied=ADMIN");
  const vivantes = { organisationA: { fusionneeDansId: null }, organisationB: { fusionneeDansId: null } };
  const org = { select: { id: true, raisonSociale: true, roles: { select: { role: true } }, identifiants: { select: { type: true, valeur: true } } } };
  const [propositions, total, fusions] = await Promise.all([
    prisma.propositionDoublonOrganisation.findMany({
      where: { statut: "PROPOSEE", ...vivantes }, take: 2000,
      select: { id: true, niveau: true, score: true, raisons: true, reserves: true, organisationA: org, organisationB: org },
    }),
    prisma.propositionDoublonOrganisation.count({ where: { statut: "PROPOSEE", ...vivantes } }),
    prisma.organisation.findMany({
      where: { fusionneeDansId: { not: null } }, orderBy: { updatedAt: "desc" }, take: 30,
      select: { id: true, raisonSociale: true, fusionneeDans: { select: { id: true, raisonSociale: true } } },
    }),
  ]);
  const triees = propositions
    .sort((p, q) => (RANG[q.niveau] ?? 0) - (RANG[p.niveau] ?? 0) || q.score - p.score)
    .slice(0, AFFICHEES);
  const decrire = (o: (typeof propositions)[number]["organisationA"]) => (
    <div>
      <Link href={`/organisations/${o.id}`} className="font-medium hover:underline">{o.raisonSociale}</Link>
      <div className="text-xs text-muted-foreground">
        {o.roles.map((r) => r.role.toLowerCase().replace(/_/g, " ")).join(", ")}
        {o.identifiants.length > 0 && ` · ${o.identifiants.map((i) => `${i.type} ${i.valeur}`).join(" · ")}`}
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      <PageHeader title="Doublons d'organisations" description={`${total} paire(s) à trancher. Le système propose, une personne tranche : une fusion n'efface rien et se défait.`}>
        <Link href="/admin/refonte-donnees" className="text-sm text-muted-foreground hover:underline"><ArrowLeft className="mr-1 inline h-4 w-4" />Refonte des données</Link>
      </PageHeader>

      {triees.length === 0 ? (
        <EmptyState title="Aucune paire à trancher" description="Lancer la reprise « Organisations — doublons à trancher » pour comparer les organisations." />
      ) : (
        <div className="space-y-3">
          {triees.map((p) => (
            <Card key={p.id} data-testid="doublon-paire">
              <CardContent className="space-y-3 pt-4 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={TON[p.niveau] ?? "neutral"}>{p.niveau.toLowerCase()}</Badge>
                  <span className="text-xs text-muted-foreground">score {p.score}</span>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">{decrire(p.organisationA)}{decrire(p.organisationB)}</div>
                <ul className="list-disc pl-5 text-xs">
                  {p.raisons.map((r, i) => <li key={`r${i}`}>{r}</li>)}
                  {p.reserves.map((r, i) => <li key={`s${i}`} className="text-muted-foreground">{r}</li>)}
                </ul>
                <TrancherDoublon
                  propositionId={p.id}
                  a={{ id: p.organisationA.id, nom: p.organisationA.raisonSociale }}
                  b={{ id: p.organisationB.id, nom: p.organisationB.raisonSociale }}
                />
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {fusions.length > 0 && (
        <Card>
          <CardHeader><CardTitle>Dernières fusions</CardTitle></CardHeader>
          <CardContent>
            <ul className="space-y-1 text-sm">
              {fusions.map((f) => (
                <li key={f.id}>
                  « {f.raisonSociale} » → <Link href={`/organisations/${f.fusionneeDans!.id}`} className="hover:underline">{f.fusionneeDans!.raisonSociale}</Link>{" "}
                  <DefaireFusion organisationId={f.id} />
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
