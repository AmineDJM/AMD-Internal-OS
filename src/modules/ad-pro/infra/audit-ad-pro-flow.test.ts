import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));
/** Le seuil des BC est un réglage GLOBAL : le banc le pose HAUT — ses BC passent sous le seuil, droit à la signature des Finances. */
vi.mock("@/lib/settings", async (importOriginal) => {
  const vrai = await importOriginal<typeof import("@/lib/settings")>();
  return { ...vrai, getAppSettings: async () => ({ ...(await vrai.getAppSettings()), bcValidationThreshold: 10_000_000 }) };
});
/** AUCUN fournisseur d'IA n'est appelé : Luna est « non configurée » (la signature d'un BC s'enregistre alors « non vérifiée »). */
vi.mock("@/lib/openai-luna", async (importOriginal) => {
  const vrai = await importOriginal<typeof import("@/lib/openai-luna")>();
  return { ...vrai, lunaConfigured: () => false, callLuna: async () => ({ ok: false, error: "Luna coupée dans ce banc." }) };
});

/**
 * LA LECTURE D'UNE PIÈCE PAR LE MODÈLE est le seul service remplacé : pour chaque fichier, le banc fournit le TEXTE du
 * papier et la SORTIE DU MODÈLE (piégeuse au besoin), et la proposition se compose avec les VRAIES règles — repérage,
 * relecture stricte, contrôle, fournisseur. Tout ce qui suit (`ingererDevisDuPoste`, l'écriture des lignes, la
 * validation d'office, la lecture de la facture) est le code de production.
 */
type Scenario = { texte: string; modele: unknown; emetteur?: string };
const SCENARIOS = new Map<string, Scenario>();
vi.mock("@/lib/pieces-lues/service", async (importOriginal) => {
  const vrai = await importOriginal<typeof import("@/lib/pieces-lues/service")>();
  return {
    ...vrai,
    proposerLecture: async (args: { nomFichier: string }) => {
      const s = SCENARIOS.get(args.nomFichier);
      if (!s) return { ok: false, error: "Pièce inconnue de ce banc." };
      const { repererEntetes } = await import("@/lib/pieces-lues/entetes");
      const { lireStructureModele } = await import("@/lib/pieces-lues/structure");
      const { controlerPiece } = await import("@/lib/pieces-lues/controle");
      const { candidatsFournisseur, identiteLue } = await import("@/lib/pieces-lues/fournisseur");
      const { IDENTITE_VIDE } = await import("@/lib/pieces-lues/emetteur");
      const entetes = repererEntetes(s.texte);
      const piece = lireStructureModele(s.modele);
      return {
        ok: true,
        proposition: {
          lectureId: `banc-${args.nomFichier}`, empreinte: "banc", nomFichier: args.nomFichier, cible: "LEGAL_DOCUMENT",
          faits: { methode: "texte", confiance: null }, noteMethode: "texte natif du PDF (banc)", lignesParModele: piece !== null,
          raisonSansLignes: null, sansLignes: null, coupe: null, entetes, piece,
          controle: piece ? controlerPiece(piece, entetes) : null,
          fournisseur: candidatsFournisseur(identiteLue(piece, entetes), []),
          appariement: null, suspectes: [],
          emetteur: { ...IDENTITE_VIDE, nom: s.emetteur ?? null, adresse: s.emetteur ? "Boulevard Krim Belkacem, Alger" : null },
        },
      };
    },
  };
});

import { prisma } from "@/lib/prisma";
import { getAccess, hasGlobalView, type SessionUser } from "@/lib/rbac";
import { addAdProItem, submitAdProItem } from "../actions-postes";
import { decideAdProItem, annulerOrdrePoste } from "../actions-postes-decision";
import { ajouterDevisPoste, deposerFacturePoste, demanderPaiementPoste } from "../actions-postes-paiement";
import { enregistrerLignesDuDevis, validerLignesDuDevis, genererBonDeCommandePoste, validerEtEnvoyerBcPoste } from "../actions-postes-lignes";
import { signerBonDeCommande } from "@/lib/actions/bc-signature-actions";
import { avecCopieSignee } from "@/lib/bons-de-commande/signature-test-outils";
import { etatDuBC } from "@/lib/bons-de-commande/etat";
import { devisDesPostes } from "./requetes/devis-poste";
import { loadAdProItems } from "./requetes/postes";
import { faitsDuPoste, prochainPas, type RegardPoste } from "../domaine/poste-etapes";
import { annulerOrdreNonRegle } from "@/lib/payments/annulation";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

// Un suffixe PAR RUN (§118.136) : un banc à étiquette fixe ne survit pas à un run interrompu.
const TAG = "__auditadpro__";
const RUN = `${TAG}${Date.now().toString(36)}`;
const HOTEL = `${TAG}Hôtel El Djazair`;

