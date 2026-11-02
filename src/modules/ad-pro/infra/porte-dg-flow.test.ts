import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR }));
/**
 * LE SEUIL DU DG EST UN RÉGLAGE GLOBAL (`AppSetting.adProDgThreshold`) : le banc l'INJECTE dans son propre
 * processus — la base partagée garde le sien, et ce banc ne dépend pas de sa valeur du jour (§118.132).
 */
const SEUIL_DG = 1_000_000;
vi.mock("@/lib/settings", async (importOriginal) => {
  const vrai = await importOriginal<typeof import("@/lib/settings")>();
  return { ...vrai, getAppSettings: async () => ({ ...(await vrai.getAppSettings()), adProDgThreshold: SEUIL_DG }) };
});

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { addAdProItem, updateAdProItem, submitAdProItem, requestAdProItemOrder, approveAdProItemOrder } from "../actions-postes";
import { decideAdProItem } from "../actions-postes-decision";
import { demanderPaiementPoste } from "../actions-postes-paiement";
import { genererBonDeCommandePoste } from "../actions-postes-lignes";
import { totalDeLaDemande, lirePorteDg, statuerSurLeTotal, peutStatuerSurLeTotal } from "./porte-dg";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

// Un suffixe PAR RUN : un banc à étiquette fixe ne survit pas à un run interrompu (§118.136).
const TAG = "__portedg__";
const RUN = `${TAG}${Date.now().toString(36)}`;
const DEBUT = new Date(Date.now() - 1_000);

