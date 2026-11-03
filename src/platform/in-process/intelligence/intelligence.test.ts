import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerNoeudsDriveEtContenu } from "@/lib/actions/internes/menage-de-banc";
import { getAccess } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import { putBlob } from "@/lib/drive-storage";
import { indexDriveNodeText } from "@/lib/assistant/document-discovery";
import { INTELLIGENCE_TOOLS } from "@/lib/assistant/intelligence-tools";
import { intelligenceComplete, mettreEnCacheClauses, signauxFinance, signauxLegal, signauxRegulatory } from "./index";

/**
 * L'INTELLIGENCE MÉTIER, depuis le VRAI point d'entrée : un contrat déposé au Drive et indexé, un
 * ordre réglé sans facture, une demande de paiement à date imposée, un dossier réglementaire dont
 * une étape est en retard — et les signaux qui en sortent, avec leur calcul. Puis la porte : un
 * compte sans module ne voit rien, et la réserve nocturne des clauses évite la relecture.
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__intel__${Date.now()}`;
const JOUR = 86_400_000;
const dans = (j: number) => new Date(Date.now() + j * JOUR);
const iso = (d: Date) => d.toISOString().slice(0, 10);

let pdg: CurrentUser;
let sansDroit: CurrentUser;
let contratId = "";
let ordreId = "";
let produitId = "";

const CONTRAT = `CONTRAT DE DISTRIBUTION ${TAG}

Article 3 — Durée. Le présent contrat est conclu pour une durée de trois (3) ans à compter de sa signature.
Il sera reconduit tacitement par périodes successives de douze (12) mois, sauf dénonciation par l'une des parties
par lettre recommandée moyennant un préavis de six (6) mois avant l'échéance.

Article 9 — Pénalités. Tout retard de livraison donnera lieu à une pénalité de 1 % du montant de la commande par jour de retard.

Article 12 — Confidentialité. Les parties garderont confidentielles les informations échangées pendant deux (2) ans après le terme.
`;

async function utilisateur(suffixe: string, role: "DIRECTION" | "VIEWER"): Promise<CurrentUser> {
  const u = await prisma.user.create({ data: { name: `${TAG} ${suffixe}`, email: `${TAG}${suffixe}@t.dz`, passwordHash: "x", role } });
  return { id: u.id, name: u.name, email: u.email, role: u.role, secondaryRole: null, access: await getAccess(u.id, u.role), mustChangePassword: false };
}

suite("intelligence métier — Legal, Finance, Regulatory depuis les données réelles", () => {
  beforeAll(async () => {
    pdg = await utilisateur("pdg", "DIRECTION");
    sansDroit = await utilisateur("lecteur", "VIEWER");
    // Un contrat au Drive, indexé, rattaché à un engagement ACTIF qui finit dans 200 jours.
    const octets = Buffer.from(CONTRAT, "utf8");
    const blob = await putBlob(octets);
    const node = await prisma.driveNode.create({ data: { name: `${TAG} contrat.txt`, type: "FILE", ownerId: pdg.id, mimeType: "text/plain", size: octets.length, createdById: pdg.id }, select: { id: true } });
    const version = await prisma.fileVersion.create({ data: { nodeId: node.id, blobId: blob.blobId, version: 1, size: octets.length, mimeType: "text/plain", createdById: pdg.id }, select: { id: true } });
    await indexDriveNodeText(node.id, version.id, CONTRAT, null, `${TAG} contrat.txt`);
    contratId = (await prisma.legalDocument.create({ data: { title: `${TAG} Distribution Sofradis`, kind: "CONTRACT", status: "ACTIVE", counterparty: "Sofradis", endDate: dans(200), driveNodeId: node.id, createdById: pdg.id, amount: 12_000_000 } })).id;
    // Un ordre RÉGLÉ qui exigeait une facture, sans facture chaînée.
    ordreId = (await prisma.expenseOrder.create({ data: { reference: `${TAG}-OD-1`, label: `${TAG} Stand congrès`, amount: 450_000, status: "PAID", requiresInvoice: true, paidDate: dans(-10) } })).id;
    // Une demande de paiement à DATE IMPOSÉE dans 3 jours.
    await prisma.paymentRequest.create({ data: { reference: `${TAG}-PAY-1`, title: `${TAG} Droits de douane`, amount: 2_000_000, payee: "Douanes", requesterId: pdg.id, status: "SUBMITTED", dueDate: dans(3), deadlineNature: "FIXED" } });
    // Un dossier réglementaire dont l'étape de dépôt était prévue il y a 40 jours et n'est pas faite.
    produitId = (await prisma.regulatoryProduct.create({ data: {
      reference: `${TAG}-REG-1`, dci: `${TAG} Nivolumab`, brandName: "Nivolex", status: "IN_PREPARATION", targetSubmissionDate: dans(-15),
      steps: { create: [{ type: "CTD_PREPARATION", order: 1, status: "DONE" }, { type: "DOSSIER_SUBMISSION", order: 2, status: "IN_PROGRESS", plannedDate: dans(-40), missingDocs: "CPP du fabricant, BPF" }] },
    } })).id;
  }, 60_000);

  afterAll(async () => {
    await prisma.regulatoryProduct.deleteMany({ where: { reference: { startsWith: TAG } } });
    await prisma.paymentRequest.deleteMany({ where: { reference: { startsWith: TAG } } });
    await prisma.expenseOrder.deleteMany({ where: { reference: { startsWith: TAG } } });
    await prisma.legalDocument.deleteMany({ where: { title: { startsWith: TAG } } });
    await retirerNoeudsDriveEtContenu({ where: { name: { startsWith: TAG } } });
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } });
  });

  it("LEGAL : la date limite de dénonciation = fin − préavis, le risque de pénalité sans plafond, l'obligation de confidentialité — chacun avec son calcul", async () => {
    const l = await signauxLegal(pdg, { horizonJours: 365, filtre: TAG });
    expect(l.portee.engagementsActifs).toBeGreaterThanOrEqual(1);
    const den = l.signaux.find((s) => s.code === "denonciation_a_decider" && s.entite?.id === contratId);
    expect(den, JSON.stringify(l.signaux.map((s) => s.code))).toBeTruthy();
    // « SIX MOIS AVANT LE TERME » : le même quantième six mois plus tôt, ramené au DERNIER jour du
    // mois quand il n'existe pas — six mois avant le 31 mars, c'est le 30 septembre. Le juge
    // s'écrivait `setUTCMonth(mois − 6)`, que JavaScript fait DÉBORDER (« 31 septembre » → 1er
    // octobre) : il était rouge les jours où « aujourd'hui + 200 » tombe un 31 dont le mois cible en
    // compte 30 (mesuré le 12/09/2026 : 31/03/2027 − 6 mois attendu au 01/10, rendu au 30/09 par le
    // produit, qui a raison). Un juge qui mesure un artefact de bibliothèque ne mesure pas la règle
    // (§118.92) ; la règle vit dans `lib/legal/clauses.ts` et son cas déterministe dans son banc.
    const fin = dans(200);
    const limite = new Date(fin);
    const quantieme = limite.getUTCDate();
    limite.setUTCDate(1);
    limite.setUTCMonth(limite.getUTCMonth() - 6);
    const dernier = new Date(Date.UTC(limite.getUTCFullYear(), limite.getUTCMonth() + 1, 0)).getUTCDate();
    limite.setUTCDate(Math.min(quantieme, dernier));
    expect(den!.echeance).toBe(iso(limite));
    expect(den!.calcul).toMatch(/− préavis/);
    expect(l.signaux.some((s) => s.code === "risque_penalite" && s.entite?.id === contratId && /plafond/.test(s.detail))).toBe(true);
    expect(l.signaux.some((s) => s.code === "obligation_confidentialite" && s.entite?.id === contratId)).toBe(true);
    // Pas de signal « échéance » brut : la reconduction tacite fait de la dénonciation LE signal.
    expect(l.signaux.some((s) => s.code === "contrat_echeance" && s.entite?.id === contratId)).toBe(false);
    expect(l.notes.join(" ")).toMatch(/à la volée/);
  }, 30_000);

  it("la réserve nocturne met les clauses en cache ; la lecture suivante ne relit plus le texte", async () => {
    const r = await mettreEnCacheClauses(200);
    expect(r.misAJour).toBeGreaterThanOrEqual(1);
    const doc = await prisma.legalDocument.findUnique({ where: { id: contratId }, select: { custom: true } });
    const cache = (doc?.custom as { intelligence?: { clauses?: unknown[]; versionId?: string } }).intelligence;
    expect(cache?.clauses?.length).toBeGreaterThanOrEqual(3);
    const l = await signauxLegal(pdg, { horizonJours: 365, filtre: TAG });
    expect(l.notes.join(" ")).not.toMatch(/à la volée/);
    expect(l.signaux.some((s) => s.code === "denonciation_a_decider")).toBe(true);
    // Idempotent : rien à refaire tant que la version indexée ne change pas.
    expect((await mettreEnCacheClauses(200)).misAJour).toBe(0);
  }, 30_000);

  it("FINANCE : l'ordre réglé sans facture est HAUTE, la date imposée à 3 jours est CRITIQUE — et les calculs sont dits", async () => {
    const f = await signauxFinance(pdg, { horizonJours: 30 });
    const just = f.signaux.find((s) => s.code === "justificatif_manquant" && s.entite?.id === ordreId);
    expect(just).toMatchObject({ gravite: "HAUTE", montant: 450_000 });
    const pay = f.signaux.find((s) => s.code === "paiement_echeance" && s.entite?.ref === `${TAG}-PAY-1`);
    expect(pay).toMatchObject({ gravite: "CRITIQUE" });
    expect(pay!.calcul).toMatch(/= 3 j|= 2 j/);
    expect(pay!.href).toMatch(/^\/validations\/paiements\//);
    expect(f.portee.ordresDeDepense).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it("REGULATORY : l'étape de dépôt en retard de 40 j est HAUTE, le dépôt cible dépassé aussi, et les pièces manquantes sont nommées", async () => {
    const r = await signauxRegulatory(pdg, { filtre: TAG });
    const codes = r.signaux.filter((s) => s.entite?.id === produitId).map((s) => s.code);
    expect(codes).toEqual(expect.arrayContaining(["etape_en_retard", "depot_en_retard"]));
    const retard = r.signaux.find((s) => s.code === "etape_en_retard" && s.entite?.id === produitId)!;
    expect(retard.gravite).toBe("HAUTE");
    expect(retard.titre).toMatch(/40 j/);
    expect(retard.calcul).toMatch(/= 40 j/);
    expect(r.signaux.find((s) => s.code === "depot_en_retard")?.titre).toMatch(/15 j/);
    expect(r.signaux.some((s) => s.code === "etape_bloquee")).toBe(false);
    expect(r.signaux.some((s) => s.code === "pieces_manquantes")).toBe(false); // l'étape en retard porte déjà ses pièces
  }, 30_000);

  it("la porte : un compte sans module ne voit AUCUN signal — et le dit ; l'ensemble lit les trois sous ses droits", async () => {
    const [l, f, r] = await Promise.all([signauxLegal(sansDroit), signauxFinance(sansDroit), signauxRegulatory(sansDroit)]);
    expect(l.signaux).toEqual([]); expect(f.signaux).toEqual([]); expect(r.signaux).toEqual([]);
    expect(l.notes[0]).toMatch(/sans droit/);
    for (const outil of INTELLIGENCE_TOOLS) expect(outil.allowed(sansDroit), outil.def.name).toBe(false);
    const tout = await intelligenceComplete(pdg, { leger: true });
    expect(tout.lectures.map((x) => x.domaine)).toEqual(["REGULATORY", "LEGAL", "FINANCE"]);
    expect(tout.signaux.length).toBeGreaterThanOrEqual(3);
    // Trié : jamais une BASSE avant une CRITIQUE.
    const rang = { CRITIQUE: 0, HAUTE: 1, NORMALE: 2, BASSE: 3 };
    for (let i = 1; i < tout.signaux.length; i++) expect(rang[tout.signaux[i].gravite]).toBeGreaterThanOrEqual(rang[tout.signaux[i - 1].gravite]);
  }, 60_000);

  it("les outils d'Adam rendent les signaux, leur calcul, un tableau et la provenance du calcul", async () => {
    const outil = INTELLIGENCE_TOOLS.find((t) => t.def.name === "legal_intelligence")!;
    expect(outil.allowed(pdg)).toBe(true);
    const sortie = JSON.parse(await outil.run({ filtre: TAG, horizonJours: 365, gravite: "NORMALE" }, pdg)) as Record<string, unknown>;
    expect(sortie.resume).toMatch(/signa/);
    const signaux = sortie.signaux as { code: string; calcul: string | null; fiche: string | null }[];
    expect(signaux.length).toBeGreaterThanOrEqual(1);
    expect(signaux.every((s) => typeof s.calcul === "string" && s.calcul.length > 0)).toBe(true);
    expect(signaux.some((s) => s.fiche === `/legal/${contratId}`)).toBe(true);
    expect((sortie._blocs as unknown[]).length).toBe(1);
    expect(sortie._provenance).toBeTruthy();
    const fin = JSON.parse(await INTELLIGENCE_TOOLS.find((t) => t.def.name === "finance_intelligence")!.run({ code: "justificatif_manquant" }, pdg)) as { signaux: { code: string }[]; filtre: string };
    expect(fin.filtre).toMatch(/justificatif_manquant/);
    expect(fin.signaux.every((s) => s.code === "justificatif_manquant")).toBe(true);
  }, 60_000);
});
