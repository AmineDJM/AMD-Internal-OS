import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import type { CurrentUser } from "@/lib/session";
import type { EffectiveAccess, Module, Action } from "@/lib/rbac";
import { buildProposal, type AssistantActionPayload } from "@/lib/assistant";

/**
 * GOLDEN OPS VAGUE 6a — tableau stratégique BD (FUSION du projet et du produit 19 champs,
 * cellule par liste blanche typée, suppressions en cascade comptées), PROJETS de suivi
 * (équipe REJOUÉE en FUSION avec « aucun » qui vide, message du fil désigné par extrait,
 * e-mail journalisé), DIRECTIVES (personne OU rôle, archivage réservé), SUPPORT (clôture
 * ouverte au demandeur), RAPPELS personnels (date obligatoire, report à demain par défaut,
 * cloisonnés par propriétaire).
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

const PREFIXE = "__ops6__";
const TAG = `${PREFIXE}${Date.now()}`;
const domainArgs = (p: { payload: unknown }) => (p.payload as Extract<AssistantActionPayload, { kind: "domain_op" }>).args;

let saId = "";
let colleagueId = "";
let projectId = "";
let rangeId = "";
let productId = "";
let dossierId = "";
let msgId = "";
let directiveId = "";
let supportId = "";
let reminderId = "";

// Le vrai loader d'accès donne TOUT au Super Admin ; le harness construit l'accès à la main.
const sa = () => userWith({
  BUSINESS_DEVELOPMENT: ["VIEW", "CREATE", "UPDATE", "DELETE"],
  DOSSIERS: ["VIEW", "CREATE", "UPDATE"],
  DIRECTIVES: ["VIEW", "CREATE"],
  SUPPORT: ["VIEW", "CREATE"],
}, "SUPER_ADMIN", saId, `${TAG} Amine`);

suite("ops vague 6a — tableau BD, projets, directives, support, rappels", () => {
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
    await prisma.reminder.deleteMany({ where: { title: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.supportRequest.deleteMany({ where: { reference: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.directive.deleteMany({ where: { reference: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.dossierMessage.deleteMany({ where: { dossier: { reference: { startsWith: PREFIXE } } } }).catch(() => {});
    await prisma.dossier.deleteMany({ where: { reference: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.bdProduct.deleteMany({ where: { dci: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.bdRange.deleteMany({ where: { name: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.bdProject.deleteMany({ where: { name: { startsWith: PREFIXE } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: PREFIXE } } }).catch(() => {});
  };
  beforeAll(balayer);
  afterAll(balayer);

  beforeAll(async () => {
    const [s, c] = await Promise.all([
      prisma.user.create({ data: { name: `${TAG} Amine`, email: `${TAG}s@t.dz`, passwordHash: "x", role: "SUPER_ADMIN" } }),
      prisma.user.create({ data: { name: `${TAG} Lynda Chargée BD`, email: `${TAG}c@t.dz`, passwordHash: "x", role: "PRODUCT_MANAGER" } }),
    ]);
    saId = s.id; colleagueId = c.id;

    const project = await prisma.bdProject.create({
      data: {
        name: `${TAG} Oncologie génériques`, status: "IN_PROGRESS",
        description: "Panorama oncologie", comment: "Priorité 2026",
        ranges: { create: { name: `${TAG} Gamme cyto`, comment: "Cible CHU" } },
      },
      include: { ranges: true },
    });
    projectId = project.id;
    rangeId = project.ranges[0].id;
    const product = await prisma.bdProduct.create({
      data: {
        rangeId, dci: `${TAG} Pemetrexed`, brandName: "Pemtra", dosage: "500 mg", form: "Poudre",
        sourcing: "IMPORTED", marketSizeDzd: 120_000_000, unitPrice: 45_000, competitors: "Lilly, Ever",
        investmentY1: 4_000_000, revenueY1: 30_000_000, comment: "Dossier CHU",
      },
    });
    productId = product.id;

    const dossier = await prisma.dossier.create({
      data: {
        reference: `${TAG}-PRJ-1`, title: `${TAG} Refonte packaging`, status: "IN_PROGRESS",
        createdById: s.id, assignedToId: s.id, participantIds: [c.id],
      },
    });
    dossierId = dossier.id;
    const msg = await prisma.dossierMessage.create({
      data: { dossierId: dossier.id, authorId: s.id, body: "Premier jet des maquettes envoyé à l'imprimeur." },
    });
    msgId = msg.id;

    const directive = await prisma.directive.create({
      data: { reference: `${TAG}-DIR-1`, title: `${TAG} Gel des embauches T4`, body: "Aucun recrutement sans visa DG.", fromId: s.id, targetUserId: c.id, status: "OPEN" },
    });
    directiveId = directive.id;

    const support = await prisma.supportRequest.create({
      data: { reference: `${TAG}-SUP-1`, subject: `${TAG} Brochures Pemtra`, body: "Besoin de 200 brochures.", category: "BROCHURE", requesterId: c.id, targetUserId: s.id },
    });
    supportId = support.id;

    const reminder = await prisma.reminder.create({
      data: { userId: s.id, createdById: s.id, title: `${TAG} Relancer l'imprimeur`, remindAt: new Date(Date.now() + 7 * 86_400_000), status: "PENDING" },
    });
    reminderId = reminder.id;
  });


  describe("tableau stratégique BD — FUSION et cascade", () => {
    it("update_bd_project : changer le SEUL stade rejoue description et commentaire (FUSION)", async () => {
      const p = await buildProposal("bd_operation", {
        op: "update_bd_project", target: "Oncologie génériques", status: "recommandation prête",
      }, sa());
      expect("error" in p).toBe(false);
      if (!("error" in p)) {
        const a = domainArgs(p);
        expect(a.id).toBe(projectId);
        expect(a.status).toBe("RECOMMENDATION_READY");
        expect(a.description).toBe("Panorama oncologie");
        expect(a.comment).toBe("Priorité 2026");
        expect(a.name).toBe(`${TAG} Oncologie génériques`);
      }
    });

    it("delete_bd_project : CRITIQUE — confirmation par le nom, gammes et produits comptés", async () => {
      const p = await buildProposal("bd_operation", { op: "delete_bd_project", target: "Oncologie génériques" }, sa());
      expect("error" in p).toBe(false);
      if (!("error" in p)) {
        expect(p.confirmText).toBe(`${TAG} Oncologie génériques`);
        expect(p.fields.map((f) => f.value).join(" ")).toMatch(/1 gamme.*1 produit/);
      }
    });

    it("update_bd_product : changer le SEUL sourcing rejoue les 19 champs de l'étude (FUSION intégrale)", async () => {
      const p = await buildProposal("bd_operation", {
        op: "update_bd_product", product: "Pemetrexed", mode: "fabrication locale",
      }, sa());
      expect("error" in p).toBe(false);
      if (!("error" in p)) {
        const a = domainArgs(p);
        expect(a.id).toBe(productId);
        expect(a.sourcing).toBe("MANUFACTURED");
        expect(a.brandName).toBe("Pemtra");
        expect(a.dosage).toBe("500 mg");
        expect(a.marketSizeDzd).toBe("120000000");
        expect(a.unitPrice).toBe("45000");
        expect(a.competitors).toBe("Lilly, Ever");
        expect(a.investmentY1).toBe("4000000");
        expect(a.revenueY1).toBe("30000000");
        expect(a.comment).toBe("Dossier CHU");
      }
    });

    it("set_bd_cell : la cellule se donne par libellé FR et la valeur typée part seule (liste blanche)", async () => {
      const p = await buildProposal("bd_operation", {
        op: "set_bd_cell", kind: "produit", product: "Pemetrexed", field: "Prix unitaire", value: "42000",
      }, sa());
      expect("error" in p).toBe(false);
      if (!("error" in p)) {
        expect(domainArgs(p).kind).toBe("product");
        expect(domainArgs(p).field).toBe("unitPrice");
        expect(domainArgs(p).value).toBe("42000");
      }

      const unknown = await buildProposal("bd_operation", {
        op: "set_bd_cell", kind: "produit", product: "Pemetrexed", field: "Champ interdit", value: "x",
      }, sa());
      expect("error" in unknown).toBe(true);
    });
  });

  describe("projets de suivi — équipe FUSION, fil par extrait", () => {
    it("assign_dossier : changer le SEUL responsable rejoue les participants existants (FUSION)", async () => {
      const p = await buildProposal("dossier_operation", {
        op: "assign_dossier", target: `${TAG}-PRJ-1`, person: "Lynda Chargée BD",
      }, sa());
      expect("error" in p).toBe(false);
      if (!("error" in p)) {
        expect(domainArgs(p).assignedToId).toBe(colleagueId);
        expect(domainArgs(p).participantIds).toBe(colleagueId);
      }

      const cleared = await buildProposal("dossier_operation", {
        op: "assign_dossier", target: `${TAG}-PRJ-1`, people: "aucun",
      }, sa());
      expect("error" in cleared).toBe(false);
      if (!("error" in cleared)) {
        expect(domainArgs(cleared).assignedToId).toBe(saId);
        expect(domainArgs(cleared).participantIds).toBe("");
      }
    });

    it("edit_dossier_message : le message se désigne par un EXTRAIT, le nouveau texte part à part", async () => {
      const p = await buildProposal("dossier_operation", {
        op: "edit_dossier_message", target: `${TAG}-PRJ-1`, message: "maquettes", note: "Maquettes V2 renvoyées ce matin.",
      }, sa());
      expect("error" in p).toBe(false);
      if (!("error" in p)) {
        expect(domainArgs(p).id).toBe(msgId);
        expect(domainArgs(p).body).toBe("Maquettes V2 renvoyées ce matin.");
      }
    });

    it("link_email_to_dossier : sans projet cible NI intitulé de création, la proposition refuse en le disant", async () => {
      const p = await buildProposal("dossier_operation", {
        op: "link_email_to_dossier", label: "Devis imprimeur",
      }, sa());
      expect("error" in p && p.error).toMatch(/target|name/);

      const ok = await buildProposal("dossier_operation", {
        op: "link_email_to_dossier", target: `${TAG}-PRJ-1`, label: "Devis imprimeur", person: "imprimeur@ex.dz",
      }, sa());
      expect("error" in ok).toBe(false);
      if (!("error" in ok)) expect(domainArgs(ok).dossierId).toBe(dossierId);
    });
  });

  describe("directives et support — destinataire personne OU rôle", () => {
    it("create_directive : sans destinataire la proposition refuse ; un RÔLE en français se résout", async () => {
      const none = await buildProposal("directive_operation", {
        op: "create_directive", label: "Note de frais", message: "Corps",
      }, sa());
      expect("error" in none && none.error).toMatch(/person|role/);

      const p = await buildProposal("directive_operation", {
        op: "create_directive", label: "Passage aux visites planifiées", message: "Toutes les visites passent par le plan hebdomadaire.", role: "Délégué médical",
      }, sa());
      expect("error" in p).toBe(false);
      if (!("error" in p)) {
        expect(domainArgs(p).targetRole).toBe("MEDICAL_DELEGATE");
        expect(domainArgs(p).targetUserId).toBeNull();
      }
    });

    it("set_directive_status : « archivée » prévient que l'archivage est réservé à la Direction", async () => {
      const p = await buildProposal("directive_operation", {
        op: "set_directive_status", target: `${TAG}-DIR-1`, status: "archivée",
      }, sa());
      expect("error" in p).toBe(false);
      if (!("error" in p)) {
        expect(domainArgs(p).status).toBe("ARCHIVED");
        expect(p.warnings.join(" ")).toMatch(/Direction/);
      }
    });

    it("set_support_status : la CLÔTURE annonce qu'elle est ouverte au demandeur ET au répondant", async () => {
      const p = await buildProposal("support_operation", {
        op: "set_support_status", target: `${TAG}-SUP-1`, status: "clôturée",
      }, sa());
      expect("error" in p).toBe(false);
      if (!("error" in p)) {
        expect(domainArgs(p).status).toBe("CLOSED");
        expect(p.warnings.join(" ")).toMatch(/demandeur/);
      }
    });

    it("answer_support_request : la réponse se propose avec la demande résolue par référence", async () => {
      const p = await buildProposal("support_operation", {
        op: "answer_support_request", target: `${TAG}-SUP-1`, message: "Les 200 brochures partent demain.",
      }, sa());
      expect("error" in p).toBe(false);
      if (!("error" in p)) expect(domainArgs(p).id).toBe(supportId);
    });
  });

  describe("rappels personnels — cloisonnés par propriétaire", () => {
    it("create_reminder : la date est OBLIGATOIRE ; snooze_reminder sans date annonce « demain » (défaut +1 j)", async () => {
      const noDate = await buildProposal("task_operation", {
        op: "create_reminder", label: "Rappeler la banque",
      }, sa());
      expect("error" in noDate && noDate.error).toMatch(/date/);

      const snooze = await buildProposal("task_operation", {
        op: "snooze_reminder", label: "Relancer l'imprimeur",
      }, sa());
      expect("error" in snooze).toBe(false);
      if (!("error" in snooze)) {
        expect(domainArgs(snooze).id).toBe(reminderId);
        expect(domainArgs(snooze).remindAt).toBeNull();
        expect(snooze.fields.map((f) => f.value).join(" ")).toMatch(/défaut \+1 jour/);
      }
    });

    it("complete_reminder : le rappel d'un AUTRE n'est pas trouvé (propriété stricte)", async () => {
      const other = userWith({}, "MEDICAL_DELEGATE", colleagueId, "Lynda");
      const p = await buildProposal("task_operation", {
        op: "complete_reminder", label: "Relancer l'imprimeur",
      }, other);
      expect("error" in p && p.error).toMatch(/Aucun rappel/);

      const own = await buildProposal("task_operation", {
        op: "complete_reminder", label: "Relancer l'imprimeur",
      }, sa());
      expect("error" in own).toBe(false);
      if (!("error" in own)) expect(domainArgs(own).id).toBe(reminderId);
    });
  });
});