async function acteur(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}
const fd = (champs: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(champs)) f.set(k, v);
  return f;
};
const pdf = (nom: string) => new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]), `${nom}-${Date.now()}-${Math.random()}`], nom, { type: "application/pdf" });
// Les montants s'écrivent à la française (espace fine insécable) : le juge formate comme la règle.
const dzd = (n: number) => `${Math.round(n).toLocaleString("fr-FR")} DZD`;

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA PORTE DU DG SUR LE TOTAL D'UNE DEMANDE Ad & Pro — par les VRAIS points d'entrée (Direction, 27/10/2026).
 *
 * « Le directeur général valide uniquement à la fin, le TOTAL. Aucun engagement ne peut être fait, aucun
 * bon de commande ne peut être généré si ça dépasse le seuil. Le seuil, c'est pour toute la demande, la
 * somme des postes. » La règle pure est tenue par `seuils/porte-dg-total.test.ts` ; ici : le total lu sur
 * les VRAIS postes, chaque action qui engagerait de l'argent refusée porte fermée, le DG prévenu une fois
 * par nouveau total, sa décision, et la rallonge qui rouvre la porte.
 *
 * Les juges comptent par LIEN CAUSAL (la notification mène à CETTE demande), jamais par un compte global
 * de la base partagée (§118.92). Chaque acteur est NOMMÉ dans son cas (§118.151f).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Ad & Pro — la porte du DG sur le total de la demande", () => {
  const u: Record<"kam" | "dm" | "gm" | "dirGm" | "ast", string> = { kam: "", dm: "", gm: "", dirGm: "", ast: "" };
  const ROLES = { kam: "MEDICAL_DELEGATE", dm: "PRODUCT_MANAGER", gm: "GENERAL_MANAGER", dirGm: "DIRECTION", ast: "DIRECTION_ASSISTANT" } as const;
  let congres = "", petit = "", catId = "";
  let stand = "", hotel = "", traiteur = "";
  const comme = async (qui: keyof typeof ROLES) => { ACTOR = await acteur(u[qui], ROLES[qui]); return ACTOR; };
  const ok = (r: { ok: boolean; error?: string }) => expect(r.ok, r.error ?? "").toBe(true);
  const DG = () => ({ id: u.gm, name: `${TAG}gm`, role: ROLES.gm });
  /** Les signalements « total à valider » reçus par le DG pour CE congrès. */
  const signales = () => prisma.notification.count({
    where: { userId: u.gm, title: "Ad & Pro — total à valider (Directeur Général)", link: { contains: congres }, createdAt: { gte: DEBUT } },
  });

  beforeAll(async () => {
    const cles = Object.keys(ROLES) as (keyof typeof ROLES)[];
    const comptes = await Promise.all(cles.map((k) => prisma.user.create({
      data: {
        name: `${TAG}${k}`, email: `${RUN}${k}@t.dz`, role: ROLES[k], passwordHash: "x",
        // Le DG par son rôle SECONDAIRE : il statue aussi (`hasRole`).
        ...(k === "dirGm" ? { secondaryRole: "GENERAL_MANAGER" as const } : {}),
      },
    })));
    cles.forEach((k, i) => { u[k] = comptes[i].id; });
    // PRÉVALIDÉS (requestStatus APPROVED, aucun montant écrit) : sans quoi aucun poste ne s'y ajoute.
    congres = (await prisma.congressNational.create({ data: { name: `${RUN} Congrès d'Oran`, requesterId: u.kam, requestStatus: "APPROVED" } })).id;
    petit = (await prisma.congressNational.create({ data: { name: `${RUN} Journée de Blida`, requesterId: u.kam, requestStatus: "APPROVED" } })).id;
    const env = await prisma.budgetEnvelope.create({
      data: { name: `${RUN}Enveloppe`, modules: ["CONGRESS_NATIONAL"], totalAmount: 50_000_000, periodStart: new Date("2026-01-01"), periodEnd: new Date("2026-12-31") },
      select: { id: true },
    });
    catId = (await prisma.budgetCategoryLine.create({ data: { envelopeId: env.id, name: `${TAG}Congrès`, allocated: 50_000_000 }, select: { id: true } })).id;
  }, 60_000);

  afterAll(async () => {
    const ids = Object.values(u).filter(Boolean);
    const parents = [congres, petit].filter(Boolean);
    const postes = (await prisma.adProItem.findMany({ where: { congressNationalId: { in: parents } }, select: { id: true } }).catch(() => [])).map((p) => p.id);
    await prisma.documentRequest.deleteMany({ where: { entityType: "AD_PRO_ITEM", entityId: { in: postes } } }).catch(() => {});
    const liens = await prisma.adProItemPiece.findMany({ where: { itemId: { in: postes } }, select: { legalDocumentId: true } }).catch(() => []);
    await prisma.adProItemPiece.deleteMany({ where: { itemId: { in: postes } } }).catch(() => {});
    await prisma.document.deleteMany({ where: { entityId: { in: [...postes, ...liens.map((l) => l.legalDocumentId)] } } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { id: { in: liens.map((l) => l.legalDocumentId) } } }).catch(() => {});
    await prisma.adProItemDecision.deleteMany({ where: { itemId: { in: postes } } }).catch(() => {});
    await prisma.adProItem.deleteMany({ where: { id: { in: postes } } }).catch(() => {});
    await prisma.adProPorteDg.deleteMany({ where: { entityId: { in: parents } } }).catch(() => {});
    // Le signalement part à TOUS les DG et Super Admins de la base partagée : retiré par son lien, borné à ce run.
    for (const id of parents) await prisma.notification.deleteMany({ where: { link: { contains: id }, createdAt: { gte: DEBUT } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { OR: [{ entityId: { in: [...parents, ...postes] } }, { actorId: { in: ids } }] } }).catch(() => {});
    await prisma.congressNational.deleteMany({ where: { id: { in: parents } } }).catch(() => {});
    await prisma.budgetCategoryLine.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.budgetEnvelope.deleteMany({ where: { name: { startsWith: RUN } } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
  }, 60_000);

  /** Un poste ajouté par le délégué (brouillon). */
  async function ajouter(label: string, montant: number, parentId = congres): Promise<string> {
    await comme("kam");
    const a = await addAdProItem(undefined, fd({ parent: "CONGRESS_NATIONAL", parentId, kind: "PRINTING", label: `${TAG}${label}`, amountEstimated: String(montant), supplier: "Imprimerie Alpha" }));
    ok(a);
    return a.id!;
  }
  /** …soumis, puis accepté par la Direction Marketing (un seul temps) avec son budget. */
  async function accepter(id: string, montant: number) {
    await comme("kam");
    ok(await submitAdProItem(undefined, fd({ id })));
    await comme("dm");
    ok(await decideAdProItem(undefined, fd({ id, decision: "APPROVED", amountGranted: String(montant), budgetCategoryId: catId })));
  }
  const demanderBC = async (id: string) => { await comme("kam"); return requestAdProItemOrder(undefined, fd({ id, note: "x", assistantId: u.ast })); };
  const payer = async (id: string, montant: string) => {
    await comme("kam");
    const f = fd({ id, montant, reference: `${TAG}FA`, argumentation: "Écart connu et accepté (banc).", confirme: "1" });
    f.append("attachment", pdf(`${TAG}facture.pdf`));
    return demanderPaiementPoste(undefined, f);
  };

  it("LE TOTAL = la somme des postes NON refusés — l'accordé quand il l'est, sinon l'estimé", async () => {
    // DÉCOR, nommé : trois postes posés en base — c'est le calcul qu'on éprouve, pas les gestes.
    await prisma.adProItem.createMany({
      data: [
        { congressNationalId: petit, kind: "PRINTING", label: `${TAG}Brouillon`, amountEstimated: 300_000, status: "DRAFT" },
        { congressNationalId: petit, kind: "PRINTING", label: `${TAG}Accordé`, amountEstimated: 500_000, amountGranted: 400_000, status: "APPROVED" },
        { congressNationalId: petit, kind: "PRINTING", label: `${TAG}Refusé`, amountEstimated: 900_000, status: "REJECTED" },
      ],
    });
    expect(await totalDeLaDemande("CONGRESS_NATIONAL", petit)).toBe(700_000);
    const p = await lirePorteDg("CONGRESS_NATIONAL", petit);
    expect(p).toMatchObject({ etat: "NON_REQUISE", total: 700_000, seuil: SEUIL_DG, phrase: null, refus: null });
    // Sous le seuil, la validation du DG n'est pas requise — et le dire plutôt que d'écrire une décision vide.
    const r = await statuerSurLeTotal({ user: DG(), parent: "CONGRESS_NATIONAL", parentId: petit, decision: "VALIDEE", totalVu: 700_000, note: null });
    expect(r.ok === false ? r.error : "validé").toBe("Le total de cette demande ne dépasse pas le seuil : votre validation n'est pas requise.");
    expect(await prisma.adProPorteDg.count({ where: { entityId: petit } })).toBe(0);
  });

  it("QUI STATUE : le DG (rôle principal ou secondaire) et le Super Admin — ni le demandeur, ni la Direction Marketing, ni la Direction seule", () => {
    expect(peutStatuerSurLeTotal({ role: "GENERAL_MANAGER" })).toBe(true);
    expect(peutStatuerSurLeTotal({ role: "DIRECTION", secondaryRole: "GENERAL_MANAGER" })).toBe(true);
    expect(peutStatuerSurLeTotal({ role: "SUPER_ADMIN" })).toBe(true);
    for (const role of ["DIRECTION", "PRODUCT_MANAGER", "OPERATIONS_DIRECTOR", "MEDICAL_DELEGATE", "NATIONAL_SALES"]) {
      expect(peutStatuerSurLeTotal({ role }), role).toBe(false);
    }
  });

  it("AU-DESSUS DU SEUIL : ni BC, ni génération, ni visa, ni paiement — et le DG est prévenu UNE fois par nouveau total", async () => {
    stand = await ajouter("Stand", 600_000);
    await accepter(stand, 600_000);
    expect((await lirePorteDg("CONGRESS_NATIONAL", congres)).etat, "600 000 : sous le seuil").toBe("NON_REQUISE");
    expect(await signales(), "rien à signaler sous le seuil").toBe(0);

    hotel = await ajouter("Hôtel", 500_000);
    await accepter(hotel, 500_000);
    const p = await lirePorteDg("CONGRESS_NATIONAL", congres);
    expect(p.etat, "1 100 000 > 1 000 000 : la porte se ferme").toBe("EN_ATTENTE");
    expect(p.total).toBe(1_100_000);
    const REFUS = `Total de ${dzd(1_100_000)} au-dessus du seuil de ${dzd(SEUIL_DG)} : la validation du Directeur Général est requise avant tout bon de commande ou paiement. Aucun bon de commande, engagement ni paiement n'est possible d'ici là.`;
    expect(p.refus).toBe(REFUS);
    expect(await signales(), "le DG est prévenu de CE total").toBe(1);

    // Chaque action qui engagerait de l'argent refuse — même pour le poste accepté AVANT que le total franchisse le seuil.
    for (const id of [stand, hotel]) {
      const bc = await demanderBC(id);
      expect(bc.ok === false ? bc.error : "demandé", "demander le BC").toBe(REFUS);
      await comme("kam");
      const gen = await genererBonDeCommandePoste(fd({ id }));
      expect(gen.ok === false ? gen.error : "généré", "générer le BC").toBe(REFUS);
      const paie = await payer(id, "500000");
      expect(paie.ok === false ? paie.error : "payé", "demander le paiement").toBe(REFUS);
    }
    await comme("gm");
    const visa = await approveAdProItemOrder(undefined, fd({ id: stand, decision: "APPROVE" }));
    expect(visa.ok === false ? visa.error : "visé", "viser le BC").toBe(REFUS);
    const apres = await prisma.adProItem.findMany({ where: { id: { in: [stand, hotel] } }, select: { orderStage: true, expenseOrderId: true } });
    expect(apres.every((x) => x.orderStage === "NONE" && x.expenseOrderId === null), "aucun refus n'a pris la marche ni créé d'ordre").toBe(true);
    expect(await prisma.documentRequest.count({ where: { entityType: "AD_PRO_ITEM", entityId: { in: [stand, hotel] } } }), "aucune demande de pièce partie").toBe(0);

    // UNE FOIS par total : un geste qui ne change pas le total ne re-signale pas.
    await comme("kam");
    ok(await updateAdProItem(undefined, fd({ id: hotel, label: `${TAG}Hôtel (12 chambres)` })));
    expect(await signales(), "même total : pas de second signalement").toBe(1);
  }, 60_000);

  it("LE DG STATUE : ni le demandeur ni la Direction Marketing ; renvoi motivé ; un total qu'il n'a pas vu ne se valide pas", async () => {
    for (const k of ["kam", "dm"] as const) {
      const r = await statuerSurLeTotal({ user: { id: u[k], role: ROLES[k] }, parent: "CONGRESS_NATIONAL", parentId: congres, decision: "VALIDEE", totalVu: 1_100_000, note: null });
      expect(r.ok === false ? r.error : "validé", k).toBe("Seul le Directeur Général (ou le Super Admin) valide le total d'une demande.");
    }
    const sansMotif = await statuerSurLeTotal({ user: DG(), parent: "CONGRESS_NATIONAL", parentId: congres, decision: "A_REVOIR", totalVu: 1_100_000, note: "  " });
    expect(sansMotif.ok === false ? sansMotif.error : "renvoyé").toMatch(/^Dites ce qu'il faut revoir/);
    const perime = await statuerSurLeTotal({ user: DG(), parent: "CONGRESS_NATIONAL", parentId: congres, decision: "VALIDEE", totalVu: 1_000_000, note: null });
    expect(perime.ok === false ? perime.error : "validé").toMatch(/^Le total vient de changer/);
    expect(await prisma.adProPorteDg.findFirst({ where: { entityId: congres, statut: { not: null } } }), "aucun refus n'a écrit de décision").toBeNull();

    // RENVOYÉ EN RÉVISION : la porte reste fermée pour CE total, et le refus le dit.
    ok(await statuerSurLeTotal({ user: DG(), parent: "CONGRESS_NATIONAL", parentId: congres, decision: "A_REVOIR", totalVu: 1_100_000, note: "Réduire l'hôtellerie." }));
    expect((await lirePorteDg("CONGRESS_NATIONAL", congres)).etat).toBe("A_REVOIR");
    const bc = await demanderBC(stand);
    expect(bc.ok === false ? bc.error : "demandé").toMatch(/renvoyé en révision par le Directeur Général/);
    // Le demandeur l'apprend — par le lien de SA demande.
    expect(await prisma.notification.count({ where: { userId: u.kam, title: "Ad & Pro — total renvoyé en révision par le DG", link: { contains: congres } } })).toBe(1);

    // CORRIGÉ : l'hôtellerie baisse (un nouveau total) — la porte attend de nouveau le DG, qui est re-prévenu.
    await comme("dm");
    ok(await updateAdProItem(undefined, fd({ id: hotel, amountGranted: "450000" })));
    const corrige = await lirePorteDg("CONGRESS_NATIONAL", congres);
    expect(corrige.total).toBe(1_050_000);
    expect(corrige.etat, "un renvoi ne survit pas à la correction des postes").toBe("EN_ATTENTE");
    expect(await signales(), "nouveau total : le DG est re-prévenu").toBe(2);

    // VALIDÉ par le DG — ici par son rôle SECONDAIRE.
    const r = await statuerSurLeTotal({ user: { id: u.dirGm, name: `${TAG}dirGm`, role: "DIRECTION", secondaryRole: "GENERAL_MANAGER" }, parent: "CONGRESS_NATIONAL", parentId: congres, decision: "VALIDEE", totalVu: 1_050_000, note: null });
    ok(r);
    expect(r.ok ? r.message : "").toBe(`Total de ${dzd(1_050_000)} validé par le Directeur Général.`);
    expect((await lirePorteDg("CONGRESS_NATIONAL", congres)).etat).toBe("VALIDEE");
    expect(await prisma.notification.count({ where: { userId: u.dm, title: "Ad & Pro — total validé par le DG : les bons de commande peuvent partir", link: { contains: congres } } }), "la Direction Marketing est prévenue").toBe(1);
    expect(await prisma.notification.count({ where: { userId: u.kam, title: "Ad & Pro — total validé par le DG : les bons de commande peuvent partir", link: { contains: congres } } }), "le demandeur aussi").toBe(1);

    // La porte ouverte : le BC part.
    ok(await demanderBC(stand));
    expect((await prisma.adProItem.findUniqueOrThrow({ where: { id: stand } })).orderStage).not.toBe("NONE");
  }, 60_000);

  it("UNE RALLONGE ROUVRE LA PORTE ; une baisse reste couverte ; un poste refusé ne compte plus", async () => {
    // Une baisse sous le total validé reste couverte.
    await comme("dm");
    ok(await updateAdProItem(undefined, fd({ id: hotel, amountGranted: "420000" })));
    expect((await lirePorteDg("CONGRESS_NATIONAL", congres))).toMatchObject({ etat: "VALIDEE", total: 1_020_000 });

    // LA RALLONGE : un traiteur porte le total à 1 170 000, au-delà des 1 050 000 validés.
    const avant = await signales();
    traiteur = await ajouter("Traiteur", 150_000);
    const p = await lirePorteDg("CONGRESS_NATIONAL", congres);
    expect(p.etat).toBe("EN_ATTENTE");
    // L'AJOUT est un changement de montant comme un autre : le DG est prévenu de ce nouveau total, sans attendre une décision.
    expect(await signales(), "le DG apprend la rallonge dès l'ajout").toBe(avant + 1);
    expect(p.phrase).toBe(`Total porté à ${dzd(1_170_000)}, au-delà des ${dzd(1_050_000)} validés par le Directeur Général : sa validation est de nouveau requise (seuil ${dzd(SEUIL_DG)}).`);
    // Elle referme la porte pour TOUS les postes de la demande — l'hôtel, accepté depuis longtemps, ne part pas.
    const bc = await demanderBC(hotel);
    expect(bc.ok === false ? bc.error : "demandé").toMatch(/de nouveau requise.*Aucun bon de commande, engagement ni paiement n'est possible d'ici là\.$/);
    expect((await prisma.adProItem.findUniqueOrThrow({ where: { id: hotel } })).orderStage).toBe("NONE");

    // LE RETRAIT DE LA RALLONGE : la Direction Marketing refuse le traiteur — il ne compte plus, la porte se rouvre.
    await soumettreEtRefuser(traiteur);
    expect((await lirePorteDg("CONGRESS_NATIONAL", congres))).toMatchObject({ etat: "VALIDEE", total: 1_020_000 });
    ok(await demanderBC(hotel));
  }, 60_000);

  /** Le traiteur soumis, puis REFUSÉ par la Direction Marketing (motif exigé). */
  async function soumettreEtRefuser(id: string) {
    await comme("kam");
    ok(await submitAdProItem(undefined, fd({ id })));
    await comme("dm");
    ok(await decideAdProItem(undefined, fd({ id, decision: "REJECTED", note: "Le traiteur est pris en charge par l'organisateur." })));
  }
});
