import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { circuitStateOf, authoritiesOpen } from "@/lib/medical-info/circuit-state";
import {
  createMedicalInfoItem, addMedicalInfoSlip, removeMedicalInfoSlip, requestSlipsValidation,
  requestDeclareDecision, skipMedicalInfoBv, recordAuthorityDeclaration, validateDeclaration,
} from "./medical-info-actions";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__micirc__";

async function actorFor(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}

const form = (fields: Record<string, string>): FormData => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * DEUX CIRCUITS DANS L'INFORMATION MÉDICALE — et le bon de versement ne concerne que l'un.
 *
 * Le module traitait tout de la même façon : quoi qu'il arrive au pharmacien, il fallait un BON
 * DE VERSEMENT avant de pouvoir déclarer quoi que ce soit. Or cette taxe ne concerne QUE le
 * matériel promotionnel — chaque dossier d'événement sortait donc par la porte « ce dossier
 * n'appelle aucun versement », motif à l'appui. Un contournement obligatoire n'est plus une porte
 * de sortie : c'est le chemin normal mal nommé.
 *
 * Ces tests partent des VRAIS points d'entrée : les actions serveur que les boutons appellent.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Information médicale — deux circuits", () => {
  let primId = "", sponsoringDeclId = "";

  beforeAll(async () => {
    const prim = await prisma.user.create({
      data: { name: `${TAG}prim`, email: `${TAG}prim@t.dz`, role: "MEDICAL_INFO_PHARMACIST", passwordHash: "x" },
    });
    primId = prim.id;
    // Un dossier d'ÉVÉNEMENT, tel qu'il arrive d'un sponsoring validé par la Direction.
    const decl = await prisma.medicalInfoDeclaration.create({
      data: {
        reference: `DIM-2031-${Math.floor(Math.random() * 9000 + 1000)}`,
        sourceType: "SPONSORING", sourceId: `${TAG}src-${Math.random().toString(36).slice(2)}`,
        label: `${TAG} Congrès de cardiologie`, pharmacistId: primId,
      },
    });
    sponsoringDeclId = decl.id;
  });

  afterAll(async () => {
    const ids = (await prisma.medicalInfoDeclaration.findMany({
      where: { OR: [{ label: { startsWith: TAG } }, { createdById: primId }] }, select: { id: true },
    })).map((d) => d.id);
    await prisma.medicalInfoSlip.deleteMany({ where: { declarationId: { in: ids } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { entityType: "MEDICAL_INFO_DECLARATION", entityId: { in: ids } } }).catch(() => {});
    await prisma.medicalInfoDeclaration.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  describe("circuit ÉVÉNEMENT — la décision, sans aucun versement", () => {
    it("UN SPONSORING N'A RIEN À CONTOURNER : la porte « sans versement » lui est fermée", async () => {
      // C'était le défaut : elle était son chemin normal, et l'on finissait par ne plus lire les
      // motifs — qui sont pourtant là pour signaler l'exception.
      ACTOR = await actorFor(primId, "MEDICAL_INFO_PHARMACIST");
      const r = await skipMedicalInfoBv(form({ id: sponsoringDeclId, reason: "pas de taxe" }));
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/matériel promotionnel/i);
    });

    it("il n'y a pas non plus de matériel à y ajouter", async () => {
      ACTOR = await actorFor(primId, "MEDICAL_INFO_PHARMACIST");
      const r = await addMedicalInfoSlip(undefined, form({ declarationId: sponsoringDeclId, label: "Affiches" }));
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/matériel promotionnel/i);
    });

    it("LE DÉPÔT AU MINISTÈRE EST FERMÉ tant que la lecture n'est pas accordée", async () => {
      ACTOR = await actorFor(primId, "MEDICAL_INFO_PHARMACIST");
      const r = await recordAuthorityDeclaration(form({ id: sponsoringDeclId, authorityRef: "MIP-1" }));
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/décision/i);
      expect(authoritiesOpen(await circuitStateOf(
        await prisma.medicalInfoDeclaration.findUniqueOrThrow({ where: { id: sponsoringDeclId } }),
      ))).toBe(false);
    });

    it("UNE LECTURE « SANS DÉCLARATION » EXIGE SON MOTIF — c'est elle qui fait ne rien faire", async () => {
      ACTOR = await actorFor(primId, "MEDICAL_INFO_PHARMACIST");
      const r = await requestDeclareDecision(undefined, form({ id: sponsoringDeclId, intent: "SKIP" }));
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/pourquoi/i);
    });

    it("une intention absente est refusée : on ne devine pas ce que le pharmacien soumet", async () => {
      ACTOR = await actorFor(primId, "MEDICAL_INFO_PHARMACIST");
      const r = await requestDeclareDecision(undefined, form({ id: sponsoringDeclId, intent: "PEUT-ÊTRE" }));
      expect(r.ok).toBe(false);
    });

    it("LA DÉCISION ACCORDÉE OUVRE LE DÉPÔT, et la validation suit", async () => {
      // La reprise (`declareGrantedAt`) est ce que pose la migration pour les dossiers déjà
      // instruits ; on s'en sert ici pour atteindre l'état « accordée » sans monter un circuit de
      // validation complet, qui est éprouvé ailleurs.
      await prisma.medicalInfoDeclaration.update({
        where: { id: sponsoringDeclId },
        data: { declareIntent: "DECLARE", declareGrantedAt: new Date() },
      });
      ACTOR = await actorFor(primId, "MEDICAL_INFO_PHARMACIST");
      const depot = await recordAuthorityDeclaration(form({ id: sponsoringDeclId, authorityRef: "MIP-2031-004" }));
      expect(depot.ok, depot.error).toBe(true);

      const r = await validateDeclaration(form({ id: sponsoringDeclId }));
      expect(r.ok, r.error).toBe(true);
      expect((await prisma.medicalInfoDeclaration.findUniqueOrThrow({ where: { id: sponsoringDeclId } })).status)
        .toBe("AWAITING_DIRECTION");
    });
  });

  describe("circuit MATÉRIEL — un bon de versement par matériel", () => {
    let promoId = "";

    it("LE PHARMACIEN OUVRE LUI-MÊME UN DOSSIER, et la nature choisie décide du circuit", async () => {
      ACTOR = await actorFor(primId, "MEDICAL_INFO_PHARMACIST");
      const r = await createMedicalInfoItem(undefined, form({
        label: `${TAG} Campagne présentoirs`, kind: "AD_VISA", amount: "0",
      }));
      expect(r.ok, r.error).toBe(true);
      promoId = r.id!;
      const decl = await prisma.medicalInfoDeclaration.findUniqueOrThrow({ where: { id: promoId } });
      expect(decl.declarationKind).toBe("AD_VISA");
      expect(decl.createdById).toBe(primId);
      expect((await circuitStateOf(decl)).circuit).toBe("PROMO");
    });

    it("LE BON DE VERSEMENT NE S'OUVRE PLUS COMME UN DOSSIER — c'est une ÉTAPE, à l'intérieur", async () => {
      // Le PRIM choisissait entre trois natures dont l'une n'était pas de même nature que les
      // autres : « bon de versement » est ce qu'on AJOUTE dans un dossier de matériel, pas ce
      // qu'on ouvre. Le proposer produisait des dossiers vides, sans matériel, dont le bon
      // n'attendait rien. Il reste RECONNU en lecture (les dossiers historiques gardent leur
      // circuit) mais ne s'ouvre plus.
      ACTOR = await actorFor(primId, "MEDICAL_INFO_PHARMACIST");
      const r = await createMedicalInfoItem(undefined, form({ label: `${TAG} refus`, kind: "PAYMENT_SLIP" }));
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/bon de versement/i);
    });

    it("une nature inventée est refusée", async () => {
      ACTOR = await actorFor(primId, "MEDICAL_INFO_PHARMACIST");
      expect((await createMedicalInfoItem(undefined, form({ label: "x", kind: "AUTRE" }))).ok).toBe(false);
    });

    it("UNE LISTE VIDE NE PART PAS EN VALIDATION — ce serait faire signer une intention", async () => {
      ACTOR = await actorFor(primId, "MEDICAL_INFO_PHARMACIST");
      const r = await requestSlipsValidation(undefined, form({ id: promoId }));
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/matériels/i);
    });

    it("LE DOSSIER SE SÉPARE EN MATÉRIELS — un bon par matériel, chacun son montant", async () => {
      ACTOR = await actorFor(primId, "MEDICAL_INFO_PHARMACIST");
      for (const [label, amount] of [["Présentoir comptoir", "12000"], ["Affiches A2", "8000"], ["Vidéo", "25000"]]) {
        const r = await addMedicalInfoSlip(undefined, form({ declarationId: promoId, label, amount }));
        expect(r.ok, r.error).toBe(true);
      }
      const etat = await circuitStateOf(await prisma.medicalInfoDeclaration.findUniqueOrThrow({ where: { id: promoId } }));
      expect(etat.slips.map((s) => s.label)).toEqual(["Présentoir comptoir", "Affiches A2", "Vidéo"]);
      expect(etat.summary.announced).toBe(45_000);
      // Rien n'est remis : le dépôt au ministère reste fermé.
      expect(authoritiesOpen(etat)).toBe(false);
    });

    it("un matériel se retire tant que le dépôt n'est pas signé", async () => {
      const etat = await circuitStateOf(await prisma.medicalInfoDeclaration.findUniqueOrThrow({ where: { id: promoId } }));
      const video = etat.slips.find((s) => s.label === "Vidéo")!;
      ACTOR = await actorFor(primId, "MEDICAL_INFO_PHARMACIST");
      expect((await removeMedicalInfoSlip(form({ slipId: video.id }))).ok).toBe(true);
      const apres = await circuitStateOf(await prisma.medicalInfoDeclaration.findUniqueOrThrow({ where: { id: promoId } }));
      expect(apres.summary.count).toBe(2);
      expect(apres.summary.announced).toBe(20_000);
    });

    it("LA PORTE « SANS VERSEMENT » RESTE OUVERTE ICI — et elle exige toujours son motif", async () => {
      ACTOR = await actorFor(primId, "MEDICAL_INFO_PHARMACIST");
      expect((await skipMedicalInfoBv(form({ id: promoId, reason: "" }))).ok).toBe(false);
      const r = await skipMedicalInfoBv(form({ id: promoId, reason: "Supports fournis par l'agence, aucune taxe due." }));
      expect(r.ok, r.error).toBe(true);
      const etat = await circuitStateOf(await prisma.medicalInfoDeclaration.findUniqueOrThrow({ where: { id: promoId } }));
      expect(etat.skipped).toBe(true);
      // Et c'est cela — et rien d'autre — qui ouvre le dépôt sur ce circuit.
      expect(authoritiesOpen(etat)).toBe(true);
    });
  });
});
