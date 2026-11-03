import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { attendu } from "@/lib/journal";
import type { CurrentUser } from "@/lib/session";
import { remplacerLecteurInterrupteurIaPourTests } from "@/lib/ai-settings";
import { executerHorsRequete } from "@/platform/ia/hors-requete";
import { annulerGeste } from "@/lib/effets/annulation";
import { putBlob } from "@/lib/drive-storage";
import { enregistrerFichierDrive } from "@/lib/drive/depot";
import { confirmerCarte } from "./api";
import { OPERATIONS_IA, preparerCarte } from "./infra/operations";
import { outilsDocumentsT1 } from "./infra/juridique/outils";
import { retirerAudit, semerAudit, sessionDe, type SemisAudit } from "./infra/testing/audit/semis";
import { TITRE_RESTREINT } from "./infra/testing/audit/semis-documents";
import { TACHES_DOCUMENTS } from "./infra/testing/audit/taches/documents";
import { ATTAQUES_DOCUMENTS } from "./infra/testing/audit/attaques-documents";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LOT T1 (décision 0053) — LES CAPACITÉS « DOCUMENTS, JURIDIQUE ET DRIVE », EXÉCUTÉES contre la base locale, par le
 * chemin du produit (carte préparée → clic « Confirmer » → geste journalisé) — puis ANNULÉES (J7) : l'ERP revient à
 * l'état d'avant. Et la porte : qui n'a pas le Juridique n'en apprend rien, la pièce restreinte n'est nommée à personne.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const ETIQUETTE = `-d${Date.now().toString(36)}`;
/** Une société à elle : les suites parallèles sèment les mêmes partenaires dans « Adventum Pharma ». */
const SOCIETE = `Adventum Pharma ${ETIQUETTE}`;
let S: SemisAudit;
let juriste: CurrentUser, commercial: CurrentUser, kam: CurrentUser, assistante: CurrentUser;

const noeud = async (owner: string, nom: string) => (await prisma.driveNode.findFirstOrThrow({ where: { ownerId: owner, name: nom, type: "FILE" }, select: { id: true } })).id;
const outil = (u: CurrentUser, nom: string) => outilsDocumentsT1(u).find((o) => o.def.name === nom)!;
const lire = async (u: CurrentUser, nom: string, e: Record<string, unknown>) => JSON.parse(await outil(u, nom).run(e, u)) as Record<string, unknown>;

/** Le produit : la carte, puis le clic « Confirmer » (hors requête, sous la session de la personne), puis le geste journalisé. */
async function confirmer(u: CurrentUser, op: string, entree: Record<string, unknown>) {
  const p = await preparerCarte(u, op, entree);
  if (!("carte" in p)) throw new Error(`pas de carte : ${JSON.stringify(p)}`);
  const avant = new Date();
  const r = (await executerHorsRequete(u, "test-t1", () => confirmerCarte(u, p.carte.intentId, p.carte.confirmText ?? "CONFIRMER"))).resultat as { ok: boolean; error?: string };
  expect(r.ok, r.error ?? "").toBe(true);
  const g = await prisma.assistantGesteJournal.findFirstOrThrow({ where: { principalId: u.id, creeLe: { gte: avant } }, orderBy: { creeLe: "desc" }, select: { id: true } });
  return { carte: p.carte, gesteId: g.id };
}

const annuler = async (u: CurrentUser, gesteId: string) => {
  const r = await executerHorsRequete(u, "test-t1", () => annulerGeste(gesteId, u));
  const c = r.resultat as { refus?: string };
  expect(c.refus ?? null).toBeNull();
};

