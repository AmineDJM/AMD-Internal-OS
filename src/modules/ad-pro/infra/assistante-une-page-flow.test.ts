import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({ cookies: () => ({ get: () => undefined }), headers: () => new Headers() }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR, requireModule: async () => ACTOR }));
/** La lecture d'une pièce par le modèle est un service externe : ici, elle échoue — le dépôt, lui, ne doit jamais échouer pour autant. */
vi.mock("@/lib/pieces-lues/service", async (importOriginal) => {
  const vrai = await importOriginal<typeof import("@/lib/pieces-lues/service")>();
  return { ...vrai, proposerLecture: async () => ({ ok: false, error: "Lecture coupée dans ce banc." }) };
});

import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis, retirerDocumentsEtContenu, retirerNoeudsDriveEtContenu } from "@/lib/actions/internes/menage-de-banc";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { canAccessEntity } from "@/lib/entity-access";
import { peutOuvrirDocument } from "@/lib/entity-access/ouverture-pieces";
import { peutLireLaPieceLegale } from "@/lib/queries/legal-fichier";
import { emettrePieceCommerciale } from "@/lib/actions/fabrique-actions";
import { renvoyerBonDeCommande } from "@/lib/actions/bc-signature-actions";
import { pieceEmise, valeursComposables } from "@/lib/legal/piece-emise";
import { formulaireDuComposeur } from "@/lib/bons-de-commande/composeur-test-outils";
import { etatDuBC } from "@/lib/bons-de-commande/etat";
import { getActionCenter } from "@/lib/queries/action-center";
import { regrouperFile } from "@/lib/espace/aujourdhui";
import { CHEMIN_BUREAU, LIBELLE_BUREAU, lienPosteAdPro, lienPosteAssistante } from "@/lib/chemins/ad-pro";
import { ajouterDevisPoste, modifierBcDuPoste } from "../actions-postes-paiement";
import { addAdProComment } from "../actions-discussion";
import { fileAgences, posteDeLAssistante, tachesAgence } from "./requetes/file-agences";
import { lignesProspectionAgences } from "@/lib/queries/bureau-familles";
import { lienDuPostePour, requireModuleOuAgences, versLesAgences } from "./porte-assistante";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ASSISTANTE DE DIRECTION, SANS AD & PRO, SUR UNE SEULE PAGE (Direction, 23/11/2026) — « retirer la page Ad & Pro à
 * l'assistante et mettre tout ce qu'elle y faisait dans Prospection d'agences » ; depuis le 24/11/2026, cette page est son
 * BUREAU DU SECRÉTARIAT (un seul tableau), et chaque poste y est une ligne qui ouvre SA page (`/agences/<id>`).
 *
 * Une assistante dont la console a BLOQUÉ les sept modules Ad & Pro (l'état voulu après la mise en production), par les VRAIES
 * actions, base locale :
 *   • ses postes qui l'attendent sont des lignes de son bureau, le lien vers SA page ; Mon espace y mène ;
 *   • elle dépose le devis d'une agence ;
 *   • les Finances renvoient le BC : elle est prévenue sur SA page, et le corrige — à cette étape-là seulement ;
 *   • elle ouvre les pièces de SES postes (devis, BC, fichiers du poste) sans Legal — et pas celles des autres ;
 *   • un message sur le poste la prévient vers SA page ; une ancienne fiche de demande la renvoie à son bureau.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__ast1p${Date.now().toString(36)}__`;
const DEBUT = new Date(Date.now() - 1_000);
const ANNEE = new Date().getUTCFullYear();
const MODULES_AD_PRO = ["SPONSORING", "CONGRESS_NATIONAL", "CONGRESS_INTERNATIONAL", "EVENTS", "PROMO_MATERIAL", "CONSULTING", "AD_PRO_OTHER"] as const;

async function acteur(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, secondaryRole: null, access: await getAccess(id, role), mustChangePassword: false };
}
const fd = (c: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(c)) f.set(k, v); return f; };
const pdf = (nom: string) => new File([Buffer.from(`%PDF-1.4\n% ${nom}\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n`)], nom, { type: "application/pdf" });
const su = (u: CurrentUser) => u as unknown as SessionUser;
/** Où mène une porte de page : la cible d'une redirection Next (`NEXT_REDIRECT;…;<url>;…`), ou `null` sans redirection. */
async function redirigeVers(f: () => Promise<unknown>): Promise<string | null> {
  try { await f(); return null; } catch (e) {
    const digest = String((e as { digest?: string }).digest ?? "");
    if (!digest.startsWith("NEXT_REDIRECT")) throw e;
    return digest.split(";")[2] ?? null;
  }
}

suite("L'assistante de direction sans Ad & Pro : tout sur son bureau (base réelle)", () => {
  const u = { sa: "", dm: "", kam: "", ast: "", ast2: "" };
  let eventId = "", societe = "", p1 = "", p2 = "", bc = "", devis = "", fichierPoste = "";

  beforeAll(async () => {
    const mk = async (n: string, role: SessionUser["role"]) =>
      (await prisma.user.create({ data: { name: `${TAG}${n}`, email: `${TAG}${n}@t.dz`, role, passwordHash: "x" } })).id;
    u.sa = await mk("sa", "SUPER_ADMIN");
    u.dm = await mk("dm", "PRODUCT_MANAGER");
    u.kam = await mk("kam", "MEDICAL_DELEGATE");
    u.ast = await mk("ast", "DIRECTION_ASSISTANT");
    u.ast2 = await mk("ast2", "DIRECTION_ASSISTANT");
    // LA CONSOLE : les sept modules Ad & Pro « Bloqué » pour les deux assistantes.
    await prisma.userAccess.createMany({ data: [u.ast, u.ast2].flatMap((userId) => MODULES_AD_PRO.map((module) => ({ userId, module, canView: false }))) });
    eventId = (await prisma.event.create({ data: { name: `${TAG}Journée`, requesterId: u.kam, requestStatus: "APPROVED" } })).id;
    const ancien = new Date("2000-01-01T00:00:00Z");

    // P1 — PROSPECTION : à elle de déposer les devis des agences.
    p1 = (await prisma.adProItem.create({ data: { label: `${TAG}Kakémonos`, eventId, kind: "PRINTING", status: "PENDING", voie: "AGENCE" } })).id;
    await prisma.adProExecutionPoste.create({ data: { itemId: p1, assistanteId: u.ast, prospectionDemandeeAt: ancien, prospectionDemandeeParId: u.dm, cahierDesCharges: "4 kakémonos 85×200." } });

    // P2 — BC SIGNÉ PAR LA DIRECTION MARKETING, chez les Finances : un vrai BC de la fabrique, rattaché au poste.
    p2 = (await prisma.adProItem.create({ data: { label: `${TAG}Stand`, eventId, kind: "STAND", status: "APPROVED", voie: "AGENCE", orderStage: "DIRECTION_OK", orderDirectionAt: new Date() } })).id;
    await prisma.adProExecutionPoste.create({
      data: { itemId: p2, assistanteId: u.ast, prospectionDemandeeAt: ancien, devisTransmisAt: ancien, agenceRetenueAt: ancien, bcSoumisAt: ancien },
    });
    societe = (await prisma.company.create({ data: { name: `${TAG} Labo`, shortName: `${TAG.slice(0, 8)}L`, color: "#1B7F79" } })).id;
    await prisma.companyLegalIdentity.create({
      data: {
        companyId: societe, legalName: `${TAG} Labo SARL`, legalForm: "SARL", rcNumber: "16/00-3333333B23", nif: "001916033333333", nis: "001916033333390",
        taxArticle: "16033333333", headOffice: "3 rue du Labo, Alger", phone: "021 33 33 33", email: null,
      },
    });
    // Elle est salariée de la société qui émet le BC (la fabrique ne révise une pièce que pour une société ouverte).
    await prisma.employee.create({ data: { fullName: `${TAG} ast`, userId: u.ast, companyId: societe } });
    ACTOR = await acteur(u.sa, "SUPER_ADMIN");
    const champs = { type: "BON_DE_COMMANDE", societe, tiersNom: `${TAG} Agence Alpha`, tiersAdresse: "Zone industrielle, Blida", date: `${ANNEE}-11-20`, modePaiement: "VIREMENT", tvaDefaut: "19", objet: "Stand 9 m²" };
    const f = fd(champs);
    for (const [d, q, p] of [["Stand 9 m²", "1", "300000"], ["Kakémonos", "4", "9000"]]) {
      f.append("ligneDesignation", d); f.append("ligneDetails", ""); f.append("ligneQuantite", q); f.append("lignePrix", p);
      f.append("ligneRemise", ""); f.append("ligneTva", ""); f.append("ligneSection", "0");
    }
    const emis = await emettrePieceCommerciale(undefined, f);
    if (!emis.ok || !emis.legalDocumentId) throw new Error(`émission refusée : ${emis.error}`);
    bc = emis.legalDocumentId;
    await prisma.legalDocument.update({ where: { id: bc }, data: { sourceType: "AD_PRO_ITEM", sourceId: p2, bcCircuitAt: new Date() } });
    await prisma.adProItemPiece.create({ data: { itemId: p2, legalDocumentId: bc, nature: "BON_DE_COMMANDE" } });
    await prisma.signatureBC.create({ data: { legalDocumentId: bc, qualite: "DIRECTION_MARKETING", userId: u.dm, signataireNom: `${TAG}dm`, methode: "EN_LIGNE", jeton: `${TAG}jeton` } });
    // Un fichier joint au poste (le BAT, une photo…) — pas une pièce de message.
    fichierPoste = (await prisma.document.create({
      data: { name: `${TAG}bat.pdf`, entityType: "AD_PRO_ITEM", entityId: p2, stepKey: "BAT_CONFORMITE", fileKey: null, mimeType: "application/pdf", sizeBytes: 10, category: "OTHER", confidentiality: "INTERNAL", uploadedById: u.dm },
    })).id;
  }, 120_000);

  afterAll(async () => {
    const postes = [p1, p2].filter(Boolean);
    const ids = Object.values(u).filter(Boolean);
    const pieces = (await prisma.adProItemPiece.findMany({ where: { itemId: { in: postes } }, select: { legalDocumentId: true } }).catch(() => [])).map((p) => p.legalDocumentId);
    const legaux = [...new Set([...pieces, bc].filter(Boolean))];
    await prisma.comment.deleteMany({ where: { entityType: "AD_PRO_ITEM", entityId: { in: postes } } }).catch(() => {});
    await retirerDocumentsEtContenu({ where: { OR: [{ entityType: "AD_PRO_ITEM", entityId: { in: postes } }, { entityType: "LEGAL_DOCUMENT", entityId: { in: legaux } }] } }).catch(() => {});
    await prisma.signatureBC.deleteMany({ where: { legalDocumentId: { in: legaux } } }).catch(() => {});
    await prisma.adProItemPiece.deleteMany({ where: { itemId: { in: postes } } }).catch(() => {});
    await prisma.adProDevis.deleteMany({ where: { legalDocumentId: { in: legaux } } }).catch(() => {});
    const vIds = (await prisma.validationRequest.findMany({ where: { entityType: "LEGAL_DOCUMENT", entityId: { in: legaux } }, select: { id: true } }).catch(() => [])).map((v) => v.id);
    await prisma.validationStep.deleteMany({ where: { requestId: { in: vIds } } }).catch(() => {});
    await prisma.validationRequest.deleteMany({ where: { id: { in: vIds } } }).catch(() => {});
    await prisma.adProGateVisa.deleteMany({ where: { entityType: "LEGAL_DOCUMENT", entityId: { in: legaux } } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { id: { in: legaux } } }).catch(() => {});
    await prisma.documentSequence.deleteMany({ where: { companyId: societe } }).catch(() => {});
    await prisma.adProItemDecision.deleteMany({ where: { itemId: { in: postes } } }).catch(() => {});
    await prisma.adProExecutionPoste.deleteMany({ where: { itemId: { in: postes } } }).catch(() => {});
    await prisma.adProItem.deleteMany({ where: { id: { in: postes } } }).catch(() => {});
    await prisma.adProPorteDg.deleteMany({ where: { entityId: eventId } }).catch(() => {});
    await prisma.event.deleteMany({ where: { id: eventId } }).catch(() => {});
    await prisma.fileVersion.deleteMany({ where: { node: { ownerId: { in: ids } } } }).catch(() => {});
    await retirerNoeudsDriveEtContenu({ where: { ownerId: { in: ids }, type: "FILE" } }).catch(() => {});
    await retirerNoeudsDriveEtContenu({ where: { ownerId: { in: ids } } }).catch(() => {});
    // Les rôles prévenus (Direction Marketing, Super Admin) comptent aussi des comptes permanents : on retire par le LIEN.
    await prisma.notification.deleteMany({
      where: { OR: [{ userId: { in: ids } }, { link: { contains: eventId } }, { link: { in: postes.map(lienPosteAssistante) } }, { body: { contains: TAG } }, { title: { contains: TAG } }] },
    }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { OR: [{ actorId: { in: ids } }, { entityId: { in: [...postes, ...legaux, eventId] } }] } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { companyId: societe } }).catch(() => {});
    await prisma.companyLegalIdentity.deleteMany({ where: { companyId: societe } }).catch(() => {});
    await prisma.company.deleteMany({ where: { id: societe } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { id: { in: ids } } });
  }, 120_000);

  it("PRÉMISSE : sans les modules Ad & Pro, la demande lui est fermée — ses postes, eux, s'ouvrent sur SA page", async () => {
    const ast = await acteur(u.ast, "DIRECTION_ASSISTANT");
    for (const m of MODULES_AD_PRO) expect(ast.access.modules.has(m), m).toBe(false);
    expect(await canAccessEntity(su(ast), "EVENT", eventId, "VIEW")).toBe(false);
    expect(await posteDeLAssistante(su(ast), p1), "la page /agences/<id> de son poste").not.toBeNull();
    expect(await posteDeLAssistante(su(await acteur(u.ast2, "DIRECTION_ASSISTANT")), p1), "une autre assistante").toBeNull();
  });

  it("« PROSPECTION D'AGENCES » : ses postes, un geste par ligne, chacun vers SA page ; sinon, chez qui en est le poste", async () => {
    const lignes = (await fileAgences(su(await acteur(u.ast, "DIRECTION_ASSISTANT")))) ?? [];
    const l1 = lignes.find((l) => l.itemId === p1);
    expect(l1).toMatchObject({ etape: "DEVIS_A_DEPOSER", aMoi: true, geste: "Déposer les devis des agences", lien: lienPosteAssistante(p1) });
    const l2 = lignes.find((l) => l.itemId === p2);
    expect(l2).toMatchObject({ etape: "BC_CHEZ_FINANCES", aMoi: false, geste: null, lien: lienPosteAssistante(p2) });
    expect(l2?.attente).toBe("BC à signer et cacheter — chez les Finances.");
    // AU BUREAU DU SECRÉTARIAT (24/11/2026) : seul le poste qui l'attend y entre (« Prospection d'agence »), vers SA page ;
    // celui chez les Finances n'y est pas. La Direction Marketing suit les agences sur sa page, pas au bureau.
    const auBureau = await lignesProspectionAgences(su(await acteur(u.ast, "DIRECTION_ASSISTANT")));
    expect(auBureau.find((l) => l.cle === `agence:${p1}`)).toMatchObject({ type: "Prospection d'agence", etat: "EN_COURS", href: lienPosteAssistante(p1) });
    expect(auBureau.some((l) => l.cle === `agence:${p2}`)).toBe(false);
    expect(await lignesProspectionAgences(su(await acteur(u.dm, "PRODUCT_MANAGER")))).toEqual([]);
  });

  it("ELLE DÉPOSE LE DEVIS D'UNE AGENCE sur son poste — sans Ad & Pro", async () => {
    ACTOR = await acteur(u.ast, "DIRECTION_ASSISTANT");
    const f = fd({ id: p1, fournisseur: `${TAG}Agence Beta`, montant: "36000", reference: `${TAG}DV-1` });
    f.append("attachment", pdf("devis-beta.pdf"));
    const r = await ajouterDevisPoste(undefined, f);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    devis = r.ok ? r.id! : "";
    expect(await prisma.adProItemPiece.count({ where: { itemId: p1, legalDocumentId: devis, nature: "DEVIS" } })).toBe(1);
    // Une autre assistante n'y dépose rien.
    ACTOR = await acteur(u.ast2, "DIRECTION_ASSISTANT");
    const g = fd({ id: p1 });
    g.append("attachment", pdf("devis-gamma.pdf"));
    expect(await ajouterDevisPoste(undefined, g)).toMatchObject({ ok: false });
  }, 60_000);

  it("LE BC RENVOYÉ PAR LES FINANCES : elle est prévenue sur SA page, et le corrige — à cette étape seulement", async () => {
    const lire = async () => prisma.legalDocument.findUniqueOrThrow({ where: { id: bc }, select: { custom: true } });
    const formulaire = async (notes: string) => {
      const custom = (await lire()).custom;
      const v = valeursComposables(custom)!;
      return formulaireDuComposeur({ ...v, champs: { ...v.champs, notes } }, { id: p2, legalDocumentId: bc, versionVue: String(pieceEmise(custom)!.version), motif: "RIB corrigé." });
    };
    // Chez les Finances, pas encore renvoyé : elle ne le touche pas.
    ACTOR = await acteur(u.ast, "DIRECTION_ASSISTANT");
    const tot = await modifierBcDuPoste(await formulaire("RIB : 00799999000123456789."));
    expect(tot.ok ? "" : tot.error).toMatch(/quand les Finances vous le renvoient/);

    // Les Finances (ici le Super Admin) le renvoient : l'assistante du poste est prévenue — vers SA page.
    ACTOR = await acteur(u.sa, "SUPER_ADMIN");
    const renvoi = await renvoyerBonDeCommande(fd({ id: bc, note: "Mauvais RIB." }));
    expect(renvoi.ok, JSON.stringify(renvoi)).toBe(true);
    expect((await etatDuBC(bc))?.etape).toBe("A_CORRIGER");
    const n = await prisma.notification.findFirst({ where: { userId: u.ast, title: "Bon de commande renvoyé pour correction", createdAt: { gte: DEBUT } } });
    expect(n?.link).toBe(lienPosteAssistante(p2));
    expect(n?.body).toMatch(/Mauvais RIB/);
    const lignes = (await fileAgences(su(await acteur(u.ast, "DIRECTION_ASSISTANT")))) ?? [];
    expect(lignes.find((l) => l.itemId === p2)).toMatchObject({ etape: "BC_A_CORRIGER", aMoi: true, geste: "Corriger le bon de commande renvoyé" });

    // Une autre assistante : le poste n'est pas le sien.
    ACTOR = await acteur(u.ast2, "DIRECTION_ASSISTANT");
    expect(await modifierBcDuPoste(await formulaire("x"))).toMatchObject({ ok: false, error: "Poste introuvable." });

    // Elle le corrige : une nouvelle version, et le renvoi s'efface — le BC repart à la signature.
    ACTOR = await acteur(u.ast, "DIRECTION_ASSISTANT");
    const avant = pieceEmise((await lire()).custom)!.version;
    const ok = await modifierBcDuPoste(await formulaire("RIB : 00799999000123456789."));
    expect(ok.ok, ok.ok ? "" : ok.error).toBe(true);
    expect(pieceEmise((await lire()).custom)!.version).toBe(avant + 1);
    expect((await etatDuBC(bc))?.etape).toBe("A_SIGNER");
    expect(await prisma.auditLog.count({ where: { actorId: u.ast, summary: { contains: "modifié" } } })).toBeGreaterThanOrEqual(1);
  }, 180_000);

  it("SES PIÈCES s'ouvrent sans Legal — le devis, le BC, le fichier du poste ; ni à une autre assistante, ni la demande", async () => {
    // Legal bloqué lui aussi : la règle étroite du poste suffit.
    await prisma.userAccess.createMany({ data: [u.ast, u.ast2].map((userId) => ({ userId, module: "LEGAL", canView: false })) });
    const ast = su(await acteur(u.ast, "DIRECTION_ASSISTANT"));
    const ast2 = su(await acteur(u.ast2, "DIRECTION_ASSISTANT"));
    expect(ast.access.modules.has("LEGAL")).toBe(false);
    for (const id of [devis, bc]) {
      const doc = await prisma.legalDocument.findUniqueOrThrow({ where: { id }, select: { id: true, kind: true } });
      expect(await peutLireLaPieceLegale(ast, { id: doc.id, kind: String(doc.kind) }), `${doc.kind} de son poste`).toBe(true);
      expect(await peutLireLaPieceLegale(ast2, { id: doc.id, kind: String(doc.kind) }), `${doc.kind} d'un poste qui n'est pas le sien`).toBe(false);
    }
    const fichier = await prisma.document.findUniqueOrThrow({ where: { id: fichierPoste }, select: { id: true, entityType: true, entityId: true, stepKey: true } });
    expect(await peutOuvrirDocument(ast, fichier)).toBe(true);
    expect(await peutOuvrirDocument(ast2, fichier)).toBe(false);
    // La porte reste celle du POSTE : la demande, elle, reste fermée.
    expect(await canAccessEntity(ast, "EVENT", eventId, "VIEW")).toBe(false);
    expect(await canAccessEntity(ast, "LEGAL_DOCUMENT", bc, "UPDATE")).toBe(false);
  }, 60_000);

  it("UN MESSAGE SUR LE POSTE la prévient vers SA page ; la Direction Marketing, vers la fiche", async () => {
    ACTOR = await acteur(u.kam, "MEDICAL_DELEGATE");
    const m = await addAdProComment(fd({ entityType: "AD_PRO_ITEM", entityId: p1, body: "Le logo doit être en haut." }));
    expect(m.ok, JSON.stringify(m)).toBe(true);
    const aElle = await prisma.notification.findFirst({ where: { userId: u.ast, title: "Nouveau message sur un poste", createdAt: { gte: DEBUT } } });
    expect(aElle?.link).toBe(lienPosteAssistante(p1));
    const aLaDm = await prisma.notification.findFirst({ where: { userId: u.dm, title: "Nouveau message sur un poste", createdAt: { gte: DEBUT } } });
    expect(aLaDm?.link).toBe(lienPosteAdPro("EVENT", eventId, p1));
  });

  it("MON ESPACE : ses gestes du parcours agence se rangent sous son bureau, et « tout voir » y mène", async () => {
    // Le BC corrigé repart à la signature ; renvoyé une seconde fois, il revient chez elle : deux gestes l'attendent.
    ACTOR = await acteur(u.sa, "SUPER_ADMIN");
    expect((await renvoyerBonDeCommande(fd({ id: bc, note: "Cachet manquant." }))).ok).toBe(true);
    const ast = su(await acteur(u.ast, "DIRECTION_ASSISTANT"));
    const taches = (await tachesAgence(ast)).filter((t) => t.key === `agence-${p1}` || t.key === `agence-${p2}`);
    expect(taches.map((t) => t.href).sort()).toEqual([lienPosteAssistante(p1), lienPosteAssistante(p2)].sort());
    expect(new Set(taches.map((t) => t.module))).toEqual(new Set([LIBELLE_BUREAU]));
    const lot = regrouperFile((await getActionCenter(ast)).items, new Date()).find((l) => l.nature === "agence");
    expect(lot?.n).toBeGreaterThanOrEqual(2);
    expect(lot?.geste.href).toBe(CHEMIN_BUREAU);
  }, 60_000);

  it("LES ANCIENS LIENS : une page de demande la renvoie à son bureau ; « Se rattache à » mène à SA page", async () => {
    const ast = await acteur(u.ast, "DIRECTION_ASSISTANT");
    const dm = await acteur(u.dm, "PRODUCT_MANAGER");
    for (const m of MODULES_AD_PRO) expect(versLesAgences(su(ast), m), m).toBe(true);
    expect(versLesAgences(su(dm), "EVENTS"), "toute autre personne garde sa porte").toBe(false);
    ACTOR = ast;
    expect(await redirigeVers(() => requireModuleOuAgences("EVENTS"))).toBe(CHEMIN_BUREAU);
    ACTOR = dm;
    expect(await redirigeVers(() => requireModuleOuAgences("EVENTS"))).toBeNull();
    // Le lien d'une demande de pièce vers un poste : SA page pour l'assistante du poste, la fiche pour qui l'ouvre, rien sinon.
    const fiche = lienPosteAdPro("EVENT", eventId, p1);
    expect(await lienDuPostePour(su(ast), p1, fiche)).toBe(lienPosteAssistante(p1));
    expect(await lienDuPostePour(su(await acteur(u.ast2, "DIRECTION_ASSISTANT")), p1, fiche)).toBeNull();
    expect(await lienDuPostePour(su(await acteur(u.sa, "SUPER_ADMIN")), p1, fiche)).toBe(fiche);
  });
});
