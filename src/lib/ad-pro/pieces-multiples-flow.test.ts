import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({
  requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR, getCurrentUser: async () => ACTOR, getCurrentUserPourEcrire: async () => ACTOR,
}));

import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAccess, hasGlobalView, type SessionUser } from "@/lib/rbac";
import { addAdProComment } from "@/lib/actions/ad-pro-discussion-actions";
import { deleteComment } from "@/lib/actions/comment-actions";
import { addAdProItem, ajouterVoyageur } from "@/lib/actions/ad-pro-item-actions";
import { createCongressRequest } from "@/lib/actions/congress-request-actions";
import { demanderPiecesPriseEnCharge, deposerPiecePriseEnCharge, retirerFichierPiecePriseEnCharge } from "@/lib/actions/care-actions";
import { getCareDossier } from "@/lib/queries/care";
import { loadAdProItems } from "@/lib/queries/ad-pro-items";
import { piecesDuProfessionnel } from "@/lib/care";
import { clePieceMessage } from "@/lib/fil-pieces";
import { CHAMP_FICHES, prefixeFiche } from "@/lib/ad-pro/fiches-saisie";
import { GET as lireDocument } from "@/app/api/documents/[id]/route";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__pjmulti__";
const RUN = `${TAG}${Date.now().toString(36)}`;

