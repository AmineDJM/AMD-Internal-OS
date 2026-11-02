import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { userCan } from "@/lib/rbac";
import { sections360 } from "@/lib/queries/vue-360";
import { chargerStrategie, chargerPanel } from "@/lib/segmentation/service";
import { synthese } from "@/lib/segmentation/moteur";
import { chargerCycle } from "@/lib/segmentation/cycle-service";
import { ETAT_LABELS } from "@/lib/segmentation/regles";
import { PageHeader } from "@/components/shared/page-header";
import { KpiCard } from "@/components/shared/kpi-card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const dynamic = "force-dynamic";

const dzd = (n: number) => `${Math.round(n).toLocaleString("fr-FR")} DZD`;

/**
 * BUSINESS UNIT 360° ET COCKPIT (cahier des charges §12, §56-57) — comprendre la BU en quelques secondes : produits,
 * spécialités, équipe, cibles H et A/B/C/D par produit, priorités, visites requises et réalisées du cycle ouvert,
 * capacité, appels d'offres, dépenses Ad&Pro accordées. Filtrable par spécialité : mêmes indicateurs, une spécialité.
 */
export default async function BusinessUnit360Page(
  props: { params: Promise<{ id: string }>; searchParams?: Promise<{ spe?: string }> }
) {
  const searchParams = await props.searchParams;
  const params = await props.params;
  const user = await requireUser();
  const voit = sections360(user);
  const pleineVue = voit.forceDeVente || user.access.modules.get("SEGMENTATION")?.scope === "ALL";
  if (!pleineVue) redirect("/dashboard?denied=SALES_PLANNING");
  const bu = await prisma.businessUnit.findUnique({
    where: { id: params.id },
    select: {
      id: true, name: true, code: true, channel: true, headId: true, supervisorId: true,
      specialites: { select: { specialtyId: true, principale: true, specialty: { select: { name: true } } }, orderBy: [{ principale: "desc" }] },
      products: { where: { productId: { not: null } }, select: { productId: true, isActive: true, canonicalProduct: { select: { canonicalName: true } }, specialitesCibles: { select: { specialty: { select: { name: true } } } } } },
      reps: { where: { isActive: true }, select: { repId: true } },
      _count: { select: { sectors: true, tenders: true, tenderLines: true } },
      segmentationStrategies: { where: { statut: "ACTIVE" }, select: { id: true } },
    },
  });
  if (!bu) notFound();
  const spe = bu.specialites.some((s) => s.specialtyId === searchParams?.spe) ? searchParams!.spe! : null;
  const annee = new Date().getUTCFullYear();
  const [noms, strategies, depenses] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: [bu.headId, bu.supervisorId, ...bu.reps.map((r) => r.repId)].filter((x): x is string => !!x) } }, select: { id: true, name: true } }),
    Promise.all(bu.segmentationStrategies.map(async ({ id }) => {
      const s = await chargerStrategie(id);
      if (!s) return null;
      const panel = (await chargerPanel(s)).filter((l) => !spe || l.specialiteId === spe);
      const cycle = await prisma.segmentationCycle.findFirst({ where: { strategieId: id, statut: "OUVERT" }, orderBy: { debut: "desc" }, select: { id: true } });
      return { s, syn: synthese(panel.flatMap((l) => (l.resultat ? [l.resultat] : []))), cycle: cycle ? await chargerCycle(cycle.id) : null };
    })),
    voit.adpro || voit.finances ? prisma.adProItem.aggregate({
      where: { status: "APPROVED", amountGranted: { not: null }, decidedAt: { gte: new Date(Date.UTC(annee, 0, 1)) }, OR: [{ sponsoring: { businessUnitId: bu.id } }, { congressNational: { businessUnitId: bu.id } }, { congressInternational: { businessUnitId: bu.id } }, { event: { businessUnitId: bu.id } }] },
      _sum: { amountGranted: true }, _count: { _all: true },
    }) : null,
  ]);
  const nom = (id: string | null) => (id ? noms.find((n) => n.id === id)?.name ?? "—" : "—");
  const produits = bu.products.filter((p, i, a) => a.findIndex((x) => x.productId === p.productId) === i);

  return (
    <div className="space-y-5">
      <PageHeader title={`BU ${bu.name}`} description={`${bu.code ? `${bu.code} · ` : ""}Chef de BU : ${nom(bu.headId)} · Superviseur : ${nom(bu.supervisorId)} · ${bu.reps.length} KAM · ${bu._count.sectors} secteur(s)`} />
      {bu.specialites.length > 1 && (
        <div className="flex flex-wrap items-center gap-1 text-xs">
          <span className="text-muted-foreground">Spécialité :</span>
          <Link href={`/business-units/${bu.id}`} className={`inline-flex min-h-9 items-center rounded-md border px-2 py-1 sm:min-h-0 ${!spe ? "border-primary text-primary" : "border-border text-muted-foreground"}`}>Toutes</Link>
          {bu.specialites.map((s) => <Link key={s.specialtyId} href={`/business-units/${bu.id}?spe=${s.specialtyId}`} className={`inline-flex min-h-9 items-center rounded-md border px-2 py-1 sm:min-h-0 ${spe === s.specialtyId ? "border-primary text-primary" : "border-border text-muted-foreground"}`}>{s.specialty.name}{s.principale ? " ★" : ""}</Link>)}
        </div>
      )}
      <section className="surface space-y-1 p-3 text-sm [overflow-wrap:anywhere] sm:p-4">
        <h2 className="font-semibold">Produits ({produits.length}) et spécialités</h2>
        <p className="text-muted-foreground">Spécialités de la BU : {bu.specialites.map((s) => `${s.specialty.name}${s.principale ? " (principale)" : ""}`).join(", ") || "aucune déclarée"}.</p>
        {produits.map((p) => <p key={p.productId}><Link href={`/produits/${p.productId}`} className="text-primary hover:underline">{p.canonicalProduct?.canonicalName}</Link>{!p.isActive ? " (inactif)" : ""} — {p.specialitesCibles.map((x) => x.specialty.name).join(", ") || "toutes les spécialités de la BU"}</p>)}
      </section>

      {strategies.filter((x): x is NonNullable<typeof x> => !!x).map(({ s, syn, cycle }) => (
        <section key={s.id} className="space-y-3">
          <h2 className="text-sm font-semibold"><Link href={`/segmentation?s=${s.id}${spe ? `&spe=${spe}` : ""}`} className="text-primary hover:underline">Stratégie {s.nom}</Link> · {s.produits.map((p) => `#${p.rang} ${p.nom}`).join(" · ")}</h2>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
            <KpiCard label="Praticiens ciblés" value={syn.cibles} icon="Target" />
            <KpiCard label="Décideurs (H)" value={syn.h} icon="Crown" tone="info" />
            {Object.entries(syn.parPriorite).sort().map(([p, n]) => <KpiCard key={p} label={`Priorité ${p}`} value={n} icon="Flag" />)}
            <KpiCard label="Visites requises / cycle" value={syn.visitesRequises} icon="CalendarCheck" />
            {cycle && <KpiCard label={`Réalisées (${cycle.libelle})`} value={`${cycle.total.realise} / ${Math.round(cycle.total.requis)}`} icon="CircleCheck" tone="success" hint={cycle.total.requis ? `couverture ${Math.round((cycle.total.realise / cycle.total.requis) * 100)} %` : undefined} />}
          </div>
          {s.produits.map((p) => { const m = syn.parProduit[p.productId]; return m ? <p key={p.productId} className="text-sm text-muted-foreground"><span className="font-medium text-foreground">{p.nom}</span> {(["A", "B", "C", "D", "EN_ATTENTE", "NON_CIBLE"] as const).map((k) => `${ETAT_LABELS[k]} ${m[k]}`).join(" · ")}</p> : null; })}
          {cycle && cycle.parKam.length > 0 && (
            <div className="surface">
              <Table>
                <TableHeader><TableRow><TableHead>KAM</TableHead><TableHead>P1</TableHead><TableHead>Requis</TableHead><TableHead>Réalisé</TableHead><TableHead>Capacité</TableHead><TableHead>Utilisation</TableHead><TableHead>H sous-visités</TableHead></TableRow></TableHeader>
                <TableBody>{cycle.parKam.map((k) => <TableRow key={k.repId}><TableCell data-sans-etiquette className="font-medium">{k.nom}</TableCell><TableCell>{k.p1}</TableCell><TableCell>{Math.round(k.requis * 10) / 10}</TableCell><TableCell>{k.realise}</TableCell><TableCell>{k.capacite ?? "—"}</TableCell><TableCell>{k.utilisation === null ? "—" : `${Math.round(k.utilisation * 100)} %`}</TableCell><TableCell>{k.hSousVisites}</TableCell></TableRow>)}</TableBody>
              </Table>
            </div>
          )}
        </section>
      ))}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {voit.marches && <KpiCard label="Appels d'offres" value={bu._count.tenders} icon="Gavel" hint={`${bu._count.tenderLines} lot(s) affecté(s)`} />}
        {depenses && <KpiCard label={`Ad&Pro accordé ${annee}`} value={dzd(Number(depenses._sum.amountGranted ?? 0))} icon="Banknote" hint={`${depenses._count._all} poste(s)`} />}
        {userCan(user, "SALES_PLANNING", "VIEW") && <KpiCard label="KAM" value={bu.reps.length} icon="Users" />}
      </div>
    </div>
  );
}
