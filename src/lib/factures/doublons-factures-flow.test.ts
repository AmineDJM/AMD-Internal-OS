import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR }));
/** AUCUN fournisseur d'IA n'est appelé dans ce banc. */
vi.mock("@/lib/openai-luna", async (importOriginal) => {
  const vrai = await importOriginal<typeof import("@/lib/openai-luna")>();
  return { ...vrai, lunaConfigured: () => false, callLuna: async () => ({ ok: false, error: "Luna coupée dans ce banc." }) };
});

/**
 * LA LECTURE PAR LUNA est le seul service remplacé : pour chaque fichier, le banc fournit le TEXTE du papier et la SORTIE
 * DU MODÈLE ; la proposition se compose avec les VRAIES règles (repérage, relecture stricte). Tout le reste — la garde
 * des portes, la recherche dans toutes les maisons, la relance, le recensement — est le code de production.
 */
type Scenario = { texte: string; modele: unknown };
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
      const { IDENTITE_VIDE } = await import("@/lib/pieces-lues/emetteur");
      return {
        ok: true,
        proposition: {
          lectureId: `banc-${args.nomFichier}`, empreinte: "banc", nomFichier: args.nomFichier, cible: "LEGAL_DOCUMENT",
          faits: { methode: "texte", confiance: null }, noteMethode: "texte natif (banc)", lignesParModele: true,
          raisonSansLignes: null, sansLignes: null, coupe: null, entetes: repererEntetes(s.texte), piece: lireStructureModele(s.modele),
          controle: null, fournisseur: { statut: "AUCUN", retenu: null, candidats: [], phrase: "", aCreer: null }, appariement: null, suspectes: [],
          emetteur: IDENTITE_VIDE,
        },
      };
    },
  };
});
vi.mock("@/lib/pieces-lues/lecture-fichier", async (importOriginal) => {
  const vrai = await importOriginal<typeof import("@/lib/pieces-lues/lecture-fichier")>();
  return { ...vrai, texteDeLaLecture: async (id: string) => SCENARIOS.get(id.replace(/^banc-/, ""))?.texte ?? null };
});

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { sealSecret } from "@/lib/crypto/secret-box";
import { repererEntetes } from "@/lib/pieces-lues/entetes";
import { lireStructureModele } from "@/lib/pieces-lues/structure";
import { empreinteDe, VERSION_LECTEUR } from "@/lib/pieces-lues/lecture-fichier";
import { persistUploadedDocument } from "@/lib/documents";
import { createExpenseOrder } from "@/modules/finances/api";
import { createPaymentRequest } from "@/modules/finances/actions-demandes";
import { createInvoice } from "@/lib/actions/invoice-actions";
import { relancerPaiement } from "@/modules/finances/actions-relances";
import { marquesDesOrdres } from "@/lib/factures/connues";
import { recenserDoublonsFactures } from "@/lib/factures/recensement";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__doublonfact__";
const RUN = `${TAG}${Date.now().toString(36)}`;

const NIF_HOTEL = "001916012345678";
const texteHotel = (numero: string | null) => [
  "Raison sociale : SPA HOTEL EL DJAZAIR",
  `NIF : ${NIF_HOTEL}`,
  numero ? `FACTURE N° ${numero}` : "FACTURE N° ~#@!",
  "Alger, le 05/09/2026",
  "Client : ADVENTUM PHARMA",
  "Hébergement congrès   10   10 000,00   100 000,00",
  "Total HT   100 000,00",
  "TVA 19 %   19 000,00",
  "Total TTC   119 000,00",
].join("\n");
const modeleHotel = (numero: string) => ({
  type: "FACTURE", numero, date: "05/09/2026", devise: "DA", modePaiement: "",
  fournisseur: { nom: "SPA HOTEL EL DJAZAIR", nif: NIF_HOTEL, rc: "", nis: "", ai: "", adresse: "" },
  tvaDefaut: "19", remiseGlobale: "", taxes: [],
  lignes: [{ designation: "Hébergement congrès", reference: "", unite: "", quantite: "10", prixUnitaire: "10 000,00", remise: "", tva: "19", montantHt: "" }],
  totaux: { ht: "100 000,00", tva: "19 000,00", taxes: "", timbre: "", ttc: "119 000,00" },
});

const octets = (s: string) => Buffer.from(`%PDF-1.4\n${RUN}\n${s}\n`);
const fichier = (nom: string, contenu: Buffer) => new File([new Uint8Array(contenu)], nom, { type: "application/pdf" });

async function acteur(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false } as CurrentUser;
}

