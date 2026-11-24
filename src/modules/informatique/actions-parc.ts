"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { getMyCompanies } from "@/lib/company";
import { actionReversible } from "@/lib/effets/reversible";
import { fdStr, type ActionResult } from "@/lib/actions/types";
import { LIBELLE_TYPE_MATERIEL, estEtatMateriel, estTypeMateriel, lireDate } from "@/modules/informatique/api";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE PARC INFORMATIQUE (24/11/2026) — enregistrer un matériel, le modifier (affectation, garantie, état).
 *
 * DROITS : la clé « Parc informatique » (`INFORMATIQUE_PARC`) — créer, modifier ; par défaut le Super Admin et le responsable
 * du département Informatique. Le matériel, la personne ou le département affectés appartiennent à une société permise.
 * Saisie réelle, rien de préchargé. RÉVERSIBLE : déclarations `metiers.ts`.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const PATH = "/informatique/parc";
const MODULE_AUDIT = "Informatique";

async function societePermise(userId: string, companyId: string): Promise<boolean> {
  return (await getMyCompanies(userId)).some((c) => c.id === companyId);
}

/** L'affectation : une personne OU un département, de la même société que le matériel (sinon le remède est dit). */
async function affectationValide(companyId: string, employeeId: string | null | undefined, departmentId: string | null | undefined): Promise<string | null> {
  if (employeeId) {
    const e = await prisma.employee.findUnique({ where: { id: employeeId }, select: { companyId: true } });
    if (!e) return "La personne choisie est introuvable dans l'organigramme.";
    if (e.companyId && e.companyId !== companyId) return "La personne choisie appartient à une autre société que le matériel.";
  }
  if (departmentId) {
    const d = await prisma.department.findUnique({ where: { id: departmentId }, select: { companyId: true } });
    if (!d) return "Le département choisi est introuvable.";
    if (d.companyId && d.companyId !== companyId) return "Le département choisi appartient à une autre société que le matériel.";
  }
  return null;
}

function lireChamps(formData: FormData, creation: boolean) {
  const data: Record<string, unknown> = {};
  const type = fdStr(formData, "type");
  if (creation && !type) return { erreur: "Le type est obligatoire (ordinateur portable, écran…)." } as const;
  if (type && !estTypeMateriel(type)) return { erreur: `Type « ${type} » inconnu.` } as const;
  if (type) data.type = type;
  const reference = fdStr(formData, "reference");
  if (creation && !reference) return { erreur: "La référence est obligatoire : marque et modèle." } as const;
  if (reference) data.reference = reference.slice(0, 200);
  const etat = fdStr(formData, "etat");
  if (etat && !estEtatMateriel(etat)) return { erreur: `État « ${etat} » inconnu.` } as const;
  if (etat) data.etat = etat;
  if (formData.has("dateAchat")) {
    const d = lireDate(fdStr(formData, "dateAchat"));
    if (d === "illisible") return { erreur: "La date d'achat est illisible (attendu : AAAA-MM-JJ)." } as const;
    data.dateAchat = d;
  }
  if (formData.has("finGarantie")) {
    const d = lireDate(fdStr(formData, "finGarantie"));
    if (d === "illisible") return { erreur: "La fin de garantie est illisible (attendu : AAAA-MM-JJ)." } as const;
    data.finGarantie = d;
  }
  if (data.dateAchat instanceof Date && data.finGarantie instanceof Date && data.finGarantie < data.dateAchat) {
    return { erreur: "La fin de garantie précède la date d'achat." } as const;
  }
  if (formData.has("numeroSerie")) data.numeroSerie = fdStr(formData, "numeroSerie");
  if (formData.has("notes")) data.notes = fdStr(formData, "notes");
  if (formData.has("employeeId")) data.employeeId = fdStr(formData, "employeeId");
  if (formData.has("departmentId")) data.departmentId = fdStr(formData, "departmentId");
  return { data } as const;
}

export async function creerMateriel(formData: FormData): Promise<ActionResult> {
  return actionReversible("informatique-parc-actions:creerMateriel", "Matériel enregistré", async () => {
    const user = await requireUser();
    if (!userCan(user, "INFORMATIQUE_PARC", "CREATE")) return { ok: false, error: "Non autorisé : enregistrer un matériel demande le droit de créer dans « Parc informatique »." };
    const companyId = fdStr(formData, "companyId");
    if (!companyId) return { ok: false, error: "Choisissez la société propriétaire du matériel." };
    if (!(await societePermise(user.id, companyId))) return { ok: false, error: "Cette société ne vous est pas ouverte : choisissez l'une des vôtres." };
    const lu = lireChamps(formData, true);
    if ("erreur" in lu) return { ok: false, error: lu.erreur };
    const refus = await affectationValide(companyId, lu.data.employeeId as string | null, lu.data.departmentId as string | null);
    if (refus) return { ok: false, error: refus };
    const cree = await prisma.materielInformatique.create({
      data: { ...(lu.data as object), companyId, type: lu.data.type as string, reference: lu.data.reference as string, createdById: user.id },
      select: { id: true, type: true, reference: true },
    });
    const libelle = `${LIBELLE_TYPE_MATERIEL[cree.type as keyof typeof LIBELLE_TYPE_MATERIEL] ?? cree.type} « ${cree.reference} »`;
    await recordAudit({ actorId: user.id, action: "CREATE", module: MODULE_AUDIT, entityId: cree.id, summary: `${libelle} enregistré au parc` });
    revalidatePath(PATH);
    return { ok: true, id: cree.id, message: `${libelle} enregistré.` };
  });
}

export async function modifierMateriel(formData: FormData): Promise<ActionResult> {
  return actionReversible("informatique-parc-actions:modifierMateriel", "Matériel modifié", async () => {
    const user = await requireUser();
    if (!userCan(user, "INFORMATIQUE_PARC", "UPDATE")) return { ok: false, error: "Non autorisé : modifier un matériel demande le droit de modifier « Parc informatique »." };
    const id = fdStr(formData, "id");
    const avant = id ? await prisma.materielInformatique.findUnique({ where: { id }, select: { id: true, companyId: true, reference: true, employeeId: true, departmentId: true } }) : null;
    if (!avant || !(await societePermise(user.id, avant.companyId))) return { ok: false, error: "Matériel introuvable." };
    const lu = lireChamps(formData, false);
    if ("erreur" in lu) return { ok: false, error: lu.erreur };
    if (!Object.keys(lu.data).length) return { ok: false, error: "Aucun champ à modifier." };
    const refus = await affectationValide(avant.companyId, lu.data.employeeId as string | null | undefined, lu.data.departmentId as string | null | undefined);
    if (refus) return { ok: false, error: refus };
    await prisma.materielInformatique.update({ where: { id: avant.id }, data: lu.data as object });
    await recordAudit({ actorId: user.id, action: "UPDATE", module: MODULE_AUDIT, entityId: avant.id, summary: `Matériel « ${avant.reference} » modifié (${Object.keys(lu.data).join(", ")})` });
    revalidatePath(PATH);
    return { ok: true, id: avant.id, message: "Matériel mis à jour." };
  });
}
