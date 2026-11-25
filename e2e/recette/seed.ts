import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BU, COMPTES, DEPARTEMENTS, MOT_DE_PASSE, P, SOCIETE, SOCIETE_FERMEE, emailDe, nomDe, type CleCompte, type CleDepartement } from "./comptes";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA GRAINE DE RECETTE — les comptes par métier et leur organigramme, rien de plus.
 *
 * Chaque parcours pose ensuite SES données (ordres, dossiers, demandes) par `donnees.ts`, toutes
 * préfixées : la graine ne fabrique pas un monde, elle installe les personnes qui vont le parcourir.
 *
 * GARDE-FOU PRODUCTION : la base doit être LOCALE (localhost / 127.0.0.1) — une recette joue de vrais
 * gestes (autoriser, payer, signer) ; contre la production, ils seraient vrais pour de bon.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export function urlBase(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL absente : la recette tourne sur une base locale dédiée (voir scripts/recette/lancer.sh).");
  const hote = new URL(url).hostname;
  if (!["localhost", "127.0.0.1", "::1"].includes(hote)) {
    throw new Error(`Recette refusée : la base ${hote} n'est pas locale. Elle ne se joue jamais contre la production.`);
  }
  return url;
}

export function prismaRecette(): PrismaClient {
  return new PrismaClient({ datasources: { db: { url: urlBase() } } });
}

/** Retire tout ce que la recette a posé (préfixe), dans l'ordre des clés. Tolérant : une table absente ne bloque pas. */
export async function nettoyerRecette(prisma: PrismaClient): Promise<void> {
  const users = await prisma.user.findMany({ where: { email: { startsWith: P } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  const societes = await prisma.company.findMany({ where: { name: { startsWith: P } }, select: { id: true } });
  const socIds = societes.map((s) => s.id);
  const ordres = await prisma.expenseOrder.findMany({
    where: { OR: [{ label: { startsWith: P } }, { companyId: { in: socIds } }, { requestedById: { in: ids } }] }, select: { id: true },
  });
  const ordreIds = ordres.map((o) => o.id);
  const sans = async (p: Promise<unknown>) => { await p.catch(() => undefined); };
  await sans(prisma.paymentCentreMessage.deleteMany({ where: { orderId: { in: ordreIds } } }));
  // Les pièces du registre posées par la recette (BC signés des ordres de test) : avant les ordres qu'elles citent.
  await sans(prisma.legalDocument.deleteMany({ where: { OR: [{ reference: { startsWith: P } }, { expenseOrderId: { in: ordreIds } }] } }));
  await sans(prisma.paymentRequest.deleteMany({ where: { OR: [{ expenseOrderId: { in: ordreIds } }, { title: { startsWith: P } }] } }));
  await sans(prisma.pettyCashAllotment.deleteMany({ where: { expenseOrderId: { in: ordreIds } } }));
  await sans(prisma.expenseOrder.deleteMany({ where: { id: { in: ordreIds } } }));
  await sans(prisma.financeTransaction.deleteMany({ where: { OR: [{ label: { startsWith: P } }, { companyId: { in: socIds } }] } }));
  await sans(prisma.financeTransaction.deleteMany({ where: { treasuryAccount: { name: { startsWith: P } } } }));
  await sans(prisma.treasuryAccount.deleteMany({ where: { name: { startsWith: P } } }));
  await sans(prisma.budgetCategoryLine.deleteMany({ where: { envelope: { name: { startsWith: P } } } }));
  await sans(prisma.budgetEnvelope.deleteMany({ where: { name: { startsWith: P } } }));
  await sans(prisma.validationRequest.deleteMany({ where: { OR: [{ title: { startsWith: P } }, { requesterId: { in: ids } }] } }));
  await sans(prisma.paymentCentreSeat.deleteMany({ where: { userId: { in: ids } } }));
  await sans(prisma.salesRepProfile.deleteMany({ where: { repId: { in: ids } } }));
  await sans(prisma.promoMessage.deleteMany({ where: { title: { startsWith: P } } }));
  await sans(prisma.promoProduct.deleteMany({ where: { name: { startsWith: P } } }));
  await sans(prisma.medicalVisit.deleteMany({ where: { OR: [{ report: { startsWith: P } }, { doctor: { name: { startsWith: P } } }] } }));
  await sans(prisma.medicalDoctor.deleteMany({ where: { name: { startsWith: P } } }));
  await sans(prisma.product.deleteMany({ where: { code: { startsWith: P } } }));
  await sans(prisma.congressNational.deleteMany({ where: { name: { startsWith: P } } }));
  await sans(prisma.businessUnit.deleteMany({ where: { name: { startsWith: P } } }));
  await sans(prisma.notification.deleteMany({ where: { userId: { in: ids } } }));
  await sans(prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } }));
  await sans(prisma.userAccess.deleteMany({ where: { userId: { in: ids } } }));
  await sans(prisma.userCompanyAccess.deleteMany({ where: { userId: { in: ids } } }));
  await sans(prisma.driveNode.deleteMany({ where: { name: { startsWith: P } } }));
  // L'organigramme : on décroche les responsables avant de retirer salariés et départements.
  await sans(prisma.department.updateMany({ where: { name: { startsWith: P } }, data: { headId: null, deputyId: null } }));
  await sans(prisma.employee.updateMany({ where: { fullName: { startsWith: P } }, data: { managerId: null } }));
  await sans(prisma.employee.deleteMany({ where: { OR: [{ fullName: { startsWith: P } }, { userId: { in: ids } }] } }));
  await sans(prisma.user.updateMany({ where: { id: { in: ids } }, data: { departmentId: null } }));
  const depts = await prisma.department.findMany({ where: { name: { startsWith: P } }, select: { id: true } });
  const deptIds = depts.map((d) => d.id);
  // Le service des moyens généraux est un réglage GLOBAL : on ne le décroche que s'il pointe sur un département de recette.
  await sans(prisma.appSetting.updateMany({ where: { generalMeansDepartmentId: { in: deptIds } }, data: { generalMeansDepartmentId: null } }));
  await sans(prisma.pettyCashAllotment.deleteMany({ where: { departmentId: { in: deptIds } } }));
  await sans(prisma.department.deleteMany({ where: { id: { in: deptIds } } }));
  const produits = (await prisma.regulatoryProduct.findMany({ where: { dci: { startsWith: P } }, select: { id: true } }).catch(() => [])).map((p) => p.id);
  await sans(prisma.document.deleteMany({ where: { entityId: { in: produits } } }));
  await sans(prisma.regulatoryProduct.deleteMany({ where: { id: { in: produits } } }));
  await sans(prisma.user.deleteMany({ where: { id: { in: ids } } }));
  await sans(prisma.company.deleteMany({ where: { id: { in: socIds } } }));
}