function demande(fields: Record<string, string>, pieces: { file: File; kind: string }[]): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  pieces.forEach((p, i) => { fd.append("files", p.file); fd.set(`kind_${i}`, p.kind); });
  return fd;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « PAS DEUX FACTURES » (Direction, 14/10/2026) — par les VRAIES portes, sur la base locale.
 *
 * Une facture déposée dans Ad & Pro (au registre, payée par un ordre au centre de paiement), puis la même facture
 * déposée dans une demande de paiement par quelqu'un d'autre : refus, « en cours de traitement », et la relance comme
 * seul geste — un clic, tracé et notifié à qui a la main. Sans accès au dossier, ni titre ni montant. Un doublon
 * probable passe, marqué. La relance depuis le poste, le délai entre deux relances, le contrôle dans l'autre sens, et
 * le recensement en lecture seule sur un jeu semé.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Doublons de factures — blocage aux portes, relance unifiée, recensement", () => {
  const ROLES = { kam: "PRODUCT_MANAGER", autre: "SALES_USER", pdg: "DIRECTION", fin: "FINANCE_BUDGET_MANAGER" } as const;
  const u: Record<keyof typeof ROLES, string> = { kam: "", autre: "", pdg: "", fin: "" };
  let evId = "", posteId = "", factureId = "", ordreId = "", compagnonId = "", titreFacture = "";
  const empreintes: string[] = [];
  const comme = async (qui: keyof typeof ROLES) => { ACTOR = await acteur(u[qui], ROLES[qui]); return ACTOR; };

  beforeAll(async () => {
    const cles = Object.keys(ROLES) as (keyof typeof ROLES)[];
    const comptes = await Promise.all(cles.map((k) => prisma.user.create({ data: { name: `${TAG}${k}`, email: `${RUN}${k}@t.dz`, role: ROLES[k], passwordHash: "x" } })));
    cles.forEach((k, i) => { u[k] = comptes[i]!.id; });

    // ── LA FACTURE DÉPOSÉE DANS AD & PRO : au registre, sur le poste, avec son fichier et la lecture que Luna en a gardée.
    const ev = await prisma.event.create({ data: { name: `${TAG} congrès ${RUN}` } });
    evId = ev.id;
    const poste = await prisma.adProItem.create({ data: { label: `${TAG} hôtel`, eventId: ev.id } });
    posteId = poste.id;
    titreFacture = `Facture — Hébergement : ${TAG} hôtel (${RUN})`;
    const facture = await prisma.legalDocument.create({
      data: {
        title: titreFacture, kind: "INVOICE", direction: "OUT", reference: "FA-2026/0145", amount: 119_000,
        counterparty: "SPA HOTEL EL DJAZAIR", sourceType: "EVENT", sourceId: ev.id, createdById: u.kam, updatedById: u.kam,
      },
    });
    factureId = facture.id;
    const original = octets("hotel-original");
    const depot = await persistUploadedDocument(u.kam, {
      entityType: "LEGAL_DOCUMENT", entityId: facture.id, category: "INVOICE", confidentiality: "INTERNAL", stepKey: null, file: fichier("facture-hotel.pdf", original), buffer: original,
    });
    expect(depot.ok, depot.error).toBe(true);
    await prisma.adProItemPiece.create({ data: { itemId: poste.id, legalDocumentId: facture.id, nature: "FACTURE", createdById: u.kam } });
    const sha = empreinteDe(original);
    empreintes.push(sha);
    const texte = texteHotel("FA-2026/0145");
    await prisma.lecturePiece.create({
      data: {
        empreinte: sha, versionLecteur: VERSION_LECTEUR, etat: "LUE", extension: "pdf", taille: original.length, methode: "texte", caracteres: texte.length,
        texteScelle: sealSecret(texte), entetes: repererEntetes(texte) as never, structure: lireStructureModele(modeleHotel("FA-2026/0145")) as never,
      },
    });
    // Le paiement du poste : un ordre au centre de paiement (et son dossier compagnon, au nom du demandeur).
    const ordre = await createExpenseOrder({
      label: `${TAG} congrès — Hébergement`, amount: 119_000, category: "EVENEMENT", beneficiary: "SPA HOTEL EL DJAZAIR",
      sourceType: "EVENT", sourceId: ev.id, requestedById: u.kam, requiresInvoice: true,
    });
    ordreId = ordre.id;
    await prisma.legalDocument.update({ where: { id: facture.id }, data: { expenseOrderId: ordre.id } });
    await prisma.adProItem.update({ where: { id: poste.id }, data: { expenseOrderId: ordre.id } });
    compagnonId = (await prisma.paymentRequest.findFirstOrThrow({ where: { expenseOrderId: ordre.id }, select: { id: true } })).id;

    SCENARIOS.set("rescan.pdf", { texte: texteHotel("FA 2026/145"), modele: modeleHotel("FA 2026/145") });
    SCENARIOS.set("floue.pdf", { texte: texteHotel(null), modele: modeleHotel("FA-2026/0999") });
  });

  afterAll(async () => {
    const ids = Object.values(u).filter(Boolean);
    const demandes = (await prisma.paymentRequest.findMany({ where: { requesterId: { in: ids } }, select: { id: true } }).catch(() => [])).map((d) => d.id);
    const legaux = (await prisma.legalDocument.findMany({ where: { OR: [{ createdById: { in: ids } }, { sourceId: evId }] }, select: { id: true } }).catch(() => [])).map((d) => d.id);
    await prisma.adProItemPiece.deleteMany({ where: { itemId: posteId } }).catch(() => {});
    await prisma.document.deleteMany({ where: { OR: [{ uploadedById: { in: ids } }, { entityId: { in: [...demandes, ...legaux] } }] } }).catch(() => {});
    await prisma.paymentRequest.deleteMany({ where: { id: { in: demandes } } }).catch(() => {});
    await prisma.adProItem.deleteMany({ where: { id: posteId } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { id: { in: legaux } } }).catch(() => {});
    await prisma.expenseOrder.deleteMany({ where: { requestedById: { in: ids } } }).catch(() => {});
    await prisma.event.deleteMany({ where: { id: evId } }).catch(() => {});
    await prisma.lecturePiece.deleteMany({ where: { empreinte: { in: empreintes } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
  });

  let blocage: { cible: { type: string; id: string }; jeton: string } | null = null;

  it("LA MÊME FACTURE (même fichier) dans une demande de paiement → refusée AVANT d'écrire : « existe déjà », « en cours de traitement — au centre de paiement »", async () => {
    await comme("autre");
    const r = await createPaymentRequest(undefined, demande(
      { title: `${TAG} hôtel`, payee: "SPA HOTEL EL DJAZAIR", amount: "119000", paymentMethodStated: "1" },
      [{ file: fichier("ma-facture.pdf", octets("hotel-original")), kind: "INVOICE" }],
    ));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Cette facture existe déjà/);
    expect(r.error).toMatch(/en cours de traitement — au centre de paiement/);
    expect(r.error).toMatch(/vous pouvez seulement la relancer/);
    expect(r.factureConnue?.etat).toBe("CENTRE");
    expect(r.factureConnue?.relance?.cible).toEqual({ type: "EXPENSE_ORDER", id: ordreId });
    // SANS ACCÈS au dossier Ad & Pro : ni son titre, ni son montant, ni lien — seulement le module.
    expect(r.error).toMatch(/dans un dossier Ad & Pro/);
    expect(r.error).not.toContain(titreFacture);
    expect(r.error).not.toMatch(/119\s?000/);
    expect(r.factureConnue?.lien).toBeNull();
    // RIEN N'A ÉTÉ ÉCRIT : ni demande, ni pièce.
    expect(await prisma.paymentRequest.count({ where: { requesterId: u.autre } })).toBe(0);
    blocage = r.factureConnue?.relance ?? null;
  });

  it("LA RELANCE EN UN CLIC depuis le blocage : tracée (qui, pourquoi), notifiée à qui a la main (le centre) et au demandeur", async () => {
    await comme("autre");
    expect(blocage).not.toBeNull();
    const fd = new FormData();
    fd.set("cibleType", blocage!.cible.type); fd.set("cibleId", blocage!.cible.id); fd.set("jeton", blocage!.jeton);
    const r = await relancerPaiement(fd);
    expect(r.ok, r.error).toBe(true);
    expect(r.message).toMatch(/centre de paiement est prévenu/);
    const trace = await prisma.paymentRequestEvent.findFirst({ where: { requestId: compagnonId, kind: "NUDGE", actorId: u.autre } });
    expect(trace?.message).toMatch(/facture déjà existante/);
    expect(trace?.message).toMatch(new RegExp(`relancé par ${TAG}autre`));
    expect(await prisma.paymentCentreMessage.count({ where: { orderId: ordreId, authorId: u.autre, body: { startsWith: "Relance" } } })).toBe(1);
    expect(await prisma.notification.count({ where: { userId: u.pdg, title: "Relance : une facture déjà en paiement a été redéposée" } })).toBe(1);
    expect(await prisma.notification.count({ where: { userId: u.kam, title: "Votre paiement a été relancé" } })).toBe(1);
    // Les Finances n'ont pas la main tant que le centre n'a pas autorisé : elles ne sont pas dérangées.
    expect(await prisma.notification.count({ where: { userId: u.fin, title: { startsWith: "Relance" } } })).toBe(0);
  });

  it("UNE RELANCE TROP RAPPROCHÉE est refusée ; sans le jeton du blocage, un tiers ne relance pas", async () => {
    await comme("autre");
    const fd = new FormData();
    fd.set("cibleType", blocage!.cible.type); fd.set("cibleId", blocage!.cible.id); fd.set("jeton", blocage!.jeton);
    const r = await relancerPaiement(fd);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/moins d'une heure/);
    const sans = new FormData();
    sans.set("cibleType", "EXPENSE_ORDER"); sans.set("cibleId", ordreId);
    expect((await relancerPaiement(sans)).error).toMatch(/Seul le demandeur/);
  });

  it("LE MÊME PAPIER RESCANNÉ (autre fichier, même fournisseur, même n° lus par Luna) → refusé ; avec l'accès, le dossier est nommé", async () => {
    await comme("pdg");
    const r = await createPaymentRequest(undefined, demande(
      { title: `${TAG} hôtel bis`, payee: "SPA HOTEL EL DJAZAIR", amount: "119000", paymentMethodStated: "1" },
      [{ file: fichier("rescan.pdf", octets("hotel-rescan")), kind: "INVOICE" }],
    ));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Cette facture existe déjà \(n° FA 2026\/145, SPA HOTEL EL DJAZAIR, 119/);
    expect(r.error).toContain(titreFacture);
    expect(r.factureConnue?.lien).toBe(`/events/${evId}`);
  });

  let demandeFloue = "";
  it("UN DOUBLON PROBABLE (photo floue, sans n°) passe : avertissement, et marque « doublon possible » au fil, sur l'ordre, au centre", async () => {
    await comme("autre");
    const r = await createPaymentRequest(undefined, demande(
      { title: `${TAG} hôtel photo`, payee: "SPA HOTEL EL DJAZAIR", amount: "119000", paymentMethodStated: "1" },
      [{ file: fichier("floue.pdf", octets("hotel-floue")), kind: "INVOICE" }],
    ));
    expect(r.ok, r.error).toBe(true);
    expect(r.avertissement).toMatch(/Doublon possible avec une pièce d'un dossier Ad & Pro/);
    demandeFloue = r.id as string;
    const ev = await prisma.paymentRequestEvent.findFirst({ where: { requestId: demandeFloue, kind: "DOUBLON_POSSIBLE" } });
    expect(ev?.message).toMatch(/Doublon possible de/);
    const req = await prisma.paymentRequest.findUniqueOrThrow({ where: { id: demandeFloue }, select: { expenseOrderId: true } });
    const marques = await marquesDesOrdres([req.expenseOrderId as string]);
    expect(marques.get(req.expenseOrderId as string)).toMatch(/même montant TTC et même date/);
    // Ce que la lecture de production GARDE par empreinte (le banc remplace `proposerLecture`, qui l'écrit d'ordinaire) :
    // le recensement relit les pièces par leur lecture gardée, sans rappeler Luna.
    const floue = octets("hotel-floue");
    const s = SCENARIOS.get("floue.pdf")!;
    empreintes.push(empreinteDe(floue));
    await prisma.lecturePiece.create({
      data: {
        empreinte: empreinteDe(floue), versionLecteur: VERSION_LECTEUR, etat: "LUE", extension: "pdf", taille: floue.length, methode: "texte",
        caracteres: s.texte.length, texteScelle: sealSecret(s.texte), entetes: repererEntetes(s.texte) as never, structure: lireStructureModele(s.modele) as never,
      },
    });
  });

  it("DANS L'AUTRE SENS : la facture déjà portée par une demande de paiement est refusée au registre (Legal / Ad & Pro)", async () => {
    await comme("fin");
    const fd = new FormData();
    fd.set("title", `${TAG} facture hôtel au registre`); fd.set("direction", "OUT"); fd.set("amount", "119000");
    fd.append("attachment", fichier("registre.pdf", octets("hotel-floue")));
    const r = await createInvoice(undefined, fd);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Cette facture existe déjà/);
    expect(r.error).toMatch(/en cours de traitement — au centre de paiement/);
    expect(await prisma.legalDocument.count({ where: { title: `${TAG} facture hôtel au registre` } })).toBe(0);
  });

  it("LA RELANCE DEPUIS LE POSTE AD & PRO (le demandeur, sur l'ordre) : au centre, puis aux Finances une fois autorisé", async () => {
    await comme("kam");
    const fd = new FormData();
    fd.set("cibleType", "EXPENSE_ORDER"); fd.set("cibleId", ordreId); fd.set("commentaire", "L'hôtel a rappelé ce matin.");
    const r1 = await relancerPaiement(fd);
    expect(r1.ok, r1.error).toBe(true);
    expect(r1.message).toMatch(/centre de paiement/);
    const trace = await prisma.paymentRequestEvent.findFirst({ where: { requestId: compagnonId, kind: "NUDGE", actorId: u.kam } });
    expect(trace?.message).toBe("L'hôtel a rappelé ce matin.");
    // Trop tôt : refusée.
    expect((await relancerPaiement(fd)).error).toMatch(/moins d'une heure/);
    // Le centre autorise ; une heure passe : la relance va aux Finances.
    await prisma.expenseOrder.update({ where: { id: ordreId }, data: { centralStatus: "APPROVED" } });
    await prisma.paymentRequestEvent.updateMany({ where: { requestId: compagnonId, actorId: u.kam, kind: "NUDGE" }, data: { at: new Date(Date.now() - 2 * 3600_000) } });
    const r2 = await relancerPaiement(fd);
    expect(r2.ok, r2.error).toBe(true);
    expect(r2.message).toMatch(/Finances sont prévenues/);
    expect(await prisma.notification.count({ where: { userId: u.fin, title: "Relance sur un paiement" } })).toBe(1);
  });

  it("LE RECENSEMENT, en lecture seule, sur un jeu semé : le doublon certain (même fichier dans deux maisons) et le probable", async () => {
    // LE JEU SEMÉ : une demande de paiement d'avant la règle, qui porte la MÊME facture que le poste.
    const ancienne = await prisma.paymentRequest.create({
      data: { reference: `${RUN}-PAY`, title: `${TAG} ancienne demande`, amount: 119_000, payee: "SPA HOTEL EL DJAZAIR", status: "SUBMITTED", requesterId: u.pdg },
    });
    const copie = octets("hotel-original");
    const doc = await persistUploadedDocument(u.pdg, {
      entityType: "PAYMENT_REQUEST", entityId: ancienne.id, category: "OTHER", confidentiality: "INTERNAL", stepKey: null, file: fichier("copie.pdf", copie), buffer: copie,
    });
    const piece = await prisma.paymentPiece.create({ data: { requestId: ancienne.id, documentId: doc.documentId as string, kind: "INVOICE", createdById: u.pdg } });

    // RIEN N'EST ÉCRIT — compté sur CE banc (d'autres bancs écrivent en parallèle dans la même base).
    const ids = Object.values(u);
    const compter = () => Promise.all([
      prisma.legalDocument.count({ where: { OR: [{ createdById: { in: ids } }, { sourceId: evId }] } }),
      prisma.paymentRequest.count({ where: { requesterId: { in: ids } } }),
      prisma.paymentPiece.count({ where: { request: { requesterId: { in: ids } } } }),
      prisma.paymentRequestEvent.count({ where: { request: { requesterId: { in: ids } } } }),
      prisma.expenseOrder.findMany({ where: { requestedById: { in: ids } }, select: { custom: true, status: true, centralStatus: true } }).then((o) => JSON.stringify(o)),
      prisma.legalDocument.findUniqueOrThrow({ where: { id: factureId }, select: { custom: true } }).then((d) => JSON.stringify(d)),
      prisma.lecturePiece.count({ where: { empreinte: { in: empreintes } } }),
    ]);
    const avant = await compter();
    const rec = await recenserDoublonsFactures();
    expect(await compter()).toEqual(avant);

    const certain = rec.groupes.find((g) => g.niveau === "CERTAIN" && g.membres.some((m) => m.cle === `REGISTRE:${factureId}`));
    expect(certain?.membres.map((m) => m.cle)).toEqual(expect.arrayContaining([`REGISTRE:${factureId}`, `DEMANDE:${piece.id}`]));
    expect(certain?.raisons.join(" ")).toMatch(/même fichier/i);
    const membreAdPro = certain?.membres.find((m) => m.cle === `REGISTRE:${factureId}`);
    expect(membreAdPro?.module).toBe("Ad & Pro");
    expect(membreAdPro?.numero).toBe("FA-2026/0145");
    const pieceFloue = await prisma.paymentPiece.findFirstOrThrow({ where: { requestId: demandeFloue }, select: { id: true } });
    const probable = rec.groupes.find((g) => g.niveau === "PROBABLE" && g.membres.some((m) => m.cle === `DEMANDE:${pieceFloue.id}`));
    expect(probable).toBeDefined();
    expect(probable?.membres.some((m) => m.cle === `REGISTRE:${factureId}`)).toBe(true);
  });
});
