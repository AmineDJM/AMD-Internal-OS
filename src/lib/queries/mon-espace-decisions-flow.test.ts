import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR, getCurrentUser: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { getAccess, hasGlobalView, isTopManagement, userCan, type SessionUser } from "@/lib/rbac";
import { auNomDeQui } from "@/lib/hr/stand-in-resolve";
import { getManagerOfUser } from "@/lib/departments";
import { getActionCenter } from "@/lib/queries/action-center";
import { sectionsMonEspace, PREFIXE_CONGE } from "@/lib/queries/mes-decisions";
import { getLeavesToDecide } from "@/modules/rh/api";
import { createPurchaseRequest } from "@/lib/actions/purchase-request-actions";
import { decideApproval, deleteRequests } from "@/lib/actions/admin-request-actions";
import { decideLeave } from "@/modules/rh/actions";
import { deciderPlanTournee, demanderRevisionPlanTournee, escaladerPlanTournee } from "@/lib/actions/tour-plan-actions";
import { decideValidation, resoumettreValidation } from "@/lib/actions/validation-actions";
import { createDirectValidation } from "@/lib/validation";
import { ensureInstance } from "@/lib/workflow/engine";
import { executePowerTool } from "@/lib/assistant/power-tools";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « MON ESPACE » EST LE LIEU OÙ L'ON DÉCIDE (lot E2 — audit 360°, N2, M09, 07-05).
 *
 * Ce qui m'attend se lit avec la règle que l'ACTION applique, une fois par file, une ligne par OBJET,
 * l'attente la plus ancienne d'abord — et le compteur « À valider » égale les lignes montrées.
 * Joué par les vrais points d'entrée (`getActionCenter`, `sectionsMonEspace`, les actions qui
 * tranchent), avec des acteurs SANS vue globale (§118.104) et des prémisses vérifiées :
 *   · N2 — l'achat tranché restait « à traiter » chez le N+1 : `validatorId` reste sur la demande ;
 *   · une demande effacée ou annulée restait « à traiter » ;
 *   · une demande assignée ET à valider était listée deux fois ; un congé d'intérim aussi ;
 *   · les congés du bloc des signatures ne comptaient pas dans « À valider » ;
 *   · M09 — le réviseur et le N+2 d'un plan de tournée n'avaient aucune file ;
 *   · 07-05 — aucune ligne ne disait depuis quand elle attend.
 * Aucune écriture conditionnelle neuve dans ce lot (on LIT des files) : aucune course à forcer.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const PREFIXE = "__monespace";
const TAG = `${PREFIXE}${Date.now()}__`;
const T0 = new Date(Date.now() - 60_000);
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

async function actorFor(id: string): Promise<CurrentUser> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  const access = await getAccess(id, u.role as SessionUser["role"]);
  return { id, name: u.name, email: u.email, role: u.role as SessionUser["role"], secondaryRole: u.secondaryRole, access, mustChangePassword: false };
}
const form = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
const jour = (decalage: number) => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + decalage); return d; };
/** Un instant passé, au jour près — les anciennetés du banc ne dépendent pas de l'heure à laquelle il tourne. */
const ilYA = (jours: number) => new Date(Date.now() - jours * 86_400_000);
/** Retire les commentaires : un cliquet qui lit la prose qui le décrit ne mesure rien (§118.79d). */
const sansCommentaires = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
const source = (f: string) => sansCommentaires(readFileSync(f, "utf8"));