async function acteur(id: string, role: SessionUser["role"], secondaryRole: SessionUser["role"] | null = null): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false, ...(secondaryRole ? { secondaryRole } : {}) } as CurrentUser;
}
const fd = (champs: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(champs)) f.set(k, v);
  return f;
};
const pdf = (nom: string) => new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34])], nom, { type: "application/pdf" });
const REGARD_DEMANDEUR: RegardPoste = { canEdit: true, canAllocate: false, canViserBC: false, canEmettre: false, fige: false, operationDecidee: true };

const lm = (designation: string, quantite: string, prixUnitaire: string, tva = "") =>
  ({ designation, reference: "", unite: "", quantite, prixUnitaire, remise: "", tva, montantHt: "" });
const modele = (o: { lignes: ReturnType<typeof lm>[]; tvaDefaut?: string; ht?: string; ttc?: string }) => ({
  type: "DEVIS", numero: "", date: "", devise: "DA", modePaiement: "",
  fournisseur: { nom: "", nif: "", rc: "", nis: "", ai: "", adresse: "" },
  tvaDefaut: o.tvaDefaut ?? "", remiseGlobale: "", taxes: [], lignes: o.lignes,
  totaux: { ht: o.ht ?? "", tva: "", taxes: "", timbre: "", ttc: o.ttc ?? "" },
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * AUDIT AD & PRO (14/10/2026) — UN POSTE DE BOUT EN BOUT, par les VRAIS points d'entrée.
 *
 * Plusieurs devis déposés d'un geste et TOUS transformés en lignes ; une TVA inventée par le modèle qui n'entre ni dans
 * le devis ni dans le BC ; une ligne doublée qui ne se valide pas d'office ; un BC généré sans TVA quand le papier n'en
 * porte pas ; une facture à plusieurs pièces ; un ordre de dépense au nom du FOURNISSEUR ; un paiement refusé par le
 * centre, puis annulé ailleurs, qui se DIT et se LIBÈRE ; « on n'accepte pas les postes de sa propre demande ».
 *
 * Aucun acteur n'a la vue globale (§118.104) ; chaque cas nomme son acteur (§118.151f) ; les juges comptent par le lien
 * causal (les pièces de CE poste), jamais un compte global.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Audit Ad & Pro — devis multiples lus en natif, TVA jamais inventée, factures multi-pièces, paiement qui dit la vérité", () => {
  const ROLES = { kam: "MEDICAL_DELEGATE", ops: "OPERATIONS_DIRECTOR", dm: "PRODUCT_MANAGER", fin: "FINANCE_BUDGET_MANAGER", dual: "DIRECTION" } as const;
  const u: Record<keyof typeof ROLES, string> = { kam: "", ops: "", dm: "", fin: "", dual: "" };
  let companyId = "", congres = "", congresDual = "", catId = "";
  const comme = async (qui: keyof typeof ROLES) => {
    ACTOR = await acteur(u[qui], ROLES[qui], qui === "dual" ? "PRODUCT_MANAGER" : null);
    return ACTOR;
  };
  const ok = (r: { ok: boolean; error?: string }) => expect(r.ok, r.error ?? "").toBe(true);
  const refus = (r: { ok: boolean; error?: string }) => { expect(r.ok, "le geste devait être refusé").toBe(false); return r.error ?? ""; };

  beforeAll(async () => {
    const cles = Object.keys(ROLES) as (keyof typeof ROLES)[];
    const comptes = await Promise.all(cles.map((k) => prisma.user.create({
      data: { name: `${TAG}${k}`, email: `${RUN}${k}@t.dz`, role: ROLES[k], ...(k === "dual" ? { secondaryRole: "PRODUCT_MANAGER" } : {}), passwordHash: "x" },
    })));
    cles.forEach((k, i) => { u[k] = comptes[i].id; });
    const c = await prisma.company.create({ data: { name: `${RUN} Pharma`, shortName: RUN.slice(-12), color: "#1B7F79" } });
    companyId = c.id;
    await prisma.employee.create({ data: { fullName: `${TAG} kam`, userId: u.kam, companyId } });
    await prisma.employee.create({ data: { fullName: `${TAG} dual`, userId: u.dual, companyId } });
    await prisma.companyLegalIdentity.create({
      data: {
        companyId, legalName: `${TAG} Pharma SARL`, legalForm: "SARL", shareCapital: "10 000 000 DZD", rcNumber: "16/00-1234567B21", nif: "001916012345678",
        nis: "001916012345690", taxArticle: "16012345678", headOffice: "12 rue des Frères Bouadou, Alger", phone: "+213 21 00 00 00", email: "contact@t.dz",
        bankName: "BNA", bankAgency: "Hydra", rib: "001 00123 0123456789 45", managerName: "Direction", managerTitle: "Gérant",
      },
    });
    const [c1, c2, env] = await Promise.all([
      prisma.congressNational.create({ data: { name: `${RUN} Congrès d'Oran`, requesterId: u.kam, requestStatus: "APPROVED" }, select: { id: true } }),
      prisma.congressNational.create({ data: { name: `${RUN} Congrès de Béjaïa`, requesterId: u.dual, requestStatus: "APPROVED" }, select: { id: true } }),
      prisma.budgetEnvelope.create({
        data: { name: `${RUN}Enveloppe`, modules: ["CONGRESS_NATIONAL"], totalAmount: 50_000_000, periodStart: new Date("2026-01-01"), periodEnd: new Date("2026-12-31") },
        select: { id: true },
      }),
    ]);
    congres = c1.id; congresDual = c2.id;
    catId = (await prisma.budgetCategoryLine.create({ data: { envelopeId: env.id, name: `${TAG}Hébergement`, allocated: 50_000_000 }, select: { id: true } })).id;

    // ── LES PIÈCES DU BANC : le papier, et ce que le modèle en rend ──────────────────────────────
    SCENARIOS.set(`${RUN}-a.pdf`, {
      emetteur: HOTEL,
      texte: "HÔTEL EL DJAZAIR\nDEVIS N° HD-2026-311\nNuitée chambre double | 10 | 12 000,00\nTotal HT 120 000,00\nTVA 19 % 22 800,00\nTotal TTC 142 800,00",
      modele: modele({ tvaDefaut: "19", lignes: [lm("Nuitée chambre double", "10", "12 000,00", "19")], ht: "120 000,00", ttc: "142 800,00" }),
    });
    // LE CAS DE LA DIRECTION : une pro forma SANS TVA imprimée — et le modèle qui en invente une (19 %, TTC 139 527,50).
    SCENARIOS.set(`${RUN}-b.pdf`, {
      emetteur: HOTEL,
      texte: "HÔTEL EL DJAZAIR\nFACTURE PRO FORMA N° PF-2026-117\nSalle de conférence (1 jour) | 1 | 117 250,00\nTotal HT 117 250,00\nTotal TTC 117 250,00",
      modele: modele({ tvaDefaut: "19", lignes: [lm("Salle de conférence (1 jour)", "1", "117 250,00", "19")], ht: "117 250,00", ttc: "139 527,50" }),
    });
    // Une ligne DOUBLÉE par le modèle : 100 000 de lignes pour 50 000 imprimés.
    SCENARIOS.set(`${RUN}-c.pdf`, {
      emetteur: HOTEL,
      texte: "HÔTEL EL DJAZAIR\nDEVIS N° HD-2026-312\nPause café | 50 | 1 000,00\nTotal HT 50 000,00\nTVA 19 % 9 500,00\nTotal TTC 59 500,00",
      modele: modele({ tvaDefaut: "19", lignes: [lm("Pause café", "50", "1 000,00", "19"), lm("Pause café", "50", "1 000,00", "19")], ht: "50 000,00" }),
    });
    // Les factures : chacune son total TTC imprimé.
    SCENARIOS.set(`${RUN}-fa.pdf`, { emetteur: HOTEL, texte: "HÔTEL EL DJAZAIR\nFACTURE N° FA-2026-901\nTotal HT 120 000,00\nTVA 19 % 22 800,00\nTotal TTC 142 800,00", modele: { lignes: [] } });
    SCENARIOS.set(`${RUN}-fb.pdf`, { emetteur: HOTEL, texte: "HÔTEL EL DJAZAIR\nFACTURE N° FA-2026-902\nTotal HT 117 250,00\nTotal TTC 117 250,00", modele: { lignes: [] } });
  }, 60_000);

  afterAll(async () => {
    const ids = Object.values(u).filter(Boolean);
    const parents = [congres, congresDual].filter(Boolean);
    const postes = (await prisma.adProItem.findMany({ where: { congressNationalId: { in: parents } }, select: { id: true } }).catch(() => [])).map((p) => p.id);
    const liens = await prisma.adProItemPiece.findMany({ where: { itemId: { in: postes } }, select: { legalDocumentId: true } }).catch(() => []);
    const aval = await prisma.legalDocument.findMany({ where: { companyId }, select: { id: true } }).catch(() => []);
    const docs = [...new Set([...liens.map((l) => l.legalDocumentId), ...aval.map((a) => a.id)])];
    await prisma.document.deleteMany({ where: { entityId: { in: [...docs, ...postes] } } }).catch(() => {});
    await prisma.adProItemPiece.deleteMany({ where: { itemId: { in: postes } } }).catch(() => {});
    const aDemandes = (await prisma.administrativeRequest.findMany({ where: { linkedEntityType: "AD_PRO_ITEM", linkedEntityId: { in: postes } }, select: { id: true } }).catch(() => [])).map((r) => r.id);
    await prisma.administrativeRequest.deleteMany({ where: { id: { in: aDemandes } } }).catch(() => {});
    await prisma.documentRequest.deleteMany({ where: { entityType: "AD_PRO_ITEM", entityId: { in: postes } } }).catch(() => {});
    await prisma.adProGateVisa.deleteMany({ where: { entityId: { in: [...docs, ...parents] } } }).catch(() => {});
    const vIds = (await prisma.validationRequest.findMany({ where: { entityId: { in: docs } }, select: { id: true } }).catch(() => [])).map((v) => v.id);
    await prisma.validationStep.deleteMany({ where: { requestId: { in: vIds } } }).catch(() => {});
    await prisma.validationRequest.deleteMany({ where: { id: { in: vIds } } }).catch(() => {});
    await prisma.adProDevisLigne.updateMany({ where: { devis: { legalDocumentId: { in: docs } } }, data: { bcId: null } }).catch(() => {});
    await prisma.legalDocument.updateMany({ where: { id: { in: docs } }, data: { chainFromId: null, expenseOrderId: null } }).catch(() => {});
    await prisma.adProItem.updateMany({ where: { id: { in: postes } }, data: { expenseOrderId: null } }).catch(() => {});
    const ordres = await prisma.expenseOrder.findMany({ where: { sourceId: { in: parents } }, select: { id: true } }).catch(() => []);
    await prisma.paymentCentreMessage.deleteMany({ where: { orderId: { in: ordres.map((o) => o.id) } } }).catch(() => {});
    await prisma.paymentRequest.deleteMany({ where: { expenseOrderId: { in: ordres.map((o) => o.id) } } }).catch(() => {});
    await prisma.expenseOrder.deleteMany({ where: { id: { in: ordres.map((o) => o.id) } } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { id: { in: docs } } }).catch(() => {});
    await prisma.adProItemDecision.deleteMany({ where: { itemId: { in: postes } } }).catch(() => {});
    await prisma.adProItem.deleteMany({ where: { id: { in: postes } } }).catch(() => {});
    await prisma.workflowInstance.deleteMany({ where: { entityId: { in: parents } } }).catch(() => {});
    await prisma.congressNational.deleteMany({ where: { id: { in: parents } } }).catch(() => {});
    await prisma.budgetCategoryLine.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.budgetEnvelope.deleteMany({ where: { name: { startsWith: RUN } } }).catch(() => {});
    await prisma.fileVersion.deleteMany({ where: { node: { ownerId: { in: ids } } } }).catch(() => {});
    await prisma.driveNode.deleteMany({ where: { ownerId: { in: ids }, type: "FILE" } }).catch(() => {});
    await prisma.driveNode.deleteMany({ where: { ownerId: { in: ids } } }).catch(() => {});
    await prisma.documentSequence.deleteMany({ where: { companyId } }).catch(() => {});
    await prisma.officeLetterhead.deleteMany({ where: { companyId } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { fullName: { startsWith: TAG } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { OR: [{ actorId: { in: ids } }, { entityId: { in: [...docs, ...parents, ...postes] } }] } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    await prisma.companyLegalIdentity.deleteMany({ where: { companyId } }).catch(() => {});
    await prisma.company.delete({ where: { id: companyId } }).catch(() => {});
  }, 120_000);

  /**
   * Un poste soumis, accepté en UN temps par la Direction Marketing avec son budget (27/10/2026) — SANS prestataire saisi
   * (le cas fréquent). Le congrès est prévalidé (`requestStatus` APPROVED) : sans quoi aucun poste ne s'ajoute.
   */
  async function posteAccorde(label: string, montant: number, parentId = congres) {
    await comme("kam");
    const a = await addAdProItem(undefined, fd({ parent: "CONGRESS_NATIONAL", parentId, kind: "PRINTING", label: `${TAG}${label}`, amountEstimated: String(montant) }));
    ok(a);
    ok(await submitAdProItem(undefined, fd({ id: a.id! })));
    await comme("dm"); ok(await decideAdProItem(undefined, fd({ id: a.id!, decision: "APPROVED", amountGranted: String(montant), budgetCategoryId: catId })));
    return a.id!;
  }
  const devisDuPoste = async (itemId: string) => (await devisDesPostes([itemId])).get(itemId) ?? [];
  const docDeFichier = async (itemId: string, nom: string) => {
    const liens = await prisma.adProItemPiece.findMany({ where: { itemId, nature: "DEVIS" }, select: { legalDocumentId: true } });
    const f = await prisma.document.findFirst({ where: { entityType: "LEGAL_DOCUMENT", entityId: { in: liens.map((l) => l.legalDocumentId) }, name: nom }, select: { entityId: true } });
    expect(f, `le fichier ${nom} doit être sur un devis du poste`).not.toBeNull();
    return f!.entityId;
  };
  const ligneP = async (id: string) => {
    const r = (await loadAdProItems("CONGRESS_NATIONAL", congres)).find((x) => x.id === id);
    expect(r).toBeDefined();
    return r!;
  };

  let p = "", devA = "", devB = "", devC = "";

  it("PRÉMISSES : le demandeur n'a pas la vue globale (une garde éprouvée avec elle ne peut pas tomber)", async () => {
    expect(hasGlobalView(await acteur(u.kam, "MEDICAL_DELEGATE"))).toBe(false);
    // La personne à deux rôles A la vue globale (Direction) : c'est précisément pourquoi la garde « sa propre demande »
    // doit se lire sur la PERSONNE — aucun droit de module ne l'arrête.
    expect(hasGlobalView(await acteur(u.dual, "DIRECTION", "PRODUCT_MANAGER"))).toBe(true);
  });

  it("PLUSIEURS DEVIS EN UN GESTE : trois fichiers → TROIS devis au registre, chacun LU et transformé en lignes natives", async () => {
    p = await posteAccorde("Hébergement et salle", 600_000);
    await comme("kam");
    const f = fd({ id: p, unDevisParFichier: "on" });
    for (const n of ["a", "b", "c"]) f.append("attachment", pdf(`${RUN}-${n}.pdf`));
    const r = await ajouterDevisPoste(undefined, f);
    ok(r);
    expect(r.message).toMatch(/^3 devis déposés, un par fichier/);
    const devis = await devisDuPoste(p);
    expect(devis, "un devis par fichier, chacun rattaché au poste").toHaveLength(3);
    devA = await docDeFichier(p, `${RUN}-a.pdf`);
    devB = await docDeFichier(p, `${RUN}-b.pdf`);
    devC = await docDeFichier(p, `${RUN}-c.pdf`);
    expect(new Set([devA, devB, devC]).size, "trois pièces DISTINCTES — plus un seul devis qui avale trois fichiers").toBe(3);
    for (const id of [devA, devB, devC]) {
      expect(await prisma.document.count({ where: { entityType: "LEGAL_DOCUMENT", entityId: id } }), "chaque devis porte SON fichier, et lui seul").toBe(1);
      expect(devis.find((d) => d.pieceId === id)?.structure, "chaque devis est transformé en lignes (pas seulement le premier)").toBe(true);
    }
    // Le fournisseur est lu sur CHAQUE papier.
    expect((await prisma.legalDocument.findUniqueOrThrow({ where: { id: devB } })).counterparty).toBe(HOTEL);
  });

  it("DEVIS PROPRE (TVA 19 % IMPRIMÉE) : ses lignes sont validées d'office, la TVA est reprise, aucun doute", async () => {
    const a = (await devisDuPoste(p)).find((d) => d.pieceId === devA)!;
    expect(a.entete.tvaRate).toBe(19);
    expect(a.lignes.every((l) => l.validee), "lecture sans doute : validée d'office").toBe(true);
    expect(a.entete.lectureNote ?? "").not.toMatch(/À VÉRIFIER/);
    expect(a.totalValideTtc).toBe(142_800);
  });

  it("TVA INVENTÉE PAR LE MODÈLE : le devis reste SANS TVA, le doute est GARDÉ avec lui, et rien n'est validé d'office", async () => {
    const b = (await devisDuPoste(p)).find((d) => d.pieceId === devB)!;
    expect(b.entete.tvaRate, "pas de TVA imprimée, pas de TVA").toBeNull();
    expect(b.entete.lectureNote).toMatch(/À VÉRIFIER SUR LE PAPIER : TVA de 19 % proposée par la lecture mais imprimée nulle part/);
    expect(b.lignes.some((l) => l.validee), "un doute du contrôle : la personne valide, pas la machine").toBe(false);
    expect(b.lignes.map((l) => [l.reference, l.quantity, l.unitPrice])).toEqual([["Salle de conférence (1 jour)", 1, 117_250]]);
  });

  it("LIGNE DOUBLÉE PAR LE MODÈLE : l'écart avec le total imprimé est dit sur la carte, et rien n'est validé d'office", async () => {
    const c = (await devisDuPoste(p)).find((d) => d.pieceId === devC)!;
    expect(c.lignes).toHaveLength(2);
    expect(c.ecartTotal).toMatchObject({ annonce: 50_000, calcule: 100_000 });
    expect(c.lignes.some((l) => l.validee)).toBe(false);
  });

  it("PLUSIEURS DEVIS D'UN COUP AVEC UN MONTANT SAISI : refusé (un montant ne vaut pas pour trois devis) — et RIEN n'est écrit", async () => {
    await comme("kam");
    const avant = await prisma.adProItemPiece.count({ where: { itemId: p } });
    const f = fd({ id: p, unDevisParFichier: "on", montant: "100000" });
    f.append("attachment", pdf(`${RUN}-x1.pdf`)); f.append("attachment", pdf(`${RUN}-x2.pdf`));
    expect(refus(await ajouterDevisPoste(undefined, f))).toMatch(/le montant et la référence se lisent sur chacun/);
    expect(await prisma.adProItemPiece.count({ where: { itemId: p } })).toBe(avant);
  });

  it("LES PAGES D'UN MÊME DEVIS (case décochée) : UN devis, ses deux fichiers — et la phrase dit que seul le premier est lu", async () => {
    const p2 = await posteAccorde("Imprimés", 300_000);
    await comme("kam");
    const f = fd({ id: p2 });
    f.append("attachment", pdf(`${RUN}-page1.pdf`)); f.append("attachment", pdf(`${RUN}-page2.pdf`));
    const r = await ajouterDevisPoste(undefined, f);
    ok(r);
    expect(await prisma.adProItemPiece.count({ where: { itemId: p2, nature: "DEVIS" } })).toBe(1);
    expect(await prisma.document.count({ where: { entityType: "LEGAL_DOCUMENT", entityId: r.id! } })).toBe(2);
  });

  it("LA CORRECTION À LA MAIN éteint le doute ; les lignes se valident alors avec l'attestation « j'ai comparé »", async () => {
    await comme("kam");
    const b = (await devisDuPoste(p)).find((d) => d.pieceId === devB)!;
    const f = fd({ id: p, pieceId: devB, tvaRate: "" });
    for (const l of b.lignes) {
      f.append("ligneId", l.id); f.append("ligneReference", l.reference); f.append("ligneUnite", "");
      f.append("ligneQuantite", String(l.quantity)); f.append("lignePrix", String(l.unitPrice));
    }
    ok(await enregistrerLignesDuDevis(f));
    const apres = (await devisDuPoste(p)).find((d) => d.pieceId === devB)!;
    expect(apres.entete.tvaRate).toBeNull();
    expect(apres.entete.lectureNote).toMatch(/doutes de la lecture ont été revus/);
    expect(apres.entete.lectureNote).not.toMatch(/À VÉRIFIER/);
    const v = fd({ id: p, pieceId: devB, compare: "1" });
    for (const l of apres.lignes) v.append("ligneId", l.id);
    const r = await validerLignesDuDevis(v);
    ok(r);
    expect(r.message, "le message dit HT et l'absence de TVA — jamais un TTC inventé").toMatch(/117\s250,00 DZD HT, TVA non indiquée/);
  });

  it("LE BC DE LA PRO FORMA SANS TVA se génère À 117 250 — pas un dinar de TVA ajouté ; celui du devis à 19 % à 142 800", async () => {
    await comme("kam");
    ok(await genererBonDeCommandePoste(fd({ id: p })));
    const r = await validerEtEnvoyerBcPoste(fd({ id: p }));
    ok(r);
    const bcs = await prisma.legalDocument.findMany({ where: { chainFromId: { in: [devA, devB] }, kind: "PURCHASE_ORDER", status: { not: "CANCELLED" } } });
    expect(bcs).toHaveLength(2);
    const bcA = bcs.find((x) => x.chainFromId === devA)!;
    const bcB = bcs.find((x) => x.chainFromId === devB)!;
    expect(Number(bcA.amount)).toBe(142_800);
    expect(Number(bcB.amount), "la Direction l'avait interdit : un devis de 117 250 sans TVA ne devient pas 139 527,50").toBe(117_250);
    expect(bcB.counterparty, "le BC est au nom du fournisseur lu sur le devis").toBe(HOTEL);
    expect((await etatDuBC(bcA.id))?.etape, "sous le seuil : droit à la signature des Finances").toBe("A_SIGNER");
  }, 180_000);

  it("SIGNATURE DES FINANCES, puis UNE FACTURE À TROIS PIÈCES : la facture est lue, ses deux annexes sont GARDÉES (plus aucune jetée en silence)", async () => {
    const bcs = await prisma.legalDocument.findMany({ where: { chainFromId: { in: [devA, devB] }, kind: "PURCHASE_ORDER", status: { not: "CANCELLED" } } });
    await comme("fin");
    for (const bc of bcs) ok(await signerBonDeCommande(avecCopieSignee(fd({ id: bc.id }))));
    const bcA = bcs.find((x) => x.chainFromId === devA)!;
    const bcB = bcs.find((x) => x.chainFromId === devB)!;
    await comme("kam");
    const fa = fd({ id: p, bcId: bcA.id });
    for (const n of ["fa.pdf", "bon-livraison.pdf", "pv-reception.pdf"]) fa.append("attachment", pdf(`${RUN}-${n}`));
    const r = await deposerFacturePoste(fa);
    ok(r);
    expect(r.message).toMatch(/2 pièces jointes à la facture/);
    expect(await prisma.document.count({ where: { entityType: "LEGAL_DOCUMENT", entityId: r.id! } }), "la facture ET ses deux annexes").toBe(3);
    expect(Number((await prisma.legalDocument.findUniqueOrThrow({ where: { id: r.id! } })).amount), "le montant est celui LU sur la facture").toBe(142_800);
    const fb = fd({ id: p, bcId: bcB.id });
    fb.append("attachment", pdf(`${RUN}-fb.pdf`));
    ok(await deposerFacturePoste(fb));
  }, 180_000);

  it("LA DEMANDE DE PAIEMENT part AU NOM DU FOURNISSEUR des factures (pas du congrès) ; deux clics simultanés ne font qu'UN ordre", async () => {
    await comme("kam");
    const demande = () => demanderPaiementPoste(undefined, fd({ id: p, argumentation: "Écart connu et accepté (banc d'audit).", confirme: "1" }));
    const [r1, r2] = await Promise.all([demande(), demande()]);
    expect([r1.ok, r2.ok].filter(Boolean), `${r1.error ?? ""} | ${r2.error ?? ""}`).toHaveLength(1);
    const ordres = await prisma.expenseOrder.findMany({ where: { sourceId: congres, status: { not: "CANCELLED" } } });
    expect(ordres).toHaveLength(1);
    expect(Number(ordres[0].amount), "la somme des factures, rien de plus").toBe(260_050);
    expect(ordres[0].beneficiary, "l'argent part au fournisseur qui a facturé — pas « Congrès d'Oran »").toBe(HOTEL);
  }, 120_000);

  it("REFUSÉ PAR LE CENTRE DE PAIEMENT : la carte le DIT (plus « en cours »), le refus de redemander nomme le geste, et le DEMANDEUR libère le poste", async () => {
    const poste = await prisma.adProItem.findUniqueOrThrow({ where: { id: p } });
    await prisma.expenseOrder.update({ where: { id: poste.expenseOrderId! }, data: { centralStatus: "REFUSED" } });
    const row = await ligneP(p);
    const pas = prochainPas(faitsDuPoste(row), REGARD_DEMANDEUR);
    expect(pas.attente).toMatch(/refusé par le centre de paiement/);
    await comme("kam");
    expect(refus(await demanderPaiementPoste(undefined, fd({ id: p })))).toMatch(/refusé par le centre de paiement : « Annuler la demande de paiement » libère le poste/);
    ok(await annulerOrdrePoste(undefined, fd({ id: p, motif: "Refusé par le centre : facture à corriger." })));
    const apres = await prisma.adProItem.findUniqueOrThrow({ where: { id: p } });
    expect(apres.expenseOrderId, "le poste est libre : le paiement se redemandera").toBeNull();
    expect(await prisma.legalDocument.count({ where: { kind: "INVOICE", expenseOrderId: poste.expenseOrderId, status: { not: "CANCELLED" } } }), "ses factures partent avec lui").toBe(0);
  }, 120_000);

  it("ANNULÉ AILLEURS (facture annulée dans Legal) : le poste ne reste plus « paiement en cours » pour toujours — il se dit annulé et se LIBÈRE", async () => {
    const bcs = await prisma.legalDocument.findMany({ where: { chainFromId: { in: [devA, devB] }, kind: "PURCHASE_ORDER", status: { not: "CANCELLED" } } });
    await comme("kam");
    for (const bc of bcs) {
      const f = fd({ id: p, bcId: bc.id });
      f.append("attachment", pdf(`${RUN}-${bc.chainFromId === devA ? "fa" : "fb"}.pdf`));
      ok(await deposerFacturePoste(f));
    }
    ok(await demanderPaiementPoste(undefined, fd({ id: p, argumentation: "Écart connu et accepté (banc d'audit).", confirme: "1" })));
    const ordre = (await prisma.adProItem.findUniqueOrThrow({ where: { id: p } })).expenseOrderId!;
    // L'écrivain commun que l'annulation d'une facture dans Legal appelle (`legal-actions.ts`).
    const a = await annulerOrdreNonRegle(ordre, { acteurId: u.fin, motif: "facture annulée dans Legal (banc)" });
    expect(a).toMatchObject({ ok: true, annule: true });
    const row = await ligneP(p);
    expect(prochainPas(faitsDuPoste(row), REGARD_DEMANDEUR).attente).toMatch(/a été annulé/);
    expect(refus(await deposerFacturePoste(fd({ id: p })))).toMatch(/a été annulé .* libère le poste/);
    ok(await annulerOrdrePoste(undefined, fd({ id: p, motif: "Ordre annulé avec sa facture : on libère le poste." })));
    expect((await prisma.adProItem.findUniqueOrThrow({ where: { id: p } })).expenseOrderId).toBeNull();
  }, 180_000);

  it("UNE FACTURE ILLISIBLE, SANS MONTANT SAISI : la demande de paiement le dit, puis part avec le montant saisi dans la case paiement (plus d'impasse)", async () => {
    const bcs = await prisma.legalDocument.findMany({ where: { chainFromId: { in: [devA, devB] }, kind: "PURCHASE_ORDER", status: { not: "CANCELLED" } } });
    await comme("kam");
    for (const bc of bcs) {
      const f = fd({ id: p, bcId: bc.id });
      // Le fichier de la facture A ne se lit pas (aucune lecture dans ce banc), et aucun montant n'est saisi au dépôt.
      f.append("attachment", pdf(bc.chainFromId === devA ? `${RUN}-illisible.pdf` : `${RUN}-fb.pdf`));
      ok(await deposerFacturePoste(f));
    }
    const sansMontant = refus(await demanderPaiementPoste(undefined, fd({ id: p, argumentation: "Facture A illisible, montant relevé sur le papier.", confirme: "1" })));
    expect(sansMontant).toMatch(/ne se lit pas : indiquez-le/);
    // La case paiement envoie désormais le montant saisi (`DemandePaiementBC`) : c'est lui qui part, plafonné par l'accordé.
    ok(await demanderPaiementPoste(undefined, fd({ id: p, montant: "260050", argumentation: "Facture A illisible, montant relevé sur le papier.", confirme: "1" })));
    const ordre = await prisma.expenseOrder.findFirstOrThrow({ where: { id: (await prisma.adProItem.findUniqueOrThrow({ where: { id: p } })).expenseOrderId! } });
    expect(Number(ordre.amount)).toBe(260_050);
    expect(ordre.notes ?? "", "l'écart assumé et son argument sont écrits dans l'ordre").toMatch(/ÉCART ASSUMÉ/);
  }, 180_000);

  it("ON N'ACCEPTE PAS LES POSTES DE SA PROPRE DEMANDE : la personne Direction ET Direction Marketing n'accepte pas son poste — le Directeur des opérations non plus (un seul temps) ; une AUTRE Direction Marketing, oui", async () => {
    await comme("dual");
    const a = await addAdProItem(undefined, fd({ parent: "CONGRESS_NATIONAL", parentId: congresDual, kind: "PRINTING", label: `${TAG}Affiches`, amountEstimated: "200000" }));
    ok(a);
    const soumis = await submitAdProItem(undefined, fd({ id: a.id! }));
    ok(soumis);
    expect(soumis.message, "un seul temps (27/10/2026) : la Direction Marketing, montant et budget").toMatch(/en attente de la Direction Marketing \(montant et budget\)/);
    expect((await prisma.adProItem.findUniqueOrThrow({ where: { id: a.id! } })).opsDecidedAt, "l'ancien premier temps est franchi d'office, et tracé").not.toBeNull();
    expect(refus(await decideAdProItem(undefined, fd({ id: a.id!, decision: "APPROVED", amountGranted: "200000", budgetCategoryId: catId }))))
      .toMatch(/attend la décision de la Direction Marketing/);
    expect((await prisma.adProItem.findUniqueOrThrow({ where: { id: a.id! } })).status).toBe("PENDING");
    await comme("ops");
    expect(refus(await decideAdProItem(undefined, fd({ id: a.id!, decision: "APPROVED", amountGranted: "200000", budgetCategoryId: catId }))),
      "le Directeur des opérations a validé la DEMANDE ; il ne tranche plus ses postes").toMatch(/attend la décision de la Direction Marketing/);
    expect((await prisma.adProItem.findUniqueOrThrow({ where: { id: a.id! } })).status).toBe("PENDING");
    await comme("dm");
    ok(await decideAdProItem(undefined, fd({ id: a.id!, decision: "APPROVED", amountGranted: "200000", budgetCategoryId: catId })));
    expect((await prisma.adProItem.findUniqueOrThrow({ where: { id: a.id! } })).status).toBe("APPROVED");
  });
});
