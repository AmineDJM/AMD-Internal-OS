import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR, getCurrentUser: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { getAccess, hasGlobalView, userCan, type SessionUser } from "@/lib/rbac";
import { platformScope } from "@/lib/company";
import { peutEcrireMessagesPromo } from "@/lib/sfe/tournee";
import { peutEcrireMessagesCockpit } from "@/lib/marketing-cockpit/acces";
import { DEFAULT_APP_SETTINGS } from "@/lib/settings";
import { getActionCenter } from "@/lib/queries/action-center";
import { accesAuxPiecesLegalDetaille, canAccessEntity } from "@/lib/entity-access";
import { chargerPiecesLiees } from "@/lib/queries/chaine-des-pieces";
import { ensureInstance } from "@/lib/workflow/engine";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA DIRECTION MARKETING TRANCHE — elle doit voir ce qui l'attend et lire ce qu'elle arbitre
 * (§118.185 — audit 360°, I11 : DM-01, DM-03, DM-07).
 *
 * Trois impasses dans la peau de la directrice : l'écran des « Messages Direction Marketing » lui
 * était fermé (le module Force de vente manquait à son rôle) ; une demande posée sur SON étape
 * n'apparaissait nulle part dans son espace, sauf les congrès ; et elle fixait le budget d'un
 * sponsoring sans pouvoir ouvrir un seul de ses devis, bons de commande ou factures.
 *
 * Joué par les vraies portes avec des rôles de la vraie matrice, et une directrice CLOISONNÉE à sa
 * société : une portée éprouvée avec une vue globale ne peut pas tomber (§118.104).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const TAG = `__dmarb${Date.now()}__`;
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

async function actorFor(id: string): Promise<CurrentUser> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  const access = await getAccess(id, u.role as SessionUser["role"]);
  return { id, name: u.name, email: u.email, role: u.role as SessionUser["role"], secondaryRole: u.secondaryRole, access, mustChangePassword: false };
}