suite("« Mon espace » — ce qui m'attend, une ligne par objet, et depuis quand", () => {
  const u: Record<string, string> = {};
  const emp: Record<string, string> = {};
  const demandes: string[] = [];
  const validations: string[] = [];
  let companyId = "";
  let n = 0;

  async function nettoyer() {
    const comptes = (await prisma.user.findMany({ where: { email: { startsWith: PREFIXE } }, select: { id: true } })).map((x) => x.id);
    const fiches = (await prisma.employee.findMany({ where: { userId: { in: comptes } }, select: { id: true } })).map((x) => x.id);
    const reqs = (await prisma.administrativeRequest.findMany({ where: { requesterId: { in: comptes } }, select: { id: true } })).map((x) => x.id);
    const vals = (await prisma.validationRequest.findMany({ where: { requesterId: { in: comptes } }, select: { id: true } })).map((x) => x.id);
    const spos = (await prisma.sponsoringRequest.findMany({ where: { reference: { startsWith: PREFIXE } }, select: { id: true } })).map((x) => x.id);
    await prisma.comment.deleteMany({ where: { entityType: "VALIDATION_REQUEST", entityId: { in: [...vals, ...validations] } } }).catch(() => {});
    await prisma.validationRequest.deleteMany({ where: { id: { in: vals } } }).catch(() => {});
    await prisma.purchaseRequestLogEntry.deleteMany({ where: { OR: [{ requestId: { in: [...reqs, ...demandes] } }, { requesterId: { in: comptes } }] } }).catch(() => {});
    await prisma.adminApproval.deleteMany({ where: { OR: [{ requestId: { in: reqs } }, { validatorId: { in: comptes } }, { requestedById: { in: comptes } }] } }).catch(() => {});
    await prisma.administrativeRequest.deleteMany({ where: { id: { in: reqs } } }).catch(() => {});
    await prisma.tourPlan.deleteMany({ where: { repId: { in: comptes } } }).catch(() => {});
    await prisma.paymentRequest.deleteMany({ where: { requesterId: { in: comptes } } }).catch(() => {});
    await prisma.workflowInstance.deleteMany({ where: { entityType: "SPONSORING", entityId: { in: spos } } }).catch(() => {});
    await prisma.sponsoringRequest.deleteMany({ where: { id: { in: spos } } }).catch(() => {});
    await prisma.leaveRequest.deleteMany({ where: { employeeId: { in: fiches } } }).catch(() => {});
    await prisma.employee.updateMany({ where: { id: { in: fiches } }, data: { managerId: null } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { id: { in: fiches } } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { userId: { in: comptes } } }).catch(() => {});
    // Une demande validée sans responsable prévient TOUT le secrétariat (audit 360°, I10) : ces lignes vont
    // à des comptes qui ne sont pas les nôtres — on les retrouve par le lien, borné par la date (l'index).
    for (const id of [...reqs, ...demandes]) {
      await prisma.notification.deleteMany({ where: { createdAt: { gte: T0 }, link: { contains: id } } }).catch(() => {});
    }
    await prisma.notification.deleteMany({ where: { userId: { in: comptes } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: comptes } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { entityId: { in: [...vals, ...validations, ...reqs] } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: comptes } } }).catch(() => {});
    await prisma.company.deleteMany({ where: { name: { startsWith: PREFIXE } } }).catch(() => {});
  }

  beforeAll(async () => {
    await nettoyer();
    companyId = (await prisma.company.create({ data: { name: `${TAG} société` } })).id;
    // M le N+1 de K et S (en congé : S est son intérimaire), N2 le N+1 de M (le N+2 d'un plan), W le témoin
    // sans rien, RH un compte que la console fait signer les congés, V1 → V2 un circuit de validation, ASST le
    // secrétariat, DM la Direction Marketing. AUCUN n'a la vue globale (prémisse).
    const roles: [string, SessionUser["role"]][] = [
      ["m", "MEDICAL_PROMOTION_MANAGER"], ["k", "MEDICAL_DELEGATE"], ["s", "MEDICAL_DELEGATE"], ["w", "MEDICAL_DELEGATE"],
      ["n2", "NATIONAL_SALES"], ["rh", "VIEWER"], ["v1", "HEAD_OF_SALES"], ["v2", "HEAD_OF_SALES"],
      ["asst", "DIRECTION_ASSISTANT"], ["dm", "PRODUCT_MANAGER"],
    ];
    for (const [k, role] of roles) {
      u[k] = (await prisma.user.create({ data: { name: `${TAG} ${k}`, email: `${TAG}${k}@t.dz`, role, passwordHash: "x" } })).id;
    }
    emp.n2 = (await prisma.employee.create({ data: { fullName: `${TAG} n2`, userId: u.n2, companyId, isActive: true } })).id;
    emp.m = (await prisma.employee.create({ data: { fullName: `${TAG} m`, userId: u.m, companyId, isActive: true, managerId: emp.n2 } })).id;
    for (const k of ["k", "s"]) {
      emp[k] = (await prisma.employee.create({ data: { fullName: `${TAG} ${k}`, userId: u[k], companyId, isActive: true, managerId: emp.m } })).id;
    }
    for (const k of ["w", "rh", "v1", "v2", "asst", "dm"]) {
      emp[k] = (await prisma.employee.create({ data: { fullName: `${TAG} ${k}`, userId: u[k], companyId, isActive: true } })).id;
    }
    // Les RH : un accès posé par la console — voir, modifier, VALIDER (la marche des RH).
    for (const module of ["RH", "EMPLOYEES", "HR_REQUESTS", "TRAINING"]) await prisma.userAccess.create({ data: { userId: u.rh, module, canView: true, canUpdate: true, canValidate: true, scope: "ALL" } });
    // L'INTÉRIM : congé de M accordé, intérimaire S validé par les RH, en cours aujourd'hui.
    await prisma.leaveRequest.create({
      data: {
        employeeId: emp.m, startDate: jour(-1), endDate: jour(5), days: 5, status: "APPROVED", stage: "DONE",
        standInId: u.s, standInStatus: "APPROVED", standInModules: ["VALIDATIONS"],
      },
    });
  }, 180_000);
  afterAll(nettoyer, 180_000);

  const centre = async (qui: string) => getActionCenter(await actorFor(u[qui]));
  const lignesDe = (c: Awaited<ReturnType<typeof getActionCenter>>, objet: string) => c.items.filter((i) => i.objet === objet);

  /** Une demande d'achat déposée par le VRAI formulaire : le validateur est le N+1 de l'organigramme. */
  async function achat(qui: string, titre: string) {
    ACTOR = await actorFor(u[qui]);
    const r = await createPurchaseRequest(undefined, form({ title: `${TAG} ${titre}`, lines: JSON.stringify([{ label: `${TAG} ramettes`, quantity: 2 }]) }));
    expect(r.ok, r.ok ? undefined : r.error).toBe(true);
    const requestId = (r as { id?: string }).id!;
    demandes.push(requestId);
    const approbation = await prisma.adminApproval.findFirstOrThrow({ where: { requestId }, select: { id: true, createdAt: true, validatorId: true } });
    return { requestId, approbationId: approbation.id, creeeLe: approbation.createdAt, validatorId: approbation.validatorId };
  }
  const conge = async (qui: string, data: Partial<Prisma.LeaveRequestUncheckedCreateInput> = {}) => (await prisma.leaveRequest.create({
    data: { employeeId: emp[qui], startDate: jour(20 + ++n), endDate: jour(22 + n), days: 3, status: "PENDING", stage: "MANAGER", managerId: emp.m, ...data },
  })).id;
  // Une période par plan : un KAM n'a qu'un plan par période (contrainte d'unicité).
  const plan = async (qui: string, data: Partial<Prisma.TourPlanUncheckedCreateInput> = {}) => {
    const d = 60 + 35 * ++n;
    return (await prisma.tourPlan.create({
      data: { repId: u[qui], periodStart: jour(d), periodEnd: jour(d + 30), submissionDueAt: jour(d - 5), reviewerId: u.m, status: "SUBMITTED", submittedAt: ilYA(3), ...data },
    })).id;
  };
  /** Un sponsoring dont l'instance est posée sur l'étape de la Direction Marketing — l'histoire est celle que le cas écrit. */
  async function sponsoring(suffixe: string, opts: { renvoye?: boolean } = {}) {
    const id = (await prisma.sponsoringRequest.create({
      data: {
        reference: `${TAG}${suffixe}`, institution: `${TAG} association ${suffixe}`, type: "Congrès", companyId, requesterId: u.k, nature: "DIRECT",
        ...(opts.renvoye ? { status: "RETURNED" as const } : {}),
      },
      select: { id: true },
    })).id;
    const inst = await ensureInstance("SPONSORING", id);
    expect(inst, "l'instance du sponsoring naît").not.toBeNull();
    await prisma.workflowInstance.update({ where: { id: inst!.id }, data: { currentSlug: "marketing", status: opts.renvoye ? "RETURNED" : "IN_PROGRESS" } });
    // La ligne de création (et tout franchissement) posée par le moteur s'efface : le cas écrit SA chronologie.
    await prisma.workflowStepEvent.deleteMany({ where: { instanceId: inst!.id } });
    return { id, instanceId: inst!.id };
  }

  it("PRÉMISSES — aucun acteur n'a la vue globale ; l'intérim de S est armé ; la chaîne M → N2 ; les droits utiles", async () => {
    for (const k of Object.keys(u)) {
      const a = await actorFor(u[k]);
      expect(hasGlobalView(a), `${k} sans vue globale`).toBe(false);
      expect(isTopManagement(a), `${k} hors du sommet`).toBe(false);
    }
    expect([...(await auNomDeQui(u.s)).ids].sort(), "S agit pour M").toEqual([u.m, u.s].sort());
    expect([...(await auNomDeQui(u.w)).ids], "le témoin n'agit pour personne").toEqual([u.w]);
    expect((await getManagerOfUser(u.k))?.userId, "le N+1 de K est M").toBe(u.m);
    expect((await getManagerOfUser(u.m))?.userId, "le N+1 de M est N2 — l'escalade d'un plan y mène").toBe(u.n2);
    expect(userCan(await actorFor(u.rh), "RH", "VALIDATE"), "les RH signent leur marche").toBe(true);
    expect(userCan(await actorFor(u.m), "RH", "VALIDATE"), "le N+1 n'est pas les RH").toBe(false);
    expect(userCan(await actorFor(u.m), "ADMIN_REQUESTS", "VIEW"), "la section des demandes est lue pour le N+1").toBe(true);
    expect(userCan(await actorFor(u.asst), "ADMIN_REQUESTS", "UPDATE"), "le secrétariat efface une demande").toBe(true);
    expect(userCan(await actorFor(u.v2), "VALIDATIONS", "VIEW"), "le second validateur lit sa file").toBe(true);
    expect(userCan(await actorFor(u.k), "MEDICAL", "CREATE"), "le KAM rouvre son plan").toBe(true);
  });

  it("N2 — l'achat tranché quitte « Mon espace » du N+1, alors que la demande garde son validateur", async () => {
    const a = await achat("k", "achat N2");
    expect(a.validatorId, "prémisse : l'approbation va au N+1").toBe(u.m);
    const avant = lignesDe(await centre("m"), `ADMIN_REQUEST:${a.requestId}`);
    expect(avant.map((l) => l.key), "à valider, depuis la demande de validation").toEqual([`approbation-${a.approbationId}`]);
    expect(avant[0].kind).toBe("validation");
    expect(avant[0].depuis, "depuis la naissance de l'approbation").toBe(a.creeeLe.toISOString());
    ACTOR = await actorFor(u.m);
    const r = await decideApproval(form({ approvalId: a.approbationId, decision: "APPROVED" }));
    expect(r.ok, r.ok ? undefined : r.error).toBe(true);
    // C'est le cas exact : le validateur RESTE posé sur la demande après la décision.
    expect((await prisma.administrativeRequest.findUniqueOrThrow({ where: { id: a.requestId } })).validatorId, "prémisse relue en base").toBe(u.m);
    expect(lignesDe(await centre("m"), `ADMIN_REQUEST:${a.requestId}`), "tranché, l'achat ne l'attend plus").toEqual([]);
  });

  it("une demande effacée ne s'attend plus — ni chez l'assistante qui la traite, ni chez le validateur", async () => {
    const a = await achat("k", "achat effacé");
    await prisma.administrativeRequest.update({ where: { id: a.requestId }, data: { assignedToId: u.asst } });
    expect((await centre("asst")).items.map((i) => i.key), "prémisse : l'assistante la traite").toContain(`req-${a.requestId}`);
    expect(lignesDe(await centre("m"), `ADMIN_REQUEST:${a.requestId}`).length, "prémisse : le validateur l'attend").toBe(1);
    ACTOR = await actorFor(u.asst);
    const r = await deleteRequests(form({ ids: a.requestId, reason: "Doublon" }));
    expect(r.ok, r.ok ? undefined : r.error).toBe(true);
    expect(lignesDe(await centre("asst"), `ADMIN_REQUEST:${a.requestId}`), "plus rien à traiter").toEqual([]);
    expect(lignesDe(await centre("m"), `ADMIN_REQUEST:${a.requestId}`), "plus rien à valider").toEqual([]);
    // La suppression retire l'approbation en attente (audit du 14/10/2026 : supprimer, c'est annuler ce qui en dépend).
    expect(await prisma.adminApproval.count({ where: { id: a.approbationId, status: "PENDING" } })).toBe(0);
  });

  it("une demande ANNULÉE par un chemin qui ne retire pas son approbation ne s'attend plus chez le validateur", async () => {
    // L'annulation d'un matériel promotionnel passe sa demande au secrétariat CANCELLED sans toucher à ses
    // approbations (promo-material-actions) : le filtre sur le statut est la seule chose qui la retire de la file.
    const a = await achat("k", "achat annulé");
    expect(lignesDe(await centre("m"), `ADMIN_REQUEST:${a.requestId}`).length, "prémisse : le validateur l'attend").toBe(1);
    await prisma.administrativeRequest.update({ where: { id: a.requestId }, data: { status: "CANCELLED", cancelledAt: new Date() } });
    expect((await prisma.adminApproval.findUniqueOrThrow({ where: { id: a.approbationId } })).status, "prémisse : l'approbation reste en attente").toBe("PENDING");
    expect(lignesDe(await centre("m"), `ADMIN_REQUEST:${a.requestId}`), "annulée, elle ne s'attend plus").toEqual([]);
  });

  it("UNE LIGNE PAR OBJET — assignée et à valider, la demande n'est listée qu'une fois ; tranchée, la ligne « à traiter » revient seule", async () => {
    const a = await achat("k", "achat double");
    await prisma.administrativeRequest.update({ where: { id: a.requestId }, data: { assignedToId: u.m } });
    const avant = lignesDe(await centre("m"), `ADMIN_REQUEST:${a.requestId}`);
    expect(avant.map((l) => l.key), "une seule ligne — le geste le plus pressant").toEqual([`approbation-${a.approbationId}`]);
    expect(avant[0].statusLabel).toBe("À valider");
    ACTOR = await actorFor(u.m);
    const r = await decideApproval(form({ approvalId: a.approbationId, decision: "APPROVED" }));
    expect(r.ok, r.ok ? undefined : r.error).toBe(true);
    const apres = lignesDe(await centre("m"), `ADMIN_REQUEST:${a.requestId}`);
    expect(apres.map((l) => l.key), "tranchée, elle reste à traiter — une ligne").toEqual([`req-${a.requestId}`]);
    expect(apres[0].kind).toBe("request");
    // La propriété générale : aucun objet deux fois, pour personne.
    for (const qui of ["m", "s", "k", "asst", "rh", "dm", "n2"]) {
      const objets = (await centre(qui)).items.map((i) => i.objet);
      expect(new Set(objets).size, `${qui} : aucun objet en double`).toBe(objets.length);
    }
  });

  it("ACHAT EN INTÉRIM — jamais sa propre demande : la demande de S va à M, chez M oui, chez S non", async () => {
    const deS = await achat("s", "achat de S");
    expect(deS.validatorId, "prémisse : l'achat de S va à M").toBe(u.m);
    expect(lignesDe(await centre("m"), `ADMIN_REQUEST:${deS.requestId}`).map((l) => l.key)).toEqual([`approbation-${deS.approbationId}`]);
    expect(lignesDe(await centre("s"), `ADMIN_REQUEST:${deS.requestId}`), "jamais sa propre demande").toEqual([]);
    // Le témoin : l'achat de K, adressé à M, est bien dans la file de S — au nom de M.
    const deK = await achat("k", "achat de K");
    const ligne = lignesDe(await centre("s"), `ADMIN_REQUEST:${deK.requestId}`);
    expect(ligne.map((l) => l.key)).toEqual([`interim-achat-${deK.approbationId}`]);
    expect(ligne[0].subtitle).toContain(`Intérim pour ${TAG} m`);
  });

  it("CONGÉS — le N+1 les voit dans le bloc des signatures, comptés une fois dans « À valider », jamais dans la liste", async () => {
    const id = await conge("k");
    await plan("k"); // une décision de plus, hors des congés : le compteur a DEUX termes
    const c = await centre("m");
    const ligne = lignesDe(c, `${PREFIXE_CONGE}${id}`);
    expect(ligne.map((l) => l.key), "une ligne au centre").toEqual([`conge-${id}`]);
    expect(ligne[0].href).toBe("/mon-espace#conges-a-signer");
    const s = sectionsMonEspace(c.items, c.conges);
    expect(s.conges.filter((l) => l.id === id).length, "dans le bloc des signatures, une fois").toBe(1);
    expect(s.decisions.some((l) => l.objet.startsWith(PREFIXE_CONGE)), "jamais dans la liste des validations").toBe(false);
    expect(s.decisions.length, "prémisse : une décision hors congés").toBeGreaterThan(0);
    expect(s.aValider, "« À valider » compte exactement les lignes des deux blocs").toBe(s.decisions.length + s.conges.length);
  });

  it("INTÉRIM — le congé que S signe pour M n'est montré qu'une fois", async () => {
    const id = await conge("k");
    const c = await centre("s");
    const ligne = lignesDe(c, `${PREFIXE_CONGE}${id}`);
    expect(ligne.map((l) => l.key)).toEqual([`interim-leave-${id}`]);
    expect(ligne[0].subtitle).toContain(`Intérim pour ${TAG} m`);
    const s = sectionsMonEspace(c.items, c.conges);
    expect(s.conges.filter((l) => l.id === id).length, "dans le bloc des signatures, une fois").toBe(1);
    expect(s.conges.find((l) => l.id === id)!.pourLeCompteDe).toBe(`${TAG} m`);
    expect(s.decisions.some((l) => l.objet === `${PREFIXE_CONGE}${id}`), "pas une seconde fois dans la liste").toBe(false);
  });

  it("RH — le congé attend à leur marche depuis l'accord du N+1 ; jamais celui qui attend encore le N+1", async () => {
    const accorde = await conge("k", { createdAt: ilYA(5) });
    const enAttente = await conge("k");
    ACTOR = await actorFor(u.m);
    const r = await decideLeave(form({ id: accorde, decision: "APPROVED" }));
    expect(r.ok, r.ok ? undefined : r.error).toBe(true);
    const lu = await prisma.leaveRequest.findUniqueOrThrow({ where: { id: accorde } });
    expect(lu.stage, "prémisse : la marche des RH est atteinte").toBe("HR");
    const c = await centre("rh");
    const ligne = c.conges.find((l) => l.id === accorde);
    expect(ligne, "à la marche des RH").toBeDefined();
    expect(ligne!.depuis, "depuis l'accord du N+1, pas depuis le dépôt").toBe(lu.managerDecidedAt!.toISOString());
    expect(ligne!.depuis).not.toBe(lu.createdAt.toISOString());
    expect(c.items.find((i) => i.objet === `${PREFIXE_CONGE}${accorde}`)?.depuis, "la ligne du centre dit la même chose").toBe(lu.managerDecidedAt!.toISOString());
    expect(c.conges.some((l) => l.id === enAttente), "ce qui attend le N+1 n'attend pas les RH").toBe(false);
  });

  it("M09 — le réviseur a sa file depuis la soumission ; ni le KAM ni le témoin ; l'intérimaire du réviseur la voit au nom de M", async () => {
    const soumis = ilYA(3);
    const id = await plan("k", { submittedAt: soumis });
    const chezM = lignesDe(await centre("m"), `TOUR_PLAN:${id}`);
    expect(chezM.map((l) => l.key)).toEqual([`plan-${id}`]);
    expect(chezM[0].kind).toBe("validation");
    expect(chezM[0].depuis, "depuis la soumission").toBe(soumis.toISOString());
    expect(chezM[0].subtitle).not.toContain("Intérim");
    expect(lignesDe(await centre("k"), `TOUR_PLAN:${id}`), "le KAM ne tranche pas son plan").toEqual([]);
    expect(lignesDe(await centre("w"), `TOUR_PLAN:${id}`), "le témoin n'a rien").toEqual([]);
    const chezS = lignesDe(await centre("s"), `TOUR_PLAN:${id}`);
    expect(chezS.map((l) => l.key)).toEqual([`interim-plan-${id}`]);
    expect(chezS[0].subtitle).toContain(`Intérim pour ${TAG} m`);
  });

  it("M09 — escaladé, le plan passe chez le N+2 (depuis l'escalade), quitte le réviseur, et sort quand le N+2 tranche", async () => {
    const id = await plan("k", { submittedAt: ilYA(3) });
    ACTOR = await actorFor(u.m);
    const e = await escaladerPlanTournee(form({ planId: id }));
    expect(e.ok, e.ok ? undefined : e.error).toBe(true);
    const lu = await prisma.tourPlan.findUniqueOrThrow({ where: { id } });
    expect(lu.escalatedToId, "prémisse : escaladé au N+1 du réviseur").toBe(u.n2);
    const chezN2 = lignesDe(await centre("n2"), `TOUR_PLAN:${id}`);
    expect(chezN2.map((l) => l.key)).toEqual([`plan-${id}`]);
    expect(chezN2[0].depuis, "depuis l'escalade, pas depuis la soumission").toBe(lu.escalatedAt!.toISOString());
    expect(chezN2[0].subtitle).toContain("escaladé au N+2");
    expect(lignesDe(await centre("m"), `TOUR_PLAN:${id}`), "il a quitté le réviseur").toEqual([]);
    ACTOR = await actorFor(u.n2);
    const d = await deciderPlanTournee(form({ planId: id, decision: "APPROVE" }));
    expect(d.ok, d.ok ? undefined : d.error).toBe(true);
    expect(lignesDe(await centre("n2"), `TOUR_PLAN:${id}`), "tranché, il sort de la file").toEqual([]);
  });

  it("M09 — l'intérimaire du réviseur ne voit jamais son propre plan", async () => {
    const id = await plan("s");
    expect(lignesDe(await centre("m"), `TOUR_PLAN:${id}`).map((l) => l.key), "prémisse : M le tranche").toEqual([`plan-${id}`]);
    expect(lignesDe(await centre("s"), `TOUR_PLAN:${id}`), "S remplace M, pas sur son propre plan").toEqual([]);
  });

  it("VALIDATION SÉQUENTIELLE — à son tour depuis la décision du rang précédent", async () => {
    const r = await createDirectValidation({ requesterId: u.k, title: `${TAG} séquentielle`, module: "Demandes de validations", validatorIds: [u.v1, u.v2], mode: "SEQUENTIAL" });
    expect(r.ok, r.error).toBe(true);
    const id = r.requestId!;
    validations.push(id);
    // La demande a CINQ jours : le second validateur n'attend pas depuis le dépôt.
    await prisma.$executeRaw`UPDATE "ValidationRequest" SET "createdAt" = ${ilYA(5)} WHERE id = ${id}`;
    await prisma.$executeRaw`UPDATE "ValidationStep" SET "createdAt" = ${ilYA(5)} WHERE "requestId" = ${id}`;
    const etapes = await prisma.validationStep.findMany({ where: { requestId: id }, orderBy: { order: "asc" } });
    ACTOR = await actorFor(u.v1);
    const d = await decideValidation(form({ stepId: etapes[0].id, decision: "APPROVED" }));
    expect(d.ok, d.ok ? undefined : d.error).toBe(true);
    const decidee = (await prisma.validationStep.findUniqueOrThrow({ where: { id: etapes[0].id } })).decidedAt!;
    const ligne = (await centre("v2")).items.find((i) => i.key === `val-${etapes[1].id}`);
    expect(ligne, "à son tour").toBeDefined();
    expect(ligne!.depuis, "depuis la décision du rang précédent").toBe(decidee.toISOString());
  });

  it("VALIDATION RESOUMISE — à son tour depuis la resoumission", async () => {
    const r = await createDirectValidation({ requesterId: u.k, title: `${TAG} resoumise`, module: "Demandes de validations", validatorIds: [u.v1] });
    expect(r.ok, r.error).toBe(true);
    const id = r.requestId!;
    validations.push(id);
    await prisma.$executeRaw`UPDATE "ValidationRequest" SET "createdAt" = ${ilYA(5)} WHERE id = ${id}`;
    await prisma.$executeRaw`UPDATE "ValidationStep" SET "createdAt" = ${ilYA(5)} WHERE "requestId" = ${id}`;
    const etape = await prisma.validationStep.findFirstOrThrow({ where: { requestId: id } });
    ACTOR = await actorFor(u.v1);
    const renvoi = await decideValidation(form({ stepId: etape.id, decision: "CHANGES_REQUESTED", reason: "Joignez le devis signé." }));
    expect(renvoi.ok, renvoi.ok ? undefined : renvoi.error).toBe(true);
    ACTOR = await actorFor(u.k);
    const reprise = await resoumettreValidation(form({ id, note: "Devis signé joint." }));
    expect(reprise.ok, reprise.ok ? undefined : reprise.error).toBe(true);
    // La trace que la resoumission écrit elle-même — c'est elle que la file lit.
    const trace = await prisma.auditLog.findFirstOrThrow({ where: { entityType: "VALIDATION_REQUEST", entityId: id, field: "version", newValue: "2" } });
    const ligne = (await centre("v1")).items.find((i) => i.key === `val-${etape.id}`);
    expect(ligne, "de nouveau à son tour").toBeDefined();
    expect(ligne!.depuis, "depuis la resoumission, pas depuis le dépôt").toBe(trace.createdAt.toISOString());
  });

  it("À ARBITRER — depuis le dernier mouvement, un commentaire n'y change rien ; sans mouvement journalisé, depuis l'ouverture de l'instance", async () => {
    const accorde = ilYA(4);
    const a = await sponsoring("SPOA");
    await prisma.workflowStepEvent.createMany({
      data: [
        { instanceId: a.instanceId, stepSlug: "__created__", stepTitle: "Demande créée", action: "CREATE", actorId: u.k, createdAt: ilYA(10) },
        { instanceId: a.instanceId, stepSlug: "preliminary", stepTitle: "Validation préliminaire", action: "APPROVE", actorId: u.n2, createdAt: accorde },
        { instanceId: a.instanceId, stepSlug: "marketing", stepTitle: "Direction Marketing", action: "COMMENT", actorId: u.dm, note: "Je regarde.", createdAt: ilYA(1) },
      ],
    });
    const ouvert = ilYA(7);
    const b = await sponsoring("SPOB");
    // Les plus anciennes d'abord dans une fenêtre bornée : aucune instance d'un banc voisin ne passe devant (§118.92).
    await prisma.$executeRaw`UPDATE "WorkflowInstance" SET "updatedAt" = ${new Date("2001-01-01T00:00:00.000Z")}, "createdAt" = ${ilYA(12)} WHERE id = ${a.instanceId}`;
    await prisma.$executeRaw`UPDATE "WorkflowInstance" SET "updatedAt" = ${new Date("2001-01-01T00:00:00.000Z")}, "createdAt" = ${ouvert} WHERE id = ${b.instanceId}`;
    const c = await centre("dm");
    const la = c.items.find((i) => i.key === `arb-SPONSORING-${a.id}`);
    expect(la, "prémisse : la demande l'attend à son étape").toBeDefined();
    expect(la!.depuis, "depuis l'accord préliminaire — pas depuis le commentaire").toBe(accorde.toISOString());
    const lb = c.items.find((i) => i.key === `arb-SPONSORING-${b.id}`);
    expect(lb, "prémisse : la seconde aussi").toBeDefined();
    expect(lb!.depuis, "sans mouvement journalisé, depuis l'ouverture de l'instance").toBe(ouvert.toISOString());
  });

  it("À CORRIGER — un plan rouvert pour révision attend depuis la demande de révision, pas depuis sa validation", async () => {
    const id = await plan("k", { status: "APPROVED", submittedAt: ilYA(8), decidedAt: ilYA(6), decidedById: u.m });
    ACTOR = await actorFor(u.k);
    const r = await demanderRevisionPlanTournee(form({ planId: id, note: "Congrès national la deuxième semaine." }));
    expect(r.ok, r.ok ? undefined : r.error).toBe(true);
    const lu = await prisma.tourPlan.findUniqueOrThrow({ where: { id } });
    const ligne = (await centre("k")).items.find((i) => i.key === `corriger-TOUR_PLAN-${id}`);
    expect(ligne, "à corriger").toBeDefined();
    expect(ligne!.depuis, "depuis la demande de révision").toBe(lu.revisionRequestedAt!.toISOString());
  });

  it("À CORRIGER — une demande de paiement attend depuis son dernier renvoi ; un commentaire plus récent ne compte pas", async () => {
    const renvoi = ilYA(3);
    const pr = await prisma.paymentRequest.create({
      data: { reference: `${TAG}PAY`, title: `${TAG} honoraires`, amount: 1000, payee: `${TAG} prestataire`, status: "CHANGES_REQUESTED", requesterId: u.k },
      select: { id: true },
    });
    await prisma.paymentRequestEvent.createMany({
      data: [
        { requestId: pr.id, actorId: u.v1, kind: "REQUEST_CHANGES", message: "Pièces à revoir.", at: renvoi },
        { requestId: pr.id, actorId: u.k, kind: "COMMENT", message: "Je m'en occupe.", at: ilYA(1) },
      ],
    });
    const ligne = (await centre("k")).items.find((i) => i.key === `corriger-PAYMENT_REQUEST-${pr.id}`);
    expect(ligne, "à corriger").toBeDefined();
    expect(ligne!.depuis, "depuis le renvoi").toBe(renvoi.toISOString());
  });

  it("À CORRIGER — une demande Ad & Pro attend depuis son renvoi", async () => {
    const renvoi = ilYA(2);
    const spo = await sponsoring("SPOR", { renvoye: true });
    await prisma.workflowStepEvent.create({
      data: { instanceId: spo.instanceId, stepSlug: "marketing", stepTitle: "Direction Marketing", action: "RETURN", actorId: u.dm, note: "Joignez le devis signé.", createdAt: renvoi },
    });
    const ligne = (await centre("k")).items.find((i) => i.key === `corriger-SPONSORING-${spo.id}`);
    expect(ligne, "à corriger").toBeDefined();
    expect(ligne!.subtitle).toContain("Joignez le devis signé.");
    expect(ligne!.depuis, "depuis le renvoi").toBe(renvoi.toISOString());
  });

  it("ADAM (en pause) — la file de décisions ne compte pas un congé deux fois", async () => {
    await conge("k");
    const m = await actorFor(u.m);
    const attendus = (await getLeavesToDecide(m)).filter((l) => l.employee === `${TAG} k`).length;
    expect(attendus, "prémisse : des congés de K attendent M").toBeGreaterThan(0);
    const sortie = await executePowerTool("list_pending_decisions", { limit: 60 }, m);
    const lignes = (JSON.parse(sortie!) as { items: { titre: string }[] }).items;
    expect(lignes.filter((l) => l.titre === `Congé — ${TAG} k`).length, "un congé, une ligne").toBe(attendus);
  });

  it("POINTS D'APPEL — la page, la file des congés, la page du plan et la boîte d'Adam lisent ce que le centre rend", () => {
    // « AUJOURD'HUI » (Direction, 14/10/2026) : la page lit le centre par `chargerAujourdhui`, qui le groupe par lot
    // (`regrouperFile`) ; les congés gardent leur bloc, nourri par la MÊME lecture que les lignes.
    const page = source("src/app/(app)/mon-espace/page.tsx");
    expect(page).toContain("chargerAujourdhui(user");
    expect(page, "le bloc des congés vient du centre").toContain("trierConges(jour.conges)");
    expect(page, "la page ne relit pas la file des congés à côté").not.toContain("getLeavesToDecide");
    expect(page).toContain('<section id="conges-a-signer"');
    const lecture = source("src/lib/queries/aujourdhui-espace.ts");
    expect(lecture).toContain("getActionCenter(user)");
    expect(lecture).toContain("regrouperFile([...centre.items, ...piecesADeposer], now)");
    expect(lecture).not.toContain("getLeavesToDecide");
    expect(source("src/lib/espace/aujourdhui.ts"), "chaque ligne sait depuis quand elle attend").toContain("attente: attenteDe(e, now)");
    expect(source("src/app/(app)/mon-espace/file-a-faire.tsx"), "la ligne dit depuis quand").toContain("{l.attente} j");
    const conges = source("src/components/hr/leave-approvals.tsx");
    expect(conges).toContain("depuisLisible(leave.depuis");
    expect(conges, "la ligne du congé dit depuis quand").toContain("En attente {attente}");
    expect(source("src/app/(app)/medical/plan-de-tournee/page.tsx"), "une seule écriture de la file des plans").toContain("clausePlansADecider(user.id, agitPour)");
    const boite = source("src/platform/in-process/inbox/compose.ts");
    expect(boite).toContain("i.objet.startsWith(PREFIXE_CONGE)");
    expect(boite).toContain("i.objet.startsWith(PREFIXE_DEMANDE_ADMIN)");
    const centreSrc = source("src/lib/queries/action-center.ts");
    expect(centreSrc).toContain("dedoublonner(items)");
    expect(centreSrc).toContain("getLeavesToDecide(user)");
    expect(centreSrc).toContain("clausePlansADecider(user.id, absents)");
  });
});
