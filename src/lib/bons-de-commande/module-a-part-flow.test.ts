import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));
class Redirection extends Error {
  constructor(readonly vers: string) { super(`redirect ${vers}`); }
}
class Introuvable extends Error {}
vi.mock("next/navigation", () => ({
  redirect: (vers: string) => { throw new Redirection(vers); },
  notFound: () => { throw new Introuvable("notFound"); },
}));

import { prisma } from "@/lib/prisma";
import { getAccess, userCan, PERMISSIONS, type SessionUser } from "@/lib/rbac";
import { createLegalDocument } from "@/lib/actions/legal-actions";
import { decideValidation } from "@/lib/actions/validation-actions";
import { signerBonDeCommande } from "@/lib/actions/bc-signature-actions";
import { avecCopieSignee } from "@/lib/bons-de-commande/signature-test-outils";
import { bcVisiblesWhere, fileBonsDeCommande, peutSignerBC, REFUS_SIGNATURE_BC } from "@/lib/queries/bons-de-commande";
import { peutLireLaPieceLegale } from "@/lib/queries/legal-fichier";
import { canAccessEntity } from "@/lib/entity-access";
import { CHEMIN_BONS_DE_COMMANDE } from "@/lib/chemins/bons-de-commande";
import { signatairesAPrevenir, ROLES_SIGNATAIRES_DE_METIER } from "./signataires";
import { etatDuBC } from "./etat";
import { OBJET_BC, CHEMIN_BC_A_SIGNER } from "./aiguillage";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__bcmodule__";

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
 * LES BONS DE COMMANDE, MODULE À PART — par les VRAIS points d'entrée (§118.176).
 *
 * « Le module bon de commande doit être à part et le super admin donne les accès à qui il veut. »
 * Quatre propriétés, chacune avec le cas qui la ferait tomber :
 *   1. PERSONNE NE PERD RIEN le jour où la règle change de forme : les défauts du module sont,
 *      rôle par rôle, exactement le périmètre d'hier (qui modifiait les Finances signait, qui les
 *      lisait voyait la file).
 *   2. LA PORTE EST LE MODULE, PAS LES FINANCES : un financier à qui le Super Admin retire le
 *      module garde ses Finances, perd la file et la signature — et n'est plus prévenu.
 *   3. LE SUPER ADMIN L'OUVRE À QUI IL VEUT : un compte sans Legal ni Finances, désigné dans la
 *      console, voit la file, LIT ce qu'il signe (fiche, fichiers, pièces jointes) sans rien d'autre
 *      du registre, signe — et il est prévenu.
 *   4. LE POUVOIR N'EST PAS LA FILE : la Direction signe par défaut (elle signait hier), mais seuls
 *      le métier (les Finances) et les personnes désignées dans la console sont PRÉVENUS.
 *
 * Les acteurs ne sont jamais Super Admin là où une garde se mesure : une garde éprouvée avec un
 * Super Admin ne peut pas tomber (§118.104). Le Super Admin du banc ne fait que trancher au centre.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Bons de commande — module à part, accès donnés par le Super Admin", () => {
  let auteurId = "", saId = "", contactId = "";
  let financeId = "", financeBloqueId = "", signataireNommeId = "", lecteurNommeId = "", directionId = "", directionNommeeId = "";
  const docs: string[] = [];

  const creerBC = async (suffix: string) => {
    ACTOR = await actorFor(auteurId, "DIRECTION_ASSISTANT");
    // 100 000 DZD : au-dessus de tout seuil qu'un banc voisin pose (1 DZD) — le BC va au centre.
    const r = await createLegalDocument(undefined, form({
      title: `${TAG} ${suffix}`, reference: `${TAG}${suffix}`, kind: "PURCHASE_ORDER",
      counterpartyIds: contactId, amount: "100000",
    }));
    expect(r.ok, r.ok === false ? r.error : "").toBe(true);
    docs.push(r.id!);
    return r.id!;
  };
  /** Le BC passe « à signer » par la DÉCISION du centre — c'est elle qui prévient les signataires. */
  const validerAuCentre = async (docId: string) => {
    const [v] = await prisma.validationRequest.findMany({
      where: { entityType: "LEGAL_DOCUMENT", entityId: docId, objectType: OBJET_BC, status: "PENDING" },
      include: { steps: true },
    });
    expect(v, "le BC doit attendre son centre").toBeDefined();
    ACTOR = await actorFor(saId, "SUPER_ADMIN");
    const d = await decideValidation(form({ stepId: v.steps[0].id, decision: "APPROVED" }));
    expect(d.ok, d.ok === false ? d.error : "").toBe(true);
    expect((await etatDuBC(docId))?.etape).toBe("A_SIGNER");
  };
  const prevenu = async (userId: string, suffix: string) =>
    (await prisma.notification.count({ where: { userId, link: { startsWith: CHEMIN_BC_A_SIGNER }, body: { contains: `${TAG}${suffix}` } } })) > 0;
  const pieceLegale = (kind: "INVOICE" | "CONTRACT", suffix: string) =>
    prisma.legalDocument.create({ data: { title: `${TAG} ${suffix}`, kind, createdById: auteurId }, select: { id: true, kind: true } })
      .then((d) => { docs.push(d.id); return d; });

  beforeAll(async () => {
    const mk = (n: string, role: SessionUser["role"]) =>
      prisma.user.create({ data: { name: `${TAG}${n}`, email: `${TAG}${n}@t.dz`, role, passwordHash: "x" } }).then((u) => u.id);
    auteurId = await mk("auteur", "DIRECTION_ASSISTANT");
    saId = await mk("sa", "SUPER_ADMIN");
    financeId = await mk("finance", "FINANCE_BUDGET_MANAGER");
    financeBloqueId = await mk("financebloque", "FINANCE_BUDGET_MANAGER");
    signataireNommeId = await mk("signataire", "VIEWER");
    lecteurNommeId = await mk("lecteur", "VIEWER");
    directionId = await mk("direction", "DIRECTION");
    directionNommeeId = await mk("directionnommee", "DIRECTION");
    // LA CONSOLE (Administration › Accès) : bloquer, désigner, ouvrir en lecture.
    await prisma.userAccess.createMany({
      data: [
        { userId: financeBloqueId, module: "PURCHASE_ORDERS", canView: false },
        { userId: signataireNommeId, module: "PURCHASE_ORDERS", canView: true, canUpdate: true, scope: "ALL" },
        { userId: lecteurNommeId, module: "PURCHASE_ORDERS", canView: true, canUpdate: false, scope: "ALL" },
        { userId: directionNommeeId, module: "PURCHASE_ORDERS", canView: true, canUpdate: true, scope: "ALL" },
      ],
    });
    contactId = (await prisma.companyContact.create({ data: { name: `${TAG} Imprimerie`, companyId: null } })).id;
  });

  afterAll(async () => {
    const vIds = (await prisma.validationRequest.findMany({ where: { entityType: "LEGAL_DOCUMENT", entityId: { in: docs } }, select: { id: true } })).map((v) => v.id);
    await prisma.validationStep.deleteMany({ where: { requestId: { in: vIds } } }).catch(() => {});
    await prisma.validationRequest.deleteMany({ where: { id: { in: vIds } } }).catch(() => {});
    await prisma.adProGateVisa.deleteMany({ where: { entityType: "LEGAL_DOCUMENT", entityId: { in: docs } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { entityType: "LEGAL_DOCUMENT", entityId: { in: docs } } }).catch(() => {});
    await prisma.legalDocumentReader.deleteMany({ where: { documentId: { in: docs } } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { id: { in: docs } } }).catch(() => {});
    await prisma.companyContact.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    const ids = (await prisma.user.findMany({ where: { email: { startsWith: TAG } }, select: { id: true } })).map((c) => c.id);
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("1. PERSONNE NE PERD RIEN : les défauts du module sont, rôle par rôle, le périmètre d'hier", () => {
    for (const [role, matrice] of Object.entries(PERMISSIONS)) {
      if (role === "SUPER_ADMIN") continue;
      const finances = matrice.FINANCES ?? [];
      const bc = matrice.PURCHASE_ORDERS ?? [];
      expect(bc.includes("VIEW"), `${role} : voir la file ⇔ lire les Finances hier`).toBe(finances.includes("VIEW"));
      expect(bc.includes("UPDATE"), `${role} : signer ⇔ modifier les Finances hier`).toBe(finances.includes("UPDATE"));
    }
    // Le métier prévenu par défaut porte bien la signature par défaut — sinon il serait prévenu pour rien.
    for (const r of ROLES_SIGNATAIRES_DE_METIER) expect(PERMISSIONS[r].PURCHASE_ORDERS ?? []).toContain("UPDATE");
  });

  it("PRÉMISSES : le financier bloqué garde ses Finances ; les désignés n'ont ni Legal ni Finances ; personne n'est Super Admin", async () => {
    const fb = await actorFor(financeBloqueId, "FINANCE_BUDGET_MANAGER");
    expect(userCan(fb, "FINANCES", "UPDATE"), "le blocage ne porte que sur le module « Bons de commande »").toBe(true);
    expect(userCan(fb, "PURCHASE_ORDERS", "VIEW")).toBe(false);
    for (const id of [signataireNommeId, lecteurNommeId]) {
      const a = await actorFor(id, "VIEWER");
      expect(userCan(a, "LEGAL", "VIEW")).toBe(false);
      expect(userCan(a, "FINANCES", "VIEW")).toBe(false);
      expect(userCan(a, "PURCHASE_ORDERS", "VIEW")).toBe(true);
    }
  });

  it("2. LA PORTE EST LE MODULE : retiré par le Super Admin, plus de file, plus de signature — mais les Finances restent", async () => {
    const id = await creerBC("bloque");
    await validerAuCentre(id);
    ACTOR = await actorFor(financeBloqueId, "FINANCE_BUDGET_MANAGER");
    expect(peutSignerBC(ACTOR)).toBe(false);
    expect(await bcVisiblesWhere(ACTOR), "la file lui est fermée").toBeNull();
    expect(await fileBonsDeCommande(ACTOR)).toBeNull();
    const s = await signerBonDeCommande(avecCopieSignee(form({ id })));
    expect(s.ok ? "" : s.error).toBe(REFUS_SIGNATURE_BC);
    // Le refus nomme la CASE à cocher et l'écran : sans cela, le Super Admin ne sait pas quoi faire.
    expect(REFUS_SIGNATURE_BC).toMatch(/« Modifier »/);
    expect(REFUS_SIGNATURE_BC).toMatch(/Administration › Accès/);
    // Ses Finances restent : la fiche d'une facture s'ouvre toujours à lui (chaîne d'achat).
    const facture = await pieceLegale("INVOICE", "facture-fb");
    expect(await peutLireLaPieceLegale(ACTOR, facture)).toBe(true);
    // Et il n'est pas prévenu d'un BC qu'il ne peut ni voir ni signer.
    expect(await prevenu(financeBloqueId, "bloque")).toBe(false);
    expect(await prevenu(financeId, "bloque"), "le financier par défaut, lui, l'est").toBe(true);
  });

  it("3. OUVERT À QUI IL VEUT : le désigné voit la file, lit ce qu'il signe et rien d'autre, signe, et il est prévenu", async () => {
    const id = await creerBC("nomme");
    await validerAuCentre(id);
    ACTOR = await actorFor(signataireNommeId, "VIEWER");
    expect(peutSignerBC(ACTOR)).toBe(true);
    const file = await fileBonsDeCommande(ACTOR);
    expect(file?.aSigner.map((l) => l.id)).toContain(id);
    // LIRE CE QU'ON SIGNE (§118.149e) : la fiche, ses fichiers, ses pièces jointes.
    const bc = { id, kind: "PURCHASE_ORDER" };
    expect(await peutLireLaPieceLegale(ACTOR, bc), "la fiche du BC s'ouvre — sinon la file est une impasse").toBe(true);
    expect(await canAccessEntity(ACTOR, "LEGAL_DOCUMENT", id, "VIEW"), "ses pièces jointes se téléchargent").toBe(true);
    expect(await canAccessEntity(ACTOR, "LEGAL_DOCUMENT", id, "UPLOAD"), "signer n'est pas modifier la pièce").toBe(false);
    // RIEN D'AUTRE du registre : ni une facture, ni un contrat.
    const facture = await pieceLegale("INVOICE", "facture-nomme");
    const contrat = await pieceLegale("CONTRACT", "contrat-nomme");
    expect(await peutLireLaPieceLegale(ACTOR, facture)).toBe(false);
    expect(await peutLireLaPieceLegale(ACTOR, contrat)).toBe(false);
    expect(await canAccessEntity(ACTOR, "LEGAL_DOCUMENT", facture.id, "VIEW")).toBe(false);
    expect(await canAccessEntity(ACTOR, "LEGAL_DOCUMENT", contrat.id, "VIEW")).toBe(false);
    // Il a été PRÉVENU par la décision du centre, et il signe.
    expect(await prevenu(signataireNommeId, "nomme")).toBe(true);
    const s = await signerBonDeCommande(avecCopieSignee(form({ id })));
    expect(s.ok, s.ok === false ? s.error : "").toBe(true);
    const apres = await prisma.legalDocument.findUniqueOrThrow({ where: { id } });
    expect(apres.signedById).toBe(signataireNommeId);
    // L'audit nomme la personne et le module — pas « les Finances », qu'il n'est pas.
    const audit = await prisma.auditLog.findFirst({ where: { entityType: "LEGAL_DOCUMENT", entityId: id, action: "VALIDATE" }, orderBy: { createdAt: "desc" } });
    expect(audit?.actorId).toBe(signataireNommeId);
    expect(audit?.summary ?? "").not.toMatch(/Finances/);
  });

  it("3 bis. OUVERT EN LECTURE : il voit la file et la fiche, il ne signe pas, et il n'est pas prévenu", async () => {
    const id = await creerBC("lecteur");
    await validerAuCentre(id);
    ACTOR = await actorFor(lecteurNommeId, "VIEWER");
    expect(peutSignerBC(ACTOR)).toBe(false);
    expect((await fileBonsDeCommande(ACTOR))?.aSigner.map((l) => l.id)).toContain(id);
    expect(await peutLireLaPieceLegale(ACTOR, { id, kind: "PURCHASE_ORDER" })).toBe(true);
    const s = await signerBonDeCommande(avecCopieSignee(form({ id })));
    expect(s.ok ? "" : s.error).toBe(REFUS_SIGNATURE_BC);
    expect(await prevenu(lecteurNommeId, "lecteur"), "on ne prévient pas quelqu'un qui ne peut pas agir").toBe(false);
  });

  it("4. LE POUVOIR N'EST PAS LA FILE : la Direction signe par défaut sans être prévenue ; désignée dans la console, elle l'est", async () => {
    const id = await creerBC("pouvoir");
    await validerAuCentre(id);
    const d = await actorFor(directionId, "DIRECTION");
    expect(peutSignerBC(d), "elle signait hier — elle signe encore").toBe(true);
    expect(await prevenu(directionId, "pouvoir"), "chaque BC chez la Direction : du bruit qu'on cesse de lire (§118.32)").toBe(false);
    expect(await prevenu(directionNommeeId, "pouvoir"), "la console l'a désignée : c'est une décision du Super Admin").toBe(true);
    // Et la résolution des signataires dit la même chose que les notifications parties.
    const ids = await signatairesAPrevenir();
    expect(ids).toContain(financeId);
    expect(ids).toContain(signataireNommeId);
    expect(ids).toContain(directionNommeeId);
    expect(ids).not.toContain(financeBloqueId);
    expect(ids).not.toContain(lecteurNommeId);
    expect(ids).not.toContain(directionId);
  });

  it("LES FINANCES ATTEIGNENT LES PIÈCES JOINTES de leur chaîne d'achat — la fiche les leur offrait, le serveur les refusait", async () => {
    // Avant ce lot, la porte des pièces jointes ne lisait que le module Legal : la fiche d'une
    // facture proposait « Joindre » aux Finances et listait ses fichiers, et le serveur refusait
    // l'envoi comme le téléchargement (§118.83).
    const f = await actorFor(financeId, "FINANCE_BUDGET_MANAGER");
    expect(userCan(f, "LEGAL", "VIEW"), "PRÉMISSE : sans Legal, seule la porte des Finances peut répondre").toBe(false);
    const facture = await pieceLegale("INVOICE", "facture-fin");
    const contrat = await pieceLegale("CONTRACT", "contrat-fin");
    expect(await canAccessEntity(f, "LEGAL_DOCUMENT", facture.id, "VIEW")).toBe(true);
    expect(await canAccessEntity(f, "LEGAL_DOCUMENT", facture.id, "UPLOAD")).toBe(true);
    // Mais pas au-delà de leur chaîne : un contrat reste fermé, en lecture comme en écriture.
    expect(await canAccessEntity(f, "LEGAL_DOCUMENT", contrat.id, "VIEW")).toBe(false);
    expect(await canAccessEntity(f, "LEGAL_DOCUMENT", contrat.id, "UPLOAD")).toBe(false);
  });

  it("LE REGISTRE ENTIER n'est pas le sien : un désigné qui ouvre Legal est conduit à sa file", async () => {
    ACTOR = await actorFor(signataireNommeId, "VIEWER");
    const { default: LegalPage } = await import("@/app/(app)/legal/page");
    let vers: string | null = null;
    try { await LegalPage({ searchParams: Promise.resolve({}) }); } catch (e) { if (e instanceof Redirection) vers = e.vers; else throw e; }
    expect(vers).toBe(CHEMIN_BONS_DE_COMMANDE);
  });
});
