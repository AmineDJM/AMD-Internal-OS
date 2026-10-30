import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { persistActionIntents, retirerCaduquesAvantLeTour } from "@/platform/ia/intentions/action-intents";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE RETRAIT SE DIT À L\'ÉCRAN — sinon le serveur refuse un geste que l\'interface propose.
 *
 * `proposition-perimee.test.ts` tient la RÈGLE (quelle proposition en remplace une autre) sans
 * toucher la base. Celui-ci tient le CONTRAT : ce que `retirerCaduquesAvantLeTour` écrit
 * vraiment, et ce qu\'elle REND.
 *
 * Le détail qui compte : elle rendait un NOMBRE. Le journal s\'en contentait, l\'écran non — et
 * c\'est l\'écran qui laissait un bouton peint sur une intention déjà annulée. Elle rend
 * désormais les IDENTIFIANTS, et ce test tombe si quelqu\'un revient à un compteur.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const TAG = `perim-${Date.now()}`;
let userId = "";

const graine = (titre: string) => ({
  kind: "create_task", module: "Tasks", title: titre,
  fields: [{ label: "Demandée à", value: "Raihana Cherif" }], payload: { titre },
});

describe("le retrait des cartes caduques rend ce que l\'écran doit éteindre", () => {
  beforeEach(async () => {
    const u = await prisma.user.findFirst({ select: { id: true } });
    if (!u) throw new Error("aucun compte en base de test");
    userId = u.id;
    await prisma.assistantActionIntent.deleteMany({ where: { userId, title: { contains: TAG } } });
  });

  afterAll(async () => {
    await prisma.assistantActionIntent.deleteMany({ where: { title: { contains: TAG } } }).catch(() => undefined);
  });

  it("rend les IDENTIFIANTS retirés, pas un compte — c\'est ce que l\'écran consomme", async () => {
    const [id] = await persistActionIntents(userId, [graine(`${TAG} étiquetage bilingue Nivolex`)], "text");
    expect(id).toBeTruthy();

    const rendus = await retirerCaduquesAvantLeTour(userId, `Non, finalement l\'étiquetage bilingue Nivolex c\'est pour Amel — ${TAG}`);
    expect(Array.isArray(rendus), "un compteur ne permet pas d\'éteindre un bouton précis").toBe(true);
    expect(rendus).toContain(id);

    const apres = await prisma.assistantActionIntent.findUnique({ where: { id: id! }, select: { status: true, events: true } });
    expect(apres?.status, "l\'intention n\'a pas été annulée en base").toBe("CANCELLED");
    // LA RAISON EST AU JOURNAL : l\'audit distingue une annulation VOULUE d\'un retrait décidé
    // par le code — sans quoi on ne saurait plus qui a renoncé.
    expect(JSON.stringify(apres?.events)).toContain("CANCELLED_SUPERSEDED");
  });

  it("un message SANS rapport ne retire rien — la moitié qui protège le travail normal", async () => {
    const [id] = await persistActionIntents(userId, [graine(`${TAG} étiquetage bilingue Nivolex`)], "text");
    const rendus = await retirerCaduquesAvantLeTour(userId, "Au fait, où en est le budget marketing du trimestre ?");
    expect(rendus).toEqual([]);
    const apres = await prisma.assistantActionIntent.findUnique({ where: { id: id! }, select: { status: true } });
    expect(apres?.status, "une carte légitime a été éteinte").toBe("PROPOSED");
  });

  it("une intention DÉJÀ confirmée n\'est jamais rétractée par un message", async () => {
    const [id] = await persistActionIntents(userId, [graine(`${TAG} étiquetage bilingue Nivolex`)], "text");
    await prisma.assistantActionIntent.update({ where: { id: id! }, data: { status: "EXECUTED" } });
    const rendus = await retirerCaduquesAvantLeTour(userId, `l\'étiquetage bilingue Nivolex ${TAG}`);
    expect(rendus).toEqual([]);
    const apres = await prisma.assistantActionIntent.findUnique({ where: { id: id! }, select: { status: true } });
    expect(apres?.status, "une écriture déjà faite a été touchée").toBe("EXECUTED");
  });
});
