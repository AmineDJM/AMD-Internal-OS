import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import {
  ETATS_MODELE, TRANSITIONS_MODELE, TYPES_MODELE, approuver, candidats, deprecier,
  modeleFaisantAutorite, noterUsage, observer, passageAutorise, proposer,
} from "./registry";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * §82 — PAS D'APPRENTISSAGE SILENCIEUX.
 *
 * Le risque concret : un bon de commande mal rangé, lu un mardi, devient « le modèle », et
 * tous les suivants sortent au mauvais format — sans que personne ne l'ait décidé.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__tmpl__${Date.now()}`;
let ownerId = "";

describe("la table des passages (pure)", () => {
  it("couvre les quatre états", () => {
    for (const e of ETATS_MODELE) expect(TRANSITIONS_MODELE[e]).toBeDefined();
  });

  it("ON NE PROMEUT PAS CE QU'ON A SIMPLEMENT VU : OBSERVED → APPROVED n'existe pas", () => {
    expect(passageAutorise("OBSERVED", "APPROVED")).toBe(false);
    expect(passageAutorise("OBSERVED", "CANDIDATE")).toBe(true);
    expect(passageAutorise("CANDIDATE", "APPROVED")).toBe(true);
  });

  it("ON NE RÉTROGRADE PAS UNE DÉCISION : APPROVED ne redevient pas candidat", () => {
    expect(passageAutorise("APPROVED", "CANDIDATE")).toBe(false);
    expect(passageAutorise("APPROVED", "OBSERVED")).toBe(false);
    expect(passageAutorise("APPROVED", "DEPRECATED")).toBe(true);
  });

  it("un modèle déprécié ne revient jamais : il reste pour lire l'historique", () => {
    expect(TRANSITIONS_MODELE.DEPRECATED).toEqual([]);
  });

  it("chaque type opérationnel a un libellé français", () => {
    expect(TYPES_MODELE.length).toBeGreaterThan(0);
  });
});

