import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import type { CurrentUser } from "@/lib/session";
import type { EffectiveAccess, Module, Action } from "@/lib/rbac";
import { buildProposal, type AssistantActionPayload } from "@/lib/assistant";

/**
 * GOLDEN OPS VAGUE 5b — PRISES EN CHARGE (personne de l'annuaire OU profil libre, décision
 * PAR personne avec pièce d'identité d'office, besoins pièce/prestation, « sans objet » ≠
 * suppression, devis multi-cases avec garde anti DOUBLE PAIEMENT, envoi Finances bloquant),
 * MATÉRIEL PROMOTIONNEL (circuit court à devis-en-main, agence retenue, chantiers parallèles,
 * règlement au montant du dossier par défaut). Le STOCK n'est plus offert à Adam (§118.164) :
 * ses gestes attestent des faits physiques et se font à l'écran — un cas le tient.
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

const PREFIXE = "__ops5b__";
const TAG = `${PREFIXE}${Date.now()}`;
const domainArgs = (p: { payload: unknown }) => (p.payload as Extract<AssistantActionPayload, { kind: "domain_op" }>).args;

let saId = "";
let doctorId = "";
let congressId = "";
let benefId = "";
let cellHotelId = "";
let cellTicketId = "";
let quoteId = "";
let promoId = "";

// Le vrai loader d'accès donne TOUT au Super Admin ; le harness construit l'accès à la
// main — on lui donne donc les permissions modules que l'écran exige.
const sa = () => userWith({
  CONGRESS_NATIONAL: ["VIEW", "CREATE", "UPDATE", "VALIDATE"],
  CONGRESS_INTERNATIONAL: ["VIEW", "CREATE", "UPDATE", "VALIDATE"],
  PROMO_MATERIAL: ["VIEW", "CREATE", "UPDATE", "DELETE"],
}, "SUPER_ADMIN", saId, `${TAG} Amine`);

suite("ops vague 5b — prises en charge, matériel promotionnel, stock", () => {
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
    await prisma.promoStockMovement.deleteMany({ where: { item: { name: { startsWith: PREFIXE } } } }).catch(() => {});
    await prisma.promoStockItem.deleteMany({ where: { name: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.promoMaterial.deleteMany({ where: { reference: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.careQuote.deleteMany({ where: { supplier: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.careCell.deleteMany({ where: { beneficiary: { lastName: { startsWith: PREFIXE } } } }).catch(() => {});
    await prisma.careBeneficiary.deleteMany({ where: { lastName: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.congressNational.deleteMany({ where: { name: { startsWith: PREFIXE } } }).catch(() => {});
    await prisma.medicalDoctor.deleteMany({ where: { name: { startsWith: PREFIXE } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: PREFIXE } } }).catch(() => {});
  };
  beforeAll(balayer);
  afterAll(balayer);

  beforeAll(async () => {
    const s = await prisma.user.create({ data: { name: `${TAG} Amine`, email: `${TAG}s@t.dz`, passwordHash: "x", role: "SUPER_ADMIN" } });
    saId = s.id;

    const doctor = await prisma.medicalDoctor.create({ data: { name: `${TAG} Pr Benali` } });
    doctorId = doctor.id;

    const congress = await prisma.congressNational.create({
      data: { name: `${TAG} Congrès SFC 2026`, requestStatus: "APPROVED" },
    });
    congressId = congress.id;

    const benef = await prisma.careBeneficiary.create({
      data: { congressNationalId: congress.id, firstName: "Karim", lastName: `${TAG}Ziani`, status: "PROPOSED", position: 0 },
    });
    benefId = benef.id;
    const [hotel, ticket] = await Promise.all([
      prisma.careCell.create({ data: { beneficiaryId: benef.id, kind: "SERVICE", serviceKind: "HOTEL", label: "Hôtel 3 nuits", status: "REQUESTED", position: 0 } }),
      prisma.careCell.create({ data: { beneficiaryId: benef.id, kind: "SERVICE", serviceKind: "TICKET", label: "Billet d'avion", status: "REQUESTED", position: 1 } }),
    ]);
    cellHotelId = hotel.id;
    cellTicketId = ticket.id;
    await prisma.careCell.create({ data: { beneficiaryId: benef.id, kind: "DOCUMENT", label: "Passeport", status: "REQUESTED", position: 2 } });

    const quote = await prisma.careQuote.create({
      data: { congressNationalId: congress.id, supplier: `${TAG} Agence Atlas`, amountDzd: 180_000, status: "PENDING" },
    });
    quoteId = quote.id;

    const promo = await prisma.promoMaterial.create({
      data: { reference: `${TAG}-MP-1`, title: `${TAG} Présentoir Cardio`, status: "PROSPECTION_REQUESTED", requesterId: s.id },
    });
    promoId = promo.id;

  });


  describe("prises en charge — personnes et décisions PAR personne", () => {
    it("add_care_person : le praticien de l'ANNUAIRE se résout (doctorId) ; un inconnu devient PROFIL LIBRE (lastName)", async () => {
      const fromDirectory = await buildProposal("care_operation", {
        op: "add_care_person", target: "Congrès SFC", person: `${TAG} Pr Benali`,
      }, sa());
      expect("error" in fromDirectory).toBe(false);
      if (!("error" in fromDirectory)) {
        expect(domainArgs(fromDirectory).doctorId).toBe(doctorId);
        expect(domainArgs(fromDirectory).lastName).toBeNull();
        expect(domainArgs(fromDirectory).scope).toBe("NATIONAL");
        expect(domainArgs(fromDirectory).requestId).toBe(congressId);
      }

      const free = await buildProposal("care_operation", {
        op: "add_care_person", target: "Congrès SFC", person: `${TAG} Invitée Libre`, role: "Chef de service", institution: "CHU Mustapha",
      }, sa());
      expect("error" in free).toBe(false);
      if (!("error" in free)) {
        expect(domainArgs(free).doctorId).toBeNull();
        expect(domainArgs(free).lastName).toBe(`${TAG} Invitée Libre`);
        expect(domainArgs(free).jobTitle).toBe("Chef de service");
      }
    });

    it("decide_care_person : ACCORDER par personne — la pièce d'identité d'office est annoncée ; la personne se résout par nom", async () => {
      const p = await buildProposal("care_operation", {
        op: "decide_care_person", target: "Congrès SFC", person: "Ziani", decision: "accorder",
      }, sa());
      expect("error" in p).toBe(false);
      if (!("error" in p)) {
        expect(domainArgs(p).id).toBe(benefId);
        expect(domainArgs(p).decision).toBe("APPROVED");
        expect(p.warnings.join(" ")).toMatch(/pièce d'identité/);
      }
    });

    it("la porte du catalogue refuse un délégué sans droits congrès — même règle que l'écran", async () => {
      const delegate = userWith({}, "MEDICAL_DELEGATE", "d1", "Délégué");
      const p = await buildProposal("care_operation", {
        op: "decide_care_person", target: "Congrès SFC", person: "Ziani", decision: "accorder",
      }, delegate);
      expect("error" in p && p.error).toMatch(/droit/);
    });

    it("remove_care_person : le retrait prévient qu'une prestation ENGAGÉE le fera refuser (écarter plutôt)", async () => {
      const p = await buildProposal("care_operation", {
        op: "remove_care_person", target: "Congrès SFC", person: "Ziani",
      }, sa());
      expect("error" in p).toBe(false);
      if (!("error" in p)) expect(p.warnings.join(" ")).toMatch(/ENGAGÉE/);
    });
  });

  describe("prises en charge — besoins (pièces / prestations) et devis", () => {
    it("add_care_cell : « hôtel » en mode prestation → SERVICE/HOTEL ; une attestation sans mode → DOCUMENT", async () => {
      const service = await buildProposal("care_operation", {
        op: "add_care_cell", target: "Congrès SFC", person: "Ziani", label: "Hôtel congrès", mode: "prestation",
      }, sa());
      expect("error" in service).toBe(false);
      if (!("error" in service)) {
        expect(domainArgs(service).kind).toBe("SERVICE");
        expect(domainArgs(service).serviceKind).toBe("HOTEL");
        expect(domainArgs(service).beneficiaryId).toBe(benefId);
      }

      const doc = await buildProposal("care_operation", {
        op: "add_care_cell", target: "Congrès SFC", person: "Ziani", label: "Attestation de participation",
      }, sa());
      expect("error" in doc).toBe(false);
      if (!("error" in doc)) expect(domainArgs(doc).kind).toBe("DOCUMENT");
    });

    it("set_care_cell_status : « sans objet » → WAIVED, en disant que ce n'est PAS une suppression", async () => {
      const p = await buildProposal("care_operation", {
        op: "set_care_cell_status", target: "Congrès SFC", person: "Ziani", label: "Passeport", status: "sans objet",
      }, sa());
      expect("error" in p).toBe(false);
      if (!("error" in p)) {
        expect(domainArgs(p).status).toBe("WAIVED");
        expect(p.warnings.join(" ")).toMatch(/PAS une suppression/);
      }
    });

    it("create_care_quote : le devis désigne les CASES couvertes (multi, virgules) ; un libellé inconnu est refusé en listant les éléments", async () => {
      const p = await buildProposal("care_operation", {
        op: "create_care_quote", target: "Congrès SFC", supplier: "Air Algérie Voyages", amount: "150000", label: "Hôtel, Billet",
      }, sa());
      expect("error" in p).toBe(false);
      if (!("error" in p)) {
        const ids = String(domainArgs(p).cellIds).split(",");
        expect(ids).toContain(cellHotelId);
        expect(ids).toContain(cellTicketId);
        expect(domainArgs(p).amountDzd).toBe("150000");
      }

      const unknown = await buildProposal("care_operation", {
        op: "create_care_quote", target: "Congrès SFC", supplier: "X", amount: "1000", label: "Limousine",
      }, sa());
      expect("error" in unknown && unknown.error).toMatch(/Hôtel 3 nuits/);
    });

    it("decide_care_quote : ACCEPTER crée l'ordre de dépense et annonce la garde anti DOUBLE PAIEMENT", async () => {
      const p = await buildProposal("care_operation", {
        op: "decide_care_quote", target: "Congrès SFC", supplier: "Atlas", decision: "accepter",
      }, sa());
      expect("error" in p).toBe(false);
      if (!("error" in p)) {
        expect(domainArgs(p).id).toBe(quoteId);
        expect(domainArgs(p).decision).toBe("ACCEPTED");
        expect(p.warnings.join(" ")).toMatch(/double paiement/i);
      }
    });

    it("send_care_to_finance : l'envoi annonce le REFUS bloquant tant qu'il manque une pièce ou une décision", async () => {
      const p = await buildProposal("care_operation", {
        op: "send_care_to_finance", target: "Congrès SFC",
      }, sa());
      expect("error" in p).toBe(false);
      if (!("error" in p)) expect(p.warnings.join(" ")).toMatch(/REFUSE tant que/);
    });
  });

  describe("matériel promotionnel — circuit court et marches", () => {
    it("start_promo_circuit : BASCULE sur le circuit 2 — « devis en main » ne promet plus de sauter la demande (§118.152)", async () => {
      // La carte d'avant envoyait `hasQuote` et annonçait « la demande de devis est sautée ». Le
      // circuit 2 ne lit plus ce champ : un devis déjà reçu se remet à l'assistante et se
      // retranscrit comme les autres. Une carte qui annonce un effet que le clic ne produira pas
      // est une fausse promesse (§118.83) — d'où les DEUX moitiés : le champ ne part plus, et la
      // carte dit ce qui arrivera réellement au devis qu'on a en main.
      const p = await buildProposal("promo_operation", {
        op: "start_promo_circuit", reference: `${TAG}-MP-1`, mode: "devis déjà en main",
      }, sa());
      expect("error" in p).toBe(false);
      if (!("error" in p)) {
        expect(domainArgs(p).id).toBe(promoId);
        expect(domainArgs(p).hasQuote, "la bascule n'envoie plus le raccourci du circuit d'avant").toBeUndefined();
        expect(p.title).toMatch(/nouveau circuit/i);
        expect(p.warnings.join(" ")).toMatch(/devis déjà en main se remet à l'assistante/);
      }
    });

    it("choose_promo_agency : l'agence retenue et son montant partent tels quels (geste du demandeur)", async () => {
      const p = await buildProposal("promo_operation", {
        op: "choose_promo_agency", reference: `${TAG}-MP-1`, supplier: "Imprimerie Étoile", amount: "90000",
      }, sa());
      expect("error" in p).toBe(false);
      if (!("error" in p)) {
        expect(domainArgs(p).chosenAgency).toBe("Imprimerie Étoile");
        expect(domainArgs(p).chosenAmount).toBe("90000");
      }
    });

    it("complete_promo_track : « visa publicitaire » → chantier AD_VISA (les trois avancent en parallèle)", async () => {
      const p = await buildProposal("promo_operation", {
        op: "complete_promo_track", reference: `${TAG}-MP-1`, track: "visa publicitaire",
      }, sa());
      expect("error" in p).toBe(false);
      if (!("error" in p)) {
        expect(domainArgs(p).track).toBe("AD_VISA");
        expect(p.warnings.join(" ")).toMatch(/parallèle/);
      }
    });

    it("settle_promo : sans montant donné, le règlement annonce le montant retenu du dossier par DÉFAUT", async () => {
      const p = await buildProposal("promo_operation", {
        op: "settle_promo", reference: `${TAG}-MP-1`,
      }, sa());
      expect("error" in p).toBe(false);
      if (!("error" in p)) {
        expect(domainArgs(p).amount).toBeNull();
        expect(p.fields.map((f) => f.value).join(" ")).toMatch(/défaut/);
      }
    });

    it("cancel_promo : le MOTIF (« note ») est exigé AVANT la carte, et la carte dit ce que l'action fait (vague « restes »)", async () => {
      // Depuis le lot C4a (§118.189), `cancelPromoMaterial` exige un motif ; la carte ne l'envoyait pas, et
      // chaque annulation confirmée était refusée APRÈS le clic (§118.83). Les deux moitiés : sans motif, pas de
      // carte ; avec, le motif part — et la phrase ne promet plus une annulation que l'action ne fait pas.
      const sans = await buildProposal("promo_operation", { op: "cancel_promo", reference: `${TAG}-MP-1` }, sa());
      expect("error" in sans).toBe(true);
      if ("error" in sans) expect(sans.error).toMatch(/motif/i);
      const p = await buildProposal("promo_operation", { op: "cancel_promo", reference: `${TAG}-MP-1`, note: "Salon reporté" }, sa());
      expect("error" in p).toBe(false);
      if (!("error" in p)) {
        expect(domainArgs(p).id).toBe(promoId);
        expect(domainArgs(p).motif).toBe("Salon reporté");
        expect(p.warnings.join(" ")).toMatch(/paiement est déjà réglé, qui reste ouverte/);
        expect(p.warnings.join(" ")).not.toMatch(/un dossier réglé ne s'annule plus/);
      }
    });
  });

  describe("le stock promotionnel n'est plus offert à Adam (§118.164)", () => {
    it("les anciens gestes de stock ne construisent plus de carte : ils attestent des faits physiques", async () => {
      for (const op of ["create_stock_item", "update_stock_item", "delete_stock_item", "record_stock_movement", "delete_stock_movement"]) {
        const p = await buildProposal("promo_operation", { op, name: `${TAG} Présentoir comptoir`, quantity: "40" }, sa());
        expect("error" in p, op).toBe(true);
      }
    });
  });
});
