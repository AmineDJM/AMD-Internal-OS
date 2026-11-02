import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import type { EffectiveAccess, Module, Action } from "@/lib/rbac";
import { buildProposal, type AssistantActionPayload } from "@/lib/assistant";

/**
 * GOLDEN OPS VAGUE 5a — Events (FUSION intégrale de la fiche — enums à défauts pièges —,
 * suppression CRITIQUE avec inscriptions comptées, participants par nom), circuit SPONSORING
 * (préliminaire avec Direction Marketing obligatoire à l'accord, analyse avec budget obligatoire
 * SAUF appel, décision finale CRITIQUE avec montant, appel motivé), circuit CONGRÈS
 * multi-types (« kind » tranche, sponsoring refusé ici), POSTES (résolution par libellé dans
 * l'opération, imputation par nom de catégorie, chaîne BC demande→visa→émission), CONSULTING
 * (co-contractant obligatoire, tâches par libellé).
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

const PREFIXE = "__ops5__";
const TAG = `${PREFIXE}${Date.now()}`;
const domainArgs = (p: { payload: unknown }) => (p.payload as Extract<AssistantActionPayload, { kind: "domain_op" }>).args;

let saId = "";
let eventId = "";
let regId = "";
let spoId = "";
let congressId = "";
let itemId = "";
let contractId = "";
let taskId = "";

const sa = () => userWith({
  EVENTS: ["VIEW", "CREATE", "UPDATE", "DELETE", "VALIDATE"],
  SPONSORING: ["VIEW", "CREATE", "UPDATE", "VALIDATE"],
  CONGRESS_NATIONAL: ["VIEW", "CREATE", "UPDATE", "VALIDATE"],
  CONGRESS_INTERNATIONAL: ["VIEW", "CREATE", "UPDATE", "VALIDATE"],
  AD_PRO_OTHER: ["VIEW", "CREATE", "VALIDATE"],
  CONSULTING: ["VIEW", "CREATE", "UPDATE", "VALIDATE"],
  FINANCES: ["VIEW", "UPDATE"],
}, "SUPER_ADMIN", saId, `${TAG} Amine`);

suite("ops vague 5a — Events, circuits Ad&Pro, postes, Consulting", () => {
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
    await prisma.consultingTask.deleteMany({ where: { label: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.consultingContract.deleteMany({ where: { reference: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.adProItem.deleteMany({ where: { label: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.congressNational.deleteMany({ where: { name: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.sponsoringRequest.deleteMany({ where: { reference: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.eventRegistration.deleteMany({ where: { lastName: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.event.deleteMany({ where: { name: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: PREFIXE } } }).catch(() => {});
  };
  beforeAll(balayer);
  afterAll(balayer);

  beforeAll(async () => {
    const [s] = await Promise.all([
      prisma.user.create({ data: { name: `${TAG} Amine`, email: `${TAG}s@t.dz`, passwordHash: "x", role: "SUPER_ADMIN" } }),
      prisma.user.create({ data: { name: `${TAG} Nadia CDP`, email: `${TAG}p@t.dz`, passwordHash: "x", role: "PRODUCT_MANAGER" } }),
    ]);
    saId = s.id;

    const event = await prisma.event.create({
      data: {
        name: `${TAG} Journée HTA Alger`, type: "SCIENTIFIC_DAY", scope: "NATIONAL", format: "PRESENTIAL",
        status: "REGISTRATION_OPEN", location: "Hôtel El Aurassi", city: "Alger", specialty: "Cardiologie",
        capacity: 120, estimatedBudget: 900_000,
      },
    });
    eventId = event.id;
    const reg = await prisma.eventRegistration.create({
      data: { eventId: event.id, firstName: "Salim", lastName: `${TAG}Merbah`, status: "REGISTERED" },
    });
    regId = reg.id;

    const spo = await prisma.sponsoringRequest.create({
      data: { reference: `${TAG}-SPO-1`, institution: `${TAG} Association cardio Blida`, type: "Sponsoring", status: "AWAITING_PRELIMINARY", amountRequested: 300_000 },
    });
    spoId = spo.id;
    // DEUX SPONSORINGS PRÉ-VALIDÉS (§118.151) : l'un dont le seul poste est encore à décider (la
    // clôture doit le NOMMER), l'autre dont le seul poste est refusé (clôturable, à 0 DZD — vrai :
    // la tenue a été pré-validée, rien n'a été financé).
    await prisma.sponsoringRequest.create({
      data: {
        reference: `${TAG}-SPO-2`, institution: `${TAG} Société de pneumologie`, type: "Sponsoring", status: "PRE_VALIDATED",
        items: { create: { kind: "ASSOCIATION_SUPPORT", label: `${TAG} Sponsoring direct pneumo`, amountEstimated: 120_000, status: "DRAFT", position: 1 } },
      },
    });
    await prisma.sponsoringRequest.create({
      data: {
        reference: `${TAG}-SPO-3`, institution: `${TAG} Association diabète`, type: "Sponsoring", status: "PRE_VALIDATED",
        items: { create: { kind: "INDIRECT_SUPPORT", label: `${TAG} Prise en charge diabète`, amountEstimated: 80_000, status: "REJECTED", position: 1 } },
      },
    });

    const congress = await prisma.congressNational.create({
      data: { name: `${TAG} Congrès SAHA 2026`, requestStatus: "AWAITING_FINAL", productManagerBudget: 500_000 },
    });
    congressId = congress.id;
    const item = await prisma.adProItem.create({
      data: { congressNationalId: congress.id, kind: "OTHER", label: `${TAG} Location de salle`, amountEstimated: 250_000, status: "DRAFT", position: 1 },
    });
    itemId = item.id;

    const contract = await prisma.consultingContract.create({
      data: {
        reference: `${TAG}-CONS-1`, title: `${TAG} Étude de marché oncologie`, counterparty: `${TAG} Cabinet Meziane`,
        status: "DRAFT", requesterId: s.id,
        tasks: { create: [{ label: `${TAG} Rapport intermédiaire`, position: 0 }] },
      },
      include: { tasks: true },
    });
    contractId = contract.id;
    taskId = contract.tasks[0].id;
  });


  describe("Events — FUSION de la fiche, inscriptions", () => {
    it("update_event : changer le SEUL statut rejoue type, format, lieu et budget — l'ancien état d'organisation n'est plus proposé", async () => {
      const p = await buildProposal("event_operation", {
        op: "update_event", target: "Journée HTA", status: "terminé",
      }, sa());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      const a = domainArgs(p);
      expect(a.id).toBe(eventId);
      expect(a.status).toBe("COMPLETED");
      expect(a.type).toBe("SCIENTIFIC_DAY");
      expect(a.format).toBe("PRESENTIAL");
      expect(a.location).toBe("Hôtel El Aurassi");
      // ÉVÉNEMENTS EXTERNES (Direction, 27/10) : la capacité ne se rejoue plus.
      expect(a.capacity).toBeUndefined();
      expect(a.estimatedBudget).toBe("900000");
      // « Complet » n'est plus un état qu'Adam propose.
      const complet = await buildProposal("event_operation", { op: "update_event", target: "Journée HTA", status: "complet" }, sa());
      expect("error" in complet).toBe(true);
    });

    it("delete_event : CRITIQUE — confirmText = nom, inscriptions emportées comptées", async () => {
      const p = await buildProposal("event_operation", { op: "delete_event", target: "Journée HTA" }, sa());
      expect("error" in p).toBe(false);
      if (!("error" in p)) {
        expect(p.confirmText).toBe(`${TAG} Journée HTA Alger`);
        expect(p.fields.map((f) => f.value).join(" ")).toContain("1");
      }
    });

    it("set_registration_status : le participant se résout par NOM, le statut FR → enum (présent)", async () => {
      const p = await buildProposal("event_operation", {
        op: "set_registration_status", target: "Journée HTA", person: `${TAG}Merbah`, status: "présent",
      }, sa());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      expect(domainArgs(p).id).toBe(regId);
      expect(domainArgs(p).status).toBe("PRESENT");
    });
  });

  describe("Sponsoring — la validation finale et la clôture (§118.151)", () => {
    it("close_sponsoring : une demande encore dans son circuit n'est PAS clôturable — le refus dit pourquoi", async () => {
      const p = await buildProposal("adpro_operation", { op: "close_sponsoring", reference: `${TAG}-SPO-1` }, sa());
      expect("error" in p && p.error).toMatch(/pré-validée/);
    });

    it("close_sponsoring : un poste encore à décider bloque la clôture, et le refus le NOMME", async () => {
      const p = await buildProposal("adpro_operation", { op: "close_sponsoring", reference: `${TAG}-SPO-2` }, sa());
      expect("error" in p && p.error).toMatch(/à décider/);
      expect("error" in p && p.error).toContain(`${TAG} Sponsoring direct pneumo`);
    });

    it("close_sponsoring : tout est décidé ⇒ la carte montre le total qui sera écrit (0 DZD si tout est refusé)", async () => {
      const p = await buildProposal("adpro_operation", { op: "close_sponsoring", reference: `${TAG}-SPO-3` }, sa());
      expect("error" in p, "error" in p ? p.error : "").toBe(false);
      if ("error" in p) return;
      expect(p.fields.map((f) => `${f.label}=${f.value}`).join(" | ")).toMatch(/Montant accordé[^|]*=\s*0\s*DZD/);
      expect(p.warnings.join(" ")).toMatch(/FIGE/);
    });

    it("reopen_sponsoring : le motif est obligatoire, et l'on ne rouvre que ce qui est clôturé", async () => {
      const sansMotif = await buildProposal("adpro_operation", { op: "reopen_sponsoring", reference: `${TAG}-SPO-3` }, sa());
      expect("error" in sansMotif && sansMotif.error).toMatch(/motif/i);
      const pasClos = await buildProposal("adpro_operation", { op: "reopen_sponsoring", reference: `${TAG}-SPO-3`, note: "facture corrigée" }, sa());
      expect("error" in pasClos && pasClos.error).toMatch(/pas clôturée/);
    });

    it("les anciennes décisions HORS circuit n'existent plus — Adam conduit le circuit par le moteur", async () => {
      for (const op of ["decide_sponsoring_preliminary", "analyze_sponsoring", "decide_sponsoring_final"]) {
        const p = await buildProposal("adpro_operation", { op, reference: `${TAG}-SPO-1`, decision: "accorder", amount: "1" }, sa());
        expect("error" in p, `${op} ne doit plus construire de carte`).toBe(true);
      }
    });
  });

  describe("Congrès — décisions multi-types & postes", () => {
    it("les anciennes décisions congrès HORS circuit n'existent plus — Adam passe par les gestes de l'écran", async () => {
      expect(congressId).not.toBe("");
      for (const op of ["decide_congress_preliminary", "analyze_congress", "decide_congress_final", "update_congress_budget"]) {
        const p = await buildProposal("adpro_operation", {
          op, target: "Congrès SAHA", kind: "congrès national", decision: "valider", amount: "450000", person: "x",
        }, sa());
        expect("error" in p, `${op} ne doit plus construire de carte`).toBe(true);
      }
    });

    it("un SPONSORING passé par les ops congrès est refusé net (chacun son circuit)", async () => {
      const p = await buildProposal("adpro_operation", {
        op: "cancel_congress_request", target: `${TAG}-SPO-1`, kind: "sponsoring", motif: "test",
      }, sa());
      // Le refus NOMME le chemin qui existe : le moteur de circuit, puis la clôture (§118.63).
      expect("error" in p && p.error).toMatch(/advance_workflow/);
    });

    it("update_item : le poste se résout par LIBELLÉ dans son opération ; seuls les champs donnés partent", async () => {
      const p = await buildProposal("adpro_operation", {
        op: "update_item", target: "Congrès SAHA", kind: "congrès national", label: "Location", grantedAmount: "240000",
      }, sa());
      expect("error" in p).toBe(false);
      if ("error" in p) return;
      expect(domainArgs(p).id).toBe(itemId);
      expect(domainArgs(p).amountGranted).toBe("240000");
      expect(domainArgs(p).label).toBeNull();
      expect(p.warnings.join(" ")).toMatch(/Direction/);
    });

    it("delete_item : CRITIQUE — confirmText = libellé du poste", async () => {
      const p = await buildProposal("adpro_operation", {
        op: "delete_item", target: "Congrès SAHA", kind: "congrès national", label: "Location",
      }, sa());
      expect("error" in p).toBe(false);
      if (!("error" in p)) expect(p.confirmText).toBe(`${TAG} Location de salle`);
    });

    it("add_congress_beneficiary : nom libre accepté ; « EVENT » refusé (prises en charge = congrès)", async () => {
      const p = await buildProposal("adpro_operation", {
        op: "add_congress_beneficiary", target: "Congrès SAHA", kind: "congrès national", person: "Pr Hamdani Lyes", role: "Intervenant",
      }, sa());
      expect("error" in p).toBe(false);
      if (!("error" in p)) {
        expect(domainArgs(p).kind).toBe("NATIONAL");
        expect(domainArgs(p).name).toBe("Pr Hamdani Lyes");
      }
      const onEvent = await buildProposal("adpro_operation", {
        op: "add_congress_beneficiary", target: "Journée HTA", kind: "événement", person: "X",
      }, sa());
      expect("error" in onEvent && onEvent.error).toMatch(/CONGRÈS/);
    });
  });

  describe("Consulting — contrat à deux parties", () => {
    it("create_contract : le CO-CONTRACTANT est obligatoire ; les tâches en virgules deviennent des lignes", async () => {
      const noParty = await buildProposal("consulting_operation", { op: "create_contract", label: "Étude X" }, sa());
      expect("error" in noParty && noParty.error).toMatch(/deux parties/);
      const p = await buildProposal("consulting_operation", {
        op: "create_contract", label: `${TAG} Accompagnement lancement`, counterparty: "Cabinet Idir", tasks: "Cadrage, Rapport final",
      }, sa());
      expect("error" in p).toBe(false);
      if (!("error" in p)) expect(domainArgs(p).tasks).toBe("Cadrage\nRapport final");
    });

    it("decide_contract : CRITIQUE — valider rend le contrat ACTIF ; toggle_contract_task résout la tâche par libellé", async () => {
      const p = await buildProposal("consulting_operation", {
        op: "decide_contract", reference: `${TAG}-CONS-1`, decision: "valider",
      }, sa());
      expect("error" in p).toBe(false);
      if (!("error" in p)) expect(domainArgs(p).approve).toBe("1");

      const t = await buildProposal("consulting_operation", {
        op: "toggle_contract_task", reference: `${TAG}-CONS-1`, label: "Rapport intermédiaire",
      }, sa());
      expect("error" in t).toBe(false);
      if (!("error" in t)) expect(domainArgs(t).taskId).toBe(taskId);
    });
  });
});
