import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));

import { prisma } from "@/lib/prisma";
import { getAccess, userCan, type SessionUser } from "@/lib/rbac";
import { addAdProComment } from "../actions-discussion";
import { addPromoComment } from "@/lib/actions/promo-material-actions";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__adprodisc__";

async function actorFor(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE FIL D'UNE DEMANDE Ad & Pro, ÉPROUVÉ PAR LE VRAI ÉCRIVAIN.
 *
 * Un banc qui se contenterait du module pur confirmerait le vocabulaire et ne dirait RIEN de ce
 * qui atteint la base ni de qui est refusé (§118.14, §118.49).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Ad & Pro — la section discussion", () => {
  let dirId = "", etrangerId = "", assistanteId = "", demandeId = "", promoId = "";

  beforeAll(async () => {
    const mk = (n: string, role: SessionUser["role"]) =>
      prisma.user.create({ data: { name: `${TAG}${n}`, email: `${TAG}${n}@t.dz`, role, passwordHash: "x" } });
    // L'ACTEUR QUI ÉCRIT a la vue globale ; celui qui doit être REFUSÉ n'a rien du pôle. Sans ce
    // second acteur, la garde rendrait « vrai » quoi qu'il arrive (§118.104).
    dirId = (await mk("dir", "DIRECTION")).id;
    etrangerId = (await mk("etranger", "LOGISTICS_MANAGER")).id;
    // L'ASSISTANTE DE DIRECTION est l'acteur qui DISCRIMINE les deux portes : mesuré, elle n'a
    // AUCUN module `PROMO_MATERIAL`, et `canAccessEntity` lui ouvre pourtant le dossier parce
    // qu'elle en pilote le circuit depuis les demandes administratives.
    assistanteId = (await mk("assist", "DIRECTION_ASSISTANT")).id;
    demandeId = (await prisma.sponsoringRequest.create({
      data: { reference: `${TAG}SPO-1`, institution: `${TAG}Asso`, type: "Congrès", requesterId: dirId },
      select: { id: true },
    })).id;
    promoId = (await prisma.promoMaterial.create({
      data: { reference: `${TAG}MP-1`, title: `${TAG}Brochure`, requesterId: dirId },
      select: { id: true },
    })).id;
  });

  afterAll(async () => {
    await prisma.comment.deleteMany({ where: { entityId: { in: [demandeId, promoId] } } }).catch(() => {});
    await prisma.promoMaterial.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await prisma.sponsoringRequest.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });

  it("un message ATTEINT la base, sur l'entité de la demande", async () => {
    ACTOR = await actorFor(dirId, "DIRECTION");
    const fd = new FormData();
    fd.set("entityType", "SPONSORING");
    fd.set("entityId", demandeId);
    fd.set("body", `${TAG}Le devis du traiteur manque encore.`);
    const r = await addAdProComment(fd);
    expect(r.ok, r.ok === false ? r.error : "").toBe(true);
    const lignes = await prisma.comment.findMany({ where: { entityType: "SPONSORING", entityId: demandeId } });
    expect(lignes).toHaveLength(1);
    expect(lignes[0]!.body).toContain("devis du traiteur");
    expect(lignes[0]!.authorId, "le message porte son AUTEUR — un fil anonyme ne se lit pas").toBe(dirId);
  });

  it("quelqu'un HORS du dossier est REFUSÉ — la porte est celle de l'enregistrement", async () => {
    // Ce qui le ferait tomber : garder sur un droit de MODULE, ou ne pas garder du tout. Le rôle
    // choisi n'a AUCUN module du pôle Ad & Pro — mesuré par l'échec attendu lui-même.
    ACTOR = await actorFor(etrangerId, "LOGISTICS_MANAGER");
    const fd = new FormData();
    fd.set("entityType", "SPONSORING");
    fd.set("entityId", demandeId);
    fd.set("body", `${TAG}Je passais par là.`);
    const r = await addAdProComment(fd);
    expect(r.ok).toBe(false);
    expect(r.ok === false ? r.error : "").toContain("ne vous est pas ouverte");
    expect(await prisma.comment.count({ where: { entityId: demandeId } }), "rien n'a été écrit").toBe(1);
  });

  it("une entité HORS du pôle est refusée, même avec la vue globale", async () => {
    /*
     * L'entité arrive du formulaire. Sans le filtre sur le registre canonique, cet écrivain
     * deviendrait générique : un identifiant forgé y poserait un commentaire sur un dossier RH ou
     * un contrat, avec une porte pensée pour Ad & Pro (§118.7).
     *
     * L'acteur a la VUE GLOBALE : le refus ne peut donc venir que du filtre d'entité, pas d'un
     * manque de droit — sans quoi le cas passerait au vert pour la mauvaise raison.
     */
    ACTOR = await actorFor(dirId, "DIRECTION");
    const fd = new FormData();
    fd.set("entityType", "EMPLOYEE");
    fd.set("entityId", demandeId);
    fd.set("body", `${TAG}Hors pôle.`);
    const r = await addAdProComment(fd);
    expect(r.ok).toBe(false);
    expect(r.ok === false ? r.error : "").toContain("Ad & Pro non précisée");
    expect(await prisma.comment.count({ where: { entityType: "EMPLOYEE", entityId: demandeId } })).toBe(0);
  });

  it("un message VIDE n'est pas un message", async () => {
    ACTOR = await actorFor(dirId, "DIRECTION");
    const fd = new FormData();
    fd.set("entityType", "SPONSORING");
    fd.set("entityId", demandeId);
    fd.set("body", "   ");
    expect((await addAdProComment(fd)).ok).toBe(false);
    expect(await prisma.comment.count({ where: { entityId: demandeId } })).toBe(1);
  });

  it("L'ASSISTANTE DE DIRECTION écrit dans le fil d'un dossier de matériel — SANS en avoir le module", async () => {
    /*
     * ═════════════════════════════════════════════════════════════════════════════════════
     * LE CAS QU'UN SABOTAGE A NOMMÉ, et il prouve une phrase que j'avais écrite sans l'éprouver.
     *
     * `addPromoComment` gardait sur `userCan(user, "PROMO_MATERIAL", "VIEW")`. Depuis que le fil
     * du pôle est canonique, deux écrivains visent la même table : une divergence de porte y
     * donne le pire symptôme, l'écran qui refuse et la conversation qui accepte (§118.71). La
     * porte est donc passée à `canAccessEntity`.
     *
     * Le sabotage qui la ramène au module est passé au VERT : aucun cas n'exerçait cet
     * écrivain — §118.111 mot pour mot. Et l'acteur qui DISCRIMINE les deux portes n'est pas
     * « quelqu'un de plus strict » : c'est l'Assistante de Direction, MESURÉE sans aucun module
     * `PROMO_MATERIAL`, à qui `canAccessEntity` ouvre le dossier parce qu'elle pilote ce circuit
     * depuis les demandes administratives. Sous l'ancienne porte elle était REFUSÉE ; c'est donc
     * le seul cas qui prouve que le remplacement est juste dans les DEUX sens, et pas seulement
     * plus sévère (§118.82 : une phrase qu'on ne peut pas exercer n'est pas une propriété tenue).
     * ═════════════════════════════════════════════════════════════════════════════════════
     */
    ACTOR = await actorFor(assistanteId, "DIRECTION_ASSISTANT");
    // LA PRÉMISSE : elle n'a bien PAS le module. Sans elle, le succès ci-dessous serait vrai pour
    // la mauvaise raison et le sabotage repasserait au vert (§118.104).
    expect(userCan(ACTOR, "PROMO_MATERIAL", "VIEW"),
      "si ce rôle gagnait le module, ce cas cesserait de discriminer les deux portes").toBe(false);
    const fd = new FormData();
    fd.set("promoId", promoId);
    fd.set("body", `${TAG}Le BC est parti chez l'agence.`);
    const r = await addPromoComment(fd);
    expect(r.ok, r.ok === false ? r.error : "").toBe(true);
    expect(await prisma.comment.count({ where: { entityType: "PROMO_MATERIAL", entityId: promoId } })).toBe(1);

    // …et l'ÉTRANGER au dossier reste refusé : sans cette moitié, une porte grande ouverte
    // passerait pour armée (§118.17).
    ACTOR = await actorFor(etrangerId, "LOGISTICS_MANAGER");
    const fd2 = new FormData();
    fd2.set("promoId", promoId);
    fd2.set("body", `${TAG}Je passais par là.`);
    expect((await addPromoComment(fd2)).ok).toBe(false);
    expect(await prisma.comment.count({ where: { entityType: "PROMO_MATERIAL", entityId: promoId } })).toBe(1);
  });
});
