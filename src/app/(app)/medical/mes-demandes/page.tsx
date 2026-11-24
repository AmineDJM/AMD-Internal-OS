import Link from "next/link";
import { redirect } from "next/navigation";
import { Plus } from "lucide-react";
import { requireModule } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { aiguillerVisite } from "@/lib/queries/aiguillage-visite";
import { lienMaDemandeRh } from "@/lib/chemins/rh";
import { etapesDemandeRh, etapesPriseEnCharge, type Etape } from "@/lib/sfe/mes-demandes";
import { PageHeader } from "@/components/shared/page-header";
import { ModuleTabs } from "@/components/shared/module-tabs";
import { StatusBadge } from "@/components/shared/status-badge";
import { Badge } from "@/components/ui/badge";
import { visibleTabs } from "@/lib/nav-tabs";
import { CONGRESS_REQUEST_STATUS, HR_REQUEST_STATUS, MEDICAL_TABS } from "@/lib/labels";
import { formatCurrency } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const metadata = { title: "Mes demandes — Visite médicale — AMD Internal OS" };

const JOUR_MS = 86_400_000;
const jour = (iso: string) => new Date(iso).toLocaleDateString("fr-FR", { day: "numeric", month: "short" });

interface LigneDemande {
  cle: string;
  type: string;
  objet: string;
  statut: string;
  carte: typeof HR_REQUEST_STATUS;
  etapes: Etape[];
  ou: string;
  href: string;
  le: string;
}

const PUCE: Record<Etape["etat"], { signe: string; ton: "success" | "info" | "neutral" | "danger" }> = {
  FAITE: { signe: "✓", ton: "success" }, EN_COURS: { signe: "●", ton: "info" }, A_VENIR: { signe: "○", ton: "neutral" }, REFUSEE: { signe: "✕", ton: "danger" },
};

/**
 * « MES DEMANDES » (interface du délégué, maquette VALIDÉE le 24/11/2026) — l'ENTRÉE et le SUIVI, « où en est ma
 * demande ». Le traitement se fait dans les modules d'origine, et chaque ligne y mène :
 *   • ordres de mission et notes de frais : « Mon dossier RH » (N+1, originaux au secrétariat, RH) ;
 *   • prises en charge pour un médecin : Ad & Pro › Prises en charge nationales (National Sales d'abord — DECISIONS).
 * Rien n'est dupliqué : on lit les demandes où elles vivent ; aucun nouveau type de note de frais (DECISIONS, 24/11).
 */
