import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { refusAdministration } from "@/lib/admin/garde-comptes";
import { estPrete, type EffectiveAccess } from "@/lib/rbac";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * QUAND UNE FICHE SALARIÉ PASSE INACTIVE, SON COMPTE SUIT (§118.184 — audit 360°, S13).
 *
 * Mesuré par l'audit : désactiver un salarié ne touchait qu'à sa fiche RH. Son compte applicatif restait
 * ouvert — une personne partie gardait l'ERP, ses sessions en cours et tout ce que ses droits lui ouvrent,
 * jusqu'à ce que quelqu'un pense, un jour, à passer aussi par l'Administration. Deux registres pour un
 * seul fait (« cette personne ne travaille plus ici ») divergent toujours, et c'est le plus permissif qui
 * reste vrai (§118.5).
 *
 * Quatre limites, et chacune a sa raison :
 *
 *   • SEUL UN SUPER ADMIN TOUCHE UN SUPER ADMIN (§118.184, S9) : une fiche RH désactivée par la RH ne
 *     ferme pas le compte d'un Super Admin — sinon la RH verrouillerait l'administration de la plateforme.
 *     La fiche est désactivée ; le compte reste actif, et la phrase le DIT avec le geste qui le ferme.
 *   • ON NE SE FERME PAS SOI-MÊME par une fiche : l'Administration le refuse déjà (« Action invalide »).
 *   • LA RÉACTIVATION NE ROUVRE RIEN : rouvrir un accès est une décision d'administration — le compte a pu
 *     être fermé pour une autre raison. La phrase le dit, avec l'écran où le rouvrir.
 *   • UN INTÉRIM NE FERME PAS DE COMPTE (§118.196, lot E4 — audit 360°, M13) : l'intérimaire de quelqu'un
 *     qui tient les RH reçoit leur métier (la fiche se désactive), pas le pouvoir de retirer un accès —
 *     fermer un compte est un geste de DROITS, et il survivrait au retour du titulaire (`estPrete`). Le
 *     compte reste actif, et la phrase nomme qui le fermera.
 *
 * Rend la phrase à montrer (ou `null` quand il n'y a rien à dire).
 */
export async function compteSuitLaFiche(
  acteur: { id: string; role: string; access: EffectiveAccess },
  fiche: { userId: string | null; fullName: string },
  active: boolean,
): Promise<string | null> {
  if (!fiche.userId) return null;
  const compte = await prisma.user.findUnique({ where: { id: fiche.userId }, select: { id: true, role: true, isActive: true } });
  if (!compte) return null;
  if (active) {
    return compte.isActive ? null : `Le compte applicatif de ${fiche.fullName} reste désactivé : sa réouverture se décide dans Administration › Comptes.`;
  }
  if (!compte.isActive) return null;
  if (compte.id === acteur.id) return "Votre propre compte applicatif reste actif : on ne se ferme pas soi-même par une fiche.";
  if (refusAdministration(acteur, compte, "COMPTE")) {
    return `Le compte applicatif de ${fiche.fullName} (Super Admin) reste actif : seul un Super Admin le ferme, depuis Administration › Comptes.`;
  }
  // UN INTÉRIM NE FERME PAS DE COMPTE : un droit RH prêté désactive la fiche (le métier), pas l'accès.
  if (estPrete(acteur, "RH", "UPDATE")) {
    return `Le compte applicatif de ${fiche.fullName} reste actif : vous tenez les ressources humaines par intérim, et un intérim ne ferme pas de compte — les RH en titre (ou Administration › Comptes) le fermeront.`;
  }
  await prisma.user.update({ where: { id: compte.id }, data: { isActive: false } });
  await prisma.userSession.updateMany({ where: { userId: compte.id, revokedAt: null }, data: { revokedAt: new Date() } });
  await recordAudit({
    actorId: acteur.id, action: "UPDATE", module: "Administration", entityId: compte.id,
    field: "isActive", newValue: "false",
    summary: `Désactivation du compte — la fiche salarié de ${fiche.fullName} a été désactivée`,
  });
  return `Le compte applicatif de ${fiche.fullName} est fermé et ses sessions déconnectées.`;
}
