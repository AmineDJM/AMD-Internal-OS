import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/shared/page-header";
import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/utils";
import { LIBELLE_ROLE } from "@/modules/referentiels/api";
import { GesteDoublon } from "./geste-doublon";

export const dynamic = "force-dynamic";
export const metadata = { title: "Personnes — doublons — AMD Internal OS" };

const RANG: Record<string, number> = { CERTAIN: 3, PROBABLE: 2, POSSIBLE: 1 };
const TON: Record<string, "danger" | "warning" | "neutral"> = { CERTAIN: "danger", PROBABLE: "warning", POSSIBLE: "neutral" };

const SELECTION_PERSONNE = {
  id: true, nom: true, prenoms: true, civilite: true, fusionneeDansId: true,
  roles: { where: { jusquA: null }, select: { role: true } },
  _count: { select: { users: true, employees: true, medicalDoctors: true, careBeneficiaries: true, adProVoyageurs: true, adProHebergements: true, recruitmentCandidates: true, directoryEntries: true, supplierUsers: true } },
} as const;

/**
 * LES DOUBLONS DE PERSONNES À TRANCHER (lot V2-B) — Super Admin. Le système propose (reprise
 * `personnes-doublons`), une personne tranche : garder l'une (l'autre y est fusionnée, tracé et réversible) ou
 * écarter (ce ne sont pas les mêmes ; la paire ne revient plus). Les fusions récentes se défont d'ici.
 */
export default async function DoublonsPersonnesPage() {
  const user = await requireUser();
  if (user.role !== "SUPER_ADMIN") redirect("/dashboard?denied=ADMIN");

  const [proposes, fusions] = await Promise.all([
    prisma.doublonPersonne.findMany({
      where: { statut: "PROPOSE", personneA: { fusionneeDansId: null }, personneB: { fusionneeDansId: null } },
      orderBy: { score: "desc" }, take: 300,
      select: { id: true, niveau: true, score: true, raisons: true, reserves: true, personneA: { select: SELECTION_PERSONNE }, personneB: { select: SELECTION_PERSONNE } },
    }),
    prisma.doublonPersonne.findMany({
      where: { statut: "FUSIONNE" }, orderBy: { decideLe: "desc" }, take: 20,
      select: { id: true, gardeeId: true, decideLe: true, deplacees: true, personneA: { select: { id: true, nom: true, prenoms: true } }, personneB: { select: { id: true, nom: true, prenoms: true } } },
    }),
  ]);
  proposes.sort((x, y) => (RANG[y.niveau] ?? 0) - (RANG[x.niveau] ?? 0) || y.score - x.score);

  return (
    <div className="space-y-5">
      <PageHeader title="Personnes — doublons à trancher" description="Le système propose, vous tranchez. Une fusion est tracée et se défait ; une paire écartée ne revient pas.">
        <Link href="/admin/refonte-donnees" className="text-sm text-primary underline">Refonte des données</Link>
      </PageHeader>
      {!proposes.length && <p className="text-sm text-muted-foreground">Aucune proposition en attente. Lancez la reprise « Personnes — doublons proposés ».</p>}
      <div className="space-y-3">
        {proposes.map((d) => (
          <section key={d.id} className="surface min-w-0 space-y-2 p-3 sm:p-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={TON[d.niveau] ?? "neutral"}>{d.niveau}</Badge>
              <span className="text-xs text-muted-foreground">score {d.score}</span>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {[d.personneA, d.personneB].map((p) => (
                <div key={p.id} className="min-w-0 rounded-lg border border-border p-2 text-sm [overflow-wrap:anywhere]">
                  <Link href={`/personnes/${p.id}`} className="font-medium text-primary hover:underline">{[p.civilite, p.prenoms, p.nom].filter(Boolean).join(" ")}</Link>
                  <p className="text-xs text-muted-foreground">{p.roles.map((r) => LIBELLE_ROLE[r.role]).join(", ") || "sans rôle"}</p>
                  <p className="text-xs text-muted-foreground">{Object.values(p._count).reduce((a, b) => a + b, 0)} fiche(s) reliée(s)</p>
                </div>
              ))}
            </div>
            <p className="text-sm">{d.raisons.join(" ; ")}</p>
            {d.reserves.length > 0 && <p className="text-xs text-warning">⚠ {d.reserves.join(" ; ")}</p>}
            <GesteDoublon
              doublonId={d.id}
              a={{ id: d.personneA.id, nom: [d.personneA.prenoms, d.personneA.nom].filter(Boolean).join(" ") }}
              b={{ id: d.personneB.id, nom: [d.personneB.prenoms, d.personneB.nom].filter(Boolean).join(" ") }}
            />
          </section>
        ))}
      </div>

      {fusions.length > 0 && (
        <section className="surface space-y-2 p-3 sm:p-4">
          <h2 className="text-sm font-semibold">Fusions récentes</h2>
          <ul className="divide-y divide-border">
            {fusions.map((f) => {
              const [gardee, absorbee] = f.gardeeId === f.personneA.id ? [f.personneA, f.personneB] : [f.personneB, f.personneA];
              return (
                <li key={f.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                  <span className="min-w-0 [overflow-wrap:anywhere]">
                    {[absorbee.prenoms, absorbee.nom].filter(Boolean).join(" ")} → <Link href={`/personnes/${gardee.id}`} className="text-primary hover:underline">{[gardee.prenoms, gardee.nom].filter(Boolean).join(" ")}</Link>
                    <span className="text-xs text-muted-foreground"> · {f.deplacees.length} fiche(s) · {f.decideLe ? formatDateTime(f.decideLe) : ""}</span>
                  </span>
                  <GesteDoublon doublonId={f.id} defaire />
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
