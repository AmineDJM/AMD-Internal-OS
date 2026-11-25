import Link from "next/link";
import { redirect } from "next/navigation";
import { AlertTriangle, Trash2 } from "lucide-react";
import { requireModule } from "@/lib/session";
import { userCan, hasGlobalView } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { lignesDuBureau } from "@/lib/queries/bureau";
import { MenuDossier } from "@/components/shared/menu-dossier";
import { toNumber } from "@/lib/utils";
import { NewRequestButton } from "./new-request";
import { SuppliesManager } from "./supplies-manager";
import { TableauBureau } from "./tableau-bureau";

/**
 * LE BUREAU DU SECRÉTARIAT — UN SEUL TABLEAU (maquette validée le 24/11/2026).
 *
 * Toutes les familles de demandes en une liste (`lignesDuBureau`) : demandes du secrétariat, fiches billet et hôtel,
 * matériel promotionnel, devis et achats de prise en charge. Les postes agence et les BC de poste n'y sont plus : ils vivent
 * sur « Prospection d'agences », module à part (Super Admin, 25/11/2026). En tête : le titre,
 * « + Nouvelle demande », et « ⋯ » (catalogue fournitures, corbeille — pour qui gère le bureau). Plus d'onglets, de
 * tuiles, de filtres ni de phrase d'explication : chaque ligne ouvre SA fiche.
 *
 * Les anciens liens de l'onglet « Ad & Pro » (`?onglet=adpro&fiche=<id>`, écrits en base par les notifications)
 * mènent à la page de la fiche.
 */
export default async function DemandesPage(props: { searchParams: Promise<{ onglet?: string; fiche?: string }> }) {
  const searchParams = await props.searchParams;
  const user = await requireModule("ADMIN_REQUESTS");
  if (searchParams.fiche) redirect(`/demandes/fiches/${encodeURIComponent(searchParams.fiche)}`);
  const isManager = hasGlobalView(user.role) || userCan(user, "ADMIN_REQUESTS", "UPDATE");

  const [bureau, users, departments, activeArticles, supplyCatalog] = await Promise.all([
    lignesDuBureau(user),
    prisma.user.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.department.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
    prisma.officeSupplyArticle.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    isManager
      ? prisma.officeSupplyArticle.findMany({ select: { id: true, name: true, category: true, unit: true, reference: true, estimatedPrice: true, supplierHint: true, active: true, notes: true }, orderBy: [{ active: "desc" }, { name: "asc" }] })
      : Promise.resolve([] as { id: string; name: string; category: string | null; unit: string | null; reference: string | null; estimatedPrice: unknown; supplierHint: string | null; active: boolean; notes: string | null }[]),
  ]);
  const catalogRows = supplyCatalog.map((a) => ({ ...a, estimatedPrice: a.estimatedPrice != null ? toNumber(a.estimatedPrice) : null }));

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Bureau du secrétariat</h1>
        <div className="flex items-center gap-2">
          <NewRequestButton users={users} departments={departments} articles={activeArticles} />
          {isManager && (
            <MenuDossier>
              <SuppliesManager articles={catalogRows} />
              <Link href="/demandes/corbeille" className="inline-flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-secondary">
                <Trash2 className="h-4 w-4" /> Corbeille des demandes
              </Link>
            </MenuDossier>
          )}
        </div>
      </header>

      {bureau.pannes.length > 0 && (
        <p role="status" className="flex items-start gap-2 rounded-xl bg-warning/10 px-3 py-2 text-sm text-warning-foreground">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Une partie du bureau n&apos;a pas pu être lue : {bureau.pannes.join(", ")}. Le reste est à jour ; rechargez la page dans un
            instant, et prévenez le Super Admin si cela persiste.
          </span>
        </p>
      )}

      <TableauBureau lignes={bureau.lignes} maintenant={Date.now()} />
    </div>
  );
}
