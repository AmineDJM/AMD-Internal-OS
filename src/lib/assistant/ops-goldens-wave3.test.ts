import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerDocumentsEtContenu, retirerNoeudsDriveEtContenu } from "@/lib/actions/internes/menage-de-banc";
import type { CurrentUser } from "@/lib/session";
import type { EffectiveAccess, Module, Action } from "@/lib/rbac";
import { buildProposal, type AssistantActionPayload } from "@/lib/assistant";

/**
 * GOLDEN OPS VAGUE 3 — Drive (catégories avec FUSION des quatre listes d'accès, copie bornée
 * aux dossiers, pièces jointes d'entités), Legal (rattachement Drive SANS COPIE, classement
 * multiple, « aucun » = déclasser), Courriers (dates reçu/accusé, pièces RÉFÉRENCÉES du Drive,
 * partenaires en FUSION, résolution de pièce par libellé). Les CRITIQUES exigent confirmText.
 */

function userWith(perms: Partial<Record<Module, Action[]>>, role: CurrentUser["role"], id: string, name: string): CurrentUser {
  const modules = new Map(
    Object.entries(perms).map(([m, actions]) => [
      m as Module,
      { module: m as Module, actions: new Set(actions as Action[]), scope: "ALL" as const },
    ]),
  );
  return {
    id, name, email: `${id}@t.dz`, role,
    access: { modules, rowGrants: new Map() } as unknown as EffectiveAccess,
    mustChangePassword: false,
  };
}

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const PREFIXE = "__ops3__";
const TAG = `${PREFIXE}${Date.now()}`;
const domainArgs = (p: { payload: unknown }) => (p.payload as Extract<AssistantActionPayload, { kind: "domain_op" }>).args;

let saId = "";
let otherId = "";
let spaceId = "";
let folderNodeId = "";
let fileNodeId = "";
let attachmentId = "";
let letterheadId = "";
let legalDoc1Id = "";
let legalDoc2Id = "";
let legalFolderId = "";
let mailEntryId = "";
let mailPartnerId = "";
let pieceId = "";

// Le vrai loader d'accès donne TOUT au Super Admin — les goldens reconstituent cet accès
// (les gates mail/legal sont des userCan purs, même règle que l'écran).
const sa = () => userWith({
  DRIVE: ["VIEW", "CREATE", "UPDATE", "DELETE"],
  MAIL_REGISTER: ["VIEW", "CREATE", "UPDATE", "DELETE"],
  LEGAL: ["VIEW", "CREATE", "UPDATE", "DELETE"],
}, "SUPER_ADMIN", saId, `${TAG} Amine`);
const other = () => userWith({ WORKSPACE: ["VIEW", "CREATE"] }, "MEDICAL_DELEGATE", otherId, `${TAG} Sofiane`);

