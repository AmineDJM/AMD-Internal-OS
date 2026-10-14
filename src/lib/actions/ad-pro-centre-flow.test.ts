import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));

import { prisma } from "@/lib/prisma";
import { getAccess, userCan, type SessionUser } from "@/lib/rbac";
import { seuilAdProEnVigueur, lireVisaAdPro, poserVisaAdPro } from "@/lib/ad-pro/visa";
import { demandesAuCentreAdPro } from "@/lib/queries/ad-pro-centre";
import { requestConsultingValidation, decideConsultingContract } from "./consulting-actions";
import { deciderVisaCentreAdPro } from "./ad-pro-centre-actions";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__centreadpro__";

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
 * LE CENTRE DE BOUT EN BOUT, PAR LES VRAIS POINTS D'ENTRÉE (§118.14).
 *
 * Les modules purs disent ce que la règle CALCULE. Ce banc dit la seule chose qui compte : si
 * quelqu'un utilise l'ERP normalement, un engagement au-dessus du seuil s'arrête-t-il, et
 * repart-il quand le centre l'a autorisé ? Un banc qui partirait d'un visa injecté à la main ne
 * répondrait pas à la question.
 *
 * LES DEUX MOITIÉS, et la seconde est celle qui protège : le centre BLOQUE au-dessus du seuil,
 * et il ne bloque RIEN en dessous. Sans ce second cas, le banc passerait au vert sur un centre
 * qui arrête tout le pôle Ad & Pro — un refus à tort coûte plus cher que le défaut (§118.27).
 *
 * LE SEUIL N'EST PAS ÉCRIT : `AppSetting` est un réglage GLOBAL et la suite tourne en parallèle
 * sur une seule base (§118.115, §118.132). On LIT le seuil en vigueur et on choisit les montants
 * par rapport à lui. La prémisse est donc ASSERTÉE : avec la porte désarmée (seuil nul), tous les
 * cas passeraient au vert sans rien garder — c'est le défaut exact de §118.104.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Centre de validation Ad & Pro — le flux réel", () => {
  let seuil = 0;
  let auDessus = 0, enDessous = 0;
  let porteurId = "", pdgId = "", directionId = "";
  const refs: string[] = [];

  const creerContrat = async (suffix: string, amount: number) => {
    const reference = `${TAG}${suffix}`;
    refs.push(reference);
    return prisma.consultingContract.create({
      data: {
        reference, title: `${TAG} ${suffix}`, counterparty: `${TAG} prestataire`,
        amount, status: "DRAFT", requesterId: porteurId, createdById: porteurId,
      },
    });
  };

  beforeAll(async () => {
    const lu = await seuilAdProEnVigueur();
    expect(
      lu,
      "PRÉMISSE : ce banc mesure la PORTE du centre. Avec un seuil nul, la porte est désarmée et "
      + "tous les cas passeraient au vert sans rien garder (§118.104). Régler AppSetting.adProDgThreshold.",
    ).not.toBeNull();
    seuil = lu as number;
    auDessus = seuil * 5;
    enDessous = Math.max(1, Math.floor(seuil / 10));

    const mk = (s: string, role: SessionUser["role"]) =>
      prisma.user.create({ data: { name: `${TAG}${s}`, email: `${TAG}${s}@t.dz`, role, passwordHash: "x" } });
    const [porteur, pdg, direction] = await Promise.all([
      mk("porteur", "SUPER_ADMIN"), mk("pdg", "GENERAL_MANAGER"), mk("direction", "DIRECTION"),
    ]);
    porteurId = porteur.id; pdgId = pdg.id; directionId = direction.id;

    // PRÉMISSE de la garde de siège : la Direction doit pouvoir TRANCHER un consulting, sinon son
    // refus au centre viendrait de son droit métier et non du siège (§118.104).
    const acteurDirection = await actorFor(directionId, "DIRECTION");
    expect(
      userCan(acteurDirection, "CONSULTING", "VALIDATE"),
      "PRÉMISSE : la Direction tranche les consultings ; c'est le SIÈGE qui doit la refuser au centre.",
    ).toBe(true);
  });

  afterAll(async () => {
    await prisma.adProGateVisa.deleteMany({
      where: { entityId: { in: (await prisma.consultingContract.findMany({
        where: { reference: { startsWith: TAG } }, select: { id: true },
      })).map((c) => c.id) } },
    }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actor: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.consultingTask.deleteMany({ where: { contract: { reference: { startsWith: TAG } } } }).catch(() => {});
    await prisma.consultingContract.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("AU-DESSUS du seuil : la soumission POSE le visa, et la décision est BLOQUÉE", async () => {
    const c = await creerContrat("bloque", auDessus);

    ACTOR = await actorFor(porteurId, "SUPER_ADMIN");
    const soumis = await requestConsultingValidation(form({ id: c.id, validatorId: directionId }));
    expect(soumis.ok, soumis.error).toBe(true);
    expect(await lireVisaAdPro("CONSULTING_CONTRACT", c.id)).toBe("PENDING");

    // Le validateur DÉSIGNÉ, qui a le droit métier, est arrêté par la porte du centre.
    ACTOR = await actorFor(directionId, "DIRECTION");
    const decision = await decideConsultingContract(form({ id: c.id, approve: "1" }));
    expect(decision.ok).toBe(false);
    expect(decision.error).toMatch(/centre de validation/i);

    // Et le contrat n'a PAS bougé : un blocage qui laisse l'écriture passer est un faux blocage.
    const apres = await prisma.consultingContract.findUniqueOrThrow({ where: { id: c.id } });
    expect(apres.status).not.toBe("APPROVED");
  });

  it("le centre AFFICHE la demande, avec son montant et le seuil qui l'y a envoyée", async () => {
    const lignes = await demandesAuCentreAdPro();
    const mienne = lignes.find((l) => l.reference?.startsWith(`${TAG}bloque`));
    expect(mienne, "la demande bloquée doit apparaître au centre").toBeTruthy();
    expect(mienne!.forme).toBe("VISA_CENTRE");
    expect(mienne!.montant).toBe(auDessus);
    expect(mienne!.seuil).toBe(seuil);
    expect(mienne!.kind).toBe("CONSULTING");
  });

  it("le SIÈGE est la garde : la Direction est refusée, la Direction Générale décide", async () => {
    const c = await prisma.consultingContract.findFirstOrThrow({
      where: { reference: { startsWith: `${TAG}bloque` } },
    });
    const champs = { entityType: "CONSULTING_CONTRACT", entityId: c.id, approve: "1", note: "" };

    ACTOR = await actorFor(directionId, "DIRECTION");
    const refuse = await deciderVisaCentreAdPro(form(champs));
    expect(refuse.ok).toBe(false);
    expect(refuse.error).toMatch(/Direction Générale|Super Admin/);
    // Le refus n'a RIEN écrit : une garde qui refuse après avoir écrit ne garde rien.
    expect(await lireVisaAdPro("CONSULTING_CONTRACT", c.id)).toBe("PENDING");

    ACTOR = await actorFor(pdgId, "GENERAL_MANAGER");
    const ok = await deciderVisaCentreAdPro(form({ ...champs, note: "Engagement justifié." }));
    expect(ok.ok, ok.error).toBe(true);
    expect(await lireVisaAdPro("CONSULTING_CONTRACT", c.id)).toBe("APPROVED");
  });

  it("le visa autorisé DÉBLOQUE la décision, et la demande quitte le centre", async () => {
    const c = await prisma.consultingContract.findFirstOrThrow({
      where: { reference: { startsWith: `${TAG}bloque` } },
    });

    ACTOR = await actorFor(directionId, "DIRECTION");
    const decision = await decideConsultingContract(form({ id: c.id, approve: "1" }));
    expect(decision.ok, decision.error).toBe(true);

    const lignes = await demandesAuCentreAdPro();
    expect(lignes.some((l) => l.reference?.startsWith(`${TAG}bloque`))).toBe(false);
  });

  /**
   * UNE ATTESTATION NE SE REJOUE PAS. Repasser sur un visa tranché doit être refusé en NOMMANT la
   * décision : l'écraser en silence effacerait la décision d'une personne, et l'audit dirait
   * qu'une autre a été prise.
   */
  it("un visa DÉJÀ tranché est refusé, sans être réécrit", async () => {
    const c = await prisma.consultingContract.findFirstOrThrow({
      where: { reference: { startsWith: `${TAG}bloque` } },
    });
    ACTOR = await actorFor(pdgId, "GENERAL_MANAGER");
    const r = await deciderVisaCentreAdPro(form({
      entityType: "CONSULTING_CONTRACT", entityId: c.id, approve: "0", note: "Je change d'avis.",
    }));
    expect(r.ok).toBe(false);
    expect(await lireVisaAdPro("CONSULTING_CONTRACT", c.id)).toBe("APPROVED");
  });

  it("un REFUS sans motif est refusé — c'est ce motif que le demandeur lira", async () => {
    const c = await creerContrat("sansmotif", auDessus);
    ACTOR = await actorFor(porteurId, "SUPER_ADMIN");
    expect((await requestConsultingValidation(form({ id: c.id, validatorId: directionId }))).ok).toBe(true);

    ACTOR = await actorFor(pdgId, "GENERAL_MANAGER");
    const r = await deciderVisaCentreAdPro(form({
      entityType: "CONSULTING_CONTRACT", entityId: c.id, approve: "0", note: "",
    }));
    expect(r.ok).toBe(false);
    expect(await lireVisaAdPro("CONSULTING_CONTRACT", c.id)).toBe("PENDING");
  });

  it("un visa REFUSÉ bloque DÉFINITIVEMENT, et le motif est dit", async () => {
    const c = await prisma.consultingContract.findFirstOrThrow({
      where: { reference: { startsWith: `${TAG}sansmotif` } },
    });
    ACTOR = await actorFor(pdgId, "GENERAL_MANAGER");
    expect((await deciderVisaCentreAdPro(form({
      entityType: "CONSULTING_CONTRACT", entityId: c.id, approve: "0", note: "Hors budget 2026.",
    }))).ok).toBe(true);
    expect(await lireVisaAdPro("CONSULTING_CONTRACT", c.id)).toBe("REFUSED");

    ACTOR = await actorFor(directionId, "DIRECTION");
    const d = await decideConsultingContract(form({ id: c.id, approve: "1" }));
    expect(d.ok).toBe(false);
    expect(d.error).toMatch(/refus/i);
  });

  /**
   * LA MOITIÉ QUI PROTÈGE — sans elle, ce banc passerait au vert sur un centre qui arrête TOUT.
   */
  it("EN DESSOUS du seuil : aucun visa, et la décision passe sans détour", async () => {
    const c = await creerContrat("libre", enDessous);

    ACTOR = await actorFor(porteurId, "SUPER_ADMIN");
    expect((await requestConsultingValidation(form({ id: c.id, validatorId: directionId }))).ok).toBe(true);
    expect(await lireVisaAdPro("CONSULTING_CONTRACT", c.id)).toBeNull();

    ACTOR = await actorFor(directionId, "DIRECTION");
    const d = await decideConsultingContract(form({ id: c.id, approve: "1" }));
    expect(d.ok, d.error).toBe(true);

    const lignes = await demandesAuCentreAdPro();
    expect(lignes.some((l) => l.reference?.startsWith(`${TAG}libre`))).toBe(false);
  });

  it("un montant NON RENSEIGNÉ passe par le centre — on ne franchit pas un contrôle sur une absence", async () => {
    const c = await creerContrat("sansmontant", 0);
    await prisma.consultingContract.update({ where: { id: c.id }, data: { amount: null } });

    ACTOR = await actorFor(porteurId, "SUPER_ADMIN");
    expect((await requestConsultingValidation(form({ id: c.id, validatorId: directionId }))).ok).toBe(true);
    expect(await lireVisaAdPro("CONSULTING_CONTRACT", c.id)).toBe("PENDING");

    const mienne = (await demandesAuCentreAdPro()).find((l) => l.reference?.startsWith(`${TAG}sansmontant`));
    expect(mienne, "elle doit apparaître au centre").toBeTruthy();
    expect(mienne!.montant).toBeNull();
  });

  /**
   * LE SEUIL EST FIGÉ DANS LE VISA (§118.41). Sans lui, baisser le seuil rendrait la décision
   * passée inexplicable : le centre afficherait « 2 M au-dessus de 5 M », et personne ne pourrait
   * dire pourquoi la demande s'était arrêtée.
   */
  it("le visa GARDE le seuil qui l'a déclenché, et le montant tel qu'il était", async () => {
    const c = await prisma.consultingContract.findFirstOrThrow({
      where: { reference: { startsWith: `${TAG}bloque` } },
    });
    const v = await prisma.adProGateVisa.findUniqueOrThrow({
      where: { entityType_entityId: { entityType: "CONSULTING_CONTRACT", entityId: c.id } },
    });
    expect(Number(v.threshold)).toBe(seuil);
    expect(Number(v.amount)).toBe(auDessus);
    expect(v.decidedById).toBe(pdgId);
    expect(v.decidedAt).not.toBeNull();
    expect(v.note).toBe("Engagement justifié.");
  });

  /**
   * LE SEUIL FIGÉ, SUR UN CAS QUI PEUT LE DISTINGUER DU RÉGLAGE DU JOUR.
   *
   * L'assertion précédente ne pouvait PAS tomber : le visa vient d'être posé avec le réglage en
   * vigueur, donc le seuil figé et le réglage du jour sont le MÊME nombre, et toutes les façons
   * fausses de le lire sont vraies. C'est §118.117 mot pour mot — une assertion ne prouve rien
   * tant que le jeu d'essai n'a qu'un seul terme. Mesuré : le sabotage « le centre lit le seuil
   * DU JOUR » passait au vert.
   *
   * On écrit donc un visa dont le seuil DIFFÈRE, sans toucher au réglage global (`AppSetting` est
   * partagé et la suite tourne en parallèle, §118.115). Le chemin d'ÉCRITURE du seuil figé est
   * prouvé par l'assertion du dessus, celui de LECTURE par celle-ci.
   */
  it("le centre affiche le seuil FIGÉ du visa, pas le réglage du jour", async () => {
    const c = await creerContrat("seuilfige", auDessus);
    // Un visa n'existe que sur un contrat SOUMIS (la porte se pose à la soumission) : le décor le
    // dit, sans quoi la lentille — qui ne montre que les demandes qui attendent encore leur décision
    // (audit 360°, lot C3) — écarterait à raison un brouillon porteur d'un visa impossible.
    await prisma.consultingContract.update({ where: { id: c.id }, data: { status: "AWAITING_VALIDATION" } });
    const seuilDAutrefois = seuil * 3;
    expect(seuilDAutrefois, "le cas doit pouvoir discriminer").not.toBe(seuil);

    await prisma.adProGateVisa.create({
      data: {
        entityType: "CONSULTING_CONTRACT", entityId: c.id, status: "PENDING",
        threshold: seuilDAutrefois, amount: auDessus,
      },
    });

    const mienne = (await demandesAuCentreAdPro()).find((l) => l.reference?.startsWith(`${TAG}seuilfige`));
    expect(mienne, "la ligne doit apparaître au centre").toBeTruthy();
    expect(mienne!.seuil).toBe(seuilDAutrefois);
    expect(mienne!.seuil).not.toBe(seuil);
  });

  /**
   * L'IDEMPOTENCE DU VISA — et ce que ce banc N'A PAS pu exercer par la porte normale.
   *
   * MESURÉ sur la machine à états du consulting : `AWAITING_VALIDATION` n'accepte ni `SUBMIT`, et
   * la nature « autre » pose son visa à la CRÉATION. AUCUN chemin de production ne rappelle donc
   * `poserVisaAdPro` sur une entité dont le visa est déjà tranché — la garde protège un appelant
   * FUTUR et la course entre deux soumissions simultanées.
   *
   * On l'exerce donc sur le module lui-même, et on l'ÉCRIT : prétendre l'avoir vérifiée par le
   * vrai point d'entrée serait le faux succès appliqué à son propre travail (§118.82).
   */
  it("repasser par la porte ne RÉOUVRE pas un visa tranché (exercé sur le module)", async () => {
    const c = await creerContrat("idempotent", auDessus);
    ACTOR = await actorFor(porteurId, "SUPER_ADMIN");
    expect((await requestConsultingValidation(form({ id: c.id, validatorId: directionId }))).ok).toBe(true);

    ACTOR = await actorFor(pdgId, "GENERAL_MANAGER");
    expect((await deciderVisaCentreAdPro(form({
      entityType: "CONSULTING_CONTRACT", entityId: c.id, approve: "1", note: "Accordé.",
    }))).ok).toBe(true);

    const avant = await prisma.adProGateVisa.findUniqueOrThrow({
      where: { entityType_entityId: { entityType: "CONSULTING_CONTRACT", entityId: c.id } },
    });
    // Le second passage rend l'état EXISTANT et ne touche à rien.
    expect(await poserVisaAdPro("CONSULTING_CONTRACT", c.id, auDessus)).toBe("APPROVED");
    const apres = await prisma.adProGateVisa.findUniqueOrThrow({
      where: { entityType_entityId: { entityType: "CONSULTING_CONTRACT", entityId: c.id } },
    });
    expect(apres.status).toBe("APPROVED");
    expect(apres.decidedById).toBe(avant.decidedById);
    expect(apres.decidedAt?.getTime()).toBe(avant.decidedAt?.getTime());
    expect(apres.note).toBe(avant.note);
  });
});
