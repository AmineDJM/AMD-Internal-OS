import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireUser } from "@/lib/session";
import { hasGlobalView, hasRole } from "@/lib/rbac";
import { canAccessEntity } from "@/lib/entity-access";
import { prisma } from "@/lib/prisma";
import { getCareDossier } from "@/lib/queries/care";
import { peutTeleverserBillet, personneVivante } from "@/lib/care-fiches";
import { PageHeader } from "@/components/shared/page-header";
import { BackLink } from "@/components/shared/back-link";
import { BilletsEmisPanel } from "@/components/care/billets-emis-panel";

/**
 * LA PAGE « BILLETS ET CONFIRMATIONS » D'UNE PRISE EN CHARGE (Direction, 10/2026) — par où l'assistante de
 * direction, qui réserve sans avoir le module des prises en charge, dépose les billets émis et les vouchers.
 * Le lien est écrit dans son sujet de réservation. Même porte que l'action (`peutTeleverserBillet`) : l'assistante,
 * le demandeur, la Direction Marketing (par sa fiche), le Super Admin et la Direction.
 */
export async function PageBilletsEmis({ scope, id }: { scope: "NATIONAL" | "INTERNATIONAL"; id: string }) {
  const user = await requireUser();
  const module = scope === "NATIONAL" ? "CONGRESS_NATIONAL" : "CONGRESS_INTERNATIONAL";
  const req = scope === "NATIONAL"
    ? await prisma.congressNational.findUnique({ where: { id }, select: { id: true, name: true, requesterId: true } })
    : await prisma.congressInternational.findUnique({ where: { id }, select: { id: true, name: true, requesterId: true } });
  if (!req) notFound();
  const autorise = peutTeleverserBillet(
    { id: user.id, roles: [user.role, user.secondaryRole].filter((r): r is NonNullable<typeof r> => Boolean(r)), vueGlobale: hasGlobalView(user) },
    { requesterId: req.requesterId },
  );
  const sansFiche = hasRole(user, "DIRECTION_ASSISTANT") || hasRole(user, "SUPER_ADMIN") || hasGlobalView(user) || req.requesterId === user.id;
  if (!autorise || (!sansFiche && !(await canAccessEntity(user, module, id, "VIEW")))) notFound();

  const care = await getCareDossier(scope, id);
  const lignes = care.beneficiaries
    .filter((b) => personneVivante(b.status))
    .map((b) => ({
      id: b.id, name: b.name,
      postes: b.cells.filter((c) => c.kind === "SERVICE" && (c.serviceKind === "TICKET" || c.serviceKind === "HOTEL") && c.status !== "WAIVED"),
    }))
    .filter((l) => l.postes.length > 0);
  const ficheVisible = hasGlobalView(user) || (await canAccessEntity(user, module, id, "VIEW"));
  const retour = ficheVisible ? `${scope === "NATIONAL" ? "/congress-national" : "/congress-international"}/${id}` : "/dossiers";

  return (
    <div className="space-y-5">
      <BackLink href={retour}><ArrowLeft className="h-4 w-4" /> {ficheVisible ? "La demande" : "Mes sujets"}</BackLink>
      <PageHeader title={`Billets et confirmations — ${req.name}`} description="L'e-billet ou le voucher de chaque personne, sa référence et ses horaires." />
      <BilletsEmisPanel lignes={lignes} />
    </div>
  );
}
