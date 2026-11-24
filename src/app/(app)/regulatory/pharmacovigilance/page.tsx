import Link from "next/link";
import { redirect } from "next/navigation";
import { Filter } from "lucide-react";
import { requireModule } from "@/lib/session";
import { voitTousLesCasPv } from "@/lib/pharmacovigilance/acces";
import { CHEMIN_PV_KAM } from "@/lib/chemins/rapports-terrain";
import { compteursCasPv, listerCasPv } from "@/lib/pharmacovigilance/donnees";
import { STATUTS_PV, STATUT_PV, estStatutPv } from "@/lib/pharmacovigilance/regles";
import { lireReglagesPv } from "@/lib/pharmacovigilance/reglages";
import { prisma } from "@/lib/prisma";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { ListeCasPv } from "./liste-cas";
import { ReglagesPv } from "./reglages-pv";

export const dynamic = "force-dynamic";

/**
 * LA BOÎTE DE PHARMACOVIGILANCE DE REGULATORY (Direction, 06/10) — les cas signalés par les KAM depuis les Rapports
 * terrain, du plus récent au plus ancien, avec leurs compteurs et des filtres (statut, produit, période). Qui ne reçoit
 * pas les cas (le KAM) est renvoyé vers ses signalements.
 */
export default async function PharmacovigilancePage(props: { searchParams: Promise<Record<string, string | undefined>> }) {
  const searchParams = await props.searchParams;
  const user = await requireModule("PHARMACOVIGILANCE");
  if (!voitTousLesCasPv(user)) redirect(CHEMIN_PV_KAM);
  const statut = estStatutPv(searchParams.statut) ? searchParams.statut : "";
  const produit = (searchParams.produit ?? "").trim();
  const du = searchParams.du ?? "";
  const au = searchParams.au ?? "";
  const [cas, compteurs] = await Promise.all([
    listerCasPv(user, { statut, produit, du, au }),
    compteursCasPv(user),
  ]);
  const aDeclarer = compteurs.RECU + compteurs.ENQUETE + compteurs.EVALUE;
  const enRetard = cas.filter((c) => c.echeance?.ton === "danger").length;
  const filtre = Boolean(statut || produit || du || au);
  // LES RÉGLAGES (Super Admin seul) : délais de déclaration et pharmacien responsable par société.
  const superAdmin = user.role === "SUPER_ADMIN";
  const reglages = superAdmin
    ? await Promise.all([
        lireReglagesPv(),
        prisma.company.findMany({ where: { isActive: true }, select: { id: true, name: true, shortName: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }),
        prisma.user.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
      ])
    : null;

  return (
    <div className="space-y-5">
      <PageHeader title="Pharmacovigilance" />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {STATUTS_PV.map((s) => (
          <Link
            key={s} href={statut === s ? "/regulatory/pharmacovigilance" : `/regulatory/pharmacovigilance?statut=${s}`}
            className={`surface min-w-0 px-4 py-3 hover:bg-secondary/40 ${statut === s ? "ring-2 ring-primary" : ""}`}
          >
            <p className="truncate text-xs text-muted-foreground">{STATUT_PV[s].label}</p>
            <p className="text-2xl font-semibold tabular-nums">{compteurs[s]}</p>
          </Link>
        ))}
      </div>
      <p className="text-sm text-muted-foreground">
        {aDeclarer} cas à déclarer à l&apos;autorité
        {enRetard > 0 && <span className="font-medium text-destructive"> — {enRetard} au jour J ou en retard</span>}.
      </p>
      {reglages && (
        <ReglagesPv
          delais={reglages[0].delais} pharmaciens={reglages[0].pharmaciens}
          societes={reglages[1].map((c) => ({ id: c.id, nom: c.shortName ?? c.name }))}
          personnes={reglages[2].map((u) => ({ id: u.id, nom: u.name }))}
        />
      )}

      <form method="get" className="surface grid grid-cols-1 gap-3 p-3 sm:grid-cols-2 lg:grid-cols-5 lg:items-end">
        <label className="min-w-0 space-y-1 text-xs text-muted-foreground">
          Statut
          <Select name="statut" defaultValue={statut}>
            <option value="">Tous</option>
            {STATUTS_PV.map((s) => <option key={s} value={s}>{STATUT_PV[s].label}</option>)}
          </Select>
        </label>
        <label className="min-w-0 space-y-1 text-xs text-muted-foreground">
          Produit
          <Input name="produit" defaultValue={produit} placeholder="Nom du produit…" />
        </label>
        <label className="min-w-0 space-y-1 text-xs text-muted-foreground">
          Survenu du
          <Input type="date" name="du" defaultValue={du} />
        </label>
        <label className="min-w-0 space-y-1 text-xs text-muted-foreground">
          au
          <Input type="date" name="au" defaultValue={au} />
        </label>
        <div className="flex gap-2">
          <Button type="submit" size="sm" className="flex-1 lg:flex-none"><Filter className="h-3.5 w-3.5" /> Filtrer</Button>
          {filtre && <Link href="/regulatory/pharmacovigilance" className="inline-flex items-center px-2 text-sm text-primary hover:underline">Effacer</Link>}
        </div>
      </form>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Cas ({cas.length})</h2>
        {cas.length === 0 ? (
          <EmptyState icon="ShieldAlert" title={filtre ? "Aucun cas pour ces filtres" : "Aucun cas signalé"} description={filtre ? "Élargissez la période ou retirez un filtre." : "Les KAM signalent les cas depuis les Rapports terrain."} />
        ) : (
          <ListeCasPv cas={cas} base="/regulatory/pharmacovigilance" avecDeclarant lecteur={{ userId: user.id, superAdmin: user.role === "SUPER_ADMIN" }} />
        )}
      </section>
    </div>
  );
}
