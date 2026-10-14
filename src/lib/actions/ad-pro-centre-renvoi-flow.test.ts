import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));

import { prisma } from "@/lib/prisma";
import { getAccess, userCan, type SessionUser } from "@/lib/rbac";
import { canAccessEntity } from "@/lib/entity-access";
import { seuilAdProEnVigueur, lireVisaAdPro } from "@/lib/ad-pro/visa";
import { REFUS_CENTRE_AD_PRO } from "@/lib/ad-pro/centre";
import { demandesAuCentreAdPro, visasTranchesCentreAdPro, peutResoumettreAuCentre } from "@/lib/queries/ad-pro-centre";
import { porteDuBC } from "@/lib/bons-de-commande/aiguillage";
import { requestConsultingValidation, decideConsultingContract, closeConsultingContract } from "./consulting-actions";
import { createAdProOtherRequest, decideAdProOtherRequest, closeAdProOtherRequest } from "./ad-pro-other-actions";
import { createLegalDocument, updateLegalDocument } from "./legal-actions";
import { deciderVisaCentreAdPro, reexaminerVisaCentreAdPro, resoumettreAuCentreAdPro } from "./ad-pro-centre-actions";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__centrerenvoi__";

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
 * LE CENTRE AD & PRO SAIT FAIRE CORRIGER — par les VRAIS points d'entrée (audit 360°, R07/R10).
 *
 * Le centre ne savait que valider ou refuser définitivement, et un refus était une impasse : la
 * demande restait arrêtée pour toujours, alors que le code annonçait « c'est au centre de la
 * revoir ». Ce banc joue ce qu'une personne fait : soumettre au-dessus du seuil, se voir RENVOYER
 * la demande avec ce qu'il faut corriger, la corriger et la RESOUMETTRE ; voir un siège RÉEXAMINER
 * un refus ; et deux sièges trancher à la même seconde sans que l'un écrase l'autre.
 *
 * LE DEMANDEUR est la Direction Marketing — elle porte des contrats et n'a aucun siège : un Super
 * Admin porteur rendrait vraies les gardes de siège quoi qu'il arrive (§118.104). LE SEUIL n'est pas
 * écrit (réglage global, suite parallèle — §118.132) : on le lit, et la prémisse est assertée.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Centre Ad & Pro — renvoyer, resoumettre, réexaminer (flux réel)", () => {
  let auDessus = 0, enDessous = 0;
  let porteurId = "", pdgId = "", saId = "", directionId = "", delegueId = "", legalId = "", contactId = "", eventId = "";
  const docs: string[] = [];

  const creerEtSoumettre = async (suffix: string, amount: number) => {
    const c = await prisma.consultingContract.create({
      data: {
        reference: `${TAG}${suffix}`, title: `${TAG} ${suffix}`, counterparty: `${TAG} cabinet`,
        amount, status: "DRAFT", requesterId: porteurId, createdById: porteurId,
      },
    });
    ACTOR = await actorFor(porteurId, "PRODUCT_MANAGER");
    const r = await requestConsultingValidation(form({ id: c.id, validatorId: directionId }));
    expect(r.ok, r.error).toBe(true);
    expect(await lireVisaAdPro("CONSULTING_CONTRACT", c.id), "PRÉMISSE : au-dessus du seuil, la soumission pose la porte").toBe("PENDING");
    return c.id;
  };
  const decider = async (actorId: string, role: SessionUser["role"], entityType: string, entityId: string, decision: string, note = "") => {
    ACTOR = await actorFor(actorId, role);
    return deciderVisaCentreAdPro(form({ entityType, entityId, decision, note }));
  };
  const resoumettre = async (actorId: string, role: SessionUser["role"], entityType: string, entityId: string, champs: Record<string, string>) => {
    ACTOR = await actorFor(actorId, role);
    return resoumettreAuCentreAdPro(form({ entityType, entityId, ...champs }));
  };
  const visa = (entityType: "CONSULTING_CONTRACT" | "AD_PRO_OTHER" | "LEGAL_DOCUMENT", entityId: string) =>
    prisma.adProGateVisa.findUnique({ where: { entityType_entityId: { entityType, entityId } } });
  const montantDuContrat = async (id: string) =>
    Number((await prisma.consultingContract.findUniqueOrThrow({ where: { id }, select: { amount: true } })).amount);

  /** Attendre que `n` sessions soient bloquées sur un verrou dont la requête nomme `motif`. */
  async function attendreBloques(tx: Prisma.TransactionClient, motif: string, n: number) {
    const debut = Date.now();
    for (;;) {
      await tx.$executeRawUnsafe("SELECT pg_stat_clear_snapshot()");
      const [{ k }] = await tx.$queryRaw<{ k: number }[]>`
        SELECT count(*)::int AS k FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock' AND query ILIKE ANY(${[`%${motif}%`]}::text[])`;
      if (k >= n) return;
      if (Date.now() - debut > 10_000) throw new Error(`${k} geste(s) bloqué(s) sur ${motif}, ${n} attendu(s)`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  beforeAll(async () => {
    const seuil = await seuilAdProEnVigueur();
    expect(seuil, "PRÉMISSE : avec un seuil nul, la porte est désarmée et rien ne serait mesuré (§118.104).").not.toBeNull();
    auDessus = (seuil as number) * 5;
    enDessous = Math.max(1, Math.floor((seuil as number) / 10));

    const mk = (s: string, role: SessionUser["role"]) =>
      prisma.user.create({ data: { name: `${TAG}${s}`, email: `${TAG}${s}@t.dz`, role, passwordHash: "x" } });
    const [porteur, pdg, sa, direction, delegue, legal] = await Promise.all([
      mk("porteur", "PRODUCT_MANAGER"), mk("pdg", "GENERAL_MANAGER"), mk("sa", "SUPER_ADMIN"),
      mk("direction", "DIRECTION"), mk("delegue", "MEDICAL_DELEGATE"), mk("legal", "DIRECTION_ASSISTANT"),
    ]);
    porteurId = porteur.id; pdgId = pdg.id; saId = sa.id; directionId = direction.id; delegueId = delegue.id; legalId = legal.id;
    contactId = (await prisma.companyContact.create({ data: { name: `${TAG} Imprimerie`, companyId: null } })).id;
    eventId = (await prisma.event.create({
      data: { name: `${TAG} Journée`, requesterId: delegueId, startDate: new Date("2026-11-02") }, select: { id: true },
    })).id;
  });

  afterAll(async () => {
    const contrats = (await prisma.consultingContract.findMany({ where: { reference: { startsWith: TAG } }, select: { id: true } })).map((c) => c.id);
    const autres = (await prisma.adProOtherRequest.findMany({ where: { title: { startsWith: TAG } }, select: { id: true } })).map((c) => c.id);
    await prisma.adProGateVisa.deleteMany({ where: { entityId: { in: [...contrats, ...autres, ...docs] } } }).catch(() => {});
    const vIds = (await prisma.validationRequest.findMany({ where: { entityType: "LEGAL_DOCUMENT", entityId: { in: docs } }, select: { id: true } })).map((v) => v.id);
    await prisma.validationStep.deleteMany({ where: { requestId: { in: vIds } } }).catch(() => {});
    await prisma.validationRequest.deleteMany({ where: { id: { in: vIds } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { entityId: { in: [...contrats, ...autres, ...docs] } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actor: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { id: { in: docs } } }).catch(() => {});
    await prisma.consultingTask.deleteMany({ where: { contractId: { in: contrats } } }).catch(() => {});
    await prisma.consultingContract.deleteMany({ where: { id: { in: contrats } } }).catch(() => {});
    await prisma.adProOtherRequest.deleteMany({ where: { id: { in: autres } } }).catch(() => {});
    await prisma.event.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.companyContact.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    const comptes = (await prisma.user.findMany({ where: { email: { startsWith: TAG } }, select: { id: true } })).map((c) => c.id);
    await prisma.notification.deleteMany({ where: { userId: { in: comptes } } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { userId: { in: comptes } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: comptes } } }).catch(() => {});
  });

  it("PRÉMISSES : le porteur a le consulting sans siège ; le délégué ne peut pas modifier la fiche, la Direction si", async () => {
    const porteur = await actorFor(porteurId, "PRODUCT_MANAGER");
    expect(userCan(porteur, "CONSULTING", "VIEW"), "sans le module, le porteur ne soumettrait rien").toBe(true);
    expect(userCan(porteur, "AD_PRO_OTHER", "CREATE")).toBe(true);
    expect(["SUPER_ADMIN", "GENERAL_MANAGER"]).not.toContain(porteur.role);
    const id = await creerEtSoumettre("premisses", auDessus);
    expect(await canAccessEntity(await actorFor(delegueId, "MEDICAL_DELEGATE"), "CONSULTING_CONTRACT", id, "UPDATE"),
      "le refus du délégué doit venir de la règle, pas d'un accès qu'il n'aurait pas eu de toute façon… et il n'a pas d'accès : c'est le témoin").toBe(false);
    expect(await canAccessEntity(await actorFor(directionId, "DIRECTION"), "CONSULTING_CONTRACT", id, "UPDATE")).toBe(true);
    const direction = await actorFor(directionId, "DIRECTION");
    expect(userCan(direction, "AD_PRO_OTHER", "VALIDATE"), "la Direction tranche les « autres demandes »").toBe(true);
  });

  it("RENVOYER exige ce qu'il faut corriger ; renvoyée, la demande ne passe pas, et son demandeur sait quoi faire", async () => {
    const id = await creerEtSoumettre("renvoi", auDessus);
    const sansMotif = await decider(pdgId, "GENERAL_MANAGER", "CONSULTING_CONTRACT", id, "RENVOYER", "");
    expect(sansMotif.ok).toBe(false);
    expect(sansMotif.error).toMatch(/Indiquez ce qu'il faut corriger/);
    expect((await visa("CONSULTING_CONTRACT", id))?.status, "un renvoi refusé ne touche à rien").toBe("PENDING");

    const r = await decider(pdgId, "GENERAL_MANAGER", "CONSULTING_CONTRACT", id, "RENVOYER", "Joindre un devis comparatif.");
    expect(r.ok, r.error).toBe(true);
    const v = await visa("CONSULTING_CONTRACT", id);
    expect(v?.status).toBe("CHANGES_REQUESTED");
    expect(v?.note).toBe("Joindre un devis comparatif.");
    expect(v?.decidedById).toBe(pdgId);

    const n = await prisma.notification.findFirst({ where: { userId: porteurId, link: { contains: id } }, orderBy: { createdAt: "desc" } });
    expect(n?.title).toMatch(/à corriger/);
    expect(n?.body).toMatch(/Joindre un devis comparatif/);
    expect(n?.body, "le geste qui la fait revenir est NOMMÉ").toMatch(/Resoumettre au centre/);

    ACTOR = await actorFor(directionId, "DIRECTION");
    const bloquee = await decideConsultingContract(form({ id, approve: "1" }));
    expect(bloquee.ok, "renvoyée, elle ne passe pas").toBe(false);
    expect(bloquee.error).toMatch(/demande une correction/);
  });

  it("RESOUMETTRE : le tiers sans droit est refusé, ce qui a été corrigé est exigé, un montant nul aussi — puis elle revient au centre avec sa correction", async () => {
    const id = await creerEtSoumettre("resoumet", auDessus);
    expect((await decider(pdgId, "GENERAL_MANAGER", "CONSULTING_CONTRACT", id, "RENVOYER", "Montant trop élevé.")).ok).toBe(true);

    const intrus = await resoumettre(delegueId, "MEDICAL_DELEGATE", "CONSULTING_CONTRACT", id, { note: "Je m'en charge." });
    expect(intrus.ok).toBe(false);
    expect(intrus.error).toMatch(/Seul le demandeur/);
    const sansNote = await resoumettre(porteurId, "PRODUCT_MANAGER", "CONSULTING_CONTRACT", id, { note: "" });
    expect(sansNote.error).toMatch(/Dites ce que vous avez corrigé/);
    const nul = await resoumettre(porteurId, "PRODUCT_MANAGER", "CONSULTING_CONTRACT", id, { note: "Remise.", amount: "0" });
    expect(nul.error).toMatch(/positif/);
    expect((await visa("CONSULTING_CONTRACT", id))?.status, "trois refus, rien d'écrit").toBe("CHANGES_REQUESTED");

    const corrige = auDessus - 1000;
    const ok = await resoumettre(porteurId, "PRODUCT_MANAGER", "CONSULTING_CONTRACT", id, { note: "Remise négociée.", amount: String(corrige) });
    expect(ok.ok, ok.error).toBe(true);
    const v = await visa("CONSULTING_CONTRACT", id);
    expect(v?.status).toBe("PENDING");
    expect(Number(v?.amount), "le centre revoit le montant CORRIGÉ").toBe(corrige);
    expect(await montantDuContrat(id), "et la fiche porte la correction").toBe(corrige);
    expect(v?.note).toMatch(/Remise négociée/);
    expect(v?.note, "le motif du renvoi reste lisible à côté de la correction").toMatch(/Montant trop élevé/);
    expect(v?.decidedById, "la décision d'hier est effacée de la ligne").toBeNull();
    const alerte = await prisma.notification.findFirst({ where: { userId: pdgId, title: { contains: "resoumise après correction" } }, orderBy: { createdAt: "desc" } });
    expect(alerte?.body).toMatch(/Remise négociée/);
    expect((await demandesAuCentreAdPro()).some((l) => l.entityId === id), "elle revient dans la file du centre").toBe(true);
  });

  it("corrigée SOUS le seuil : la porte est retirée, et le validateur tranche", async () => {
    const id = await creerEtSoumettre("sousseuil", auDessus);
    expect((await decider(saId, "SUPER_ADMIN", "CONSULTING_CONTRACT", id, "RENVOYER", "Ramener sous le seuil.")).ok).toBe(true);
    const r = await resoumettre(porteurId, "PRODUCT_MANAGER", "CONSULTING_CONTRACT", id, { note: "Périmètre réduit.", amount: String(enDessous) });
    expect(r.ok, r.error).toBe(true);
    expect(r.message).toMatch(/sous le seuil/);
    expect(await lireVisaAdPro("CONSULTING_CONTRACT", id), "la porte n'a plus d'objet").toBeNull();
    expect(await montantDuContrat(id)).toBe(enDessous);
    ACTOR = await actorFor(directionId, "DIRECTION");
    const d = await decideConsultingContract(form({ id, approve: "1" }));
    expect(d.ok, d.error).toBe(true);
    expect((await prisma.consultingContract.findUniqueOrThrow({ where: { id } })).status).toBe("ACTIVE");
  });

  it("une demande ANNULÉE ne se resoumet pas — et rien n'est écrit, ni le montant ni le visa", async () => {
    const id = await creerEtSoumettre("annule", auDessus);
    expect((await decider(pdgId, "GENERAL_MANAGER", "CONSULTING_CONTRACT", id, "RENVOYER", "À revoir.")).ok).toBe(true);
    ACTOR = await actorFor(porteurId, "PRODUCT_MANAGER");
    expect((await closeConsultingContract(form({ id, cancel: "1", note: "Projet abandonné." }))).ok).toBe(true);
    const r = await resoumettre(porteurId, "PRODUCT_MANAGER", "CONSULTING_CONTRACT", id, { note: "Finalement si.", amount: String(auDessus * 2) });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/n'attend plus de décision/);
    expect((await visa("CONSULTING_CONTRACT", id))?.status, "le visa n'a pas bougé : la transaction a reculé").toBe("CHANGES_REQUESTED");
    expect(await montantDuContrat(id), "le montant non plus").toBe(auDessus);
  });

  it("annulée pendant qu'elle attendait le centre : sa porte est RETIRÉE, et une porte d'avant ne se tranche plus", async () => {
    const id = await creerEtSoumettre("morte", auDessus);
    ACTOR = await actorFor(porteurId, "PRODUCT_MANAGER");
    expect((await closeConsultingContract(form({ id, cancel: "1", note: "Projet abandonné." }))).ok).toBe(true);
    expect(await lireVisaAdPro("CONSULTING_CONTRACT", id), "l'annulation retire la porte en attente").toBeNull();

    // Une porte qu'une annulation d'AVANT ce lot a laissée — l'état exact d'une base de production.
    await prisma.adProGateVisa.create({ data: { entityType: "CONSULTING_CONTRACT", entityId: id, status: "PENDING", threshold: 1, amount: auDessus } });
    expect((await demandesAuCentreAdPro()).some((l) => l.entityId === id), "la lentille ne montre pas une demande morte").toBe(false);
    const forge = await decider(pdgId, "GENERAL_MANAGER", "CONSULTING_CONTRACT", id, "VALIDER");
    expect(forge.ok).toBe(false);
    expect(forge.error).toMatch(/n'attend plus de décision/);
    expect((await visa("CONSULTING_CONTRACT", id))?.status).toBe("PENDING");
  });

  it("qui peut MODIFIER la fiche resoumet aussi — l'écran et l'action lisent la MÊME règle", async () => {
    const id = await creerEtSoumettre("tiers", auDessus);
    expect((await decider(pdgId, "GENERAL_MANAGER", "CONSULTING_CONTRACT", id, "RENVOYER", "Préciser la mission.")).ok).toBe(true);
    expect(await peutResoumettreAuCentre(await actorFor(porteurId, "PRODUCT_MANAGER"), "CONSULTING_CONTRACT", id)).toBe(true);
    expect(await peutResoumettreAuCentre(await actorFor(directionId, "DIRECTION"), "CONSULTING_CONTRACT", id)).toBe(true);
    expect(await peutResoumettreAuCentre(await actorFor(delegueId, "MEDICAL_DELEGATE"), "CONSULTING_CONTRACT", id)).toBe(false);
    const r = await resoumettre(directionId, "DIRECTION", "CONSULTING_CONTRACT", id, { note: "Mission précisée avec le porteur." });
    expect(r.ok, r.error).toBe(true);
    expect((await visa("CONSULTING_CONTRACT", id))?.status).toBe("PENDING");
    expect(await montantDuContrat(id), "sans montant saisi, le montant ne bouge pas").toBe(auDessus);
  });

  it("« autre demande », par la VRAIE création : renvoyée, bloquée pour la Direction, resoumise sous le seuil, tranchée", async () => {
    ACTOR = await actorFor(porteurId, "PRODUCT_MANAGER");
    const cree = await createAdProOtherRequest(undefined, form({ title: `${TAG} autre`, description: "Prestation ponctuelle.", amount: String(auDessus) }));
    expect(cree.ok, cree.error).toBe(true);
    const id = cree.id!;
    expect(await lireVisaAdPro("AD_PRO_OTHER", id)).toBe("PENDING");
    expect((await decider(saId, "SUPER_ADMIN", "AD_PRO_OTHER", id, "RENVOYER", "Fractionner la prestation.")).ok).toBe(true);
    ACTOR = await actorFor(directionId, "DIRECTION");
    const bloquee = await decideAdProOtherRequest(form({ id, approve: "1" }));
    expect(bloquee.ok).toBe(false);
    expect(bloquee.error).toMatch(/demande une correction/);
    const r = await resoumettre(porteurId, "PRODUCT_MANAGER", "AD_PRO_OTHER", id, { note: "Première tranche seulement.", amount: String(enDessous) });
    expect(r.ok, r.error).toBe(true);
    expect(await lireVisaAdPro("AD_PRO_OTHER", id)).toBeNull();
    ACTOR = await actorFor(directionId, "DIRECTION");
    const d = await decideAdProOtherRequest(form({ id, approve: "1" }));
    expect(d.ok, d.error).toBe(true);

    // ANNULÉE pendant qu'elle attend le centre : sa porte est retirée, comme au consulting.
    ACTOR = await actorFor(porteurId, "PRODUCT_MANAGER");
    const autre = await createAdProOtherRequest(undefined, form({ title: `${TAG} autre annulée`, description: "Finalement non.", amount: String(auDessus) }));
    expect(autre.ok, autre.error).toBe(true);
    expect(await lireVisaAdPro("AD_PRO_OTHER", autre.id!)).toBe("PENDING");
    expect((await closeAdProOtherRequest(form({ id: autre.id!, cancel: "1", note: "Finalement non." }))).ok).toBe(true);
    expect(await lireVisaAdPro("AD_PRO_OTHER", autre.id!), "le centre ne trancherait plus qu'une demande morte").toBeNull();
  });

  it("RÉEXAMINER : un siège seulement, motif exigé, un refus seulement — et une demande annulée ne revient pas dans la file", async () => {
    const id = await creerEtSoumettre("reexam", auDessus);
    expect((await decider(pdgId, "GENERAL_MANAGER", "CONSULTING_CONTRACT", id, "REFUSER", "Hors budget.")).ok).toBe(true);
    expect((await visa("CONSULTING_CONTRACT", id))?.status).toBe("REFUSED");

    ACTOR = await actorFor(porteurId, "PRODUCT_MANAGER");
    const pasSiege = await reexaminerVisaCentreAdPro(form({ entityType: "CONSULTING_CONTRACT", entityId: id, note: "S'il vous plaît." }));
    expect(pasSiege.error).toBe(REFUS_CENTRE_AD_PRO);
    ACTOR = await actorFor(pdgId, "GENERAL_MANAGER");
    const sansNote = await reexaminerVisaCentreAdPro(form({ entityType: "CONSULTING_CONTRACT", entityId: id, note: "" }));
    expect(sansNote.error).toMatch(/Dites pourquoi/);
    const ok = await reexaminerVisaCentreAdPro(form({ entityType: "CONSULTING_CONTRACT", entityId: id, note: "Budget complémentaire obtenu." }));
    expect(ok.ok, ok.error).toBe(true);
    const v = await visa("CONSULTING_CONTRACT", id);
    expect(v?.status).toBe("PENDING");
    expect(v?.note).toBe("Réexamen : Budget complémentaire obtenu.");
    const n = await prisma.notification.findFirst({ where: { userId: porteurId, title: { contains: "réexaminée" }, link: { contains: id } } });
    expect(n, "le demandeur apprend que le centre reprend sa décision").not.toBeNull();
    const encore = await reexaminerVisaCentreAdPro(form({ entityType: "CONSULTING_CONTRACT", entityId: id, note: "Bis." }));
    expect(encore.error).toMatch(/Seul un refus/);

    // Un refus sur une demande ANNULÉE ne se réexamine pas — sans quoi elle reviendrait dans la file.
    const morte = await creerEtSoumettre("reexammorte", auDessus);
    expect((await decider(pdgId, "GENERAL_MANAGER", "CONSULTING_CONTRACT", morte, "REFUSER", "Non.")).ok).toBe(true);
    ACTOR = await actorFor(porteurId, "PRODUCT_MANAGER");
    expect((await closeConsultingContract(form({ id: morte, cancel: "1", note: "Projet abandonné." }))).ok).toBe(true);
    ACTOR = await actorFor(pdgId, "GENERAL_MANAGER");
    const r = await reexaminerVisaCentreAdPro(form({ entityType: "CONSULTING_CONTRACT", entityId: morte, note: "On revoit." }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/n'attend plus de décision/);
    expect((await visa("CONSULTING_CONTRACT", morte))?.status).toBe("REFUSED");
    const { lignes } = await visasTranchesCentreAdPro();
    expect(lignes.some((l) => l.entityId === morte), "la demande annulée n'est plus proposée au réexamen").toBe(false);
  });

  it("DEUX SIÈGES à la même seconde : une seule décision compte, l'autre apprend qu'elle a été prise", async () => {
    const id = await creerEtSoumettre("duel", auDessus);
    const pdg = await actorFor(pdgId, "GENERAL_MANAGER");
    const sa = await actorFor(saId, "SUPER_ADMIN");
    let gestes: Promise<{ ok: boolean; error?: string }>[] = [];
    // Le verrou SHARE arrête toute écriture de visa sans arrêter les lectures : chacun lit « en
    // attente » avant que l'autre n'écrive — sans l'écriture conditionnelle, le second écraserait le premier.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`LOCK TABLE "AdProGateVisa" IN SHARE MODE`);
      ACTOR = pdg;
      const a = deciderVisaCentreAdPro(form({ entityType: "CONSULTING_CONTRACT", entityId: id, decision: "VALIDER" }));
      ACTOR = sa;
      const b = deciderVisaCentreAdPro(form({ entityType: "CONSULTING_CONTRACT", entityId: id, decision: "REFUSER", note: "Pas cette année." }));
      gestes = [a, b];
      for (const g of gestes) g.catch(() => undefined);
      await attendreBloques(tx, "AdProGateVisa", 2);
    }, { timeout: 20_000 });
    const [a, b] = await Promise.all(gestes);
    expect([a.ok, b.ok].filter(Boolean), "une décision, pas deux").toHaveLength(1);
    const perdant = a.ok ? b : a;
    expect(perdant.error).toMatch(/vient d'être tranchée/);
    const v = await visa("CONSULTING_CONTRACT", id);
    expect(v?.status, "l'état final est celui du gagnant").toBe(a.ok ? "APPROVED" : "REFUSED");
    expect(v?.decidedById).toBe(a.ok ? pdgId : saId);
    const traces = await prisma.auditLog.count({ where: { entityType: "CONSULTING_CONTRACT", entityId: id, summary: { startsWith: "Centre Ad & Pro :" } } });
    expect(traces, "une seule décision au journal").toBe(1);
  });

  it("un BC du registre Legal renvoyé est « à revoir » ; il ne se resoumet pas d'un bouton — sa MODIFICATION le rend au centre", async () => {
    ACTOR = await actorFor(legalId, "DIRECTION_ASSISTANT");
    const cree = await createLegalDocument(undefined, form({
      title: `${TAG} BC`, reference: `${TAG}BC`, kind: "PURCHASE_ORDER", counterpartyIds: contactId, amount: "100000",
      sourceType: "EVENT", sourceId: eventId,
    }));
    expect(cree.ok, cree.ok === false ? cree.error : "").toBe(true);
    docs.push(cree.id!);
    expect(await porteDuBC(cree.id!)).toMatchObject({ centre: "AD_PRO", etat: "EN_ATTENTE" });

    expect((await decider(pdgId, "GENERAL_MANAGER", "LEGAL_DOCUMENT", cree.id!, "RENVOYER", "Corriger le fournisseur.")).ok).toBe(true);
    expect(await porteDuBC(cree.id!)).toMatchObject({ centre: "AD_PRO", etat: "A_REVOIR", note: "Corriger le fournisseur." });
    const n = await prisma.notification.findFirst({ where: { userId: legalId, link: { contains: cree.id! } }, orderBy: { createdAt: "desc" } });
    expect(n?.title).toMatch(/à corriger/);
    expect(n?.body).toMatch(/Modifiez le bon de commande dans Legal/);

    const bouton = await resoumettre(legalId, "DIRECTION_ASSISTANT", "LEGAL_DOCUMENT", cree.id!, { note: "Corrigé." });
    expect(bouton.ok).toBe(false);
    expect(bouton.error).toMatch(/se corrige dans Legal/);

    ACTOR = await actorFor(legalId, "DIRECTION_ASSISTANT");
    const modif = await updateLegalDocument(form({ id: cree.id!, title: `${TAG} BC`, kind: "PURCHASE_ORDER", counterpartyIds: contactId, amount: "100000" }));
    expect(modif.ok, modif.ok === false ? modif.error : "").toBe(true);
    expect(modif.message).toMatch(/renvoyé au/);
    const v = await visa("LEGAL_DOCUMENT", cree.id!);
    expect(v?.status).toBe("PENDING");
    expect(v?.note).toBe("Bon de commande corrigé à la demande du centre.");
  });
});