async function acteur(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}
const fdOf = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
const pdf = (nom: string, contenu = nom) => new File([Buffer.from(`%PDF-1.4 ${contenu} ${RUN}`)], nom, { type: "application/pdf" });
const ouvrir = (id: string) => lireDocument(new NextRequest(`http://localhost/api/documents/${id}`), { params: Promise.resolve({ id }) });

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * PLUSIEURS PIÈCES JOINTES (Direction, 10/2026), PAR LES VRAIES ACTIONS :
 *   • un message de fil Ad & Pro avec ses pièces — sous la porte du fil, et parties avec lui ;
 *   • un passeport en plusieurs fichiers — voyageur Ad & Pro et pièce de prise en charge ;
 *   • un poste billetterie créé AVEC ses voyageurs, d'un geste — rien de partiel.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Pièces jointes multiples — fils, passeports, fiches saisies avec le poste", () => {
  let dirId = "", etrangerId = "", pmId = "", spoId = "", intlId = "", docId = "";
  let DIR: CurrentUser, ETRANGER: CurrentUser, PM: CurrentUser;
  const postes: string[] = [];

  beforeAll(async () => {
    const mk = (n: string, role: SessionUser["role"]) =>
      prisma.user.create({ data: { name: `${TAG}${n}`, email: `${RUN}${n}@t.dz`, role, passwordHash: "x" } });
    dirId = (await mk("dir", "DIRECTION")).id;
    etrangerId = (await mk("etranger", "LOGISTICS_MANAGER")).id;
    pmId = (await mk("pm", "PRODUCT_MANAGER")).id;
    DIR = await acteur(dirId, "DIRECTION");
    ETRANGER = await acteur(etrangerId, "LOGISTICS_MANAGER");
    PM = await acteur(pmId, "PRODUCT_MANAGER");
    expect(hasGlobalView(ETRANGER) || hasGlobalView(PM)).toBe(false);
    spoId = (await prisma.sponsoringRequest.create({
      // PRÉVALIDÉE (27/10/2026) : aucun poste ne s'ajoute avant la prévalidation de la Direction Marketing.
      data: { reference: `${RUN}SPO`, institution: `${TAG}Asso`, type: "Congrès", requesterId: dirId, status: "PRE_VALIDATED" }, select: { id: true },
    })).id;
    docId = (await prisma.medicalDoctor.create({ data: { name: `${TAG}Dr Annuaire` } })).id;
    ACTOR = PM;
    const intl = await createCongressRequest(undefined, fdOf({ type: "INTL", name: `${RUN}Intl`, startDate: "2026-11-02", endDate: "2026-11-05", invitedDoctorIds: docId }));
    if (!intl.ok) throw new Error(intl.error);
    intlId = intl.id!;
  }, 60_000);

  afterAll(async () => {
    const items = await prisma.adProItem.findMany({ where: { sponsoringId: spoId }, select: { id: true } }).catch(() => []);
    const ids = [spoId, intlId, ...items.map((i) => i.id)].filter(Boolean);
    await prisma.document.deleteMany({ where: { entityId: { in: ids } } }).catch(() => {});
    await prisma.comment.deleteMany({ where: { entityId: { in: ids } } }).catch(() => {});
    await prisma.adProItem.deleteMany({ where: { sponsoringId: spoId } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { entityId: { in: ids } } }).catch(() => {});
    await prisma.sponsoringRequest.deleteMany({ where: { id: spoId } }).catch(() => {});
    // Le circuit s'ouvre à la création (27/10/2026) : la demande de la Direction Marketing naît prévalidée d'office,
    // son instance et sa déclaration d'information médicale avec elle.
    const decls = (await prisma.medicalInfoDeclaration.findMany({ where: { sourceId: { in: ids } }, select: { id: true } }).catch(() => [])).map((d) => d.id);
    await prisma.medicalInfoDeclaration.deleteMany({ where: { id: { in: decls } } }).catch(() => {});
    await prisma.workflowStepEvent.deleteMany({ where: { instance: { entityId: { in: ids } } } }).catch(() => {});
    await prisma.workflowInstance.deleteMany({ where: { entityId: { in: ids } } }).catch(() => {});
    await prisma.congressInternational.deleteMany({ where: { name: { startsWith: RUN } } }).catch(() => {});
    await prisma.medicalDoctor.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { user: { email: { startsWith: RUN } } } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { user: { email: { startsWith: RUN } } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: RUN } } }).catch(() => {});
    ACTOR = null;
  }, 60_000);

  // ───────────────────────────── Le fil ─────────────────────────────

  it("un message avec DEUX pièces : le message, et chaque pièce rattachée à lui sur l'entité de la demande", async () => {
    ACTOR = DIR;
    const fd = fdOf({ entityType: "SPONSORING", entityId: spoId, body: `${TAG}Voici le programme et le devis.` });
    fd.append("files", pdf("programme.pdf"));
    fd.append("files", pdf("devis.pdf"));
    const r = await addAdProComment(fd);
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const pieces = await prisma.document.findMany({ where: { stepKey: clePieceMessage(r.id!) }, orderBy: { name: "asc" } });
    expect(pieces.map((p) => [p.name, p.entityType, p.entityId])).toEqual([
      ["devis.pdf", "SPONSORING", spoId], ["programme.pdf", "SPONSORING", spoId],
    ]);
  });

  it("une pièce de fil s'ouvre sous la porte du fil : la Direction oui, quelqu'un hors du dossier non", async () => {
    const piece = await prisma.document.findFirstOrThrow({ where: { entityId: spoId, stepKey: { startsWith: "fil-message:" } } });
    ACTOR = DIR;
    expect((await ouvrir(piece.id)).status).toBe(200);
    ACTOR = ETRANGER;
    expect((await ouvrir(piece.id)).status, "pas de fuite à qui ne voit pas le dossier").toBe(403);
  });

  it("un message sans texte mais avec une pièce se publie ; une pièce refusée ne publie RIEN", async () => {
    ACTOR = DIR;
    const seul = fdOf({ entityType: "SPONSORING", entityId: spoId });
    seul.append("files", pdf("photo-stand.pdf"));
    expect((await addAdProComment(seul)).ok).toBe(true);
    const avant = await prisma.comment.count({ where: { entityId: spoId } });
    const refuse = fdOf({ entityType: "SPONSORING", entityId: spoId, body: `${TAG}avec un programme` });
    refuse.append("files", pdf("ok.pdf"));
    refuse.append("files", new File([Buffer.from("MZ")], "outil.exe"));
    const r = await addAdProComment(refuse);
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.error).toMatch(/outil\.exe/);
    expect(await prisma.comment.count({ where: { entityId: spoId } }), "le message n'est pas publié en double au second essai").toBe(avant);
    expect(await prisma.document.count({ where: { entityId: spoId, name: "ok.pdf" } })).toBe(0);
  });

  it("quelqu'un hors du dossier ne poste rien, pas même une pièce", async () => {
    ACTOR = ETRANGER;
    const fd = fdOf({ entityType: "SPONSORING", entityId: spoId, body: "x" });
    fd.append("files", pdf("intrus.pdf"));
    expect((await addAdProComment(fd)).ok).toBe(false);
    expect(await prisma.document.count({ where: { name: "intrus.pdf" } })).toBe(0);
  });

  it("supprimer le message emporte ses pièces", async () => {
    ACTOR = DIR;
    const c = await prisma.comment.findFirstOrThrow({ where: { entityId: spoId, body: { contains: "programme et le devis" } } });
    expect((await deleteComment(fdOf({ id: c.id }))).ok).toBe(true);
    expect(await prisma.document.count({ where: { stepKey: clePieceMessage(c.id) } })).toBe(0);
  });

  // ───────────────────────────── Le passeport en plusieurs fichiers (Ad & Pro) ─────────────────────────────

  it("un voyageur créé avec un passeport en DEUX fichiers : les deux sont son passeport", async () => {
    ACTOR = DIR;
    const add = await addAdProItem(undefined, fdOf({ parent: "SPONSORING", parentId: spoId, label: `${TAG}Billets`, kind: "TICKETING", amountEstimated: "50000" }));
    expect(add.ok, add.ok ? "" : add.error).toBe(true);
    postes.push(add.id!);
    const fd = fdOf({ itemId: add.id!, nom: "Haddad", prenom: "Amel" });
    fd.append("passeport", pdf("recto.pdf"));
    fd.append("passeport", pdf("verso.pdf"));
    const r = await ajouterVoyageur(undefined, fd);
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const rows = await loadAdProItems("SPONSORING", spoId);
    const v = rows.find((x) => x.id === add.id)!.voyageurs.find((x) => x.id === r.id)!;
    expect(v.passeports.map((p) => p.name).sort()).toEqual(["recto.pdf", "verso.pdf"]);
  });

  // ───────────────────────────── Le poste créé AVEC ses fiches ─────────────────────────────

  it("un poste billetterie créé avec DEUX voyageurs d'un geste — le poste, les fiches, leurs passeports", async () => {
    ACTOR = DIR;
    const fd = fdOf({ parent: "SPONSORING", parentId: spoId, label: `${TAG}Billets d'un geste`, kind: "TICKETING", amountEstimated: "120000" });
    const [a, b] = [prefixeFiche(0), prefixeFiche(1)];
    fd.append(CHAMP_FICHES, a); fd.append(CHAMP_FICHES, b);
    fd.set(`${a}nom`, "Haddad"); fd.set(`${a}prenom`, "Amel"); fd.set(`${a}trajet`, "ALLER_RETOUR"); fd.set(`${a}transport`, "AVION");
    fd.set(`${a}villeDepart`, "Alger"); fd.set(`${a}villeArrivee`, "Paris"); fd.set(`${a}dateDepart`, "2026-11-02"); fd.set(`${a}dateRetour`, "2026-11-06");
    fd.append(`${a}passeport`, pdf("amel-recto.pdf")); fd.append(`${a}passeport`, pdf("amel-verso.pdf"));
    fd.set(`${b}nom`, "Benali"); fd.set(`${b}trajet`, "ALLER_SIMPLE"); fd.set(`${b}transport`, "TRAIN");
    fd.append(`${b}documents`, pdf("benali-invitation.pdf"));
    const r = await addAdProItem(undefined, fd);
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    postes.push(r.id!);
    expect(r.message).toMatch(/2 voyageurs, 3 documents joints/);
    const poste = (await loadAdProItems("SPONSORING", spoId)).find((x) => x.id === r.id)!;
    expect(poste.voyageurs.map((v) => [v.nom, v.trajet, v.transport])).toEqual([["Haddad", "ALLER_RETOUR", "AVION"], ["Benali", "ALLER_SIMPLE", "TRAIN"]]);
    expect(poste.voyageurs[0]!.passeports).toHaveLength(2);
    expect(poste.voyageurs[1]!.passeports, "Benali n'a pas de passeport : son geste reste « Joindre le passeport »").toHaveLength(0);
    expect(poste.voyageurs[1]!.autresDocuments.map((d) => d.name)).toEqual(["benali-invitation.pdf"]);
  });

  it("une fiche refusée → AUCUN poste créé, et la fiche fautive est nommée", async () => {
    ACTOR = DIR;
    const label = `${TAG}Billets refusés`;
    const fd = fdOf({ parent: "SPONSORING", parentId: spoId, label, kind: "TICKETING" });
    fd.append(CHAMP_FICHES, prefixeFiche(0)); fd.append(CHAMP_FICHES, prefixeFiche(1));
    fd.set(`${prefixeFiche(0)}nom`, "Haddad");
    fd.append(`${prefixeFiche(0)}passeport`, pdf("passeport-ok.pdf"));
    fd.set(`${prefixeFiche(1)}nom`, "Benali"); fd.set(`${prefixeFiche(1)}dateDepart`, "2026-13-45");
    const r = await addAdProItem(undefined, fd);
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.error).toMatch(/^Fiche 2 \(Benali\) : .*Le poste n'a pas été créé\.$/);
    expect(await prisma.adProItem.count({ where: { sponsoringId: spoId, label } })).toBe(0);
    expect(await prisma.document.count({ where: { name: "passeport-ok.pdf" } }), "aucune pièce orpheline").toBe(0);

    // Une PIÈCE refusée (exécutable) d'une fiche : même règle — rien de partiel.
    const fd2 = fdOf({ parent: "SPONSORING", parentId: spoId, label, kind: "ACCOMMODATION" });
    fd2.append(CHAMP_FICHES, prefixeFiche(0));
    fd2.set(`${prefixeFiche(0)}nom`, "Haddad");
    fd2.append(`${prefixeFiche(0)}pieceIdentite`, new File([Buffer.from("MZ")], "piece.exe"));
    const r2 = await addAdProItem(undefined, fd2);
    expect(r2.ok).toBe(false);
    expect(await prisma.adProItem.count({ where: { sponsoringId: spoId, label } })).toBe(0);
  });

  it("un poste hôtellerie créé avec ses personnes logées d'un geste", async () => {
    ACTOR = DIR;
    const fd = fdOf({ parent: "SPONSORING", parentId: spoId, label: `${TAG}Hôtel`, kind: "ACCOMMODATION", amountEstimated: "80000" });
    fd.append(CHAMP_FICHES, prefixeFiche(4));
    fd.set(`${prefixeFiche(4)}nom`, "Haddad"); fd.set(`${prefixeFiche(4)}hotel`, "Sheraton"); fd.set(`${prefixeFiche(4)}ville`, "Oran");
    fd.set(`${prefixeFiche(4)}dateArrivee`, "2026-11-02"); fd.set(`${prefixeFiche(4)}dateDepart`, "2026-11-05");
    fd.append(`${prefixeFiche(4)}pieceIdentite`, pdf("cni-recto.pdf")); fd.append(`${prefixeFiche(4)}pieceIdentite`, pdf("cni-verso.pdf"));
    const r = await addAdProItem(undefined, fd);
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    postes.push(r.id!);
    const h = await prisma.adProHebergement.findMany({ where: { itemId: r.id! } });
    expect(h.map((x) => [x.nom, x.hotel, x.ville])).toEqual([["Haddad", "Sheraton", "Oran"]]);
    expect(await prisma.document.count({ where: { entityType: "AD_PRO_ITEM", entityId: r.id!, stepKey: h[0]!.id, category: "ID_DOCUMENT" } })).toBe(2);
  });

  // ───────────────────────────── Le passeport en plusieurs fichiers (prise en charge) ─────────────────────────────

  it("prise en charge : plusieurs fichiers en un geste, ajout ultérieur, retrait — « manquant » revient au dernier", async () => {
    ACTOR = PM;
    expect((await demanderPiecesPriseEnCharge(undefined, fdOf({ scope: "INTERNATIONAL", requestId: intlId }))).ok).toBe(true);
    const lire = async () => {
      const d = await getCareDossier("INTERNATIONAL", intlId);
      const b = d.beneficiaries.find((x) => x.status === "PROPOSED")!;
      const p = piecesDuProfessionnel("INTERNATIONAL", b.cells).find((x) => x.label === "Passeport")!;
      return { piece: p, fichiers: b.cells.find((c) => c.id === p.cellId)!.fichiers ?? [] };
    };
    const { piece } = await lire();
    expect(piece.etat).toBe("DEMANDEE");

    const fd = fdOf({ cellId: piece.cellId! });
    fd.append("file", pdf("passeport-p1.pdf")); fd.append("file", pdf("passeport-p2.pdf"));
    const r = await deposerPiecePriseEnCharge(undefined, fd);
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(r.message).toBe("Passeport : 2 fichiers joints.");
    let lu = await lire();
    expect(lu.piece.etat).toBe("RECUE");
    expect(lu.fichiers.map((f) => f.name).sort()).toEqual(["passeport-p1.pdf", "passeport-p2.pdf"]);

    const plus = fdOf({ cellId: piece.cellId! });
    plus.append("file", pdf("visa-colle.pdf"));
    expect((await deposerPiecePriseEnCharge(undefined, plus)).ok).toBe(true);
    lu = await lire();
    expect(lu.fichiers).toHaveLength(3);
    const principal = (await prisma.careCell.findUniqueOrThrow({ where: { id: piece.cellId! } })).documentId;
    expect(lu.fichiers.some((f) => f.id === principal), "le principal reste un des fichiers").toBe(true);

    // Quelqu'un hors du dossier ne retire rien.
    ACTOR = ETRANGER;
    expect((await retirerFichierPiecePriseEnCharge(lu.fichiers[0]!.id)).ok).toBe(false);
    ACTOR = PM;
    for (const [i, f] of lu.fichiers.entries()) {
      const rr = await retirerFichierPiecePriseEnCharge(f.id);
      expect(rr.ok, rr.ok ? "" : rr.error).toBe(true);
      const apres = await lire();
      expect(apres.fichiers).toHaveLength(lu.fichiers.length - i - 1);
      expect(apres.piece.etat, i < lu.fichiers.length - 1 ? "il reste un fichier : reçue" : "plus aucun : de nouveau attendue")
        .toBe(i < lu.fichiers.length - 1 ? "RECUE" : "DEMANDEE");
    }
    const cell = await prisma.careCell.findUniqueOrThrow({ where: { id: piece.cellId! } });
    expect([cell.status, cell.documentId]).toEqual(["REQUESTED", null]);
  });
});
