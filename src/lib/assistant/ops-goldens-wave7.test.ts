import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import type { EffectiveAccess, Module, Action } from "@/lib/rbac";
import { buildProposal, type AssistantActionPayload } from "@/lib/assistant";

/**
 * GOLDEN OPS VAGUE 7 — demandes administratives : décision hiérarchique qui annonce l'ordre de
 * dépense au montant saisi, mission chauffeur avec points « Lieu : consigne », lot de cellules,
 * fenêtre demandeur (propre demande seulement, FUSION), suppression à MOTIF OBLIGATOIRE +
 * restauration d'une demande supprimée, fin d'achat qui exige l'imputation, pièce soumise à
 * validation par NOM (déjà en cours → refus par l'action, annoncé), achat moyens généraux à
 * validateur d'organigramme (jamais choisi) avec quantités « xN ».
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

const PREFIXE = "__ops7__";
const TAG = `${PREFIXE}${Date.now()}`;
const domainArgs = (p: { payload: unknown }) => (p.payload as Extract<AssistantActionPayload, { kind: "domain_op" }>).args;

let saId = "";
let validatorId = "";
let requestId = "";
let approvalId = "";
let deletedReqId = "";
let missionId = "";
let stopId = "";
let docId = "";

const sa = () => userWith({
  ADMIN_REQUESTS: ["VIEW", "CREATE", "UPDATE", "VALIDATE"],
}, "SUPER_ADMIN", saId, `${TAG} Amine`);

suite("ops vague 7 — demandes administratives et achats", () => {
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
    await prisma.driverMissionStop.deleteMany({ where: { mission: { title: { startsWith: PREFIXE } } } }).catch(() => {});
    await prisma.driverMission.deleteMany({ where: { title: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.document.deleteMany({ where: { name: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.adminApproval.deleteMany({ where: { request: { reference: { startsWith: PREFIXE } } } }).catch(() => {});
    await prisma.administrativeRequest.deleteMany({ where: { reference: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: PREFIXE } } }).catch(() => {});
  };
  beforeAll(balayer);
  afterAll(balayer);

  beforeAll(async () => {
    const [s, v] = await Promise.all([
      prisma.user.create({ data: { name: `${TAG} Amine`, email: `${TAG}s@t.dz`, passwordHash: "x", role: "SUPER_ADMIN" } }),
      prisma.user.create({ data: { name: `${TAG} Kamel Directeur`, email: `${TAG}v@t.dz`, passwordHash: "x", role: "DIRECTION" } }),
    ]);
    saId = s.id; validatorId = v.id;

    const req = await prisma.administrativeRequest.create({
      data: {
        reference: `${TAG}-REQ-1`, title: `${TAG} Achat vidéoprojecteur`, type: "PURCHASE",
        status: "IN_PROGRESS", requesterId: s.id, createdById: s.id, priority: "HIGH",
        description: "Salle de réunion", deadline: new Date("2026-09-15T00:00:00Z"),
      },
    });
    requestId = req.id;
    const approval = await prisma.adminApproval.create({
      data: { requestId: req.id, requestedById: s.id, validatorId: v.id, status: "PENDING", amount: 180_000 },
    });
    approvalId = approval.id;
    const doc = await prisma.document.create({
      data: {
        name: `${TAG} Devis vidéoprojecteur.pdf`, category: "OTHER", entityType: "ADMIN_REQUEST",
        entityId: req.id, fileKey: `${TAG}/devis.pdf`, confidentiality: "INTERNAL",
      },
    });
    docId = doc.id;

    const deleted = await prisma.administrativeRequest.create({
      data: {
        reference: `${TAG}-REQ-2`, title: `${TAG} Demande effacée`, type: "OTHER",
        status: "CANCELLED", requesterId: s.id, createdById: s.id,
        deletedAt: new Date(), deletedById: s.id, deletionReason: "Doublon",
      },
    });
    deletedReqId = deleted.id;

    const mission = await prisma.driverMission.create({
      data: {
        title: `${TAG} Course banque + ANPP`, assignedToId: v.id, status: "NEW", createdById: s.id,
        stops: { create: [{ position: 0, location: "Banque BNA Didouche", task: "Déposer les chèques" }, { position: 1, location: "ANPP", task: null }] },
      },
      include: { stops: true },
    });
    missionId = mission.id;
    stopId = mission.stops[0].id;
  });


  it("decide_approval : l'étape en attente se résout, l'APPROBATION annonce l'ordre de dépense au montant saisi", async () => {
    const p = await buildProposal("request_operation", {
      op: "decide_approval", target: `${TAG}-REQ-1`, decision: "approuver",
    }, sa());
    expect("error" in p).toBe(false);
    if (!("error" in p)) {
      expect(domainArgs(p).approvalId).toBe(approvalId);
      expect(domainArgs(p).decision).toBe("APPROVED");
      expect(p.warnings.join(" ")).toMatch(/ordre de dépense/);
    }
  });

  it("decide_approval : un REFUS sans motif est refusé AVANT la carte — l'action l'exigerait après le clic (lot E5)", async () => {
    const sansMotif = await buildProposal("request_operation", {
      op: "decide_approval", target: `${TAG}-REQ-1`, decision: "refuser",
    }, sa());
    expect("error" in sansMotif && sansMotif.error).toMatch(/se motive/);
    // Le témoin : avec son motif, la carte se construit et le motif part à l'action.
    const avecMotif = await buildProposal("request_operation", {
      op: "decide_approval", target: `${TAG}-REQ-1`, decision: "refuser", note: "Hors budget du trimestre.",
    }, sa());
    expect("error" in avecMotif).toBe(false);
    if (!("error" in avecMotif)) {
      expect(domainArgs(avecMotif).decision).toBe("REJECTED");
      expect(domainArgs(avecMotif).comment).toBe("Hors budget du trimestre.");
    }
  });

  // (Golden « create_mission » retiré : les missions chauffeur ne se créent plus — Direction, 10/2026 — et l'op
  // n'existe plus. Les courses déjà posées se mènent encore : toggle_mission_stop, update_mission ci-dessous.)

  it("toggle_mission_stop : le point se désigne par son LIEU et annonce le sens du basculement", async () => {
    const p = await buildProposal("request_operation", {
      op: "toggle_mission_stop", target: "Course banque", location: "BNA",
    }, sa());
    expect("error" in p).toBe(false);
    if (!("error" in p)) {
      expect(domainArgs(p).id).toBe(stopId);
      expect(p.title).toMatch(/Cocher/);
    }
  });

  it("edit_own_request : MA demande seulement — FUSION du titre, de la description et de l'échéance", async () => {
    const other = userWith({}, "MEDICAL_DELEGATE", validatorId, "Kamel");
    const denied = await buildProposal("request_operation", {
      op: "edit_own_request", target: `${TAG}-REQ-1`, newName: "X",
    }, other);
    expect("error" in denied && denied.error).toMatch(/votre demande/);

    const p = await buildProposal("request_operation", {
      op: "edit_own_request", target: `${TAG}-REQ-1`, newName: `${TAG} Achat vidéoprojecteur 4K`,
    }, sa());
    expect("error" in p).toBe(false);
    if (!("error" in p)) {
      const a = domainArgs(p);
      expect(a.title).toBe(`${TAG} Achat vidéoprojecteur 4K`);
      expect(a.description).toBe("Salle de réunion");
      expect(a.deadline).toBe("2026-09-15");
    }
  });

  it("delete_requests : le MOTIF est obligatoire ; avec motif, les références se résolvent et la confirmation compte", async () => {
    const noReason = await buildProposal("request_operation", {
      op: "delete_requests", target: `${TAG}-REQ-1`,
    }, sa());
    expect("error" in noReason && noReason.error).toMatch(/MOTIF/i);

    const p = await buildProposal("request_operation", {
      op: "delete_requests", target: `${TAG}-REQ-1`, note: "Doublon de saisie",
    }, sa());
    expect("error" in p).toBe(false);
    if (!("error" in p)) {
      expect(domainArgs(p).ids).toBe(requestId);
      expect(p.confirmText).toBe("1 demandes");
    }
  });

  it("restore_request : une demande SUPPRIMÉE se retrouve (le vivant ne matche pas)", async () => {
    const p = await buildProposal("request_operation", {
      op: "restore_request", target: `${TAG}-REQ-2`,
    }, sa());
    expect("error" in p).toBe(false);
    if (!("error" in p)) expect(domainArgs(p).id).toBe(deletedReqId);
  });

  it("finish_request : pour un ACHAT, la facture et l'imputation moyens généraux sont annoncées", async () => {
    const p = await buildProposal("request_operation", {
      op: "finish_request", target: `${TAG}-REQ-1`,
    }, sa());
    expect("error" in p).toBe(false);
    if (!("error" in p)) expect(p.warnings.join(" ")).toMatch(/facture finale.*moyens généraux/i);
  });

  it("submit_attachment_validation : la pièce se désigne par NOM, les validateurs par noms (parallèle)", async () => {
    const p = await buildProposal("request_operation", {
      op: "submit_attachment_validation", target: `${TAG}-REQ-1`, label: "Devis vidéo", people: "Kamel Directeur", amount: "175000",
    }, sa());
    expect("error" in p).toBe(false);
    if (!("error" in p)) {
      expect(domainArgs(p).documentId).toBe(docId);
      expect(domainArgs(p).validatorIds).toBe(validatorId);
      expect(p.warnings.join(" ")).toMatch(/PARALLÈLE/);
    }
  });

  it("create_purchase_request : « article xN » se lit, le validateur d'organigramme est annoncé (jamais choisi)", async () => {
    const p = await buildProposal("request_operation", {
      op: "create_purchase_request", cells: "Ramette A4 x3 ; Toner HP",
    }, sa());
    expect("error" in p).toBe(false);
    if (!("error" in p)) {
      const lines = JSON.parse(String(domainArgs(p).lines)) as { label: string; quantity: number }[];
      expect(lines).toEqual([{ label: "Ramette A4", quantity: 3 }, { label: "Toner HP", quantity: 1 }]);
      expect(p.warnings.join(" ")).toMatch(/NE SE CHOISIT PAS/);
    }
  });

  it("withdraw_purchase_request : seul l'AUTEUR retire, tant que non tranché (annoncé)", async () => {
    const other = userWith({}, "MEDICAL_DELEGATE", validatorId, "Kamel");
    const denied = await buildProposal("request_operation", {
      op: "withdraw_purchase_request", target: `${TAG}-REQ-1`,
    }, other);
    expect("error" in denied && denied.error).toMatch(/auteur/);

    const p = await buildProposal("request_operation", { op: "withdraw_purchase_request", target: `${TAG}-REQ-1` }, sa());
    expect("error" in p).toBe(false);
    if (!("error" in p)) expect(p.warnings.join(" ")).toMatch(/tranché/);
  });
});
