import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/notify";
import { sansBloquer } from "@/lib/journal";
import { getAccess } from "@/lib/rbac";
import { compteSuitLaFiche } from "./depart";
import { departEchu, SOURCE_COMPTE } from "../domaine/depart/regles";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE LENDEMAIN DU DERNIER JOUR, LA FICHE ET LE COMPTE SE FERMENT SEULS (lot rhdepart).
 *
 * Une fin de contrat validée porte sa date ; le planificateur (`rh.departs-echus`) la relit à chaque passage et, le
 * lendemain du dernier jour travaillé (minuit à Alger), désactive la fiche — et le compte suit, par la règle commune
 * `compteSuitLaFiche` (§118.184) : sessions déconnectées, un Super Admin jamais fermé par ce chemin, et la phrase qui le
 * dit. Le geste est fait AU NOM de qui a donné l'accord final (la Direction générale), relu avec ses droits du jour.
 *
 * La prise est conditionnelle (`compteFermeLe` encore vide) : deux passages simultanés ne ferment qu'une fois.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Ferme une fin de contrat si son jour est passé. Rend la phrase dite (ou `null` : pas encore, ou déjà fait). */
export async function fermerSiEchu(departId: string, maintenant = new Date()): Promise<string | null> {
  const d = await prisma.departSalarie.findUnique({
    where: { id: departId },
    select: {
      id: true, statut: true, dateFin: true, compteFermeLe: true, ouvertParId: true, validationRequestId: true, employeeId: true,
      employee: { select: { fullName: true, userId: true, isActive: true } },
    },
  });
  if (!d || d.statut !== "VALIDE" || d.compteFermeLe || !departEchu(d.dateFin, maintenant)) return null;
  const pris = await prisma.departSalarie.updateMany({ where: { id: d.id, statut: "VALIDE", compteFermeLe: null }, data: { compteFermeLe: maintenant } });
  if (pris.count === 0) return null;

  // L'AUTEUR DU GESTE : qui a donné l'accord final (la dernière marche tranchée), sinon la RH qui a ouvert.
  const derniere = d.validationRequestId
    ? await prisma.validationStep.findFirst({ where: { requestId: d.validationRequestId, status: "APPROVED" }, orderBy: { order: "desc" }, select: { validatorId: true } })
    : null;
  const auteurId = derniere?.validatorId ?? d.ouvertParId;
  const auteur = await prisma.user.findUnique({ where: { id: auteurId }, select: { id: true, role: true } });

  await prisma.employee.updateMany({ where: { id: d.employeeId, isActive: true }, data: { isActive: false } });
  const phrase = auteur
    ? await compteSuitLaFiche({ id: auteur.id, role: String(auteur.role), access: await getAccess(auteur.id, auteur.role) }, d.employee, false)
    : null;
  await prisma.departSalarieTache.updateMany({ where: { departId: d.id, source: SOURCE_COMPTE, faitLe: null }, data: { faitLe: maintenant, faitParId: auteurId, detail: phrase } });
  await recordAudit({
    actorId: auteurId, action: "UPDATE", module: "Ressources humaines", entityType: "EMPLOYEE", entityId: d.employeeId,
    field: "isActive", newValue: "false", summary: `Fin de contrat échue — fiche de ${d.employee.fullName} désactivée${phrase ? ` ; ${phrase}` : ""}`,
  });
  await notifyUser({
    userId: d.ouvertParId, type: "GENERIC", title: `Départ de ${d.employee.fullName} : fiche fermée`,
    body: phrase ?? "La fiche est désactivée (aucun compte applicatif à fermer).", link: `/rh/${d.employeeId}#depart`,
  }).catch(sansBloquer("depart-cloture.fermerSiEchu.notifyUser"));
  return phrase ?? "Fiche désactivée.";
}

/** Le passage du planificateur : toutes les fins de contrat validées dont le jour est passé. */
export async function fermerLesDepartsEchus(maintenant = new Date()): Promise<number> {
  const candidates = await prisma.departSalarie.findMany({
    where: { statut: "VALIDE", compteFermeLe: null, dateFin: { lte: maintenant } }, select: { id: true }, take: 50,
  });
  let n = 0;
  for (const c of candidates) {
    if (await fermerSiEchu(c.id, maintenant).catch(sansBloquer("depart-cloture.fermerLesDepartsEchus", null))) n++;
  }
  return n;
}