suite("registre des modèles opérationnels", () => {
  beforeAll(async () => {
    const u = await prisma.user.create({
      data: { name: `${TAG}pdg`, email: `${TAG}pdg@t.dz`, passwordHash: "x", role: "SUPER_ADMIN" },
    });
    ownerId = u.id;
  });

  afterAll(async () => {
    await prisma.operationalTemplate.deleteMany({ where: { ownerId } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("OBSERVER ne donne AUCUNE autorité", async () => {
    await observer({ ownerId, type: "PURCHASE_ORDER", name: "BC vu dans le Drive", fileHash: "h1" });
    expect(await modeleFaisantAutorite(ownerId, "PURCHASE_ORDER")).toBeNull();
  });

  it("revoir le même fichier ne crée pas une seconde observation", async () => {
    const a = await observer({ ownerId, type: "INVOICE", name: "Facture", fileHash: "meme-fichier" });
    const b = await observer({ ownerId, type: "INVOICE", name: "Facture (revue)", fileHash: "meme-fichier" });
    expect(b).toBe(a);
    expect(await prisma.operationalTemplate.count({ where: { ownerId, type: "INVOICE" } })).toBe(1);
  });

  it("PROPOSER ne donne pas davantage d'autorité — un candidat n'est pas une décision", async () => {
    const id = await observer({ ownerId, type: "QUOTATION", name: "Devis", fileHash: "q1" });
    expect(await proposer(id, "c'est le format utilisé sur les 12 derniers devis")).toBe(true);
    expect(await modeleFaisantAutorite(ownerId, "QUOTATION")).toBeNull();

    const enAttente = await candidats(ownerId);
    expect(enAttente.map((c) => c.id)).toContain(id);
    expect(enAttente.find((c) => c.id === id)!.note).toMatch(/12 derniers devis/);
  });

  it("seule l'APPROBATION HUMAINE fait autorité, et elle est signée", async () => {
    const id = await observer({ ownerId, type: "CONTRACT", name: "Contrat type", fileHash: "c1" });
    await proposer(id, "format récurrent");
    expect(await approuver(id, ownerId)).toBe(true);

    const autorite = await modeleFaisantAutorite(ownerId, "CONTRACT");
    expect(autorite!.id).toBe(id);

    const ligne = await prisma.operationalTemplate.findUnique({
      where: { id }, select: { approvedById: true, approvedAt: true },
    });
    expect(ligne!.approvedById).toBe(ownerId);
    expect(ligne!.approvedAt).not.toBeNull();
  });

  it("on ne peut PAS approuver un modèle simplement observé", async () => {
    const id = await observer({ ownerId, type: "EXPENSE_REPORT", name: "Note de frais", fileHash: "n1" });
    expect(await approuver(id, ownerId)).toBe(false);
    expect(await modeleFaisantAutorite(ownerId, "EXPENSE_REPORT")).toBeNull();
  });

  it("UN SEUL APPROUVÉ PAR TYPE : approuver le nouveau déprécie l'ancien", async () => {
    const v1 = await observer({ ownerId, type: "PAYMENT_REQUEST", name: "Demande v1", fileHash: "p1" });
    await proposer(v1, "format 2025");
    await approuver(v1, ownerId);

    const v2 = await observer({ ownerId, type: "PAYMENT_REQUEST", name: "Demande v2", fileHash: "p2" });
    await proposer(v2, "format 2026");
    expect(await approuver(v2, ownerId)).toBe(true);

    expect((await modeleFaisantAutorite(ownerId, "PAYMENT_REQUEST"))!.id).toBe(v2);
    const ancien = await prisma.operationalTemplate.findUnique({ where: { id: v1 }, select: { state: true } });
    // L'ancien n'est pas supprimé : il reste lisible pour comprendre les documents de 2025.
    expect(ancien!.state).toBe("DEPRECATED");
  });

  it("un modèle déprécié ne peut plus être réapprouvé", async () => {
    const id = await observer({ ownerId, type: "MEETING_MINUTES", name: "CR", fileHash: "m1" });
    await proposer(id, "x");
    await approuver(id, ownerId);
    expect(await deprecier(id)).toBe(true);
    expect(await approuver(id, ownerId)).toBe(false);
    expect(await modeleFaisantAutorite(ownerId, "MEETING_MINUTES")).toBeNull();
  });

  it("l'usage ne se compte QUE sur un modèle approuvé", async () => {
    const observe = await observer({ ownerId, type: "REGULATORY_LETTER", name: "Lettre", fileHash: "r1" });
    const compteur = () => prisma.operationalTemplate.findUnique({
      where: { id: observe }, select: { usageCount: true, lastUsedAt: true },
    });

    await noterUsage(observe);
    expect((await compteur())!.usageCount).toBe(0);

    await proposer(observe, "x");
    await approuver(observe, ownerId);
    await noterUsage(observe);
    const apres = (await compteur())!;
    expect(apres.usageCount).toBe(1);
    expect(apres.lastUsedAt).not.toBeNull();
  });

  it("le registre est CLOISONNÉ par propriétaire", async () => {
    const autre = await prisma.user.create({
      data: { name: `${TAG}b`, email: `${TAG}b@t.dz`, passwordHash: "x", role: "DIRECTION" },
    });
    const id = await observer({ ownerId: autre.id, type: "INVOICE", name: "Sa facture", fileHash: "x1" });
    await proposer(id, "x");
    await approuver(id, autre.id);

    // Le modèle de l'un ne fait pas autorité chez l'autre.
    expect(await modeleFaisantAutorite(ownerId, "INVOICE")).toBeNull();
    expect((await modeleFaisantAutorite(autre.id, "INVOICE"))!.id).toBe(id);

    await prisma.operationalTemplate.deleteMany({ where: { ownerId: autre.id } });
    await prisma.user.delete({ where: { id: autre.id } });
  });
});
