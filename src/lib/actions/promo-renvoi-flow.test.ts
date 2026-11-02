import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR, getCurrentUser: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { getAccess, hasGlobalView, userCan, type SessionUser } from "@/lib/rbac";
import { getAppSettings } from "@/lib/settings";
import { createPromoMaterial } from "./promo-material-actions";
import { validatePromoStep, refusePromoStep, renvoyerPromoStep, resoumettrePromoDemande } from "./promo-circuit-actions";
import {
  enregistrerDevisPromo, terminerRetranscriptionPromo, choisirLignesPromo, demanderCorrectionDevisPromo, redemanderDevisPromo,
} from "./promo-devis-actions";
import { enregistrerArticleDemandePromo, retirerArticleDemandePromo } from "./promo-demande-actions";
import { REFUS_EN_CORRECTION } from "@/lib/promo-material/renvoi";
import { statutDuDossier } from "@/lib/promo-material/statut";
import { dossiersPromoAMonTour } from "@/lib/queries/promo-circuit";
import { getAdProRequests } from "@/modules/ad-pro/api";
import type { ActionResult } from "./types";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__prenv__${Date.now().toString(36)}`;

async function actorFor(id: string): Promise<CurrentUser> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  const access = await getAccess(id, u.role);
  return { id, name: u.name, email: u.email, role: u.role, secondaryRole: u.secondaryRole, access, mustChangePassword: false };
}
const form = (fields: Record<string, string | string[]>): FormData => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) for (const x of v) fd.append(k, x); else fd.set(k, v);
  }
  return fd;
};
const pdf = (nom: string) => new File([new Uint8Array([37, 80, 68, 70, 45, 49, 46, 52])], nom, { type: "application/pdf" });
const err = (r: ActionResult) => (r.ok ? "" : r.error ?? "");
function reussi(r: ActionResult, quoi: string): ActionResult {
  if (!r.ok) throw new Error(`${quoi} : ${r.error}`);
  return r;
}
const dossier = (id: string) => prisma.promoMaterial.findUniqueOrThrow({
  where: { id },
  select: {
    status: true, circuitState: true, circuitVersion: true, adminRequestId: true,
    returnedAt: true, returnedById: true, returnNote: true, returnedFrom: true,
  },
});
const fil = async (id: string) => (await prisma.comment.findMany({ where: { entityType: "PROMO_MATERIAL", entityId: id }, orderBy: { createdAt: "asc" }, select: { body: true } })).map((c) => c.body);
const avis = (userId: string, id: string, title: string) => prisma.notification.count({ where: { userId, link: `/promo-material/${id}`, title } });
/** Le tour d'une personne sur ce dossier, lu par la requête du centre d'actions et de « Mon espace ». */
const tourSur = async (userId: string, id: string) => (await dossiersPromoAMonTour(await actorFor(userId))).find((d) => d.id === id)?.tour ?? null;

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE MATÉRIEL PROMOTIONNEL SE CORRIGE (audit 360°, lot C4b — R05, R06, R07), par les VRAIS points
 * d'entrée et des acteurs SANS vue globale (§118.104).
 *
 * Le circuit ne savait que valider ou refuser : un format mal précisé tuait la demande, un devis qui
 * ne convenait pas laissait le demandeur entre retenir une ligne fausse et abandonner son dossier, la
 * correction d'une retranscription prévenait une assistante dont le bureau ne montrait rien, et la
 * liste des articles se figeait dès les devis demandés.
 *
 *   ops   Direction des opérations (vue globale, suppléance)   dir   directrice marketing (valide)
 *   cp    chef de produit, sous dir (le demandeur)             cp2   un collègue de cp, sous dir
 *   asst  assistante de direction (retranscrit)                dehors  sans le module
 *
 * Chaque écriture CONDITIONNELLE a son témoin forcé (`pendantLaLecture`) : le détenteur du verrou
 * écrit lui-même le changement concurrent pendant que le geste attend, entre sa lecture et son
 * écriture — jamais un ordonnancement espéré (§118.65).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Matériel promotionnel — renvoyer, resoumettre, redemander des devis (lot C4b)", () => {
  const u: Record<string, string> = {};
  let companyId = "", fourA = "", fourB = "", catCarnet = "", catPresentoir = "";
  let debutBanc = new Date();
  let seuilDg = 0;

  beforeAll(async () => {
    debutBanc = new Date(Date.now() - 1_000);
    const mk = async (k: string, role: SessionUser["role"]) => {
      u[k] = (await prisma.user.create({ data: { name: `${TAG} ${k}`, email: `${TAG}${k}@t.dz`, role, passwordHash: "x" } })).id;
    };
    await Promise.all([
      mk("ops", "DIRECTION"), mk("dir", "PRODUCT_MANAGER"), mk("cp", "MEDICAL_PROMOTION_MANAGER"),
      mk("cp2", "MEDICAL_PROMOTION_MANAGER"), mk("asst", "DIRECTION_ASSISTANT"), mk("dehors", "SALES_USER"),
    ]);
    companyId = (await prisma.company.create({ data: { name: `${TAG} Pharma`, shortName: TAG.slice(0, 12), color: "#1B7F79" } })).id;
    // L'ORGANIGRAMME : la directrice du chef de produit est celle qui valide sa demande (§118.152).
    const emp: Record<string, string> = {};
    const e = async (k: string, managerKey: string | null) => {
      emp[k] = (await prisma.employee.create({ data: { fullName: `${TAG} ${k}`, userId: u[k], managerId: managerKey ? emp[managerKey] : null, companyId } })).id;
    };
    await e("ops", null);
    await e("dir", "ops");
    await Promise.all([e("cp", "dir"), e("cp2", "dir"), e("asst", null)]);
    const cat = (suffixe: string, nom: string, famille: "CONSOMMABLE" | "DURABLE") =>
      prisma.promoCatalogueArticle.create({ data: { reference: `${TAG}-${suffixe}`, nom: `${TAG} ${nom}`, famille }, select: { id: true } });
    const vague = await Promise.all([
      prisma.companyContact.create({ data: { name: `${TAG} Imprimerie Atlas`, address: "Zone industrielle", city: "Alger", companyId: null }, select: { id: true } }),
      prisma.companyContact.create({ data: { name: `${TAG} Imprimerie Tell`, address: "Rue 5", city: "Blida", companyId: null }, select: { id: true } }),
      cat("CARNET", "Carnet bilan", "CONSOMMABLE"),
      cat("PLV", "Présentoir PLV", "DURABLE"),
    ]);
    [fourA, fourB, catCarnet, catPresentoir] = vague.map((r) => r.id);
    seuilDg = (await getAppSettings()).adProDgThreshold ?? 0;
  }, 60_000);

  afterAll(async () => {
    const pmIds = (await prisma.promoMaterial.findMany({ where: { title: { startsWith: TAG } }, select: { id: true } })).map((p) => p.id);
    const demandes = (await prisma.administrativeRequest.findMany({ where: { linkedEntityType: "PROMO_MATERIAL", linkedEntityId: { in: pmIds } }, select: { id: true } })).map((d) => d.id);
    await prisma.comment.deleteMany({ where: { OR: [{ entityType: "PROMO_MATERIAL", entityId: { in: pmIds } }, { entityType: "ADMIN_REQUEST", entityId: { in: demandes } }] } }).catch(() => {});
    await prisma.promoMaterial.updateMany({ where: { id: { in: pmIds } }, data: { adminRequestId: null } }).catch(() => {});
    await prisma.administrativeRequest.deleteMany({ where: { id: { in: demandes } } }).catch(() => {});
    await prisma.promoMaterial.deleteMany({ where: { id: { in: pmIds } } }).catch(() => {});
    await prisma.document.deleteMany({ where: { entityType: "PROMO_MATERIAL", entityId: { in: pmIds } } }).catch(() => {});
    await prisma.promoCatalogueArticle.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await prisma.companyContact.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    // Les avis envoyés au RÔLE (tout le secrétariat, quand aucune assistante n'est nommée) atteignent
    // des comptes qui ne sont pas les nôtres : on les retire par le lien, BORNÉS à ce banc (`createdAt`
    // passe par l'index — par le seul lien, Postgres lirait toute la table, §118.175).
    await prisma.notification.deleteMany({ where: { link: { in: pmIds.map((id) => `/promo-material/${id}`) }, createdAt: { gte: debutBanc } } }).catch(() => {});
    const ids = Object.values(u);
    await prisma.fileVersion.deleteMany({ where: { node: { ownerId: { in: ids } } } }).catch(() => {});
    await prisma.driveNode.deleteMany({ where: { ownerId: { in: ids }, type: "FILE" } }).catch(() => {});
    await prisma.driveNode.deleteMany({ where: { ownerId: { in: ids } } }).catch(() => {});
    await prisma.employee.updateMany({ where: { fullName: { startsWith: TAG } }, data: { managerId: null } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { fullName: { startsWith: TAG } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    await prisma.company.delete({ where: { id: companyId } }).catch(() => {});
  }, 60_000);

  const comme = async (k: string) => { ACTOR = await actorFor(u[k]!); };

  /** Une demande neuve de cp : un carnet à imprimer — elle attend la validation de sa directrice. */
  async function nouveau(titre: string): Promise<string> {
    await comme("cp");
    const r = await createPromoMaterial(undefined, form({
      title: `${TAG} ${titre}`,
      lignes: JSON.stringify([{ catalogueId: catCarnet, quantite: "500", actions: ["IMPRESSION"], commentaire: "A5" }]),
    }));
    if (!r.ok) throw new Error(r.error);
    return r.id!;
  }
  /** Jusqu'au choix des lignes : demande validée, devis demandés, un devis retranscrit. */
  async function jusquAuChoix(id: string): Promise<void> {
    await comme("dir");
    reussi(await validatePromoStep(form({ id })), "valider la demande");
    // LA DEMANDE DE DEVIS PART D'ELLE-MÊME à la validation de la demande (§118.204) : plus de geste « demander les devis ».
    if ((await prisma.promoMaterial.findUniqueOrThrow({ where: { id }, select: { circuitState: true } })).circuitState !== "QUOTE_REQUESTED") throw new Error("la demande de devis n'est pas partie d'elle-même à la validation");
    await retranscrire(id, fourA, "A-1", "100");
    await comme("asst");
    reussi(await terminerRetranscriptionPromo(form({ promoMaterialId: id })), "terminer la retranscription");
  }
  async function retranscrire(id: string, fournisseur: string, reference: string, prix: string): Promise<void> {
    await comme("asst");
    const article = (await prisma.promoRequestItem.findFirstOrThrow({ where: { promoMaterialId: id, catalogueId: catCarnet } })).id;
    // Le total HT imprimé est exigé pour terminer : celui du papier, 500 carnets au prix retranscrit.
    const fd = form({
      promoMaterialId: id, supplierId: fournisseur, reference, tvaRate: "19", announcedTotal: String(500 * Number(prix)),
      ligneReference: ["Carnet A5"], ligneQuantite: ["500"], lignePrix: [prix], ligneAction: ["IMPRESSION"], ligneArticle: [article],
    });
    fd.set("scan", pdf(`${reference}.pdf`));
    reussi(await enregistrerDevisPromo(fd), "retranscrire un devis");
  }
  async function choisirEtValider(id: string): Promise<void> {
    const ligne = (await prisma.promoQuoteLine.findFirstOrThrow({ where: { quote: { promoMaterialId: id } }, orderBy: { createdAt: "asc" } })).id;
    await comme("cp");
    reussi(await choisirLignesPromo(form({ promoMaterialId: id, lineIds: [ligne], valider: "1" })), "valider le choix");
  }

  /** Forcer l'entrelacement (§118.65) : le geste lit, puis attend ; le détenteur écrit le changement concurrent. */
  async function pendantLaLecture<T>(lancer: () => Promise<T>, concurrent: (tx: Prisma.TransactionClient) => Promise<unknown>): Promise<T> {
    let geste!: Promise<T>;
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`LOCK TABLE "PromoMaterial" IN SHARE MODE`);
      geste = lancer();
      geste.catch(() => undefined);
      const debut = Date.now();
      for (;;) {
        await tx.$executeRawUnsafe("SELECT pg_stat_clear_snapshot()");
        const [{ n }] = await tx.$queryRaw<{ n: number }[]>`
          SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid()
            AND wait_event_type = 'Lock' AND query ILIKE ${'%"PromoMaterial"%'}`;
        if (n >= 1) break;
        if (Date.now() - debut > 10_000) throw new Error("le geste n'a pas atteint la barrière");
        await new Promise((r) => setTimeout(r, 25));
      }
      await concurrent(tx);
    }, { timeout: 20_000 });
    return geste;
  }

  it("PRÉMISSES : la directrice valide sans vue globale ; le collègue a le module sans être validateur ; le choix reste sous le seuil du DG", async () => {
    const dir = await actorFor(u.dir!);
    expect(hasGlobalView(dir.role), "une garde éprouvée avec la vue globale ne peut pas tomber (§118.104)").toBe(false);
    expect(userCan(await actorFor(u.cp2!), "PROMO_MATERIAL", "VIEW")).toBe(true);
    expect(userCan(await actorFor(u.dehors!), "PROMO_MATERIAL", "VIEW")).toBe(false);
    expect(hasGlobalView((await actorFor(u.ops!)).role), "la Direction supplée par sa vue globale").toBe(true);
    // 500 × 100 DZD + 19 % = 59 500 TTC : sous le seuil du DG, le choix validé passe à l'exécution.
    expect(seuilDg === 0 || seuilDg >= 59_500, `décor : seuil du DG ${seuilDg}`).toBe(true);
    const id = await nouveau("Prémisse");
    const pm = await prisma.promoMaterial.findUniqueOrThrow({ where: { id }, select: { circuitState: true, circuitVersion: true, requestValidatorId: true } });
    expect(pm).toEqual({ circuitState: "REVIEW_REQUEST", circuitVersion: 2, requestValidatorId: u.dir });
  });

  it("RENVOYER — l'état d'abord, le motif ensuite : ni le demandeur, ni un collègue, ni qui n'a pas le module ; le motif n'est demandé qu'à qui peut renvoyer", async () => {
    const id = await nouveau("Ordre des refus");
    for (const k of ["cp", "cp2", "dehors"]) {
      await comme(k);
      expect(err(await renvoyerPromoStep(form({ id }))), k).toBe("Cette étape ne vous revient pas.");
    }
    await comme("dir");
    expect(err(await renvoyerPromoStep(form({ id })))).toMatch(/^Dites ce qu'il faut corriger/);
    expect(err(await renvoyerPromoStep(form({ id, motif: "   " }))), "un motif blanc n'est pas un motif").toMatch(/^Dites ce qu'il faut corriger/);
    expect((await dossier(id)).returnedAt).toBeNull();
  });

  it("RENVOYER LA DEMANDE : elle reste à son étape, chez son demandeur, avec le motif — au fil, prévenu, « À corriger »", async () => {
    const id = await nouveau("Renvoi de la demande");
    await comme("dir");
    const r = await renvoyerPromoStep(form({ id, motif: "Précisez le format et le grammage" }));
    expect(r.ok, err(r)).toBe(true);
    expect(r.message).toBe("Renvoyé au demandeur : il corrige sa demande, puis vous la resoumet.");
    const pm = await dossier(id);
    expect(pm).toMatchObject({ circuitState: "REVIEW_REQUEST", returnedById: u.dir, returnNote: "Précisez le format et le grammage", returnedFrom: "REVIEW_REQUEST" });
    expect(pm.returnedAt).not.toBeNull();
    expect(statutDuDossier(pm).libelle).toBe("À corriger");
    expect((await fil(id)).some((b) => /Renvoyé pour correction à l'étape .*Précisez le format et le grammage/.test(b))).toBe(true);
    expect(await avis(u.cp!, id, "Matériel promotionnel — à corriger")).toBe(1);
    // LA FILE SUIT LA BALLE : le dossier quitte celle de la directrice et entre dans celle du demandeur.
    expect(await tourSur(u.cp!, id)).toBe("GESTE");
    expect(await tourSur(u.dir!, id)).toBeNull();
    const etatUnifie = async () => (await getAdProRequests(await actorFor(u.cp!))).find((x) => x.id === id)?.state ?? null;
    expect(await etatUnifie(), "la liste Ad & Pro et « Mon espace » disent « À corriger »").toBe("RETURNED");

    // PENDANT LA CORRECTION, le validateur n'a rien à trancher — et un refus ne demande pas son motif.
    expect(err(await validatePromoStep(form({ id })))).toBe(REFUS_EN_CORRECTION);
    expect(err(await refusePromoStep(form({ id })))).toBe(REFUS_EN_CORRECTION);
    expect(err(await renvoyerPromoStep(form({ id, motif: "Encore" })))).toBe(REFUS_EN_CORRECTION);
    expect((await dossier(id)).returnNote, "rien n'a changé").toBe("Précisez le format et le grammage");

    // LE DEMANDEUR CORRIGE SA LISTE (étape 0 : l'assistante n'est pas concernée), puis RESOUMET.
    await comme("cp");
    const ajout = await enregistrerArticleDemandePromo(form({ promoMaterialId: id, catalogueId: catPresentoir, quantite: "10", actions: ["FABRICATION"], commentaire: "Sol" }));
    expect(ajout.ok, err(ajout)).toBe(true);
    expect(ajout.message).not.toMatch(/assistante/);
    expect(await prisma.notification.count({ where: { link: `/promo-material/${id}`, title: { contains: "article" } } })).toBe(0);

    await comme("dehors");
    expect(err(await resoumettrePromoDemande(form({ id, note: "x" })))).toBe("Seul le demandeur (ou la Direction) resoumet ce dossier.");
    await comme("cp");
    expect(err(await resoumettrePromoDemande(form({ id })))).toMatch(/^Dites ce qui a changé/);
    const re = await resoumettrePromoDemande(form({ id, note: "Format A5, 90 g ; présentoir ajouté" }));
    expect(re.ok, err(re)).toBe(true);
    expect(re.message).toBe("Demande resoumise : elle revient à la personne qui l'a renvoyée.");
    expect(await dossier(id)).toMatchObject({ circuitState: "REVIEW_REQUEST", returnedAt: null, returnedById: null, returnNote: null, returnedFrom: null });
    // Le renvoi et la correction restent au fil — le motif d'abord, ce qui a changé ensuite.
    expect((await fil(id)).some((b) => /Resoumis après correction\..*« Précisez le format et le grammage ».*Format A5, 90 g ; présentoir ajouté/.test(b))).toBe(true);
    expect(await avis(u.dir!, id, "Matériel promotionnel — demande corrigée, à valider")).toBe(1);
    expect(await tourSur(u.dir!, id), "resoumise, elle revient dans la file de la directrice").toBe("VALIDATION");
    expect(await tourSur(u.cp!, id)).toBeNull();
    expect(await etatUnifie()).toBe("AWAITING");
    expect(err(await resoumettrePromoDemande(form({ id, note: "encore" })))).toBe("Ce dossier n'est pas à corriger : il n'y a rien à resoumettre.");

    // La directrice tranche de nouveau — et l'étape suivante ne se renvoie pas : c'est le demandeur qui l'a.
    await comme("dir");
    reussi(await validatePromoStep(form({ id })), "revalider");
    // Revalidée, la demande de devis part d'elle-même (§118.204).
    expect((await dossier(id)).circuitState).toBe("QUOTE_REQUESTED");
    expect(err(await renvoyerPromoStep(form({ id, motif: "x" })))).toMatch(/ne se renvoie pas/);
    await comme("cp");
    expect(err(await resoumettrePromoDemande(form({ id, note: "x" })))).toBe("Ce dossier n'est pas à corriger : il n'y a rien à resoumettre.");
  }, 60_000);

  it("DEUX RENVOIS qui se croisent à la validation de la demande : un seul motif s'écrit — la condition, pas l'ordre des clics", async () => {
    const id = await nouveau("Deux renvois");
    await comme("dir");
    const r = await pendantLaLecture(
      () => renvoyerPromoStep(form({ id, motif: "Le mien" })),
      (tx) => tx.promoMaterial.update({ where: { id }, data: { returnedAt: new Date(), returnedById: u.ops, returnNote: "L'autre", returnedFrom: "REVIEW_REQUEST" } }),
    );
    expect(err(r)).toMatch(/vient de changer d'étape/);
    expect((await dossier(id)).returnNote, "le premier renvoi tient").toBe("L'autre");
    expect((await fil(id)).filter((b) => b.includes("Le mien")), "le geste perdant n'écrit rien").toHaveLength(0);
    expect(await avis(u.cp!, id, "Matériel promotionnel — à corriger")).toBe(0);

    // DEUX RESOUMISSIONS : une seule.
    await comme("cp");
    const re = await pendantLaLecture(
      () => resoumettrePromoDemande(form({ id, note: "Corrigé" })),
      (tx) => tx.promoMaterial.update({ where: { id }, data: { returnedAt: null, returnedById: null, returnNote: null, returnedFrom: null } }),
    );
    expect(err(re)).toBe("Ce dossier vient de changer : rouvrez sa fiche.");
    expect(await avis(u.dir!, id, "Matériel promotionnel — demande corrigée, à valider")).toBe(0);
  }, 60_000);

  it("UN RENVOI CROISÉ AVEC UNE VALIDATION à l'étape de la directrice ne s'applique pas sur un dossier qui a avancé", async () => {
    const id = await nouveau("Renvoi croisé");
    await jusquAuChoix(id);
    await choisirEtValider(id);
    expect((await dossier(id)).circuitState).toBe("REVIEW_MANAGER");
    await comme("dir");
    const r = await pendantLaLecture(
      () => renvoyerPromoStep(form({ id, motif: "Trop tard" })),
      (tx) => tx.promoMaterial.update({ where: { id }, data: { circuitState: "IN_EXECUTION" } }),
    );
    expect(err(r)).toMatch(/vient de changer d'étape/);
    expect(await dossier(id)).toMatchObject({ circuitState: "IN_EXECUTION", returnedAt: null });
  }, 60_000);

  it("AU CHOIX DES LIGNES, le demandeur ne refuse pas sa propre demande — il redemande des devis ; et le choix ne se renvoie pas", async () => {
    const id = await nouveau("Choix");
    await jusquAuChoix(id);
    await comme("cp");
    expect(err(await refusePromoStep(form({ id })))).toBe("C'est votre propre demande : pour d'autres prix, « Redemander des devis » ; pour l'abandonner, annulez le dossier.");
    await comme("dir");
    expect(err(await renvoyerPromoStep(form({ id, motif: "x" })))).toMatch(/ne se renvoie pas/);
    expect((await dossier(id)).circuitState).toBe("REVIEW_REQUESTER");
  }, 60_000);

  it("REDEMANDER DES DEVIS : une nouvelle demande au secrétariat, les devis reçus restent, la sélection aussi — et un double clic n'en fait pas deux", async () => {
    const id = await nouveau("Redemander");
    await jusquAuChoix(id);
    const ligne = (await prisma.promoQuoteLine.findFirstOrThrow({ where: { quote: { promoMaterialId: id } } })).id;
    await comme("cp");
    reussi(await choisirLignesPromo(form({ promoMaterialId: id, lineIds: [ligne] })), "une sélection, sans valider");
    const avant = await dossier(id);

    await comme("asst");
    expect(err(await redemanderDevisPromo(form({ promoMaterialId: id, note: "x" })))).toBe("Redemander des devis revient au demandeur.");
    await comme("cp");
    expect(err(await redemanderDevisPromo(form({ promoMaterialId: id })))).toMatch(/^Dites ce que vous cherchez/);
    const r = await redemanderDevisPromo(form({ promoMaterialId: id, note: "Un second imprimeur, délai 10 jours" }));
    expect(r.ok, err(r)).toBe(true);
    expect(r.message).toMatch(/^Nouveaux devis demandés au secrétariat \(.+\) — les devis déjà reçus restent sur la fiche\.$/);
    const apres = await dossier(id);
    expect(apres.circuitState).toBe("QUOTE_REQUESTED");
    expect(apres.adminRequestId).toBe(r.id);
    expect(apres.adminRequestId).not.toBe(avant.adminRequestId);
    const nouvelle = await prisma.administrativeRequest.findUniqueOrThrow({ where: { id: r.id! } });
    expect(nouvelle).toMatchObject({ type: "QUOTE", status: "NEW", linkedEntityType: "PROMO_MATERIAL", linkedEntityId: id, requesterId: u.cp });
    expect(nouvelle.title).toMatch(/^Nouveaux devis — matériel promotionnel/);
    expect(nouvelle.description).toMatch(/Un second imprimeur, délai 10 jours/);
    expect(nouvelle.description).toMatch(/NOUVELLE DEMANDE de devis/);
    expect((await prisma.administrativeRequest.findUniqueOrThrow({ where: { id: avant.adminRequestId! } })).status, "l'ancienne reste close").toBe("DONE");
    expect(await prisma.promoQuote.count({ where: { promoMaterialId: id } }), "les devis reçus restent").toBe(1);
    expect((await prisma.promoQuoteLine.findUniqueOrThrow({ where: { id: ligne } })).selected, "la sélection aussi").toBe(true);
    expect(await avis(u.asst!, id, "Matériel promotionnel — nouveaux devis à demander et à retranscrire")).toBe(1);
    expect((await fil(id)).some((b) => b.startsWith("Nouveaux devis demandés"))).toBe(true);
    expect(err(await redemanderDevisPromo(form({ promoMaterialId: id, note: "encore" })))).toMatch(/se redemandent au moment de choisir les lignes/);
    expect(await prisma.administrativeRequest.count({ where: { linkedEntityType: "PROMO_MATERIAL", linkedEntityId: id } })).toBe(2);

    // Le second devis arrive ; le choix porte maintenant sur deux devis.
    await retranscrire(id, fourB, "T-7", "90");
    await comme("asst");
    reussi(await terminerRetranscriptionPromo(form({ promoMaterialId: id })), "terminer la seconde retranscription");
    expect((await dossier(id)).circuitState).toBe("REVIEW_REQUESTER");
    expect(await prisma.promoQuote.count({ where: { promoMaterialId: id } })).toBe(2);

    // LE DOUBLE CLIC PERD LA COURSE : sa demande en trop est retirée — personne ne l'a vue.
    await comme("cp");
    const perdu = await pendantLaLecture(
      () => redemanderDevisPromo(form({ promoMaterialId: id, note: "Un troisième" })),
      (tx) => tx.promoMaterial.update({ where: { id }, data: { circuitState: "QUOTE_REQUESTED" } }),
    );
    expect(err(perdu)).toMatch(/vient de changer d'étape/);
    expect(await prisma.administrativeRequest.count({ where: { linkedEntityType: "PROMO_MATERIAL", linkedEntityId: id } }), "aucune demande orpheline").toBe(2);
    expect((await dossier(id)).adminRequestId).toBe(r.id);
  }, 90_000);

  it("DEMANDER UNE CORRECTION DE LA RETRANSCRIPTION rouvre la demande au secrétariat — l'assistante la retrouve « à traiter »", async () => {
    const id = await nouveau("Correction retranscription");
    await jusquAuChoix(id);
    const demande = (await dossier(id)).adminRequestId!;
    await prisma.administrativeRequest.update({ where: { id: demande }, data: { completedAt: new Date() } });
    expect((await prisma.administrativeRequest.findUniqueOrThrow({ where: { id: demande } })).status).toBe("DONE");
    await comme("cp");
    const r = await demanderCorrectionDevisPromo(form({ promoMaterialId: id, motif: "Le carnet est à 90 DZD sur le devis, pas 100" }));
    expect(r.ok, err(r)).toBe(true);
    expect((await dossier(id)).circuitState).toBe("QUOTE_REQUESTED");
    const rouverte = await prisma.administrativeRequest.findUniqueOrThrow({ where: { id: demande } });
    expect(rouverte.status).toBe("IN_PROGRESS");
    expect(rouverte.completedAt, "« en cours » ne garde pas de date de fin").toBeNull();
    const raison = await prisma.comment.findFirst({ where: { entityType: "ADMIN_REQUEST", entityId: demande }, orderBy: { createdAt: "desc" }, select: { body: true } });
    expect(raison?.body).toMatch(/^Demande rouverte — Correction de la retranscription demandée par le demandeur : Le carnet est à 90 DZD/);
    await comme("asst");
    reussi(await terminerRetranscriptionPromo(form({ promoMaterialId: id })), "retranscription corrigée");
    expect((await prisma.administrativeRequest.findUniqueOrThrow({ where: { id: demande } })).status).toBe("DONE");

    // UNE DEMANDE ANNULÉE au secrétariat ne ressuscite pas : la réouverture ne touche qu'une demande
    // TERMINÉE — la raison est quand même écrite sur la demande, sans prétendre l'avoir rouverte.
    await prisma.administrativeRequest.update({ where: { id: demande }, data: { status: "CANCELLED" } });
    await comme("cp");
    reussi(await demanderCorrectionDevisPromo(form({ promoMaterialId: id, motif: "La TVA du devis est à 9 %" })), "seconde correction");
    expect((await prisma.administrativeRequest.findUniqueOrThrow({ where: { id: demande } })).status).toBe("CANCELLED");
    const derniere = await prisma.comment.findFirst({ where: { entityType: "ADMIN_REQUEST", entityId: demande }, orderBy: { createdAt: "desc" }, select: { body: true } });
    expect(derniere?.body).toBe("Correction de la retranscription demandée par le demandeur : La TVA du devis est à 9 %");
  }, 60_000);

  it("LA LISTE DES ARTICLES : au choix, un article ajouté renvoie à la retranscription et rouvre la demande ; en validation, elle ne bouge plus", async () => {
    const id = await nouveau("Articles");
    await jusquAuChoix(id);
    const demande = (await dossier(id)).adminRequestId!;
    await comme("cp");
    const ajout = await enregistrerArticleDemandePromo(form({ promoMaterialId: id, catalogueId: catPresentoir, quantite: "10", actions: ["FABRICATION"] }));
    expect(ajout.ok, err(ajout)).toBe(true);
    expect(ajout.message).toMatch(/Le dossier revient à l'assistante pour le faire chiffrer\.$/);
    expect((await dossier(id)).circuitState).toBe("QUOTE_REQUESTED");
    expect((await prisma.administrativeRequest.findUniqueOrThrow({ where: { id: demande } })).status).toBe("IN_PROGRESS");
    expect(await avis(u.asst!, id, "Matériel promotionnel — un article demandé a changé")).toBe(1);

    // Pendant la retranscription : corrigé, puis retiré — l'assistante est prévenue des deux.
    const article = ajout.id!;
    const corrige = await enregistrerArticleDemandePromo(form({ promoMaterialId: id, requestItemId: article, catalogueId: catPresentoir, quantite: "12", actions: ["FABRICATION"] }));
    expect(corrige.ok, err(corrige)).toBe(true);
    expect(corrige.message).toMatch(/L'assistante en est prévenue\.$/);
    expect(await avis(u.asst!, id, "Matériel promotionnel — un article demandé a changé")).toBe(2);
    reussi(await retirerArticleDemandePromo(form({ promoMaterialId: id, requestItemId: article })), "retirer");
    expect(await avis(u.asst!, id, "Matériel promotionnel — un article demandé a été retiré")).toBe(1);

    await comme("asst");
    reussi(await terminerRetranscriptionPromo(form({ promoMaterialId: id })), "terminer");
    await choisirEtValider(id);
    expect((await dossier(id)).circuitState).toBe("REVIEW_MANAGER");
    await comme("cp");
    const verrou = "Votre choix est en validation : la liste des articles se modifie si la validation vous le renvoie pour correction.";
    expect(err(await enregistrerArticleDemandePromo(form({ promoMaterialId: id, catalogueId: catPresentoir, quantite: "1", actions: ["FABRICATION"] })))).toBe(verrou);
    const carnet = (await prisma.promoRequestItem.findFirstOrThrow({ where: { promoMaterialId: id } })).id;
    expect(err(await retirerArticleDemandePromo(form({ promoMaterialId: id, requestItemId: carnet })))).toBe(verrou);
  }, 90_000);

  it("UN ARTICLE AJOUTÉ PENDANT QUE L'ÉTAPE CHANGE n'est pas écrit — l'écriture est conditionnelle sur l'étape lue", async () => {
    const id = await nouveau("Article croisé");
    await comme("cp");
    const avant = await prisma.promoRequestItem.count({ where: { promoMaterialId: id } });
    const r = await pendantLaLecture(
      () => enregistrerArticleDemandePromo(form({ promoMaterialId: id, catalogueId: catPresentoir, quantite: "3", actions: ["FABRICATION"] })),
      (tx) => tx.promoMaterial.update({ where: { id }, data: { circuitState: "REVIEW_MANAGER" } }),
    );
    expect(err(r)).toMatch(/vient de changer d'étape/);
    expect(await prisma.promoRequestItem.count({ where: { promoMaterialId: id } }), "rien n'est écrit").toBe(avant);

    // RETIRER aussi : un article retiré pendant que le choix part en validation reste demandé.
    await prisma.promoMaterial.update({ where: { id }, data: { circuitState: "REVIEW_REQUEST" } });
    const carnet = (await prisma.promoRequestItem.findFirstOrThrow({ where: { promoMaterialId: id } })).id;
    const retrait = await pendantLaLecture(
      () => retirerArticleDemandePromo(form({ promoMaterialId: id, requestItemId: carnet })),
      (tx) => tx.promoMaterial.update({ where: { id }, data: { circuitState: "REVIEW_MANAGER" } }),
    );
    expect(err(retrait)).toMatch(/vient de changer d'étape/);
    expect(await prisma.promoRequestItem.count({ where: { id: carnet } }), "l'article est toujours là").toBe(1);
  }, 60_000);

  it("RENVOYER LE CHOIX (Direction Marketing) : le dossier revient au choix des lignes, « À corriger » ; le revalider repasse par la directrice", async () => {
    const id = await nouveau("Renvoi du choix");
    await jusquAuChoix(id);
    await choisirEtValider(id);
    await comme("dehors");
    expect(err(await refusePromoStep(form({ id }))), "l'état d'abord : qui ne tranche pas n'écrit pas de motif").toBe("Cette étape ne vous revient pas.");
    await comme("cp2");
    expect(err(await renvoyerPromoStep(form({ id, motif: "x" })))).toBe("Cette étape ne vous revient pas.");
    await comme("dir");
    expect(err(await refusePromoStep(form({ id })))).toMatch(/^Dites pourquoi/);
    const r = await renvoyerPromoStep(form({ id, motif: "Le grammage retenu n'est pas celui du brief" }));
    expect(r.ok, err(r)).toBe(true);
    expect(r.message).toBe("Renvoyé au demandeur : il refait son choix de lignes, qui repassera par les validations.");
    const pm = await dossier(id);
    expect(pm).toMatchObject({ circuitState: "REVIEW_REQUESTER", returnedFrom: "REVIEW_MANAGER", returnNote: "Le grammage retenu n'est pas celui du brief", returnedById: u.dir });
    expect(statutDuDossier(pm).libelle).toBe("À corriger");
    expect(await avis(u.cp!, id, "Matériel promotionnel — à corriger")).toBe(1);

    // Revalider le choix efface la marque et repasse par la directrice ; puis l'exécution.
    await choisirEtValider(id);
    expect(await dossier(id)).toMatchObject({ circuitState: "REVIEW_MANAGER", returnedAt: null, returnNote: null, returnedFrom: null });
    await comme("dir");
    reussi(await validatePromoStep(form({ id })), "la directrice valide");
    expect((await dossier(id)).circuitState).toBe("IN_EXECUTION");
    expect(err(await renvoyerPromoStep(form({ id, motif: "x" })))).toMatch(/ne se renvoie pas/);
    await comme("cp");
    expect(err(await enregistrerArticleDemandePromo(form({ promoMaterialId: id, catalogueId: catPresentoir, quantite: "1", actions: ["FABRICATION"] }))))
      .toBe("Les validations sont obtenues : la liste des articles ne se modifie plus — les bons de commande en découlent.");
  }, 90_000);
});
