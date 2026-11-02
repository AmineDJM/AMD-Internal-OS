import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));

import { prisma } from "@/lib/prisma";
import { getAccess, userCan, type SessionUser } from "@/lib/rbac";
import { canAccessEntity, moduleDeLEntite, modulesDesEntites } from "@/lib/entity-access";
import { getAdProRequests, demandesAuCentreAdPro, seuilAdProEnVigueur, lireVisaAdPro } from "@/modules/ad-pro/api";
import { resoudreCible } from "@/lib/cibles/resoudre";
import { getEntity, canReadEntity } from "@/lib/api/registry/entities";
import { aiguillerBC, porteDuBC } from "@/lib/bons-de-commande/aiguillage";
import { getAppSettings } from "@/lib/settings";
import { refusTransfert } from "@/lib/lecteurs/consulting";
import { buildProposal } from "@/lib/assistant";
import {
  createConsultingContract, requestConsultingValidation, decideConsultingContract,
  addConsultingTask, transfererConsulting,
} from "./consulting-actions";
import { deciderVisaCentreAdPro } from "@/modules/ad-pro/actions-centre";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__consultrh__";

const form = (fields: Record<string, string>): FormData => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};

async function actorFor(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE TRANSFERT D'UN CONTRAT DE CONSULTING D'AD & PRO AUX RH — par les VRAIS points d'entrée
 * (§118.150).
 *
 * « Transfère le consulting de Consultant médical — Atakor Minds, qui est dans Consulting
 * d'Ad&Pro, à un consulting en RH. » Ce banc ne demande pas si le champ `pole` change : il
 * demande si, après le geste, CHAQUE lecteur du contrat voit la nouvelle maison — la garde
 * d'accès, la liste d'Ad & Pro, le registre (donc Adam et l'API), le centre Ad & Pro, les
 * bons de commande en attente — et si rien n'a été perdu.
 *
 * ── LES ACTEURS, ET POURQUOI AUCUN N'A LA VUE GLOBALE SAUF LE TRANSFÉREUR ────────────────
 *
 * Une garde éprouvée avec un Super Admin ne peut pas tomber (§118.104). Les lecteurs sont donc
 * la Direction Marketing (PRODUCT_MANAGER : Consulting complet, AUCUN droit RH) et le Directeur
 * des Opérations (OPERATIONS_DIRECTOR : RH en lecture, AUCUN droit Consulting) — les deux côtés
 * d'une frontière que le transfert déplace. Leurs prémisses sont ASSERTÉES : le jour où la
 * matrice changerait, le banc le dirait au lieu de passer au vert sans plus rien garder.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Transfert d'un contrat de consulting — Ad & Pro ⇄ RH, le flux réel", () => {
  let saId = "", pmId = "", odId = "", dirId = "";
  let contactId = "";
  const docs: string[] = [];

  const contrat = async (suffix: string, extra: Record<string, unknown> = {}) =>
    prisma.consultingContract.create({
      data: {
        reference: `${TAG}${suffix}`, title: `${TAG} ${suffix}`, counterparty: `${TAG} Atakor Minds`,
        status: "DRAFT", requesterId: pmId, createdById: pmId,
        doctor: "Dr Test", product: "Produit test", amount: 120_000,
        tasks: { create: [{ label: `${TAG} Cadrage`, position: 0 }, { label: `${TAG} Rapport`, position: 1 }] },
        ...extra,
      },
    });

  beforeAll(async () => {
    const mk = (n: string, role: SessionUser["role"]) =>
      prisma.user.create({ data: { name: `${TAG}${n}`, email: `${TAG}${n}@t.dz`, role, passwordHash: "x" } });
    saId = (await mk("sa", "SUPER_ADMIN")).id;
    pmId = (await mk("pm", "PRODUCT_MANAGER")).id;
    odId = (await mk("od", "OPERATIONS_DIRECTOR")).id;
    dirId = (await mk("dir", "DIRECTION")).id;
    contactId = (await prisma.companyContact.create({ data: { name: `${TAG} Atakor Minds`, companyId: null } })).id;
  });

  afterAll(async () => {
    const ids = (await prisma.consultingContract.findMany({ where: { reference: { startsWith: TAG } }, select: { id: true } })).map((c) => c.id);
    const vIds = (await prisma.validationRequest.findMany({ where: { entityType: "LEGAL_DOCUMENT", entityId: { in: docs } }, select: { id: true } })).map((v) => v.id);
    await prisma.validationStep.deleteMany({ where: { requestId: { in: vIds } } }).catch(() => {});
    await prisma.validationRequest.deleteMany({ where: { id: { in: vIds } } }).catch(() => {});
    await prisma.adProGateVisa.deleteMany({ where: { entityId: { in: [...ids, ...docs] } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { entityId: { in: [...ids, ...docs] } } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { id: { in: docs } } }).catch(() => {});
    await prisma.companyContact.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.consultingTask.deleteMany({ where: { contractId: { in: ids } } }).catch(() => {});
    await prisma.consultingContract.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    const comptes = (await prisma.user.findMany({ where: { email: { startsWith: TAG } }, select: { id: true } })).map((c) => c.id);
    await prisma.notification.deleteMany({ where: { userId: { in: comptes } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: comptes } } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { userId: { in: comptes } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("PRÉMISSES : les deux lecteurs sont chacun d'UN seul côté ; le transféreur tient les deux", async () => {
    const pm = await actorFor(pmId, "PRODUCT_MANAGER");
    expect(userCan(pm, "CONSULTING", "UPDATE")).toBe(true);
    expect(userCan(pm, "CONSULTING", "VALIDATE")).toBe(true);
    expect(userCan(pm, "EMPLOYEES", "VIEW"), "sans cela, la fuite vers la promotion ne se mesurerait pas").toBe(false);
    const od = await actorFor(odId, "OPERATIONS_DIRECTOR");
    expect(userCan(od, "EMPLOYEES", "VIEW")).toBe(true);
    expect(userCan(od, "EMPLOYEES", "UPDATE"), "un lecteur RH ne transfère pas").toBe(false);
    expect(userCan(od, "CONSULTING", "VIEW"), "sans cela, la lecture RH ne se mesurerait pas").toBe(false);
    const dir = await actorFor(dirId, "DIRECTION");
    for (const m of ["CONSULTING", "EMPLOYEES"] as const) {
      expect(userCan(dir, m, "UPDATE")).toBe(true);
      expect(userCan(dir, m, "VALIDATE")).toBe(true);
    }
  });

  it("transférer exige de MODIFIER les deux modules : la promotion seule et les RH en lecture sont refusées", async () => {
    const c = await contrat("refus");
    ACTOR = await actorFor(pmId, "PRODUCT_MANAGER");
    const parPm = await transfererConsulting(form({ id: c.id }));
    expect(parPm.ok).toBe(false);
    expect(parPm.error).toBe(refusTransfert("AD_PRO", "RH"));
    ACTOR = await actorFor(odId, "OPERATIONS_DIRECTOR");
    const parOd = await transfererConsulting(form({ id: c.id }));
    expect(parOd.ok).toBe(false);
    expect((await prisma.consultingContract.findUniqueOrThrow({ where: { id: c.id } })).pole, "un refus qui écrit quand même est un faux refus").toBe("AD_PRO");
  });

  it("une destination ILLISIBLE est refusée, jamais devinée ; le pôle actuel aussi", async () => {
    const c = await contrat("dest");
    ACTOR = await actorFor(dirId, "DIRECTION");
    const flou = await transfererConsulting(form({ id: c.id, vers: "ailleurs" }));
    expect(flou.ok).toBe(false);
    expect(flou.error).toMatch(/Pôle inconnu/);
    const meme = await transfererConsulting(form({ id: c.id, vers: "AD_PRO" }));
    expect(meme.ok).toBe(false);
    expect(meme.error).toMatch(/relève déjà/);
    expect((await prisma.consultingContract.findUniqueOrThrow({ where: { id: c.id } })).pole).toBe("AD_PRO");
  });

  it("Ad & Pro → RH : le MÊME contrat change de maison, et rien n'est perdu ; l'audit garde les deux pôles", async () => {
    const c = await contrat("atakor");
    ACTOR = await actorFor(dirId, "DIRECTION");
    const r = await transfererConsulting(form({ id: c.id }));
    expect(r.ok, r.error).toBe(true);
    expect(r.message).toMatch(/Ressources humaines/);

    const apres = await prisma.consultingContract.findUniqueOrThrow({ where: { id: c.id }, include: { tasks: true } });
    expect(apres.pole).toBe("RH");
    expect(apres.reference).toBe(c.reference);
    // Rien de détruit : un transfert se défait par le geste inverse, et l'aller-retour ne doit
    // rien avoir perdu — la gamme, les praticiens et les produits restent, lus côté Ad & Pro.
    expect(apres.doctor).toBe("Dr Test");
    expect(apres.product).toBe("Produit test");
    expect(apres.tasks).toHaveLength(2);

    const trace = await prisma.auditLog.findFirst({ where: { entityType: "CONSULTING_CONTRACT", entityId: c.id, field: "pole" } });
    expect(trace?.oldValue).toBe("AD_PRO");
    expect(trace?.newValue).toBe("RH");
  });

  it("après le transfert, CHAQUE lecteur voit la nouvelle maison : garde d'accès, liste Ad & Pro, registre", async () => {
    const reste = await contrat("reste");
    const part = await contrat("part");
    ACTOR = await actorFor(dirId, "DIRECTION");
    expect((await transfererConsulting(form({ id: part.id }))).ok).toBe(true);

    const pm = await actorFor(pmId, "PRODUCT_MANAGER");
    const od = await actorFor(odId, "OPERATIONS_DIRECTOR");

    // LA GARDE PAR ENREGISTREMENT — le module du POLE, pas « Consulting » en dur.
    expect(await canAccessEntity(pm, "CONSULTING_CONTRACT", reste.id, "VIEW")).toBe(true);
    expect(await canAccessEntity(pm, "CONSULTING_CONTRACT", part.id, "VIEW"), "la promotion lirait la rémunération d'un consultant RH").toBe(false);
    expect(await canAccessEntity(od, "CONSULTING_CONTRACT", part.id, "VIEW"), "les RH ne verraient pas le contrat qu'elles suivent").toBe(true);
    expect(await canAccessEntity(od, "CONSULTING_CONTRACT", reste.id, "VIEW")).toBe(false);

    // LA LISTE UNIFIÉE D'AD & PRO.
    const liste = await getAdProRequests(pm);
    expect(liste.some((l) => l.id === reste.id)).toBe(true);
    expect(liste.some((l) => l.id === part.id), "la liste d'Ad & Pro rendrait un contrat RH").toBe(false);

    // LE REGISTRE — la désignation d'Adam et de l'API. Une recherche ne rend jamais, même comme
    // candidat, un contrat hors des pôles lisibles.
    const parPm = await resoudreCible(pm, "consulting_contract", part.reference);
    expect(parPm.retenu).toHaveLength(0);
    expect(parPm.candidats).toHaveLength(0);
    const parOd = await resoudreCible(od, "consulting_contract", part.reference);
    expect(parOd.retenu.map((c) => c.id), "les RH seraient refusées par la porte générique alors que l'écran les sert").toEqual([part.id]);
    expect((await resoudreCible(od, "consulting_contract", reste.reference)).retenu).toHaveLength(0);
    expect(canReadEntity(od, getEntity("consulting_contract")!)).toBe(true);

    // LE MODULE D'UN LOT — la même réponse que la garde, pour l'imputation d'un écran de paiements.
    // Côté RH, c'est le sous-module « Employés » (équipe, consultants, départements) depuis que « RH » s'est scindé (7dece361).
    const lot = await modulesDesEntites([
      { entityType: "CONSULTING_CONTRACT", entityId: reste.id },
      { entityType: "CONSULTING_CONTRACT", entityId: part.id },
      { entityType: "SPONSORING", entityId: "inconnu" },
    ]);
    expect(lot.get(`CONSULTING_CONTRACT:${reste.id}`)).toBe("CONSULTING");
    expect(lot.get(`CONSULTING_CONTRACT:${part.id}`)).toBe("EMPLOYEES");
    expect(lot.get("SPONSORING:inconnu")).toBe("SPONSORING");
    expect(await moduleDeLEntite("CONSULTING_CONTRACT", part.id)).toBe("EMPLOYEES");
  });

  it("le PORTEUR qui n'a pas les RH perd ses droits de porteur sur le contrat transféré — et les garde sur l'autre", async () => {
    const reste = await contrat("porteur-reste");
    const part = await contrat("porteur-part");
    ACTOR = await actorFor(dirId, "DIRECTION");
    expect((await transfererConsulting(form({ id: part.id }))).ok).toBe(true);

    ACTOR = await actorFor(pmId, "PRODUCT_MANAGER");
    const ici = await addConsultingTask(form({ contractId: reste.id, label: `${TAG} Livrable` }));
    expect(ici.ok, ici.error).toBe(true);
    const labas = await addConsultingTask(form({ contractId: part.id, label: `${TAG} Livrable` }));
    expect(labas.ok, "l'action serait une porte ouverte à côté de la fiche fermée").toBe(false);
  });

  it("le geste inverse RAMÈNE le contrat, et l'aller-retour n'a rien perdu", async () => {
    const c = await contrat("allerretour");
    ACTOR = await actorFor(dirId, "DIRECTION");
    expect((await transfererConsulting(form({ id: c.id }))).ok).toBe(true);
    const retour = await transfererConsulting(form({ id: c.id }));
    expect(retour.ok, retour.error).toBe(true);
    const apres = await prisma.consultingContract.findUniqueOrThrow({ where: { id: c.id }, include: { tasks: true } });
    expect(apres.pole).toBe("AD_PRO");
    expect(apres.doctor).toBe("Dr Test");
    expect(apres.tasks).toHaveLength(2);
    expect(await canAccessEntity(await actorFor(pmId, "PRODUCT_MANAGER"), "CONSULTING_CONTRACT", c.id, "VIEW")).toBe(true);
  });

  describe("la porte du centre Ad & Pro suit le pôle", () => {
    let seuil = 0;
    beforeAll(async () => {
      const lu = await seuilAdProEnVigueur();
      expect(lu, "PRÉMISSE : sans seuil, la porte du centre est désarmée et ces cas ne mesureraient rien (§118.104).").not.toBeNull();
      seuil = lu as number;
    });

    it("quitter Ad & Pro RETIRE la validation en attente et fait tomber le validateur sans droit RH — la Direction tranche ensuite", async () => {
      const c = await contrat("visa", { amount: seuil * 5, requesterId: saId, createdById: saId });
      ACTOR = await actorFor(saId, "SUPER_ADMIN");
      expect((await requestConsultingValidation(form({ id: c.id, validatorId: pmId }))).ok).toBe(true);
      expect(await lireVisaAdPro("CONSULTING_CONTRACT", c.id)).toBe("PENDING");

      ACTOR = await actorFor(dirId, "DIRECTION");
      const r = await transfererConsulting(form({ id: c.id }));
      expect(r.ok, r.error).toBe(true);
      expect(r.message).toMatch(/centre Ad & Pro/);
      expect(r.message).toMatch(/désignation/);
      expect(await lireVisaAdPro("CONSULTING_CONTRACT", c.id), "le centre de la promotion arbitrerait un contrat RH").toBeNull();
      expect((await demandesAuCentreAdPro()).some((l) => l.entityId === c.id)).toBe(false);
      const apres = await prisma.consultingContract.findUniqueOrThrow({ where: { id: c.id } });
      expect(apres.validatorId, "la décision reviendrait à quelqu'un que l'action refusera").toBeNull();

      const decision = await decideConsultingContract(form({ id: c.id, approve: "1" }));
      expect(decision.ok, decision.error).toBe(true);
      expect((await prisma.consultingContract.findUniqueOrThrow({ where: { id: c.id } })).status).toBe("ACTIVE");
    });

    it("un validateur qui PEUT trancher dans la nouvelle maison est GARDÉ", async () => {
      const c = await contrat("garde", { amount: 1, requesterId: saId, createdById: saId });
      ACTOR = await actorFor(saId, "SUPER_ADMIN");
      expect((await requestConsultingValidation(form({ id: c.id, validatorId: dirId }))).ok).toBe(true);
      ACTOR = await actorFor(dirId, "DIRECTION");
      expect((await transfererConsulting(form({ id: c.id }))).ok).toBe(true);
      expect((await prisma.consultingContract.findUniqueOrThrow({ where: { id: c.id } })).validatorId).toBe(dirId);
    });

    it("un contrat RH ne passe pas par le centre ; ENTRER dans Ad & Pro en attente remet la porte, et elle bloque", async () => {
      ACTOR = await actorFor(dirId, "DIRECTION");
      const cree = await createConsultingContract(undefined, form({
        pole: "RH", title: `${TAG} RH né`, counterparty: `${TAG} Consultant`, amount: String(seuil * 5),
      }));
      expect(cree.ok, cree.error).toBe(true);
      await prisma.consultingContract.update({ where: { id: cree.id! }, data: { reference: `${TAG}rh-ne` } });
      expect((await requestConsultingValidation(form({ id: cree.id! }))).ok).toBe(true);
      expect(await lireVisaAdPro("CONSULTING_CONTRACT", cree.id!), "un contrat RH serait arbitré par le centre de la promotion").toBeNull();

      const r = await transfererConsulting(form({ id: cree.id!, vers: "AD_PRO" }));
      expect(r.ok, r.error).toBe(true);
      expect(await lireVisaAdPro("CONSULTING_CONTRACT", cree.id!)).toBe("PENDING");
      const decision = await decideConsultingContract(form({ id: cree.id!, approve: "1" }));
      expect(decision.ok, "entrer dans Ad & Pro sans passer la porte serait le contournement du centre").toBe(false);
      expect(decision.error).toMatch(/centre de validation/i);
    });
  });

  it("une porte PÉRIMÉE sur un contrat RH (course entre transfert et soumission) ne bloque rien et n'apparaît nulle part", async () => {
    // Ce cas part d'un état posé à la main, et c'est voulu : aucun chemin de production ne le
    // produit de façon déterministe — il naît d'une COURSE (une soumission qui pose la porte
    // pendant qu'un transfert la retire). Les deux gardes qu'il éprouve existent pour cette
    // seule course : sans elles, la décision RH serait bloquée par un centre qui ne liste pas
    // la demande — une impasse invisible, que personne ne pourrait lever.
    const c = await contrat("perime", { pole: "RH", status: "AWAITING_VALIDATION", requesterId: saId, createdById: saId });
    await prisma.adProGateVisa.create({
      data: { entityType: "CONSULTING_CONTRACT", entityId: c.id, status: "PENDING", threshold: 1, amount: 120_000 },
    });
    expect((await demandesAuCentreAdPro()).some((l) => l.entityId === c.id), "le centre de la promotion afficherait un contrat RH").toBe(false);
    ACTOR = await actorFor(dirId, "DIRECTION");
    const decision = await decideConsultingContract(form({ id: c.id, approve: "1" }));
    expect(decision.ok, decision.error).toBe(true);
  });

  it("créer au pôle RH : le droit est celui des RH, et les faits de promotion ne sont PAS écrits", async () => {
    ACTOR = await actorFor(pmId, "PRODUCT_MANAGER");
    const refuse = await createConsultingContract(undefined, form({ pole: "RH", title: `${TAG} forgé`, counterparty: "X" }));
    expect(refuse.ok, "un champ forgé ferait créer un contrat RH à qui n'a pas les RH").toBe(false);

    ACTOR = await actorFor(dirId, "DIRECTION");
    const r = await createConsultingContract(undefined, form({
      pole: "RH", title: `${TAG} RH propre`, counterparty: `${TAG} Consultant`, doctor: "Dr Forgé", product: "Produit forgé",
    }));
    expect(r.ok, r.error).toBe(true);
    const c = await prisma.consultingContract.update({ where: { id: r.id! }, data: { reference: `${TAG}rh-propre` } });
    expect(c.pole).toBe("RH");
    expect(c.businessUnitId).toBeNull();
    expect(c.doctor, "un contrat RH ne porte pas de praticien de promotion").toBeNull();
    expect(c.product).toBeNull();
  });

  it("les bons de commande EN ATTENTE changent de centre ; un BC déjà DÉCIDÉ ne se rejuge pas", async () => {
    const { bcValidationThreshold } = await getAppSettings();
    const montant = Math.max(5_000_000, Number(bcValidationThreshold) * 10);
    const c = await contrat("bc");
    const mkBC = async (suffix: string) => {
      const d = await prisma.legalDocument.create({
        data: {
          title: `${TAG} BC ${suffix}`, reference: `${TAG}BC-${suffix}`, kind: "PURCHASE_ORDER", amount: montant,
          counterpartyIds: [contactId], sourceType: "CONSULTING_CONTRACT", sourceId: c.id, createdById: pmId,
        },
      });
      docs.push(d.id);
      const a = await aiguillerBC(d.id, { acteurId: pmId });
      expect(a.porte?.centre, "PRÉMISSE : né d'un contrat Ad & Pro, le BC attend le centre Ad & Pro").toBe("AD_PRO");
      return d;
    };
    const enAttente = await mkBC("attente");
    const decide = await mkBC("decide");
    ACTOR = await actorFor(saId, "SUPER_ADMIN");
    expect((await deciderVisaCentreAdPro(form({ entityType: "LEGAL_DOCUMENT", entityId: decide.id, approve: "1" }))).ok).toBe(true);

    ACTOR = await actorFor(dirId, "DIRECTION");
    const r = await transfererConsulting(form({ id: c.id }));
    expect(r.ok, r.error).toBe(true);
    expect(r.message).toMatch(/1 bon\(s\) de commande/);

    const porte = await porteDuBC(enAttente.id);
    expect(porte?.centre, "un BC de consultant RH serait arbitré par le centre de la promotion").toBe("VALIDATION");
    expect(porte?.etat).toBe("EN_ATTENTE");
    expect(await prisma.adProGateVisa.count({ where: { entityType: "LEGAL_DOCUMENT", entityId: enAttente.id, status: "PENDING" } })).toBe(0);

    const tranche = await porteDuBC(decide.id);
    expect(tranche?.centre, "une décision prise ne se rejuge pas parce que la fiche a changé de pôle").toBe("AD_PRO");
    expect(tranche?.etat).toBe("VALIDE");
  });

  describe("Adam — la même règle, par la conversation", () => {
    it("la carte n'est offerte qu'à qui peut modifier les DEUX modules, et dit ce qui bouge", async () => {
      const c = await contrat("adam");
      const refus = await buildProposal("consulting_operation", { op: "transfer_contract", reference: c.reference, pole: "RH" }, await actorFor(pmId, "PRODUCT_MANAGER"));
      expect("error" in refus && refus.error).toMatch(/pas le droit/);

      const p = await buildProposal("consulting_operation", { op: "transfer_contract", reference: c.reference, pole: "ressources humaines" }, await actorFor(dirId, "DIRECTION"));
      expect("error" in p, "error" in p ? p.error : "").toBe(false);
      if (!("error" in p)) {
        expect(p.title).toMatch(/vers Ressources humaines/);
        const args = (p.payload as { args: Record<string, string> }).args;
        expect(args).toEqual({ id: c.id, vers: "RH" });
        expect(p.warnings?.join(" ")).toMatch(/Rien n'est perdu/);
      }
    });

    it("une phrase qui nomme les DEUX pôles est redemandée, jamais tranchée", async () => {
      const c = await contrat("adam-flou");
      const p = await buildProposal("consulting_operation", { op: "transfer_contract", reference: c.reference, pole: "du RH vers Ad&Pro" }, await actorFor(dirId, "DIRECTION"));
      expect("error" in p && p.error).toMatch(/Vers quel pôle/);
    });

    it("la désignation d'un contrat passe par la PORTÉE : la promotion ne retrouve pas, même comme candidat, un contrat RH", async () => {
      const c = await contrat("adam-rh", { pole: "RH" });
      const p = await buildProposal("consulting_operation", { op: "close_contract", reference: c.reference }, await actorFor(pmId, "PRODUCT_MANAGER"));
      expect("error" in p && p.error).toMatch(/dans votre périmètre/);
      expect("error" in p && p.error, "le refus révélerait l'intitulé du contrat").not.toMatch(new RegExp(c.title));
    });
  });
});