suite("ops vague 3 — Drive, Legal, Courriers", () => {
  /**
   * LE MÉNAGE SE FAIT SUR LE PRÉFIXE STABLE, PAS SUR L'ÉTIQUETTE DE CE RUN — et AVANT de semer.
   *
   * L'étiquette porte l'horodatage du run (`__xxx__<Date.now()>`). Un ménage qui s'y accroche ne
   * peut, par construction, jamais ramasser les lignes d'un run PRÉCÉDENT : le jour où un `beforeAll`
   * expire sous la charge de la suite complète, ses lignes restent en base POUR TOUJOURS. Et elles
   * ne dorment pas — la résolution d'une cible par son nom trouve alors DEUX « Journée HTA » et
   * refuse, honnêtement, de choisir. Mesuré : sept tests rouges dans un fichier que personne n'avait
   * touché, à cause d'un événement oublié par une exécution morte des heures plus tôt.
   *
   * Balayer sur le préfixe, avant ET après, rend le fichier auto-réparant : un run qui meurt ne
   * pénalise que lui-même.
   */
  const balayer = async () => {
    await prisma.driveComment.deleteMany({ where: { body: { startsWith: PREFIXE } } }).catch(() => {});
    await retirerNoeudsDriveEtContenu({ where: { name: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.driveSpace.deleteMany({ where: { name: { startsWith: PREFIXE } } }).catch(() => {});
    await retirerDocumentsEtContenu({ where: { name: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.officeLetterhead.deleteMany({ where: { name: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { title: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.legalFolder.deleteMany({ where: { name: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.mailEntryPiece.deleteMany({ where: { label: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.mailEntry.deleteMany({ where: { title: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.mailEntryFolder.deleteMany({ where: { name: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.mailPartner.deleteMany({ where: { name: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: PREFIXE } } }).catch(() => {});
  };
  beforeAll(balayer);
  afterAll(balayer);

  beforeAll(async () => {
    const [s, o] = await Promise.all([
      prisma.user.create({ data: { name: `${TAG} Amine`, email: `${TAG}s@t.dz`, passwordHash: "x", role: "SUPER_ADMIN" } }),
      prisma.user.create({ data: { name: `${TAG} Sofiane`, email: `${TAG}o@t.dz`, passwordHash: "x", role: "MEDICAL_DELEGATE" } }),
    ]);
    saId = s.id; otherId = o.id;

    const space = await prisma.driveSpace.create({
      data: {
        name: `${TAG} Marketing Algérie`, icon: "megaphone",
        accessRoles: ["DIRECTION"], accessUserIds: [o.id],
        managerRoles: ["SUPER_ADMIN"], managerUserIds: [s.id],
      },
    });
    spaceId = space.id;

    const folder = await prisma.driveNode.create({ data: { name: `${TAG} Dossier campagne`, type: "FOLDER" } });
    folderNodeId = folder.id;
    const file = await prisma.driveNode.create({ data: { name: `${TAG} Visuel stand`, type: "FILE" } });
    fileNodeId = file.id;

    const doc = await prisma.document.create({
      data: { name: `${TAG} BC imprimeur.pdf`, entityType: "EVENT", entityId: "evt-x" },
    });
    attachmentId = doc.id;

    const lh = await prisma.officeLetterhead.create({
      data: { name: `${TAG} En-tête Adventum`, kind: "pdf", blobId: "blob-x", mime: "application/pdf", size: 1024 },
    });
    letterheadId = lh.id;

    const [lg1, lg2] = await Promise.all([
      prisma.legalDocument.create({ data: { title: `${TAG} Contrat imprimeur 2026`, reference: `${TAG}-LGL-1` } }),
      prisma.legalDocument.create({ data: { title: `${TAG} Avenant imprimeur`, reference: `${TAG}-LGL-2` } }),
    ]);
    legalDoc1Id = lg1.id; legalDoc2Id = lg2.id;
    const lf = await prisma.legalFolder.create({ data: { name: `${TAG} Fournisseurs` } });
    legalFolderId = lf.id;

    const entry = await prisma.mailEntry.create({
      data: { reference: `${TAG}-CRR-1`, title: `${TAG} Mise en demeure DGI`, direction: "INCOMING" },
    });
    mailEntryId = entry.id;
    const piece = await prisma.mailEntryPiece.create({
      data: { entryId: entry.id, label: `${TAG} Lettre originale` },
    });
    pieceId = piece.id;
    const partner = await prisma.mailPartner.create({
      data: { name: `${TAG} Imprimerie El Djazair`, kind: "Fournisseur", contact: "021 55 44 33" },
    });
    mailPartnerId = partner.id;
  });


  describe("Drive — catégories : FUSION intégrale des accès", () => {
    it("update_space : renommer SEUL rejoue les 4 listes d'accès À L'IDENTIQUE (rien ne se perd)", async () => {
      const p = await buildProposal("drive_operation", {
        op: "update_space", name: `${TAG} Marketing Algérie`, newName: `${TAG} Marketing DZ`,
      }, sa());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      const a = domainArgs(p);
      expect(a.id).toBe(spaceId);
      expect(a.name).toBe(`${TAG} Marketing DZ`);
      // FUSION : l'action REMPLACE — les listes existantes sont relues et rejouées.
      expect(a.accessRoles).toBe("DIRECTION");
      expect(a.accessUserIds).toBe(otherId);
      expect(a.managerRoles).toBe("SUPER_ADMIN");
      expect(a.managerUserIds).toBe(saId);
      expect(a.icon).toBe("megaphone");
    });

    it("update_space : « retire la lecture à Sofiane » — retrait CIBLÉ, le reste intact", async () => {
      const p = await buildProposal("drive_operation", {
        op: "update_space", name: `${TAG} Marketing Algérie`, person: `${TAG} Sofiane`, mode: "retire",
      }, sa());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      const a = domainArgs(p);
      expect(a.accessUserIds).toBe("");
      expect(a.managerUserIds).toBe(saId);
      expect(a.name).toBe(`${TAG} Marketing Algérie`);
    });

    it("delete_space : CRITIQUE — confirmText = nom exact de la catégorie", async () => {
      const p = await buildProposal("drive_operation", { op: "delete_space", name: `${TAG} Marketing Algérie` }, sa());
      expect("error" in p).toBe(false);
      if (!("error" in p)) expect(p.confirmText).toBe(`${TAG} Marketing Algérie`);
    });

    it("copy : la destination doit être un DOSSIER — un fichier comme cible est refusé net", async () => {
      const bad = await buildProposal("drive_operation", {
        op: "copy", name: `${TAG} Visuel stand`, folder: `${TAG} Visuel stand`,
      }, sa());
      expect("error" in bad && bad.error).toMatch(/pas un dossier/);
      const p = await buildProposal("drive_operation", {
        op: "copy", name: `${TAG} Visuel stand`, folder: `${TAG} Dossier campagne`,
      }, sa());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      expect(domainArgs(p).id).toBe(fileNodeId);
      expect(domainArgs(p).targetId).toBe(folderNodeId);
      expect(p.warnings.join(" ")).toMatch(/COPIE/);
    });
  });

  describe("Drive — pièces jointes d'entités & papiers en-tête", () => {
    it("rename_attachment : la pièce (Document universel) se résout par NOM DE FICHIER, entité affichée", async () => {
      const p = await buildProposal("drive_operation", {
        op: "rename_attachment", name: `${TAG} BC imprimeur`, newName: "BC imprimeur signé.pdf",
      }, sa());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      expect(domainArgs(p).id).toBe(attachmentId);
      expect(domainArgs(p).newName).toBe("BC imprimeur signé.pdf");
    });

    it("delete_attachment : CRITIQUE — confirmText = nom du fichier ; suppression annoncée DÉFINITIVE", async () => {
      const p = await buildProposal("drive_operation", { op: "delete_attachment", name: `${TAG} BC imprimeur` }, sa());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      expect(p.confirmText).toBe(`${TAG} BC imprimeur.pdf`);
      expect(p.warnings.join(" ")).toMatch(/DÉFINITIVE/);
    });

    it("delete_letterhead : CRITIQUE — confirmText ; les documents déjà créés ne bougent pas", async () => {
      const p = await buildProposal("drive_operation", { op: "delete_letterhead", name: `${TAG} En-tête Adventum` }, sa());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      expect(p.confirmText).toBe(`${TAG} En-tête Adventum`);
      expect(domainArgs(p).id).toBe(letterheadId);
    });
  });

  describe("Legal — rattachement SANS COPIE, classement", () => {
    it("attach_drive : un DOSSIER est refusé ; un fichier passe, « SANS COPIE » annoncé", async () => {
      const bad = await buildProposal("legal_operation", { op: "attach_drive", name: `${TAG} Dossier campagne` }, sa());
      expect("error" in bad && bad.error).toMatch(/DOSSIER/);
      const p = await buildProposal("legal_operation", {
        op: "attach_drive", name: `${TAG} Visuel stand`, label: "Contrat stand 2026", kind: "CONTRACT",
      }, sa());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      expect(domainArgs(p).nodeId).toBe(fileNodeId);
      expect(domainArgs(p).title).toBe("Contrat stand 2026");
      expect(p.warnings.join(" ")).toMatch(/SANS COPIE/);
    });

    it("delete_document : CRITIQUE — confirmText = titre ; le fichier Drive référencé reste intact", async () => {
      const p = await buildProposal("legal_operation", { op: "delete_document", reference: `${TAG}-LGL-1` }, sa());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      expect(p.confirmText).toBe(`${TAG} Contrat imprimeur 2026`);
      expect(p.warnings.join(" ")).toMatch(/reste intact/);
    });

    it("move_documents : PLUSIEURS documents (virgules) vers un dossier ; « aucun » = déclasser", async () => {
      const p = await buildProposal("legal_operation", {
        op: "move_documents", reference: `${TAG}-LGL-1, ${TAG}-LGL-2`, folder: `${TAG} Fournisseurs`,
      }, sa());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      expect(domainArgs(p).documentIds).toBe(`${legalDoc1Id},${legalDoc2Id}`);
      expect(domainArgs(p).folderId).toBe(legalFolderId);

      const out = await buildProposal("legal_operation", {
        op: "move_documents", reference: `${TAG}-LGL-2`, folder: "aucun",
      }, sa());
      expect("error" in out).toBe(false);
      if (!("error" in out)) expect(domainArgs(out).folderId).toBeNull();
    });
  });

  describe("Courriers — dates, pièces référencées, partenaires", () => {
    it("set_date : « kind » tranche reçu/accusé ; sans date ni « aucune », refus", async () => {
      const noField = await buildProposal("mail_operation", { op: "set_date", reference: `${TAG}-CRR-1`, date: "2026-08-20" }, sa());
      expect("error" in noField && noField.error).toMatch(/reçu le|accusé/);
      const p = await buildProposal("mail_operation", {
        op: "set_date", reference: `${TAG}-CRR-1`, kind: "accusé de réception", date: "2026-08-20",
      }, sa());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      expect(domainArgs(p).field).toBe("acknowledgedAt");
      expect(domainArgs(p).value).toBe("2026-08-20");

      const clear = await buildProposal("mail_operation", {
        op: "set_date", reference: `${TAG}-CRR-1`, kind: "reçu le", date: "aucune",
      }, sa());
      expect("error" in clear).toBe(false);
      if (!("error" in clear)) {
        expect(domainArgs(clear).field).toBe("receivedAt");
        expect(domainArgs(clear).value).toBeNull();
      }
    });

    it("delete_entry : CRITIQUE — confirmText = n° de chrono ; la gate écarte un délégué sans droits Courriers", async () => {
      const p = await buildProposal("mail_operation", { op: "delete_entry", reference: `${TAG}-CRR-1` }, sa());
      expect("error" in p).toBe(false);
      if (!("error" in p)) expect(p.confirmText).toBe(`${TAG}-CRR-1`);

      const refused = await buildProposal("mail_operation", { op: "delete_entry", reference: `${TAG}-CRR-1` }, other());
      expect("error" in refused).toBe(true);
    });

    it("add_piece : RÉFÉRENCE Drive sans copie — un dossier est refusé, le fichier passe par driveNodeId", async () => {
      const bad = await buildProposal("mail_operation", {
        op: "add_piece", reference: `${TAG}-CRR-1`, name: `${TAG} Dossier campagne`,
      }, sa());
      expect("error" in bad && bad.error).toMatch(/FICHIER/);
      const p = await buildProposal("mail_operation", {
        op: "add_piece", reference: `${TAG}-CRR-1`, name: `${TAG} Visuel stand`, recipient: "DGI Bab Ezzouar",
      }, sa());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      expect(domainArgs(p).entryId).toBe(mailEntryId);
      expect(domainArgs(p).driveNodeId).toBe(fileNodeId);
      expect(p.warnings.join(" ")).toMatch(/SANS COPIE/);
    });

    it("update_piece : une SEULE pièce au courrier → résolue sans la nommer ; renommage ciblé", async () => {
      const p = await buildProposal("mail_operation", {
        op: "update_piece", reference: `${TAG}-CRR-1`, newName: "Lettre originale + AR",
      }, sa());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      expect(domainArgs(p).id).toBe(pieceId);
      expect(domainArgs(p).label).toBe("Lettre originale + AR");
    });

    it("update_partner : FUSION — nature et contact existants REJOUÉS quand on ne change que le nom", async () => {
      const p = await buildProposal("mail_operation", {
        op: "update_partner", name: `${TAG} Imprimerie El Djazair`, newName: `${TAG} Imprimerie El Djazaïr SARL`,
      }, sa());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      const a = domainArgs(p);
      expect(a.id).toBe(mailPartnerId);
      expect(a.kind).toBe("Fournisseur");
      expect(a.contact).toBe("021 55 44 33");
      expect(a.isActive).toBe("1");
    });
  });
});