suite("T1 — documents, juridique et Drive : exécutés puis annulés", () => {
  beforeAll(async () => {
    remplacerLecteurInterrupteurIaPourTests(async () => false);
    S = await semerAudit(ETIQUETTE, { putBlob, enregistrerFichierDrive }, { societe: SOCIETE });
    [juriste, commercial, kam, assistante] = await Promise.all(["juriste", "commercial", "kam", "assistante"].map((t) => sessionDe(S.users[t as "juriste"])));
  }, 240_000);
  afterAll(async () => {
    if (S) await retirerAudit(ETIQUETTE);
    await prisma.company.deleteMany({ where: { name: SOCIETE } }).catch(attendu("test T1 : société encore référencée", null));
  }, 120_000);

  it("ranger UN contrat : nature, dossier, partie et dates LUES sur la pièce — puis « annule » défait la fiche", async () => {
    const id = await noeud(S.users.juriste, "Contrat de distribution Pharmalliance 2026.pdf");
    const { carte, gesteId } = await confirmer(juriste, "ranger_au_juridique", { documents: [{ fichier: "Contrat de distribution Pharmalliance 2026.pdf" }] });
    expect(carte.fields.map((f) => `${f.label}: ${f.value}`).join("\n")).toMatch(/Échéance: 2027-12-31/);
    const f = await prisma.legalDocument.findFirstOrThrow({ where: { driveNodeId: id }, select: { kind: true, counterparty: true, startDate: true, endDate: true, status: true, folder: { select: { name: true } } } });
    expect(f).toMatchObject({ kind: "CONTRACT", counterparty: "Pharmalliance Distribution", status: "ACTIVE", folder: { name: "Contrats" } });
    expect(f.startDate?.toISOString().slice(0, 10)).toBe("2026-01-01");
    expect(f.endDate?.toISOString().slice(0, 10)).toBe("2027-12-31");
    await annuler(juriste, gesteId);
    // Une pièce créée ne se retire pas en silence : elle passe ANNULÉE (règle K10b), ou disparaît — jamais active.
    expect(await prisma.legalDocument.count({ where: { driveNodeId: id, status: { not: "CANCELLED" } } })).toBe(0);
    // Le dossier « Contrats » EXISTAIT avant le rangement : l'annulation ne le retire jamais.
    expect(await prisma.legalFolder.count({ where: { companyId: S.companyId, name: "Contrats" } })).toBe(1);
    // Ranger de nouveau après l'annulation : une fiche NEUVE (la fiche annulée n'est pas « déjà au registre »).
    const again = await preparerCarte(juriste, "ranger_au_juridique", { documents: [{ fichier: "Contrat de distribution Pharmalliance 2026.pdf" }] });
    expect("carte" in again && again.carte.warnings.join(" ")).not.toMatch(/déjà au registre/);
  }, 120_000);

  it("ranger un LOT en une carte : chaque pièce dans son dossier canonique, les dossiers manquants créés — et l'annulation passe les pièces ANNULÉES", async () => {
    const dossiersAvant = await prisma.legalFolder.count({ where: { companyId: S.companyId } });
    const { carte, gesteId } = await confirmer(juriste, "ranger_au_juridique", { documents: [
      { fichier: "NDA BioSimilaire Lab.pdf" }, { fichier: "Licence d'importation 2026.pdf" }, { fichier: "Statuts Adventum Pharma SPA 2024.pdf" },
    ] });
    expect(carte.title).toMatch(/3 pièces/);
    const fiche = async (nom: string) => prisma.legalDocument.findFirstOrThrow({ where: { driveNodeId: await noeud(S.users.juriste, nom) }, select: { kind: true, endDate: true, folder: { select: { name: true } } } });
    expect(await fiche("NDA BioSimilaire Lab.pdf")).toMatchObject({ kind: "NDA", folder: { name: "Confidentialité" } });
    const lic = await fiche("Licence d'importation 2026.pdf");
    expect(lic).toMatchObject({ kind: "LICENSE", folder: { name: "Agréments et autorisations" } });
    expect(lic.endDate?.toISOString().slice(0, 10)).toBe("2027-01-14");
    expect(await fiche("Statuts Adventum Pharma SPA 2024.pdf")).toMatchObject({ kind: "STATUTES", folder: { name: "Statuts et PV" } });
    // Les dossiers créés en rangeant appartiennent à l'entité de la pièce (ici, la société du semis).
    expect(await prisma.legalFolder.count({ where: { companyId: S.companyId } })).toBe(dossiersAvant + 3);
    await annuler(juriste, gesteId);
    // Direction, 03/11 (décision 0061) : les dossiers CRÉÉS par le rangement, vides une fois ses pièces annulées, sont retirés.
    expect(await prisma.legalFolder.count({ where: { companyId: S.companyId } })).toBe(dossiersAvant);
    // Règle K10b : une pièce du registre ne s'efface pas, elle passe ANNULÉE (non classée, ses dossiers créés retirés).
    for (const nom of ["NDA BioSimilaire Lab.pdf", "Licence d'importation 2026.pdf", "Statuts Adventum Pharma SPA 2024.pdf"]) {
      expect(await prisma.legalDocument.count({ where: { driveNodeId: await noeud(S.users.juriste, nom), status: { not: "CANCELLED" } } }), nom).toBe(0);
    }
  }, 120_000);

  it("mettre à jour une échéance par la fiche : seule l'échéance change — l'annulation la remet", async () => {
    const { gesteId } = await confirmer(juriste, "modifier_fiche_juridique", { piece: "Bail du siège social — Hydra", fin: "30/06/2028" });
    const b = await prisma.legalDocument.findUniqueOrThrow({ where: { id: S.pieces["doc_fiche:bail"]!.id }, select: { endDate: true, startDate: true, counterparty: true, folder: { select: { name: true } } } });
    expect(b.endDate?.toISOString().slice(0, 10)).toBe("2028-06-30");
    expect(b.startDate?.toISOString().slice(0, 10)).toBe("2024-07-01");
    expect(b).toMatchObject({ counterparty: "SCI El Djazair", folder: { name: "Baux" } });
    await annuler(juriste, gesteId);
    const apres = await prisma.legalDocument.findUniqueOrThrow({ where: { id: S.pieces["doc_fiche:bail"]!.id }, select: { endDate: true } });
    expect(apres.endDate?.toISOString().slice(0, 10)).toBe("2027-06-30");
  }, 120_000);

  it("la porte : sans le Juridique, ni le geste, ni le registre ; la pièce restreinte n'est nommée à personne", async () => {
    expect(OPERATIONS_IA.find((o) => o.nom === "ranger_au_juridique")!.ouverte(commercial)).toBe(false);
    const refus = await lire(commercial, "registre_juridique", { partie: "MediSupply" });
    expect(refus.statut).toBe("REFUS");
    expect(JSON.stringify(refus)).not.toMatch(/MediSupply 2025|\/drive\//);
    const tout = JSON.stringify(await lire(juriste, "registre_juridique", { partie: "Pharmalliance" }));
    expect(tout).not.toContain("QZ-PROTO-7731");
    expect(JSON.stringify(await lire(juriste, "bilan_drive", {}))).not.toContain(TITRE_RESTREINT);
    // Le geste refuse aussi un fichier qu'on ne voit pas — sans le nommer.
    const p = await preparerCarte(assistante, "ranger_au_juridique", { documents: [{ fichier: S.pieces.bulletin_victime!.id }] });
    expect("erreur" in p && p.erreur).toMatch(/pas accessible/);
  }, 60_000);

  it("« donne-moi le dernier contrat MediSupply » : LA pièce 2025, son fichier remis par son lien", async () => {
    const r = await lire(juriste, "registre_juridique", { partie: "MediSupply", nature: "contrat", dernier: "oui" });
    const pieces = r.pieces as { titre: string; lien: string | null }[];
    expect(pieces).toHaveLength(1);
    expect(pieces[0]!.titre).toBe("Contrat de fourniture MediSupply 2025");
    expect(pieces[0]!.lien).toBe(`/drive/${await noeud(S.users.juriste, "Contrat MediSupply 2025.pdf")}`);
    const ech = await lire(juriste, "registre_juridique", { echeance: "30" });
    expect((ech.pieces as { titre: string }[]).map((p) => p.titre)).toContain("Attestation de mise à jour CNAS");
  }, 60_000);

  it("checker le Drive : le doublon, la police expirée non classée, les pièces à ranger", async () => {
    const b = await lire(juriste, "bilan_drive", {}) as { drive: { doublons: { fichiers: string[] }[]; piecesJuridiquesARanger: { fichier: string }[] }; juridique: { expirees: { titre: string }[]; nonClassees: string[] } };
    expect(b.drive.doublons.some((d) => d.fichiers.includes("Contrat Pharmalliance 2026 (copie).pdf"))).toBe(true);
    expect(b.drive.piecesJuridiquesARanger.map((p) => p.fichier)).toContain("Bail entrepôt Rouiba.pdf");
    expect(b.juridique.expirees.map((p) => p.titre)).toContain("Police d'assurance flotte automobile");
    expect(b.juridique.nonClassees).toContain("Police d'assurance flotte automobile");
  }, 60_000);

  it("assembler des PDF : fusion (3 pages), extraction (2 pages), page hors document refusée, bulletin d'autrui refusé", async () => {
    const f = await lire(kam, "assembler_pdf", { action: "fusionner", documents: ["Annexe 1 tarifs.pdf", "Annexe 2 logistique.pdf"] });
    expect(f.statut).toBe("FAIT");
    const mupdf = await import("mupdf");
    const { getBlob } = await import("@/lib/drive-storage");
    const v = await prisma.fileVersion.findFirstOrThrow({ where: { nodeId: String(f.lien).replace("/drive/", "") }, select: { blobId: true } });
    expect(new mupdf.PDFDocument(new Uint8Array((await getBlob(v.blobId))!)).countPages()).toBe(3);
    const reg = await sessionDe(S.users.regulatory);
    expect((await lire(reg, "assembler_pdf", { action: "extraire", documents: ["Dossier ANPP complet.pdf"], pages: "2-3" })).statut).toBe("FAIT");
    expect(JSON.stringify(await lire(reg, "assembler_pdf", { action: "extraire", documents: ["Dossier ANPP complet.pdf"], pages: "9" }))).toMatch(/compte 4/);
    expect((await lire(juriste, "assembler_pdf", { action: "extraire", documents: [S.pieces.bulletin_victime!.id], pages: "1" })).statut).toBe("REFUS");
  }, 60_000);

  it("un AVENANT naît sur son contrat (action des avenants de l'ERP) : fichier, dossier « Avenants », partie — annulable", async () => {
    const { carte, gesteId } = await confirmer(juriste, "ranger_au_juridique", { documents: [{ fichier: "Avenant n°1 contrat Pharmalliance.docx", nature: "contrat" }] });
    expect(carte.fields.map((f) => f.value).join(" ")).toMatch(/Avenant/);
    const id = await noeud(S.users.juriste, "Avenant n°1 contrat Pharmalliance.docx");
    const a = await prisma.legalDocument.findFirstOrThrow({ where: { driveNodeId: id }, select: { kind: true, amendsId: true, counterparty: true, startDate: true, folder: { select: { name: true } } } });
    expect(a).toMatchObject({ kind: "AMENDMENT", amendsId: S.pieces["doc_fiche:pharmalliance2024"]!.id, counterparty: "Pharmalliance Distribution", folder: { name: "Avenants" } });
    expect(a.startDate?.toISOString().slice(0, 10)).toBe("2026-03-01");
    await annuler(juriste, gesteId);
    expect(await prisma.legalDocument.count({ where: { driveNodeId: id, status: { not: "CANCELLED" } } })).toBe(0);
  }, 120_000);

  it("un fichier nommé à la façon d'une personne : par ses MOTS, sans extension, sans accents", async () => {
    const d = await sessionDe(S.users.delegue);
    const r = await lire(d, "assembler_pdf", { action: "images_en_pdf", documents: ["le scan du cachet de la pharmacie"] });
    expect(r.statut, JSON.stringify(r)).toBe("FAIT");
    // (La juriste : le Super Admin voit TOUTES les entités, où d'autres suites sèment les mêmes partenaires.)
    const p = await preparerCarte(juriste, "ranger_au_juridique", { documents: [{ fichier: "l'amm du sofosbuvir 400" }] });
    expect("carte" in p && p.carte.fields.find((f) => f.label === "Pièce")?.value, JSON.stringify(p)).toBe("AMM Sofosbuvir 400 mg.pdf");
    // « Range le contrat Pharmalliance » : l'original — pas la copie (même contenu), pas l'avenant (autre famille) ; hypothèse DITE.
    const c = await preparerCarte(juriste, "ranger_au_juridique", { documents: [{ fichier: "contrat Pharmalliance" }] });
    expect("carte" in c && c.carte.fields.find((f) => f.label === "Pièce")?.value, JSON.stringify(c)).toBe("Contrat de distribution Pharmalliance 2026.pdf");
    expect("carte" in c && c.carte.warnings.join(" ")).toMatch(/j'ai pris « Contrat de distribution Pharmalliance 2026\.pdf »/);
  }, 60_000);

  it("sans moteur de conversion : image → PDF et PDF → Excel par la voie de secours, dite", async () => {
    const { demanderConversion } = await import("@/platform/ia/artifact/atelier/conversions");
    const d = await sessionDe(S.users.delegue);
    const img = await demanderConversion(d, await noeud(S.users.delegue, "Scan cachet pharmacie.png"), "PDF", null, {});
    expect(img.ok, JSON.stringify(img)).toBe(true);
    const x = await demanderConversion(assistante, await noeud(S.users.assistante, "Grille tarifaire 2026.pdf"), "XLSX", null, {});
    expect(x.ok, JSON.stringify(x)).toBe(true);
  }, 120_000);

  it("Direction, 03/11 — le DAF ajoute le partenaire manquant en rangeant ; la juriste reçoit un refus propre, rien n'est créé", async () => {
    const daf = await sessionDe(S.users.finance);
    const avant = await prisma.companyContact.count({ where: { name: "Medilog Services" } });
    const { carte, gesteId } = await confirmer(daf, "ranger_au_juridique", { documents: [{ fichier: "Contrat de prestation Medilog Services.pdf", partie: "Medilog Services" }] });
    expect(carte.warnings.join(" ")).toMatch(/Ajouté\(s\) à l'annuaire des partenaires : Medilog Services/);
    const f = await prisma.legalDocument.findFirstOrThrow({ where: { driveNodeId: await noeud(S.users.finance, "Contrat de prestation Medilog Services.pdf") }, select: { counterparty: true, kind: true } });
    expect(f).toMatchObject({ counterparty: "Medilog Services", kind: "CONTRACT" });
    expect(await prisma.companyContact.count({ where: { name: "Medilog Services" } })).toBe(avant + 1);
    await annuler(daf, gesteId);
    // La juriste n'a ni les Moyens généraux ni l'annuaire : le refus nomme le DAF, et rien ne naît.
    const r = await preparerCarte(juriste, "ranger_au_juridique", { documents: [{ fichier: "Convention de partenariat Clinique El Fath.pdf", partie: "Clinique El Fath" }] });
    expect("erreur" in r && r.erreur).toMatch(/directeur administratif et financier/);
    expect(await prisma.companyContact.count({ where: { name: { contains: "El Fath" } } })).toBe(0);
  }, 120_000);

  it("Direction, 03/11 — l'agrément, l'AMM, les statuts et le PV sont des natures du registre, filtrables", async () => {
    const p = await preparerCarte(juriste, "ranger_au_juridique", { documents: [{ fichier: "Agrément établissement pharmaceutique Blida.pdf" }] });
    expect("carte" in p && p.carte.fields.find((x) => x.label === "Nature")?.value, JSON.stringify(p)).toBe("Agrément");
    // Le nom DÉVELOPPÉ d'une partie de l'annuaire (« ANPP — Agence nationale… ») désigne la fiche « ANPP ».
    const a = await preparerCarte(juriste, "ranger_au_juridique", { documents: [{ fichier: "Décision AMM Daclavir 60 mg.pdf", partie: "ANPP — Agence nationale des produits pharmaceutiques" }] });
    expect("carte" in a && a.carte.fields.find((x) => x.label === "Partie")?.value, JSON.stringify(a)).toBe("ANPP");
    const r = await lire(juriste, "registre_juridique", { nature: "AMM" });
    expect((r.pieces as { titre: string; nature: string }[]).map((x) => `${x.titre} · ${x.nature}`)).toContain("AMM Ribavirine 200 mg · AMM");
  }, 60_000);

  // ── Ce que le premier passage réel a appris (corrigé par le code) ──
  it("un DOSSIER du Drive se range en UNE carte (chaque pièce sa nature), sans mission", async () => {
    const p = await preparerCarte(juriste, "ranger_au_juridique", { dossierDrive: "À classer — novembre" });
    expect("carte" in p && p.carte.title).toBe("Ranger 5 pièces au Juridique");
    const lignes = "carte" in p ? p.carte.fields.map((f) => `${f.label}: ${f.value}`).join("\n") : "";
    expect(lignes).toMatch(/NDA BioSimilaire Lab\.pdf: Accord de confidentialité/);
    expect(lignes).toMatch(/Frigomed\.pdf: Contrat · Frigomed/);
    // « range le contrat » ne range jamais un dossier « Contrats » entier : un fichier sans extension ne vaut dossier que s'il en porte le nom exact.
    const q = await preparerCarte(juriste, "ranger_au_juridique", { documents: [{ fichier: "À classer" }] });
    expect("carte" in q && q.carte.title).not.toBe("Ranger 5 pièces au Juridique");
  }, 60_000);

  it("une pièce DÉJÀ au registre, désignée par son TITRE (le fichier s'appelle autrement) : rangée dans le dossier demandé", async () => {
    const p = await preparerCarte(juriste, "ranger_au_juridique", { documents: [{ fichier: "police d'assurance flotte automobile", dossier: "Assurances" }] });
    expect("carte" in p, JSON.stringify(p)).toBe(true);
    const w = "carte" in p ? p.carte.warnings.join(" ") : "";
    expect(w).toMatch(/pièce du registre « Police d'assurance flotte automobile »/);
    expect(w).toMatch(/déjà au registre/);
  }, 60_000);

  it("les mots sans accents : « bail du siege a Hydra » trouve la fiche ; « agrements » le dossier", async () => {
    const p = await preparerCarte(juriste, "modifier_fiche_juridique", { piece: "bail du siege a Hydra", fin: "2028-06-30" });
    expect("carte" in p, JSON.stringify(p)).toBe(true);
    expect(JSON.stringify(await lire(juriste, "registre_juridique", { recherche: "siege hydra" }))).toContain("Bail du siège social — Hydra");
  }, 60_000);

  it("les gestes nus supplantés ne sont plus offerts à qui a « ranger au juridique » ; le reste du registre l'est", async () => {
    const { capacitesOffertes } = await import("./api");
    const ids = capacitesOffertes(juriste).map((c) => c.id);
    expect(ids).not.toContain("legal-actions:attachDriveNodeToLegal");
    expect(ids).not.toContain("legal-folder-actions:moveLegalDocuments");
    expect(ids).toContain("legal-actions:renewLegalDocument");
  });
});

describe("T1 — le banc DOC- (catalogue)", () => {
  it("25 à 40 tâches variées, identifiants DOC-, un vérificateur pour chaque rangement et chaque production", () => {
    expect(TACHES_DOCUMENTS.length).toBeGreaterThanOrEqual(25);
    expect(TACHES_DOCUMENTS.length).toBeLessThanOrEqual(40);
    expect(TACHES_DOCUMENTS.every((t) => t.id.startsWith("DOC-"))).toBe(true);
    expect(new Set(TACHES_DOCUMENTS.map((t) => t.persona)).size).toBeGreaterThanOrEqual(6);
    expect(new Set(TACHES_DOCUMENTS.map((t) => t.categorie)).size).toBeGreaterThanOrEqual(5);
    for (const t of TACHES_DOCUMENTS.filter((x) => x.attendu.objet === "document_legal")) expect(t.verifier, t.id).toBeTypeOf("function");
    expect(ATTAQUES_DOCUMENTS.every((a) => a.id.startsWith("DOC-ATK-"))).toBe(true);
  });
});