/** Les identifiants posés, relus par les parcours (évite de refaire les requêtes à chaque spec). */
export interface GraineRecette {
  societeId: string;
  societeFermeeId: string;
  comptes: Record<CleCompte, string>;
  departements: Record<CleDepartement, string>;
  buId: string;
}

export const FICHIER_GRAINE = (): string => path.join(process.env.RECETTE_SORTIE ?? "recette-sortie", "graine.json");

export default async function seedRecette(): Promise<void> {
  const prisma = prismaRecette();
  try {
    await nettoyerRecette(prisma);
    const hash = await bcrypt.hash(MOT_DE_PASSE, 10);

    const societeId = (await prisma.company.create({ data: { name: SOCIETE.nom, shortName: SOCIETE.court, sortOrder: 9101 } })).id;
    const societeFermeeId = (await prisma.company.create({ data: { name: SOCIETE_FERMEE.nom, shortName: SOCIETE_FERMEE.court, sortOrder: 9102 } })).id;

    const departements = {} as Record<CleDepartement, string>;
    for (const [cle, d] of Object.entries(DEPARTEMENTS) as [CleDepartement, { nom: string; code: string }][]) {
      departements[cle] = (await prisma.department.create({ data: { name: d.nom, code: d.code, companyId: societeId } })).id;
    }

    const comptes = {} as Record<CleCompte, string>;
    const salaries = {} as Record<CleCompte, string>;
    for (const [cle, p] of Object.entries(COMPTES) as [CleCompte, (typeof COMPTES)[CleCompte]][]) {
      const user = await prisma.user.create({
        data: {
          email: emailDe(cle), name: nomDe(cle), passwordHash: hash, role: p.role as never,
          departmentId: departements[p.departement], mustChangePassword: false, mustOnboard: false,
        },
      });
      comptes[cle] = user.id;
      salaries[cle] = (await prisma.employee.create({
        data: { fullName: nomDe(cle), userId: user.id, companyId: societeId, departmentId: departements[p.departement], position: p.metier, email: emailDe(cle) },
      })).id;
      // Toutes les personnes travaillent pour la société de test ; seule la Direction voit la seconde (rôle global).
      await prisma.userCompanyAccess.create({ data: { userId: user.id, companyId: societeId, canEdit: true } });
      for (const a of p.acces ?? []) {
        await prisma.userAccess.create({
          data: {
            userId: user.id, module: a.module, canView: true, canCreate: Boolean(a.creer), canUpdate: Boolean(a.modifier),
            canValidate: Boolean(a.valider), canUpload: Boolean(a.deposer), scope: "ALL",
          },
        });
      }
    }

    // L'ORGANIGRAMME : le N+1 de chacun, et le responsable de chaque département.
    for (const [cle, p] of Object.entries(COMPTES) as [CleCompte, (typeof COMPTES)[CleCompte]][]) {
      if (p.superieur) await prisma.employee.update({ where: { id: salaries[cle] }, data: { managerId: salaries[p.superieur] } });
      if (p.responsable) await prisma.department.update({ where: { id: departements[p.departement] }, data: { headId: salaries[cle] } });
    }

    // LA FORCE DE VENTE : une BU supervisée par le superviseur ; le KAM y est rattaché (le délégué, lui, ne l'est pas).
    const buId = (await prisma.businessUnit.create({
      data: { name: BU.nom, code: BU.code, companyId: societeId, supervisorId: comptes.superviseur, departmentId: departements.OPERATIONS },
    })).id;
    // Délégué et KAM ont la même gamme (la BU) : sans gamme, le compte rendu n'a aucun produit à présenter.
    await prisma.salesRepProfile.create({ data: { repId: comptes.kam, businessUnitId: buId, region: "Centre" } });
    await prisma.salesRepProfile.create({ data: { repId: comptes.delegue, businessUnitId: buId, region: "Ouest" } });

    // LES MOYENS GÉNÉRAUX : le service de la caisse d'avance — seulement si la base n'en a pas déjà un (base dédiée).
    const reglage = await prisma.appSetting.findUnique({ where: { id: "global" }, select: { generalMeansDepartmentId: true } });
    if (!reglage?.generalMeansDepartmentId) {
      await prisma.appSetting.upsert({
        where: { id: "global" },
        create: { id: "global", generalMeansDepartmentId: departements.MOYENS_GENERAUX },
        update: { generalMeansDepartmentId: departements.MOYENS_GENERAUX },
      });
    }

    const graine: GraineRecette = { societeId, societeFermeeId, comptes, departements, buId };
    mkdirSync(path.dirname(FICHIER_GRAINE()), { recursive: true });
    writeFileSync(FICHIER_GRAINE(), JSON.stringify(graine, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}