export default async function MesDemandesPage() {
  const user = await requireModule("MEDICAL");
  const aiguillage = await aiguillerVisite(user);
  if (aiguillage.destination !== "JOURNEE") redirect(aiguillage.chemin);

  const depuis = new Date(Date.now() - 180 * JOUR_MS);
  const peutPec = userCan(user, "CONGRESS_NATIONAL", "CREATE");
  const [rh, nationales, internationales, tabs] = await Promise.all([
    prisma.hrDocumentRequest.findMany({
      where: { employee: { userId: user.id }, type: { in: ["MISSION_ORDER", "EXPENSE_REPORT"] }, createdAt: { gte: depuis } },
      orderBy: { createdAt: "desc" },
      take: 30,
      select: {
        id: true, type: true, status: true, details: true, createdAt: true, expenseMonth: true, expenseAmount: true,
        periodStart: true, periodEnd: true, managerGate: true, managerDecidedAt: true, originalsAckAt: true, handledAt: true,
      },
    }),
    prisma.congressNational.findMany({
      where: { requesterId: user.id, createdAt: { gte: depuis } }, orderBy: { createdAt: "desc" }, take: 20,
      select: { id: true, name: true, requestStatus: true, createdAt: true },
    }),
    prisma.congressInternational.findMany({
      where: { requesterId: user.id, createdAt: { gte: depuis } }, orderBy: { createdAt: "desc" }, take: 20,
      select: { id: true, name: true, requestStatus: true, createdAt: true },
    }),
    visibleTabs(user, MEDICAL_TABS),
  ]);

  const lignes: LigneDemande[] = [
    ...rh.map((d): LigneDemande => {
      const om = d.type === "MISSION_ORDER";
      const periode = d.periodStart && d.periodEnd ? `du ${jour(d.periodStart.toISOString())} au ${jour(d.periodEnd.toISOString())}` : null;
      const frais = [d.expenseMonth, d.expenseAmount !== null ? formatCurrency(Number(d.expenseAmount)) : null].filter(Boolean).join(" · ");
      return {
        cle: `rh-${d.id}`, type: om ? "Ordre de mission" : "Note de frais",
        objet: [om ? periode : frais || null, d.details].filter(Boolean).join(" — ") || (om ? "Ordre de mission" : "Note de frais"),
        statut: d.status, carte: HR_REQUEST_STATUS,
        etapes: etapesDemandeRh({
          type: d.type as "MISSION_ORDER" | "EXPENSE_REPORT", status: d.status, createdAt: d.createdAt.toISOString(),
          managerGate: d.managerGate, managerDecidedAt: d.managerDecidedAt?.toISOString() ?? null,
          originalsAckAt: d.originalsAckAt?.toISOString() ?? null, handledAt: d.handledAt?.toISOString() ?? null,
        }),
        ou: "Traité dans Mon dossier RH", href: lienMaDemandeRh(d.id), le: d.createdAt.toISOString(),
      };
    }),
    ...nationales.map((c): LigneDemande => ({
      cle: `pn-${c.id}`, type: "Prise en charge (nationale)", objet: c.name, statut: c.requestStatus, carte: CONGRESS_REQUEST_STATUS,
      etapes: etapesPriseEnCharge(c.requestStatus, c.createdAt.toISOString()), ou: "Traité dans Ad & Pro", href: `/congress-national/${c.id}`, le: c.createdAt.toISOString(),
    })),
    ...internationales.map((c): LigneDemande => ({
      cle: `pi-${c.id}`, type: "Prise en charge (internationale)", objet: c.name, statut: c.requestStatus, carte: CONGRESS_REQUEST_STATUS,
      etapes: etapesPriseEnCharge(c.requestStatus, c.createdAt.toISOString()), ou: "Traité dans Ad & Pro", href: `/congress-international/${c.id}`, le: c.createdAt.toISOString(),
    })),
  ].sort((a, b) => b.le.localeCompare(a.le));

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <PageHeader title="Mes demandes">
        {/* L'ENTRÉE, là où la demande se dépose aujourd'hui : le formulaire de Mon dossier RH, celui d'Ad & Pro. */}
        <Link href={lienMaDemandeRh(null)} className="inline-flex h-10 items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 sm:h-9">
          <Plus className="h-4 w-4" aria-hidden /> Ordre de mission ou note de frais
        </Link>
        {peutPec && (
          <Link href="/congress-national" className="inline-flex h-10 items-center gap-1.5 rounded-md border border-input bg-card px-3 text-sm font-medium hover:bg-secondary sm:h-9">
            <Plus className="h-4 w-4" aria-hidden /> Prise en charge pour un médecin
          </Link>
        )}
      </PageHeader>
      <ModuleTabs tabs={tabs} />

      {lignes.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
          <p>Aucune demande ces six derniers mois.</p>
          <p className="mt-2 flex flex-wrap justify-center gap-3">
            <Link href={lienMaDemandeRh(null)} className="inline-flex items-center gap-1 font-medium text-primary hover:underline"><Plus className="h-4 w-4" aria-hidden /> Ordre de mission ou note de frais</Link>
            {peutPec && <Link href="/congress-national" className="inline-flex items-center gap-1 font-medium text-primary hover:underline"><Plus className="h-4 w-4" aria-hidden /> Prise en charge</Link>}
          </p>
        </div>
      ) : (
        <ul className="space-y-2.5">
          {lignes.map((d) => (
            <li key={d.cle}>
              <Link href={d.href} className="block space-y-2.5 rounded-xl border border-border bg-card px-3 py-3 hover:bg-secondary/40 sm:px-4">
                <span className="flex flex-wrap items-start justify-between gap-2">
                  <span className="min-w-0">
                    <span className="block text-xs text-muted-foreground">{d.type} · {jour(d.le)}</span>
                    <span className="block font-medium [overflow-wrap:anywhere]">{d.objet}</span>
                  </span>
                  <StatusBadge map={d.carte} value={d.statut} />
                </span>
                <span className="flex flex-wrap gap-1.5">
                  {d.etapes.map((e) => (
                    <Badge key={e.libelle} tone={PUCE[e.etat].ton} dot={false}>{PUCE[e.etat].signe} {e.libelle}{e.le && e.etat !== "EN_COURS" ? ` · ${jour(e.le)}` : ""}</Badge>
                  ))}
                </span>
                <span className="block text-xs text-muted-foreground">{d.ou}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
