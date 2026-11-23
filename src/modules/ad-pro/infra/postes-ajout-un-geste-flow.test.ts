import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR }));
/** La lecture d'une pièce par le modèle est un service externe : ici, elle échoue — le dépôt, lui, ne doit jamais échouer pour autant. */
vi.mock("@/lib/pieces-lues/service", async (importOriginal) => {
  const vrai = await importOriginal<typeof import("@/lib/pieces-lues/service")>();
  return { ...vrai, proposerLecture: async () => ({ ok: false, error: "Lecture coupée dans ce banc." }) };
});

import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis, retirerDocumentsEtContenu } from "@/lib/actions/internes/menage-de-banc";
import { canAccessEntity } from "@/lib/entity-access";
import { peutOuvrirDocument } from "@/lib/entity-access/ouverture-pieces";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { addAdProItem, submitAdProItem } from "../actions-postes";
import { decideAdProItem } from "../actions-postes-decision";
import { addAdProComment } from "../actions-discussion";
import { loadAdProItems } from "./requetes/postes";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE FORMULAIRE D'AJOUT D'UN POSTE ALLÉGÉ, ET LA DISCUSSION DU POSTE (Direction, 23/11/2026) — par les VRAIES actions.
 *
 *   • un poste « par une agence » ajouté AVEC son cahier des charges par la Direction Marketing : soumis ET prospection
 *     demandée (assistante prévenue) en UN appel ; par une autre partie prenante : soumis, le cahier gardé sur le poste ;
 *   • un poste payé directement, ajouté SANS montant : il se soumet, et la Direction Marketing l'accepte avec la pro forma —
 *     montant et « payé à » confirmés, la pièce rangée sur le poste ;
 *   • la discussion d'un poste : un message avec un fichier se lit par la Direction Marketing et le demandeur (et sa pièce
 *     s'ouvre), il est refusé à une personne étrangère à la demande ; les participants sont prévenus.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__ajout1g${Date.now().toString(36)}__`;
const DEBUT = new Date(Date.now() - 1_000);

async function acteur(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}
const fd = (c: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(c)) f.set(k, v); return f; };
const pdf = (nom: string) => new File([Buffer.from(`%PDF-1.4\n% ${nom}\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n`)], nom, { type: "application/pdf" });

