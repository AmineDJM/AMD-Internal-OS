import { prisma } from "@/lib/prisma";
import { clausePanelDuKam, userCan, type SessionUser } from "@/lib/rbac";
import { cheminDeDestination, destinationVisite, type Destination, type FaitsAiguillage } from "@/lib/sfe/aiguillage-visite";

/**
 * LES FAITS DE L'AIGUILLAGE « VISITE MÉDICALE » — lus ici, jugés par le module pur
 * (`sfe/aiguillage-visite.ts`). Deux lectures au plus : le rattachement KAM et les BU supervisées
 * ensemble, puis — seulement quand rien d'autre ne l'a dit — le panel.
 */
export async function aiguillerVisite(user: SessionUser): Promise<{ destination: Destination; chemin: string }> {
  const [profil, bus] = await Promise.all([
    prisma.salesRepProfile.findUnique({ where: { repId: user.id }, select: { id: true } }),
    prisma.businessUnit.findMany({
      where: { isActive: true, OR: [{ supervisorId: user.id }, { headId: user.id }] },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: { id: true },
    }),
  ]);
  const base: FaitsAiguillage = {
    roles: [user.role, user.secondaryRole].filter((r): r is NonNullable<typeof r> => Boolean(r)),
    peutSaisir: userCan(user, "MEDICAL", "CREATE"),
    estKam: Boolean(profil),
    aUnPanel: false,
    busSupervisees: bus.map((b) => b.id),
    voitCockpit: userCan(user, "COCKPIT_OPERATIONS", "VIEW"),
    voitForceDeVente: userCan(user, "SALES_PLANNING", "VIEW"),
  };
  // LE PANEL N'EST LU QUE S'IL PEUT CHANGER LA RÉPONSE : un saisisseur que rien d'autre ne désigne déjà.
  let faits = base;
  const sansPanel = destinationVisite(base);
  if (sansPanel !== "JOURNEE" && sansPanel !== "COCKPIT" && base.peutSaisir) {
    const un = await prisma.medicalDoctor.findFirst({ where: clausePanelDuKam(user.id), select: { id: true } });
    faits = { ...base, aUnPanel: Boolean(un) };
  }
  const destination = destinationVisite(faits);
  return { destination, chemin: cheminDeDestination(destination, faits.busSupervisees) };
}
