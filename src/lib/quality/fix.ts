/**
 * LES CORRECTEURS — la liste FERMÉE de ce que le moteur sait modifier (mandat 4 §23).
 *
 * Un correcteur relit la valeur COURANTE, refuse si elle n'est plus celle du constat (quelqu'un
 * est passé entre-temps), écrit l'après, et dépose l'avant / l'après dans l'audit avec le nom de
 * qui l'a demandé (« le moteur » pour une correction AUTO). Un champ absent d'ici n'est
 * corrigeable ni par le moteur, ni par un clic : c'est la structure qui interdit, pas une consigne.
 */

import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import type { EntityType } from "@prisma/client";
import type { Constat, Correction } from "@/lib/quality/model";

export interface IssueCorrection { ok: boolean; message: string; avant?: string | null; apres?: string | null }

type Correcteur = (c: Correction) => Promise<{ courant: string | null; ecrire: () => Promise<void>; entityType: EntityType | null }>;

const CORRECTEURS: Record<string, Correcteur> = {
  "Employee.email": async (c) => {
    const row = await prisma.employee.findUnique({ where: { id: c.entiteId }, select: { email: true } });
    return { courant: row?.email ?? null, entityType: "EMPLOYEE", ecrire: async () => { await prisma.employee.update({ where: { id: c.entiteId }, data: { email: c.apres } }); } };
  },
  "Supplier.contactEmail": async (c) => {
    const row = await prisma.supplier.findUnique({ where: { id: c.entiteId }, select: { contactEmail: true } });
    return { courant: row?.contactEmail ?? null, entityType: "SUPPLIER", ecrire: async () => { await prisma.supplier.update({ where: { id: c.entiteId }, data: { contactEmail: c.apres } }); } };
  },
  "MedicalDoctor.email": async (c) => {
    const row = await prisma.medicalDoctor.findUnique({ where: { id: c.entiteId }, select: { email: true } });
    return { courant: row?.email ?? null, entityType: "DOCTOR", ecrire: async () => { await prisma.medicalDoctor.update({ where: { id: c.entiteId }, data: { email: c.apres } }); } };
  },
  "User.email": async (c) => {
    const row = await prisma.user.findUnique({ where: { id: c.entiteId }, select: { email: true } });
    return { courant: row?.email ?? null, entityType: null, ecrire: async () => { await prisma.user.update({ where: { id: c.entiteId }, data: { email: c.apres ?? undefined } }); } };
  },
  "LegalDocument.status": async (c) => {
    const row = await prisma.legalDocument.findUnique({ where: { id: c.entiteId }, select: { status: true } });
    if (c.apres !== "EXPIRED") throw new Error("seul le passage en EXPIRÉ est un correcteur connu");
    return { courant: row?.status ?? null, entityType: "LEGAL_DOCUMENT", ecrire: async () => { await prisma.legalDocument.update({ where: { id: c.entiteId }, data: { status: "EXPIRED" } }); } };
  },
  "User.isActive": async (c) => {
    const row = await prisma.user.findUnique({ where: { id: c.entiteId }, select: { isActive: true } });
    if (c.apres !== "false") throw new Error("le moteur ne réactive jamais un compte");
    // Désactiver = fermer aussi les sessions ouvertes : le jeton change de version.
    return { courant: row ? String(row.isActive) : null, entityType: null, ecrire: async () => { await prisma.user.update({ where: { id: c.entiteId }, data: { isActive: false, tokenVersion: { increment: 1 } } }); } };
  },
  "User.departmentId": async (c) => {
    const row = await prisma.user.findUnique({ where: { id: c.entiteId }, select: { departmentId: true } });
    return { courant: row?.departmentId ?? null, entityType: null, ecrire: async () => { await prisma.user.update({ where: { id: c.entiteId }, data: { departmentId: c.apres } }); } };
  },
};

export async function appliquerCorrection(
  constat: Pick<Constat, "regle" | "module" | "titre" | "correction">,
  opts: { acteurId: string | null; acteurNom?: string | null },
): Promise<IssueCorrection> {
  const c = constat.correction;
  if (!c) return { ok: false, message: "Ce constat n'a pas de correction formulée : c'est une décision, pas un clic." };
  const correcteur = CORRECTEURS[`${c.entite}.${c.champ}`];
  if (!correcteur) return { ok: false, message: `Aucun correcteur pour ${c.entite}.${c.champ} : le moteur ne modifie que ce qu'il sait défaire.` };
  try {
    const { courant, ecrire, entityType } = await correcteur(c);
    if (courant === null && c.avant !== null) return { ok: false, message: "La ligne n'existe plus." };
    if ((courant ?? null) !== (c.avant ?? null)) {
      return { ok: false, message: `La valeur a changé depuis le constat (« ${courant ?? "—"} » au lieu de « ${c.avant ?? "—"} ») : rien n'a été modifié.`, avant: courant };
    }
    await ecrire();
    await recordAudit({
      actorId: opts.acteurId, action: "UPDATE", module: constat.module,
      entityType: entityType ?? undefined, entityId: c.entiteId, field: c.champ, oldValue: c.avant, newValue: c.apres,
      summary: `Qualité des données — ${constat.regle} : ${c.description} (${opts.acteurId ? (opts.acteurNom ?? "personne") : "correction automatique du moteur"})`,
    });
    return { ok: true, message: `Corrigé : ${c.description}`, avant: c.avant, apres: c.apres };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Échec de la correction." };
  }
}