suite("Ad & Pro — l'ajout d'un poste en un geste, l'accord sur pièce, la discussion du poste (base réelle)", () => {
  const u = { kam: "", dm: "", ast: "", etranger: "" };
  let congres = "", catId = "", envId = "";

  beforeAll(async () => {
    const mk = async (n: string, role: SessionUser["role"]) =>
      (await prisma.user.create({ data: { name: `${TAG}${n}`, email: `${TAG}${n}@t.dz`, role, passwordHash: "x" } })).id;
    u.kam = await mk("kam", "MEDICAL_DELEGATE");
    u.dm = await mk("dm", "PRODUCT_MANAGER");
    u.ast = await mk("ast", "DIRECTION_ASSISTANT");
    u.etranger = await mk("etranger", "COORDINATOR");
    // PRÉVALIDÉ (N+1, Directeur des opérations, Direction Marketing) : les postes s'ajoutent.
    congres = (await prisma.congressNational.create({ data: { name: `${TAG}Congrès de Sétif`, requesterId: u.kam, requestStatus: "APPROVED" }, select: { id: true } })).id;
    envId = (await prisma.budgetEnvelope.create({
      data: { name: `${TAG}Enveloppe`, modules: ["CONGRESS_NATIONAL"], totalAmount: 50_000_000, periodStart: new Date("2026-01-01"), periodEnd: new Date("2026-12-31") },
      select: { id: true },
    })).id;
    catId = (await prisma.budgetCategoryLine.create({ data: { envelopeId: envId, name: `${TAG}Événementiel`, allocated: 50_000_000 }, select: { id: true } })).id;
  }, 60_000);

  afterAll(async () => {
    const postes = (await prisma.adProItem.findMany({ where: { congressNationalId: congres }, select: { id: true } }).catch(() => [])).map((p) => p.id);
    const ids = Object.values(u).filter(Boolean);
    const pieces = (await prisma.adProItemPiece.findMany({ where: { itemId: { in: postes } }, select: { legalDocumentId: true } }).catch(() => [])).map((p) => p.legalDocumentId);
    await prisma.comment.deleteMany({ where: { entityType: "AD_PRO_ITEM", entityId: { in: postes } } }).catch(() => {});
    await retirerDocumentsEtContenu({ where: { OR: [{ entityType: "AD_PRO_ITEM", entityId: { in: postes } }, { entityType: "LEGAL_DOCUMENT", entityId: { in: pieces } }] } }).catch(() => {});
    await prisma.adProItemPiece.deleteMany({ where: { itemId: { in: postes } } }).catch(() => {});
    await prisma.adProDevis.deleteMany({ where: { legalDocumentId: { in: pieces } } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { id: { in: pieces } } }).catch(() => {});
    await prisma.adProItemDecision.deleteMany({ where: { itemId: { in: postes } } }).catch(() => {});
    await prisma.adProExecutionPoste.deleteMany({ where: { itemId: { in: postes } } }).catch(() => {});
    await prisma.adProItem.deleteMany({ where: { id: { in: postes } } }).catch(() => {});
    await prisma.adProPorteDg.deleteMany({ where: { entityId: congres } }).catch(() => {});
    await prisma.congressNational.deleteMany({ where: { id: congres } }).catch(() => {});
    await prisma.budgetCategoryLine.deleteMany({ where: { envelopeId: envId } }).catch(() => {});
    await prisma.budgetEnvelope.deleteMany({ where: { id: envId } }).catch(() => {});
    // Les rôles prévenus (Direction Marketing, Super Admin) comptent aussi des comptes permanents : on retire par le LIEN.
    await prisma.notification.deleteMany({ where: { OR: [{ userId: { in: ids } }, { link: { contains: congres } }, { link: { in: postes.map((p) => `/agences/${p}`) } }] } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { id: { in: ids } } });
  }, 60_000);

  it("LA DIRECTION MARKETING ajoute un poste « par une agence » avec son cahier des charges : soumis et prospection demandée en UN appel", async () => {
    ACTOR = await acteur(u.dm, "PRODUCT_MANAGER");
    const r = await addAdProItem(undefined, fd({
      parent: "CONGRESS_NATIONAL", parentId: congres, kind: "STAND", label: `${TAG}Stand 9 m²`, voie: "AGENCE",
      cahierDesCharges: "Stand 9 m² avec comptoir, 4 kakémonos, livraison le 11/12.", assistanteId: u.ast,
    }));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.ok ? r.message : "").toMatch(/^Poste ajouté et soumis — prospection demandée à /);
    const poste = await prisma.adProItem.findUniqueOrThrow({ where: { id: r.ok ? r.id! : "" }, include: { execution: true } });
    expect(poste.status).toBe("PENDING");
    expect(poste.budgetKind).toBe("INCLUDED");
    expect(poste.amountEstimated, "aucun montant saisi à l'ajout").toBeNull();
    expect(poste.supplier).toBeNull();
    expect(poste.execution?.prospectionDemandeeAt).not.toBeNull();
    expect(poste.execution?.assistanteId).toBe(u.ast);
    expect(poste.execution?.cahierDesCharges).toMatch(/kakémonos/);
    const prevenue = await prisma.notification.count({ where: { userId: u.ast, type: "ASSIGNMENT", link: `/agences/${poste.id}`, createdAt: { gte: DEBUT } } });
    expect(prevenue, "l'assistante est prévenue de la prospection").toBe(1);
  });

  it("UNE AUTRE PARTIE PRENANTE ajoute un poste « par une agence » : soumis à la Direction Marketing, le cahier des charges l'attend sur le poste", async () => {
    ACTOR = await acteur(u.kam, "MEDICAL_DELEGATE");
    const r = await addAdProItem(undefined, fd({
      parent: "CONGRESS_NATIONAL", parentId: congres, kind: "PRINTING", label: `${TAG}Brochures`, voie: "AGENCE",
      cahierDesCharges: "2 000 brochures A5, quadri.", assistanteId: u.ast,
    }));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.ok ? r.message : "").toMatch(/soumis à la Direction Marketing avec son cahier des charges/);
    const poste = await prisma.adProItem.findUniqueOrThrow({ where: { id: r.ok ? r.id! : "" }, include: { execution: true } });
    expect(poste.status).toBe("PENDING");
    expect(poste.execution?.cahierDesCharges).toBe("2 000 brochures A5, quadri.");
    expect(poste.execution?.prospectionDemandeeAt, "seule la Direction Marketing lance la prospection").toBeNull();
    expect(poste.execution?.assistanteId).toBeNull();
    expect(await prisma.notification.count({ where: { userId: u.dm, type: "VALIDATION_REQUIRED", link: { contains: poste.id }, createdAt: { gte: DEBUT } } })).toBe(1);
  });

  it("UN POSTE PAYÉ DIRECTEMENT, ajouté SANS montant : il se soumet, et la Direction Marketing l'accepte avec la pro forma — montant et « payé à » confirmés", async () => {
    ACTOR = await acteur(u.kam, "MEDICAL_DELEGATE");
    const r = await addAdProItem(undefined, fd({ parent: "CONGRESS_NATIONAL", parentId: congres, kind: "CATERING", label: `${TAG}Déjeuner`, voie: "DIRECT" }));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const id = r.ok ? r.id! : "";
    const s = await submitAdProItem(undefined, fd({ id }));
    expect(s.ok, JSON.stringify(s)).toBe(true);

    ACTOR = await acteur(u.dm, "PRODUCT_MANAGER");
    // Sans montant, l'accord reste refusé : c'est la pièce (ou la Direction Marketing) qui le donne.
    const sans = await decideAdProItem(undefined, fd({ id, decision: "APPROVED", budgetCategoryId: catId }));
    expect(sans.ok ? "" : sans.error).toBe("Indiquez le montant accordé à ce poste.");
    const f = fd({ id, decision: "APPROVED", budgetCategoryId: catId, amountGranted: "184500", supplier: `${TAG}Traiteur El Bahdja` });
    f.append("proforma", pdf("proforma-traiteur.pdf"));
    const d = await decideAdProItem(undefined, f);
    expect(d.ok, JSON.stringify(d)).toBe(true);
    expect(d.ok ? d.message : "").toMatch(/Pro forma jointe au poste/);
    const poste = await prisma.adProItem.findUniqueOrThrow({ where: { id } });
    expect(poste.status).toBe("APPROVED");
    expect(Number(poste.amountGranted)).toBe(184_500);
    expect(poste.supplier).toBe(`${TAG}Traiteur El Bahdja`);
    const piece = await prisma.adProItemPiece.findFirst({ where: { itemId: id, nature: "DEVIS" }, include: { legalDocument: { select: { counterparty: true, kind: true } } } });
    expect(piece?.legalDocument.kind, "la pro forma est rangée dans la case « Justificatif » du poste").toBe("QUOTE");
    expect(piece?.legalDocument.counterparty).toBe(`${TAG}Traiteur El Bahdja`);
  });

  it("LA DISCUSSION D'UN POSTE : un message avec un fichier se lit par la Direction Marketing et le demandeur — refusé à une personne étrangère", async () => {
    const posteId = (await prisma.adProItem.findFirstOrThrow({ where: { congressNationalId: congres, label: `${TAG}Brochures` } })).id;
    ACTOR = await acteur(u.kam, "MEDICAL_DELEGATE");
    const f = fd({ entityType: "AD_PRO_ITEM", entityId: posteId, body: "Voici la maquette souhaitée pour les brochures." });
    f.append("files", pdf("maquette.pdf"));
    const m = await addAdProComment(f);
    expect(m.ok, JSON.stringify(m)).toBe(true);

    // Lu au chargement de la carte, sa pièce avec lui.
    const items = await loadAdProItems("CONGRESS_NATIONAL", congres);
    const fil = items.find((i) => i.id === posteId)?.discussion ?? [];
    expect(fil.map((x) => x.body)).toEqual(["Voici la maquette souhaitée pour les brochures."]);
    expect(fil[0]?.attachments.map((a) => a.name)).toEqual(["maquette.pdf"]);
    const doc = await prisma.document.findUniqueOrThrow({ where: { id: fil[0]!.attachments[0]!.id }, select: { id: true, entityType: true, entityId: true, stepKey: true } });

    // La Direction Marketing et le demandeur l'ouvrent ; la Direction Marketing est prévenue, l'auteur non.
    const dm = await acteur(u.dm, "PRODUCT_MANAGER");
    const kam = await acteur(u.kam, "MEDICAL_DELEGATE");
    expect(await peutOuvrirDocument(dm as unknown as SessionUser, doc)).toBe(true);
    expect(await peutOuvrirDocument(kam as unknown as SessionUser, doc)).toBe(true);
    expect(await prisma.notification.count({ where: { userId: u.dm, title: "Nouveau message sur un poste", link: { contains: posteId }, createdAt: { gte: DEBUT } } })).toBe(1);
    expect(await prisma.notification.count({ where: { userId: u.kam, title: "Nouveau message sur un poste", createdAt: { gte: DEBUT } } })).toBe(0);

    // La Direction Marketing répond — le demandeur est prévenu.
    ACTOR = dm;
    expect((await addAdProComment(fd({ entityType: "AD_PRO_ITEM", entityId: posteId, body: "Validé, format A5." }))).ok).toBe(true);
    expect(await prisma.notification.count({ where: { userId: u.kam, title: "Nouveau message sur un poste", link: { contains: posteId }, createdAt: { gte: DEBUT } } })).toBe(1);

    // Une personne étrangère à la demande : ni écrire, ni ouvrir la pièce.
    const etranger = await acteur(u.etranger, "COORDINATOR");
    expect(await canAccessEntity(etranger as unknown as SessionUser, "CONGRESS_NATIONAL", congres, "VIEW"), "prémisse : la demande lui est fermée").toBe(false);
    ACTOR = etranger;
    const refus = await addAdProComment(fd({ entityType: "AD_PRO_ITEM", entityId: posteId, body: "Je passe par là." }));
    expect(refus.ok ? "" : refus.error).toBe("Ce poste ne vous est pas ouvert.");
    expect(await peutOuvrirDocument(etranger as unknown as SessionUser, doc)).toBe(false);
    expect(await prisma.comment.count({ where: { entityType: "AD_PRO_ITEM", entityId: posteId } })).toBe(2);
  });

  it("L'ASSISTANTE QUI PROSPECTE écrit dans le fil de SON poste et en ouvre les pièces, sans voir la demande", async () => {
    const posteId = (await prisma.adProItem.findFirstOrThrow({ where: { congressNationalId: congres, label: `${TAG}Stand 9 m²` } })).id;
    ACTOR = await acteur(u.dm, "PRODUCT_MANAGER");
    const f = fd({ entityType: "AD_PRO_ITEM", entityId: posteId, body: "Plan du stand joint." });
    f.append("files", pdf("plan-stand.pdf"));
    expect((await addAdProComment(f)).ok).toBe(true);
    const doc = await prisma.document.findFirstOrThrow({ where: { entityType: "AD_PRO_ITEM", entityId: posteId, name: "plan-stand.pdf" }, select: { id: true, entityType: true, entityId: true, stepKey: true } });
    const ast = await acteur(u.ast, "DIRECTION_ASSISTANT");
    expect(await peutOuvrirDocument(ast as unknown as SessionUser, doc)).toBe(true);
    expect(await prisma.notification.count({ where: { userId: u.ast, title: "Nouveau message sur un poste", link: { contains: posteId }, createdAt: { gte: DEBUT } } })).toBe(1);
    ACTOR = ast;
    expect((await addAdProComment(fd({ entityType: "AD_PRO_ITEM", entityId: posteId, body: "Trois agences contactées." }))).ok).toBe(true);
  });
});