suite("la Direction Marketing : la force de vente en lecture, ce qui l'attend, et les pièces qu'elle arbitre", () => {
  const u: Record<string, string> = {};
  let societeC = "", societeD = "";
  let spo = "", spoAilleurs = "", spoAutreEtape = "", contratAdPro = "", contratRh = "", autre = "";
  const pieces: Record<string, string> = {};

  async function nettoyer() {
    const comptes = (await prisma.user.findMany({ where: { email: { startsWith: "__dmarb" } }, select: { id: true } })).map((x) => x.id);
    const spos = (await prisma.sponsoringRequest.findMany({ where: { reference: { startsWith: "__dmarb" } }, select: { id: true } })).map((x) => x.id);
    await prisma.legalDocument.deleteMany({ where: { title: { startsWith: "__dmarb" } } }).catch(() => {});
    await prisma.workflowInstance.deleteMany({ where: { entityType: "SPONSORING", entityId: { in: spos } } }).catch(() => {});
    await prisma.sponsoringRequest.deleteMany({ where: { id: { in: spos } } }).catch(() => {});
    await prisma.consultingContract.deleteMany({ where: { reference: { startsWith: "__dmarb" } } }).catch(() => {});
    await prisma.adProOtherRequest.deleteMany({ where: { reference: { startsWith: "__dmarb" } } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { userId: { in: comptes } } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { userId: { in: comptes } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: comptes } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: comptes } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: comptes } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { name: { startsWith: "__dmarb" } } }).catch(() => {});
  }

  beforeAll(async () => {
    await nettoyer();
    societeC = (await prisma.company.create({ data: { name: `${TAG} C`, shortName: `${TAG}C`.slice(0, 12), color: "#1B7F79" } })).id;
    societeD = (await prisma.company.create({ data: { name: `${TAG} D`, shortName: `${TAG}D`.slice(0, 12), color: "#7F1B1B" } })).id;
    const comptes: [string, SessionUser["role"]][] = [
      ["dm", "PRODUCT_MANAGER"], ["dm2", "PRODUCT_MANAGER"], ["ns", "NATIONAL_SALES"],
      ["asst", "DIRECTION_ASSISTANT"], ["sans", "SALES_USER"], ["fin", "FINANCE_BUDGET_MANAGER"],
    ];
    for (const [k, role] of comptes) {
      u[k] = (await prisma.user.create({ data: { name: `${TAG} ${k}`, email: `${TAG}${k}@t.dz`, role, passwordHash: "x" } })).id;
      // Tous TRAVAILLENT pour C : c'est ce qui leur ouvre C, et rien d'autre.
      await prisma.employee.create({ data: { fullName: `${TAG} ${k}`, userId: u[k], companyId: societeC, isActive: true } });
    }
    // La seconde directrice voit les contrats RH (un accès posé par la console) : c'est ce qui
    // isole la règle du PÔLE — sans lui, la porte de la fiche la refuserait déjà (§118.111).
    // Depuis 7dece361 (Direction, 06/10 : RH en sous-modules), un contrat du pôle RH est gardé par
    // « Employés » (`MODULE_DU_POLE.RH === "EMPLOYEES"`), et un accès « RH » de la console est recopié
    // sur EMPLOYEES / HR_REQUESTS / TRAINING par la migration 20270114180000_sous_modules_rh. La
    // fixture pose donc ce que la console + la migration posent réellement : « RH » seul ne lui
    // ouvrirait plus la fiche, et la prémisse ne mesurerait plus la règle du pôle.
    for (const module of ["RH", "EMPLOYEES", "HR_REQUESTS", "TRAINING"]) {
      await prisma.userAccess.create({ data: { userId: u.dm2, module, canView: true, scope: "ALL" } });
    }
    // …et la console lui a BLOQUÉ le sponsoring : c'est ce qui éprouve « une demande qu'elle OUVRE ».
    await prisma.userAccess.create({ data: { userId: u.dm2, module: "SPONSORING", canView: false, scope: "ASSIGNED" } });

    const sponsoring = async (suffixe: string, companyId: string) => (await prisma.sponsoringRequest.create({
      data: { reference: `${TAG}${suffixe}`, institution: `${TAG} association ${suffixe}`, type: "Congrès", companyId, requesterId: u.sans, nature: "DIRECT" },
      select: { id: true },
    })).id;
    spo = await sponsoring("SPO", societeC);
    spoAilleurs = await sponsoring("SPOD", societeD);
    spoAutreEtape = await sponsoring("SPO2", societeC);
    // Les instances par le vrai chemin paresseux, puis posées sur l'étape que le banc éprouve.
    for (const [id, etape] of [[spo, "marketing"], [spoAilleurs, "marketing"], [spoAutreEtape, "preliminary"]] as const) {
      const inst = await ensureInstance("SPONSORING", id);
      expect(inst, "l'instance du sponsoring naît").not.toBeNull();
      await prisma.workflowInstance.update({ where: { id: inst!.id }, data: { currentSlug: etape, status: "IN_PROGRESS" } });
    }
    contratAdPro = (await prisma.consultingContract.create({
      data: { reference: `${TAG}CONS`, title: `${TAG} accompagnement`, counterparty: "Atakor", status: "AWAITING_VALIDATION", pole: "AD_PRO", companyId: societeC },
    })).id;
    contratRh = (await prisma.consultingContract.create({
      data: { reference: `${TAG}CONSRH`, title: `${TAG} recrutement`, counterparty: "Atakor", status: "AWAITING_VALIDATION", pole: "RH", companyId: societeC },
    })).id;
    autre = (await prisma.adProOtherRequest.create({
      data: { reference: `${TAG}AUT`, title: `${TAG} autre demande`, status: "AWAITING_DECISION", companyId: societeC },
    })).id;
    // Les plus anciennes d'abord : on les vieillit, pour qu'aucune demande d'un banc voisin ne
    // passe devant dans une fenêtre bornée — le juge ne doit pas dépendre du voisinage (§118.92).
    await prisma.$executeRaw`UPDATE "ConsultingContract" SET "updatedAt" = '2001-01-01' WHERE reference LIKE ${TAG + "%"}`;
    await prisma.$executeRaw`UPDATE "AdProOtherRequest" SET "updatedAt" = '2001-01-01' WHERE reference LIKE ${TAG + "%"}`;
    await prisma.$executeRaw`UPDATE "WorkflowInstance" SET "updatedAt" = '2001-01-01' WHERE "entityId" IN (${spo}, ${spoAilleurs}, ${spoAutreEtape})`;

    const piece = async (cle: string, kind: string, sourceType: string, sourceId: string, companyId: string) => {
      pieces[cle] = (await prisma.legalDocument.create({
        data: { title: `${TAG} ${cle}`, kind: kind as never, sourceType: sourceType as never, sourceId, companyId },
        select: { id: true },
      })).id;
    };
    await piece("devis", "QUOTE", "SPONSORING", spo, societeC);
    await piece("bc", "PURCHASE_ORDER", "SPONSORING", spo, societeC);
    await piece("facture", "INVOICE", "SPONSORING", spo, societeC);
    await piece("convention", "AGREEMENT", "SPONSORING", spo, societeC);
    await piece("devisRestreint", "QUOTE", "SPONSORING", spo, societeC);
    await piece("devisAilleurs", "QUOTE", "SPONSORING", spoAilleurs, societeD);
    await piece("devisAdPro", "QUOTE", "CONSULTING_CONTRACT", contratAdPro, societeC);
    await piece("devisRh", "QUOTE", "CONSULTING_CONTRACT", contratRh, societeC);
    // Un devis RESTREINT à un lecteur désigné qui n'est pas elle.
    await prisma.legalDocumentReader.create({ data: { documentId: pieces.devisRestreint, userId: u.asst } });
  }, 120_000);
  afterAll(nettoyer, 120_000);

  it("PRÉMISSES : une directrice cloisonnée à sa société, sans vue globale, sans Legal ni Finances", async () => {
    const dm = await actorFor(u.dm);
    expect(hasGlobalView(dm.role)).toBe(false);
    expect(await platformScope(u.dm), "sa portée filtre par société").toHaveProperty("companyId");
    expect(userCan(dm, "LEGAL", "VIEW")).toBe(false);
    expect(userCan(dm, "FINANCES", "VIEW")).toBe(false);
    // L'étape décisive nomme bien son rôle : sans cela, « À arbitrer » mesurerait autre chose.
    const inst = await prisma.workflowInstance.findFirstOrThrow({ where: { entityType: "SPONSORING", entityId: spo } });
    const etape = await prisma.workflowStep.findFirstOrThrow({ where: { definitionId: inst.definitionId, slug: "marketing" } });
    expect(etape.actorScope).toBe("ROLE");
    expect(etape.actorRoles).toContain("PRODUCT_MANAGER");
  });

  it("DM-01 — SES MESSAGES : la Direction Marketing les écrit par défaut dans son cockpit, sans gagner la Force de vente", async () => {
    const dm = await actorFor(u.dm);
    expect(userCan(dm, "SALES_PLANNING", "VIEW"), "elle lit la Force de vente").toBe(true);
    expect(userCan(dm, "SALES_PLANNING", "UPDATE"), "lire n'est pas configurer la force de vente").toBe(false);
    // Par défaut (07/10), la liste des auteurs CONTIENT la Direction Marketing ; le Super Admin peut la retirer.
    expect(peutEcrireMessagesCockpit(dm, DEFAULT_APP_SETTINGS.promoMessageAuthorRoles, "CREATE")).toBe(true);
    expect(peutEcrireMessagesCockpit(dm, [], "CREATE"), "liste vidée par le Super Admin : plus d'écriture").toBe(false);
    expect(peutEcrireMessagesPromo(dm, ["PRODUCT_MANAGER"]), "le geste du Super Admin suffit").toBe(true);
    // Le témoin : un rôle sans rapport n'y gagne rien.
    expect(userCan(await actorFor(u.fin), "SALES_PLANNING", "VIEW")).toBe(false);
    // Le point d'appel : c'est bien le module du cockpit qui garde l'écran.
    expect(readFileSync("src/app/(app)/marketing-cockpit/page.tsx", "utf8")).toMatch(/requireModule\("MARKETING_COCKPIT"\)/);
  });

  it("DM-03 — À ARBITRER : le sponsoring posé sur SON étape, le contrat et l'autre demande qui l'attendent", async () => {
    const centre = await getActionCenter(await actorFor(u.dm));
    const hrefs = centre.items.map((i) => i.href);
    expect(hrefs, "le sponsoring à son étape").toContain(`/sponsoring/${spo}`);
    expect(hrefs, "le contrat de consulting à valider").toContain(`/consulting/${contratAdPro}`);
    expect(hrefs, "l'autre demande à décider").toContain(`/ad-pro/autres/${autre}`);
    // Une autre société : pour qui tranche, ce n'est pas une frontière (§118.184) — la fiche
    // s'ouvre, donc la demande l'attend aussi.
    expect(hrefs, "la demande d'une autre société qu'elle tranche").toContain(`/sponsoring/${spoAilleurs}`);
    const item = centre.items.find((i) => i.href === `/sponsoring/${spo}`)!;
    expect(item.kind, "compté dans « À valider »").toBe("validation");
    // Ce qui n'est pas à elle n'y est pas : une autre étape, un contrat RH.
    expect(hrefs, "une autre étape n'est pas la sienne").not.toContain(`/sponsoring/${spoAutreEtape}`);
    expect(hrefs, "un contrat passé aux RH ne s'arbitre pas en Ad & Pro").not.toContain(`/consulting/${contratRh}`);
    // Le témoin : un rôle qui ne tranche rien n'a rien à arbitrer.
    const sans = await getActionCenter(await actorFor(u.sans));
    expect(sans.items.some((i) => i.key.startsWith("arb-"))).toBe(false);
    // Et l'étape ne suffit pas : une directrice à qui la console a fermé le sponsoring porte le
    // rôle de l'étape, mais ne peut pas ouvrir la demande — elle ne lui est donc pas proposée.
    const ferme = await getActionCenter(await actorFor(u.dm2));
    expect(ferme.items.map((i) => i.href), "une demande qu'elle n'ouvre pas").not.toContain(`/sponsoring/${spo}`);
    // Le PÔLE, isolé : la seconde directrice OUVRE le contrat RH (la console lui a ouvert les RH),
    // et il ne lui est pas proposé pour autant — ce n'est pas une demande Ad & Pro.
    expect(await canAccessEntity(await actorFor(u.dm2), "CONSULTING_CONTRACT", contratRh, "VIEW"), "prémisse").toBe(true);
    expect(ferme.items.map((i) => i.href), "un contrat RH ne s'arbitre pas en Ad & Pro").not.toContain(`/consulting/${contratRh}`);
  });

  it("DM-07 — LES PIÈCES QU'ELLE ARBITRE : devis, bon de commande et facture se lisent ; rien ne s'écrit ; la fiche Legal reste fermée", async () => {
    const dm = await actorFor(u.dm);
    const tous = Object.values(pieces);
    const { droits, horsFiche } = await accesAuxPiecesLegalDetaille(dm, tous, ["VIEW", "UPLOAD", "UPDATE", "DELETE"]);
    const vue = droits.get("VIEW")!;
    for (const k of ["devis", "bc", "facture", "devisAdPro", "devisAilleurs"]) {
      expect(vue.has(pieces[k]), `${k} se lit`).toBe(true);
      expect(horsFiche.has(pieces[k]), `${k} : la fiche Legal ne s'ouvre pas`).toBe(true);
    }
    for (const a of ["UPLOAD", "UPDATE", "DELETE"] as const) {
      expect(droits.get(a)!.size, `aucun geste ${a}`).toBe(0);
    }
    // Les bornes, chacune son cas (la fiche fermée et le rôle ont les leurs, plus bas).
    expect(vue.has(pieces.convention), "une convention n'est pas une pièce d'arbitrage").toBe(false);
    expect(vue.has(pieces.devisRestreint), "un devis restreint à d'autres lecteurs reste fermé").toBe(false);
    expect(vue.has(pieces.devisRh), "un contrat RH").toBe(false);
    // La porte unitaire dit la même chose (c'est elle que le téléchargement interroge).
    expect(await canAccessEntity(dm, "LEGAL_DOCUMENT", pieces.facture, "VIEW")).toBe(true);
    expect(await canAccessEntity(dm, "LEGAL_DOCUMENT", pieces.facture, "DELETE")).toBe(false);
  });

  it("…LE PÔLE : même avec les RH ouvertes, le devis d'un contrat RH n'est pas une pièce Ad & Pro", async () => {
    const dm2 = await actorFor(u.dm2);
    expect(await canAccessEntity(dm2, "CONSULTING_CONTRACT", contratRh, "VIEW"), "prémisse : elle ouvre la fiche du contrat RH").toBe(true);
    const { droits } = await accesAuxPiecesLegalDetaille(dm2, [pieces.devisRh, pieces.devisAdPro], ["VIEW"]);
    expect(droits.get("VIEW")!.has(pieces.devisRh)).toBe(false);
    expect(droits.get("VIEW")!.has(pieces.devisAdPro), "le témoin : le contrat Ad & Pro, lui, se lit").toBe(true);
  });

  it("…LA FICHE : une demande qu'elle n'OUVRE pas ne lui ouvre pas ses pièces", async () => {
    const dm2 = await actorFor(u.dm2);
    expect(await canAccessEntity(dm2, "SPONSORING", spo, "VIEW"), "prémisse : la console lui a fermé le sponsoring").toBe(false);
    const { droits } = await accesAuxPiecesLegalDetaille(dm2, [pieces.devis, pieces.facture], ["VIEW"]);
    expect(droits.get("VIEW")!.size).toBe(0);
  });

  it("…LE RÔLE : qui ouvre la fiche sans trancher ne lit pas les pièces", async () => {
    const ns = await actorFor(u.ns);
    expect(await canAccessEntity(ns, "SPONSORING", spo, "VIEW"), "prémisse : le National Sales ouvre ce sponsoring").toBe(true);
    expect(userCan(ns, "LEGAL", "VIEW") || userCan(ns, "FINANCES", "VIEW"), "prémisse : ni Legal ni Finances").toBe(false);
    const { droits } = await accesAuxPiecesLegalDetaille(ns, [pieces.devis, pieces.facture], ["VIEW"]);
    expect(droits.get("VIEW")!.size).toBe(0);
  });

  it("L'ÉCRAN : les fichiers se chargent pour elle, le titre ne mène pas à une fiche refusée — et mène à la fiche pour Legal", async () => {
    const pourElle = await chargerPiecesLiees({ entityType: "SPONSORING", entityId: spo, canCreate: false, spectateur: await actorFor(u.dm) });
    const devis = pourElle.sections.QUOTE.find((l) => l.id === pieces.devis)!;
    expect(devis.documents, "les fichiers sont chargés").not.toBeNull();
    expect(devis.fiche, "le titre est rendu sans lien").toBe(false);
    const restreint = pourElle.sections.QUOTE.find((l) => l.id === pieces.devisRestreint)!;
    expect(restreint.documents, "une pièce fermée ne charge rien").toBeNull();
    expect(restreint.fiche).toBe(false);
    const pourLegal = await chargerPiecesLiees({ entityType: "SPONSORING", entityId: spo, canCreate: false, spectateur: await actorFor(u.asst) });
    expect(pourLegal.sections.QUOTE.find((l) => l.id === pieces.devis)!.fiche, "Legal ouvre la fiche").toBe(true);
    // Le point d'appel : le rendu lit bien ce drapeau.
    expect(readFileSync("src/components/shared/linked-records.tsx", "utf8")).toMatch(/href=\{l\.fiche \? `\/legal\/\$\{l\.id\}` : null\}/);
  });
});
