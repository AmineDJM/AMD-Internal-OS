/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA FABRIQUE, SUR UNE VRAIE BASE — parce que ce qui compte ici est tenu par Postgres : le
 * compteur atomique, la pièce au registre, le fichier dans le Drive, la reprise d'une émission
 * interrompue, et vingt-cinq bons de commande comptés EXACTEMENT par le moteur de missions.
 *
 * Aucune donnée simulée : un vrai utilisateur, une vraie société avec sa carte d'identité légale,
 * un vrai papier en-tête dans la bibliothèque, de vrais fichiers relus par l'adaptateur.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import { putBlob } from "@/lib/drive-storage";
import type { CurrentUser } from "@/lib/session";
import { adaptateurDocx } from "@/lib/artifact/adapters/docx/adapter";
import type { DocxModel } from "@/lib/artifact/object-model/model";
import { papierEnTeteDeDemonstration } from "@/lib/artifact/factory/word";
import { portsArtefact } from "@/platform/ia/artifact/ports";
import {
  construireDossierDrive, definirProfilDocumentaire, emettreDocumentDrive, manquesDIdentite, profilDocumentaire, reviserDocumentDrive,
  type DemandeDocument, type ProfilDocumentaire,
} from "@/platform/ia/artifact/factory";
import { peutEmettrePieces } from "@/platform/ia/artifact/factory-access";
import { avancer } from "@/lib/missions/runtime/engine";
import { chargerEtat, materialiser } from "@/lib/missions/runtime/store";
import { compile } from "@/lib/missions/compiler/compile";
import { controlerQualite, type EtapeObservee } from "@/lib/missions/goal/evaluate";
import { capabilityMeta } from "@/lib/missions/registry/capability-meta";
import type { MissionPlan, PlannedStep } from "@/lib/missions/planner/contract";
import type { CapabilityCall, CapabilityCatalog, CapabilityOutcome, MissionActor } from "@/lib/missions/ports";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__fab__${Date.now()}`;
const ANNEE = new Date().getUTCFullYear();
let user: CurrentUser;
let companyId = "";
let actor: MissionActor;

const lignes = (k = 1): DemandeDocument["lignes"] => [
  { designation: "Amoxicilline 1 g — boîte de 12", quantite: 100 * k, prixUnitaire: 250 },
  { designation: "Paracétamol 500 mg — boîte de 20", quantite: 40, prixUnitaire: 85.5, remise: 0.1 },
];
const demande = (extra: Partial<DemandeDocument> = {}): DemandeDocument => ({
  type: "FACTURE", societe: companyId, tiers: { nom: "Pharmacie Centrale d'Alger", adresse: "Alger", nif: "000016098765432" },
  lignes: lignes(), date: `${ANNEE}-09-05`, echeance: `${ANNEE}-10-05`, modePaiement: "VIREMENT", ...extra,
});

async function modeleDrive(nodeId: string, version = 1): Promise<DocxModel> {
  const octets = await portsArtefact.documents.lire(user.id, nodeId, version);
  if (!octets) throw new Error(`fichier ${nodeId} v${version} illisible`);
  return (await adaptateurDocx.ouvrir(octets)).modele() as DocxModel;
}

suite("la fabrique de documents — émission, registre, Drive, reprise, révision, profil", () => {
  beforeAll(async () => {
    const u = await prisma.user.create({ data: { name: `${TAG} PDG`, email: `${TAG}@t.dz`, passwordHash: "x", role: "SUPER_ADMIN" } });
    const access = await getAccess(u.id, u.role);
    user = { id: u.id, name: u.name, email: u.email, role: u.role, secondaryRole: null, access, mustChangePassword: false };
    actor = { userId: u.id, label: "le PDG", isAgent: false };
    const c = await prisma.company.create({ data: { name: `${TAG} Pharma`, shortName: TAG.slice(0, 12), color: "#1B7F79" } });
    companyId = c.id;
    await prisma.companyLegalIdentity.create({
      data: {
        companyId, legalName: `${TAG} Pharma SARL`, legalForm: "SARL", shareCapital: "10 000 000 DZD", rcNumber: "16/00-1234567B21", nif: "001916012345678",
        nis: "001916012345690", taxArticle: "16012345678", headOffice: "12 rue des Frères Bouadou, Alger", phone: "+213 21 00 00 00", email: "contact@t.dz",
        bankName: "BNA", bankAgency: "Hydra", rib: "001 00123 0123456789 45", managerName: "Amine Djouamai", managerTitle: "Gérant",
      },
    });
  }, 60_000);

  afterAll(async () => {
    await prisma.mission.deleteMany({ where: { ownerId: user.id } }).catch(() => {});
    // Les PORTES des BC émis (§118.148) : leur demandeur est le compte du banc — sans ce retrait,
    // la clé étrangère `requesterId` empêche de le supprimer, et le run suivant tombe sur son adresse.
    const pieces = (await prisma.legalDocument.findMany({ where: { companyId }, select: { id: true } }).catch(() => [])).map((d) => d.id);
    await prisma.validationRequest.deleteMany({ where: { entityType: "LEGAL_DOCUMENT", entityId: { in: pieces } } }).catch(() => {});
    await prisma.adProGateVisa.deleteMany({ where: { entityType: "LEGAL_DOCUMENT", entityId: { in: pieces } } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { companyId } }).catch(() => {});
    await prisma.officeLetterhead.deleteMany({ where: { companyId } }).catch(() => {});
    await prisma.fileVersion.deleteMany({ where: { node: { ownerId: user.id } } }).catch(() => {});
    await prisma.driveNode.deleteMany({ where: { ownerId: user.id, type: "FILE" } }).catch(() => {});
    await prisma.driveNode.deleteMany({ where: { ownerId: user.id } }).catch(() => {});
    await prisma.company.delete({ where: { id: companyId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  }, 60_000);

  it("refuse sans le droit d'écrire au registre — avant toute lecture en base", async () => {
    const sansDroits: CurrentUser = { ...user, access: { ...user.access, modules: new Map() } };
    expect(peutEmettrePieces(sansDroits)).toBe(false);
    const r = await emettreDocumentDrive(sansDroits, demande());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.echec).toBe("MISSING_PERMISSION");
  });

  it("émet une facture : numéro du compteur, pièce au registre Legal, Word + PDF dans le Drive, montants calculés", async () => {
    const r = await emettreDocumentDrive(user, demande());
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.reference).toBe(`FA-${ANNEE}-0001`);
    expect(r.dejaEmis).toBe(false);
    expect(r.totaux.totalTtc).toBe(33_412.82); // 28 078 HT (remise de 10 % sur la 2e ligne) + 5 334,82 de TVA
    expect(r.pdf?.pages).toBeGreaterThanOrEqual(1);
    const doc = await prisma.legalDocument.findUnique({ where: { id: r.legalDocumentId } });
    expect(doc).toMatchObject({ kind: "INVOICE", direction: "IN", reference: `FA-${ANNEE}-0001`, counterparty: "Pharmacie Centrale d'Alger", companyId, driveNodeId: r.docx.nodeId });
    expect(Number(doc!.amount)).toBe(33_412.82);
    expect(doc!.title).toBe(`Facture n° FA-${ANNEE}-0001 — Pharmacie Centrale d'Alger`);
    const m = await modeleDrive(r.docx.nodeId);
    // LA MISE EN PAGE MAISON (§118.135) : le numéro vit dans le bloc « Numéro de facture », plus dans un titre.
    const texte = [...m.paragraphs.map((x) => x.text), ...m.tables.flatMap((t) => t.cells.map((c) => c.text))].join("\n");
    expect(texte).toContain(`FA-${ANNEE}-0001`);
    expect(texte).toContain("Numéro de facture :");
    expect(texte).toContain("SOMME À PAYER :");
    expect(m.hasHeader).toBe(false);
    const fiche = await portsArtefact.documents.decrire(user.id, r.pdf!.nodeId);
    expect(fiche?.mime).toBe("application/pdf");
    // L'AUTEUR EST CELUI QUI A CLIQUÉ (§118.153) : sans `canal`, c'est une personne sur un écran —
    // la pièce et l'audit la nomment, et ne parlent pas d'Adam.
    expect(doc!.notes).toContain(`par ${user.name}`);
    expect(doc!.notes).not.toMatch(/par Adam/);
    const trace = await prisma.auditLog.findFirst({ where: { entityId: r.legalDocumentId, action: "CREATE" }, orderBy: { createdAt: "desc" } });
    expect(trace?.summary).toContain(`par ${user.name}`);
    expect(trace?.summary).not.toMatch(/par Adam/);
  }, 60_000);


  it("reconnaît une pièce identique : rendue telle quelle, aucun numéro consommé — sauf si on force", async () => {
    const encore = await emettreDocumentDrive(user, demande());
    expect(encore.ok && encore.dejaEmis).toBe(true);
    if (encore.ok) expect(encore.reference).toBe(`FA-${ANNEE}-0001`);
    const force = await emettreDocumentDrive(user, demande({ forcerDoublon: true }));
    expect(force.ok && !force.dejaEmis).toBe(true);
    if (force.ok) expect(force.reference).toBe(`FA-${ANNEE}-0002`);
  }, 60_000);

  it("termine une émission interrompue après la numérotation au lieu de numéroter à nouveau", async () => {
    const d = demande({ tiers: { nom: "EPH de Sétif", nif: "000019000000001" } });
    const premiere = await emettreDocumentDrive(user, d);
    expect(premiere.ok).toBe(true);
    if (!premiere.ok) return;
    // La panne : la pièce est numérotée, le fichier n'a jamais été écrit.
    const doc = await prisma.legalDocument.findUnique({ where: { id: premiere.legalDocumentId }, select: { custom: true } });
    const custom = doc!.custom as { fabrique: Record<string, unknown> };
    await prisma.legalDocument.update({
      where: { id: premiere.legalDocumentId },
      data: { driveNodeId: null, custom: { fabrique: { ...custom.fabrique, etat: "EN_COURS", docx: null, pdf: null } } },
    });
    const reprise = await emettreDocumentDrive(user, d);
    expect(reprise.ok).toBe(true);
    if (!reprise.ok) return;
    expect(reprise.repris).toBe(true);
    expect(reprise.reference).toBe(premiere.reference);
    const apres = await prisma.legalDocument.findUnique({ where: { id: premiere.legalDocumentId }, select: { driveNodeId: true } });
    expect(apres?.driveNodeId).toBe(reprise.docx.nodeId);
    expect(await prisma.legalDocument.count({ where: { companyId, kind: "INVOICE" } })).toBe(3);
  }, 60_000);

  it("refuse une facture quand l'identité légale de l'émetteur est incomplète, et ne consomme aucun numéro", async () => {
    await prisma.companyLegalIdentity.update({ where: { companyId }, data: { nis: null } });
    const r = await emettreDocumentDrive(user, demande({ tiers: { nom: "Client sans NIS" } }));
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.echec).toBe("MISSING_INPUT"); expect(r.motif).toMatch(/NIS/); }
    await prisma.companyLegalIdentity.update({ where: { companyId }, data: { nis: "001916012345690" } });
    const seq = await prisma.documentSequence.findUnique({ where: { companyId_kind_year: { companyId, kind: "INVOICE", year: ANNEE } } });
    expect(seq?.last).toBe(3);
  }, 60_000);

  it("pose la pièce sur le papier en-tête de la société dès qu'il existe dans la bibliothèque", async () => {
    const octets = papierEnTeteDeDemonstration(`${TAG} Pharma`);
    const { blobId, size } = await putBlob(octets);
    await prisma.officeLetterhead.create({ data: { name: "Papier officiel", kind: "word", companyId, blobId, size, mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", isActive: true, uploadedById: user.id } });
    const r = await emettreDocumentDrive(user, demande({ type: "DEVIS", echeance: null, tiers: { nom: "Grossiste de l'Est" } }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.surPapierEnTete).toBe(true);
    expect(r.reference).toBe(`DEV-${ANNEE}-0001`);
    const m = await modeleDrive(r.docx.nodeId);
    expect(m.hasHeader).toBe(true);
    expect(m.hasFooter).toBe(true);
    expect(r.avertissements.some((a) => /PDF/.test(a))).toBe(true);
  }, 60_000);

  it("révise un devis : même numéro, nouvelle version du même fichier, historique ; une facture ne se révise pas", async () => {
    const devis = await emettreDocumentDrive(user, demande({ type: "DEVIS", echeance: null, tiers: { nom: "CHU Mustapha" } }));
    expect(devis.ok).toBe(true);
    if (!devis.ok) return;
    const rev = await reviserDocumentDrive(user, { legalDocumentId: devis.legalDocumentId, modifications: { lignes: lignes(2) }, motif: "quantités doublées" });
    expect(rev.ok, JSON.stringify(rev)).toBe(true);
    if (!rev.ok) return;
    expect(rev.reference).toBe(devis.reference);
    expect(rev.version).toBe(2);
    expect(rev.docx.nodeId).toBe(devis.docx.nodeId);
    expect(rev.docx.version).toBe(2);
    expect(rev.totaux.totalTtc).toBeGreaterThan(devis.totaux.totalTtc);
    const fiche = await portsArtefact.documents.decrire(user.id, devis.docx.nodeId);
    expect(fiche?.version).toBe(2);
    const doc = await prisma.legalDocument.findUnique({ where: { id: devis.legalDocumentId }, select: { amount: true, custom: true } });
    expect(Number(doc!.amount)).toBe(rev.totaux.totalTtc);
    const f = (doc!.custom as { fabrique: { version: number; historique: { version: number; resume: string }[] } }).fabrique;
    expect(f.version).toBe(2);
    expect(f.historique.at(-1)).toMatchObject({ version: 2, resume: "v2 — quantités doublées" });
    // La version 1 reste ouvrable — le Drive est un historique.
    // Le titre « DEVIS » est centré sous l'en-tête (Direction, 10/2026) : il précède la ligne « DEVIS : N° … ».
    expect((await modeleDrive(devis.docx.nodeId, 1)).paragraphs.slice(0, 2).map((x) => x.text)).toEqual(["DEVIS", `DEVIS : N° ${devis.reference}`]);

    const facture = await prisma.legalDocument.findFirst({ where: { companyId, kind: "INVOICE" }, select: { id: true } });
    const refus = await reviserDocumentDrive(user, { legalDocumentId: facture!.id, modifications: { notes: "x" } });
    expect(refus.ok).toBe(false);
    if (!refus.ok) expect(refus.motif).toMatch(/ne se réécrit pas/);
  }, 90_000);

  it("un chainFromId VIDE n'est pas un chaînage : la pièce s'émet, sans violer la clé étrangère", async () => {
    // Le modèle envoie volontiers "" pour « pas de pièce amont » ; ce cas-là violait la clé
    // étrangère au moment d'écrire au registre — mesuré au banc des défis.
    const r = await emettreDocumentDrive(user, { ...demande(), type: "DEVIS", chainFromId: "   " });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    const doc = await prisma.legalDocument.findUnique({ where: { id: r.legalDocumentId }, select: { chainFromId: true, kind: true } });
    expect(doc).toMatchObject({ kind: "QUOTE", chainFromId: null });
  }, 60_000);

  it("le profil documentaire : lu par tous, réglé par la papeterie seulement, appliqué aux pièces suivantes", async () => {
    const lu = await profilDocumentaire(user, companyId);
    expect(lu.ok).toBe(true);
    if (lu.ok) { expect(lu.profil.reglages.existe).toBe(false); expect(lu.profil.papierEnTete?.nom).toBe("Papier officiel"); expect(lu.profil.identiteIncomplete).toEqual([]); }
    const employe: CurrentUser = { ...user, role: "EMPLOYEE" as never };
    const refus = await definirProfilDocumentaire(employe, { societe: companyId, invoicePrefix: "FAC" });
    expect(refus.ok).toBe(false);
    const mauvais = await definirProfilDocumentaire(user, { societe: companyId, vatRate: 0.2 });
    expect(mauvais.ok).toBe(false);
    const ok = await definirProfilDocumentaire(user, { societe: companyId, invoicePrefix: "FAC", quoteValidityDays: 45, paymentTerms: "45 jours fin de mois", signatoryName: "Amine Djouamai", signatoryTitle: "Gérant" });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.profil.reglages).toMatchObject({ invoicePrefix: "FAC", quoteValidityDays: 45, existe: true });
    const f = await emettreDocumentDrive(user, demande({ tiers: { nom: "Client après profil" } }));
    expect(f.ok).toBe(true);
    // Le compteur INVOICE continue (4), le préfixe change : la continuité ne dépend pas du libellé.
    if (f.ok) expect(f.reference).toBe(`FAC-${ANNEE}-0004`);
  }, 60_000);

  it("numérote sans collision sous dix émissions parallèles", async () => {
    const r = await Promise.all(Array.from({ length: 10 }, (_, i) => emettreDocumentDrive(user, demande({
      type: "BON_DE_COMMANDE", echeance: null, tiers: { nom: `Fournisseur parallèle ${i + 1}` }, lignes: [{ designation: `Article ${i + 1}`, quantite: i + 1, prixUnitaire: 1_000 }], sansPdf: true,
    }))));
    const refs = r.map((x) => (x.ok ? x.reference : `ECHEC ${JSON.stringify(x)}`));
    expect(new Set(refs).size).toBe(10);
    expect(refs.sort()).toEqual(Array.from({ length: 10 }, (_, i) => `BC-${ANNEE}-${String(i + 1).padStart(4, "0")}`));

    // CHAQUE BC PORTE SA PORTE (§118.148). Dix numéros justes ne suffisent pas : sans la file
    // d'attente des références `VAL-…` (`enSerie`), les demandes de validation des derniers BC
    // entraient en collision au-delà de six essais, et ces BC sortaient SANS porte — émis, numérotés,
    // et hors de tout centre, en silence. C'est exactement le cas qui fait tomber ces trois lignes.
    const emis = r.flatMap((x) => (x.ok ? [x] : []));
    expect(emis.map((x) => x.porteBC?.etat ?? `SANS PORTE — ${x.reserveBonDeCommande ?? "(aucune phrase)"}`))
      .toEqual(Array.from({ length: 10 }, () => "EN_ATTENTE"));
    const portes = await prisma.validationRequest.groupBy({
      by: ["entityId"], _count: { _all: true },
      where: { entityType: "LEGAL_DOCUMENT", entityId: { in: emis.map((x) => x.legalDocumentId) }, objectType: "BON_DE_COMMANDE", status: "PENDING" },
    });
    expect(portes.map((p) => p._count._all)).toEqual(Array.from({ length: 10 }, () => 1));
  }, 120_000);

  it("MISSION MASSIVE : 25 bons de commande par le moteur — 25 pièces, 25 numéros consécutifs, contrôle qualité 25/25, aucun doublon à la reprise", async () => {
    const fournisseurs = Array.from({ length: 25 }, (_, i) => ({
      id: `F${i + 1}`, nom: `Fournisseur mission ${String(i + 1).padStart(2, "0")}`, nif: `0000190000000${String(i + 1).padStart(2, "0")}`,
      lignes: [{ designation: `Matière première lot ${i + 1}`, quantite: 10 + i, prixUnitaire: 2_500 }],
    }));
    const appels: CapabilityCall[] = [];
    const runner = {
      async run(call: CapabilityCall): Promise<CapabilityOutcome> {
        appels.push(call);
        if (call.capability === "directory_list") return { ok: true, output: { fournisseurs } };
        if (call.capability === "document_build") {
          const r = await emettreDocumentDrive(user, call.input as never);
          return r.ok ? { ok: true, output: r, structured: true } : { ok: false, output: r, error: { kind: r.echec, message: r.motif, retryable: false } };
        }
        return { ok: false, output: null, error: { kind: "CAPABILITY_FAILURE", message: `capacité inconnue ${call.capability}`, retryable: false } };
      },
    };
    const catalogue: CapabilityCatalog = { has: (n) => ["directory_list", "document_build"].includes(n), allowed: () => true, meta: (n) => capabilityMeta(n), brief: () => [] };
    const steps: PlannedStep[] = [
      { key: "liste", title: "Lister les fournisseurs", capability: "directory_list" },
      {
        key: "bc", title: "Émettre un bon de commande par fournisseur", capability: "document_build",
        forEach: { from: "liste", path: "fournisseurs", as: "f" },
        input: { type: "BON_DE_COMMANDE", societe: companyId, tiers: { nom: "{{f.nom}}", nif: "{{f.nif}}" }, lignes: "{{f.lignes}}", dossier: "Bons de commande mission", sansPdf: true },
      },
    ];
    const plan: MissionPlan = { objective: "25 bons de commande", acceptance: ["chaque fournisseur a son bon de commande"], complexity: "B", scale: "L", steps };
    const compile_ = compile(plan, catalogue, actor);
    if (!compile_.ok) throw new Error(compile_.issues.map((i) => `${i.code} ${i.message}`).join(" | "));
    const missionId = await materialiser(compile_.mission, { ownerId: user.id, title: "25 BC", goalRaw: "25 BC" });

    const avantBc = await prisma.legalDocument.count({ where: { companyId, kind: "PURCHASE_ORDER" } });
    const r = await avancer(missionId, actor, { runner });
    expect(r.deployees).toBe(25);
    expect(r.echouees).toBe(0);
    const emissions = appels.filter((a) => a.capability === "document_build");
    expect(emissions).toHaveLength(25);
    expect(new Set(emissions.map((a) => (a.input.tiers as { nom: string }).nom)).size).toBe(25);
    // Les lignes sont passées ENTIÈRES (une liste reste une liste) : la pièce porte les vraies lignes.
    expect(emissions.every((a) => Array.isArray(a.input.lignes))).toBe(true);

    // 1. LE REGISTRE : 25 pièces de plus, 25 numéros consécutifs, 25 fichiers distincts.
    const pieces = await prisma.legalDocument.findMany({ where: { companyId, kind: "PURCHASE_ORDER", counterparty: { startsWith: "Fournisseur mission" } }, select: { reference: true, driveNodeId: true, counterparty: true } });
    expect(pieces).toHaveLength(25);
    expect(await prisma.legalDocument.count({ where: { companyId, kind: "PURCHASE_ORDER" } })).toBe(avantBc + 25);
    const nums = pieces.map((p) => Number(p.reference!.split("-").at(-1))).sort((a, b) => a - b);
    expect(nums).toEqual(Array.from({ length: 25 }, (_, i) => nums[0] + i));
    expect(new Set(pieces.map((p) => p.driveNodeId)).size).toBe(25);

    // 2. LE CONTRÔLE QUALITÉ DU MOTEUR : arithmétique, 25 attendues, 25 faites.
    const etat = await chargerEtat(missionId);
    const observees: EtapeObservee[] = etat!.steps.map((s) => ({ key: s.key, title: s.title, status: s.status, nodeType: s.nodeType, receipt: s.receipt, attempt: s.attempt, maxAttempts: s.maxAttempts, result: s.result, input: s.input }));
    const qa = controlerQualite(observees);
    expect(qa.ok, qa.resume).toBe(true);
    expect(qa.faits).toBe(qa.attendus);
    expect(etat!.steps.filter((s) => s.key.startsWith("bc#") && s.status === "DONE")).toHaveLength(25);

    // 2 bis. LES 25 PORTES : un BC émis par une mission passe au centre comme un autre (§118.148),
    // et vingt-cinq émissions d'un coup ne doivent en laisser AUCUNE dehors.
    const idsBc = (await prisma.legalDocument.findMany({ where: { companyId, kind: "PURCHASE_ORDER", counterparty: { startsWith: "Fournisseur mission" } }, select: { id: true } })).map((d) => d.id);
    const portesEnAttente = () => prisma.validationRequest.count({ where: { entityType: "LEGAL_DOCUMENT", entityId: { in: idsBc }, objectType: "BON_DE_COMMANDE", status: "PENDING" } });
    expect(await portesEnAttente()).toBe(25);

    // 3. LA REPRISE : rejouer un appel à l'identique ne crée rien — ni pièce, ni seconde porte.
    const rejoue = await emettreDocumentDrive(user, emissions[7].input as never);
    expect(rejoue.ok && rejoue.dejaEmis).toBe(true);
    expect(rejoue.ok ? rejoue.porteBC?.etat : null).toBe("EN_ATTENTE");
    expect(await prisma.legalDocument.count({ where: { companyId, kind: "PURCHASE_ORDER" } })).toBe(avantBc + 25);
    expect(await portesEnAttente()).toBe(25);
  }, 240_000);

  /**
   * LA RÉÉMISSION RATTRAPE LA PORTE QUI MANQUE (§118.148). Le décor EST l'absence : un BC émis dont
   * l'aiguillage a échoué (on retire sa demande de validation, ce que l'échec aurait laissé). À la
   * reprise d'une mission, l'émission identique rend « pièce déjà émise » — et, avant, s'arrêtait
   * là : le BC restait hors de tout centre pour toujours, la reprise ayant l'air d'avoir réussi.
   */
  it("réémettre un BC SANS porte la lui pose — et une seule, même réémis deux fois", async () => {
    const d = demande({ type: "BON_DE_COMMANDE", echeance: null, tiers: { nom: "Fournisseur à rattraper" }, lignes: [{ designation: "Étuis", quantite: 3, prixUnitaire: 4_000 }], sansPdf: true });
    const premier = await emettreDocumentDrive(user, d);
    expect(premier.ok, JSON.stringify(premier)).toBe(true);
    if (!premier.ok) return;
    const where = { entityType: "LEGAL_DOCUMENT" as const, entityId: premier.legalDocumentId, objectType: "BON_DE_COMMANDE" };
    await prisma.validationRequest.deleteMany({ where });
    expect(await prisma.validationRequest.count({ where })).toBe(0);

    const second = await emettreDocumentDrive(user, d);
    expect(second.ok && second.dejaEmis).toBe(true);
    expect(second.ok ? second.porteBC?.etat : null).toBe("EN_ATTENTE");
    expect(await prisma.validationRequest.count({ where: { ...where, status: "PENDING" } })).toBe(1);

    const troisieme = await emettreDocumentDrive(user, d);
    expect(troisieme.ok && troisieme.dejaEmis).toBe(true);
    expect(await prisma.validationRequest.count({ where: { ...where, status: "PENDING" } })).toBe(1);
  }, 90_000);

  it("le dossier à trois formats arrive dans le Drive, aux couleurs et sur le papier de la société", async () => {
    const r = await construireDossierDrive(user, {
      nom: "Revue T3", societe: companyId,
      canon: {
        titre: "Revue commerciale T3", societe: { nom: "" }, date: `${ANNEE}-09-05`,
        sections: [{ titre: "Faits marquants", puces: ["Croissance de 12 % sur la gamme cardio"] }],
        chiffres: [{ cle: "ca", libelle: "Chiffre d'affaires", valeur: 41_300_000, format: "montant" }],
        parametres: [{ nom: "TVA", valeur: 0.19 }],
        tableaux: [{
          cle: "v", titre: "Ventes", colonnes: [{ cle: "r", titre: "Région", type: "texte" }, { cle: "q", titre: "Qté", type: "entier" }, { cle: "pu", titre: "P.U.", type: "montant" }, { cle: "ht", titre: "HT", type: "montant", formule: "[q]*[pu]" }],
          lignes: [{ r: "Alger", q: 10, pu: 100 }, { r: "Oran", q: 5, pu: 200 }], totaux: ["ht"],
        }],
      },
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.coherence.totauxCompares).toBe(1);
    expect(r.classeur.nom).toBe("Revue T3.xlsx");
    const note = await modeleDrive(r.note.nodeId);
    expect(note.hasHeader).toBe(true);
    expect(note.paragraphs[0].text).toBe("Revue commerciale T3");
    for (const n of [r.classeur.nodeId, r.deck.nodeId, r.note.nodeId]) expect(await portsArtefact.documents.decrire(user.id, n)).toBeTruthy();
  }, 90_000);

  // PLACÉ APRÈS LES CAS DE NUMÉROTATION : il émet un BC, donc consomme un numéro de la série, et
  // « numérote sans collision » attend une série qui commence à 0001. Écrit d'abord plus haut, il
  // a fait échouer son voisin — BC-0002 à BC-0011 au lieu de 0001 à 0010 — pour une raison qui
  // n'était pas la sienne : un cas qui consomme le compteur d'un autre échoue pour lui (§118.149h).
  it("réviser la LIVRAISON d'un BC ne change que ce qui est nommé : le délai seul garde l'adresse, `null` efface (§118.152)", async () => {
    // Le formulaire « Modifier le BC » n'est pas pré-rempli, et Adam ne nomme que ce qui change :
    // remplacer l'objet entier effaçait l'adresse de qui ne changeait que le délai — la pièce
    // révisée partait sans elle, sans un mot.
    const bc = await emettreDocumentDrive(user, demande({
      type: "BON_DE_COMMANDE", echeance: null, tiers: { nom: "Imprimerie Atlas", adresse: "Alger", nif: "0001" },
      livraison: { adresse: "Dépôt de Oued Smar", delai: "10 jours" }, contact: { nom: "Mme Abdelaziz", telephone: "0770 00 00 00" },
    }));
    expect(bc.ok, JSON.stringify(bc)).toBe(true);
    if (!bc.ok) return;
    const lire = async () => {
      const d = await prisma.legalDocument.findUniqueOrThrow({ where: { id: bc.legalDocumentId }, select: { custom: true } });
      return (d.custom as { fabrique: { spec: { livraison?: { adresse?: string | null; delai?: string | null } | null; contact?: { nom?: string | null; telephone?: string | null } | null } } }).fabrique.spec;
    };
    const r1 = await reviserDocumentDrive(user, { legalDocumentId: bc.legalDocumentId, modifications: { livraison: { delai: "15 jours" } }, motif: "délai" });
    expect(r1.ok, JSON.stringify(r1)).toBe(true);
    const apres = await lire();
    expect(apres.livraison).toEqual({ adresse: "Dépôt de Oued Smar", delai: "15 jours" });
    expect(apres.contact).toEqual({ nom: "Mme Abdelaziz", telephone: "0770 00 00 00" });
    // Le téléphone seul : l'interlocuteur reste.
    await reviserDocumentDrive(user, { legalDocumentId: bc.legalDocumentId, modifications: { contact: { telephone: "0550 11 11 11" } } });
    expect((await lire()).contact).toEqual({ nom: "Mme Abdelaziz", telephone: "0550 11 11 11" });
    // `null` EFFACE — c'est le seul geste qui retire une valeur.
    await reviserDocumentDrive(user, { legalDocumentId: bc.legalDocumentId, modifications: { livraison: null } });
    expect((await lire()).livraison).toBeNull();
  }, 90_000);

  it("émise PAR ADAM, la pièce le dit — et seulement dans ce cas (§118.153) — en DERNIER : il consomme un numéro, et les cas précédents comptent le compteur", async () => {
    const r = await emettreDocumentDrive(user, demande({ forcerDoublon: true }), { canal: "ADAM" });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    const doc = await prisma.legalDocument.findUnique({ where: { id: r.legalDocumentId } });
    expect(doc!.notes).toMatch(/par Adam/);
    const trace = await prisma.auditLog.findFirst({ where: { entityId: r.legalDocumentId, action: "CREATE" }, orderBy: { createdAt: "desc" } });
    expect(trace?.summary).toMatch(/par Adam/);
  }, 60_000);
});

/**
 * LE « BC ADVENTUM GÉNÉRIQUE » — un livrable techniquement valide et commercialement inutilisable.
 *
 * Les totaux étaient justes, le .docx s'ouvrait, et la pièce ne portait ni RC, ni NIF, ni logo,
 * ni papier en-tête. Rien dans la réponse ne le disait. Le code CONNAISSAIT ces trois manques
 * (`identiteIncomplete`, `papierEnTete`, `marque.logo`) et ne les recopiait nulle part.
 *
 * Ce test tient l'invariant dans les deux sens — c'est le second sens qui compte : une société
 * complète ne doit pas récolter un avertissement, sinon le bruit tuerait la règle.
 */
describe("une pièce qui ne porte pas la charte de la société le DIT", () => {
  const profilNu = (o: Partial<ProfilDocumentaire> = {}): ProfilDocumentaire => ({
    societe: { id: "s1", nom: "Adventum Pharma", couleur: "#0f766e" },
    identite: { nom: "Adventum Pharma" },
    identiteIncomplete: ["siège social", "RC", "NIF"],
    reglages: { quotePrefix: "DEV", orderPrefix: "BC", invoicePrefix: "FA", vatRate: 0.19, paymentTerms: "", quoteValidityDays: 30, footerNote: null, letterheadId: null, signatoryName: null, signatoryTitle: null, numerotation: {}, numerotationDepart: {}, existe: false },
    papierEnTete: null,
    reglesAppliquees: [],
    marque: { logo: null } as ProfilDocumentaire["marque"],
    charte: {} as ProfilDocumentaire["charte"],
    resumeMarque: "",
    ...o,
  });

  it("nomme ce qui manque ET où le renseigner", () => {
    const m = manquesDIdentite(profilNu());
    expect(m.join(" ")).toMatch(/siège social, RC, NIF/);
    expect(m.join(" ")).toMatch(/Legal → Sociétés/);
    expect(m.join(" ")).toMatch(/mise en page est NEUTRE/);
    expect(m.join(" ")).toMatch(/Aucun profil documentaire/);
  });

  it("se tait quand la société est complète — sans quoi l'avertissement deviendrait du bruit", () => {
    expect(manquesDIdentite(profilNu({
      identiteIncomplete: [],
      papierEnTete: { id: "l1", nom: "En-tête Adventum" },
      reglages: { ...profilNu().reglages, existe: true },
    }))).toEqual([]);
  });

  it("un logo suffit à porter la charte, même sans papier en-tête", () => {
    const avecLogo = profilNu({ identiteIncomplete: [], reglages: { ...profilNu().reglages, existe: true }, marque: { logo: { blobId: "b1" } } as ProfilDocumentaire["marque"] });
    expect(manquesDIdentite(avecLogo)).toEqual([]);
  });
});
