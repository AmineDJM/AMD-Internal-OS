import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import PizZip from "pizzip";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR, requireUserAuNomDeLaVue: async () => ACTOR }));

import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import { getBlob, putBlob } from "@/lib/drive-storage";
import { enregistrerFichierDrive } from "@/lib/drive/depot";
import { composerDocx, MIME_DOCX, paragraphe } from "@/lib/artifact/factory/word";
import { remplacerModelesPourTests } from "@/lib/agent/generer";
import { modeleFactice } from "@/lib/agent/testing/modele-factice";
import { executerOperationIA, outilsOperations, type PropositionCarte } from "@/lib/agent/operations";
import { lecturesDocuments } from "@/lib/agent/operations/documents-lus";
import { VOYAGEUR_PASSEPORT } from "@/lib/agent/operations/voyageur-passeport";
import { TRADUCTION } from "@/lib/agent/operations/traduction";
import { champsDuFormulaire, FORMULAIRE_PDF, lectureFormulaire } from "@/lib/agent/operations/formulaire-pdf";
import { chiffreDeControle } from "@/lib/agent/operations/mrz";
import { effacerJournalDe } from "@/lib/agent/testing/journal";

/**
 * L'ASSISTANT IA — LES DOCUMENTS AU-DELÀ DE L'ÉDITION : passeport saisi sans que le modèle le voie,
 * traduction en place (et RTL pour l'arabe), formulaire PDF rempli, long document résumé par
 * parties, deux versions comparées.
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__iadocs_${Date.now().toString(36)}_`;
let admin: CurrentUser;
let spoId = "";
let posteId = "";

async function compte(nom: string, role: CurrentUser["role"]): Promise<CurrentUser> {
  const u = await prisma.user.create({ data: { name: `${TAG}${nom}`, email: `${TAG}${nom}@t.dz`, passwordHash: "x", role } });
  return { id: u.id, name: u.name, email: u.email, role: u.role, access: await getAccess(u.id, u.role), mustChangePassword: false } as CurrentUser;
}

const CIBLE = { nodeId: null, parentId: null, spaceId: null, category: null, viewers: [], editors: [] };
async function fichier(user: CurrentUser, nom: string, octets: Buffer, mime: string, nodeId: string | null = null): Promise<string> {
  const { blobId, size } = await putBlob(octets);
  return (await enregistrerFichierDrive(user, { ...CIBLE, nodeId }, { blobId, size, mimeType: mime, name: nom })).id;
}

/** Une zone MRZ VALIDE (chiffres de contrôle calculés) — celle d'un passeport fictif. */
function mrz(): string {
  const num = "123456789";
  const nai = "850101";
  const exp = "310101";
  const perso = "<".repeat(14);
  const c = (s: string) => String(chiffreDeControle(s));
  const debut = `${num}${c(num)}DZA${nai}${c(nai)}M${exp}${c(exp)}${perso}${c(perso)}`;
  const composite = `${num}${c(num)}${nai}${c(nai)}${exp}${c(exp)}${perso}${c(perso)}`;
  return `P<DZABENALIX<<MOHAMED<AMINE${"<".repeat(44 - 27)}\n${debut}${c(composite)}`;
}

/** Un PDF à champs (AcroForm) écrit à la main : un texte, un IBAN (sensible), une case. */
function pdfFormulaire(): Buffer {
  const app = "0 0 15 15 re f";
  const objets = [
    "<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [4 0 R 5 0 R 6 0 R] /DA (/Helv 0 Tf 0 g) /DR << /Font << /Helv 7 0 R >> >> >> >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Annots [4 0 R 5 0 R 6 0 R] >>",
    "<< /Type /Annot /Subtype /Widget /FT /Tx /T (nom) /TU (Nom complet) /Rect [100 700 400 720] /P 3 0 R /DA (/Helv 12 Tf 0 g) /F 4 >>",
    "<< /Type /Annot /Subtype /Widget /FT /Tx /T (iban) /TU (IBAN du beneficiaire) /Rect [100 650 400 670] /P 3 0 R /DA (/Helv 12 Tf 0 g) /F 4 /V (DZ5800400174401234567890) >>",
    "<< /Type /Annot /Subtype /Widget /FT /Btn /T (accord) /TU (J'accepte) /Rect [100 600 115 615] /P 3 0 R /F 4 /V /Off /AS /Off /AP << /N << /Yes 8 0 R /Off 9 0 R >> >> >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Type /XObject /Subtype /Form /BBox [0 0 15 15] /Length ${app.length} >>\nstream\n${app}\nendstream`,
    "<< /Type /XObject /Subtype /Form /BBox [0 0 15 15] /Length 0 >>\nstream\n\nendstream",
  ];
  let corps = "%PDF-1.4\n";
  const decalages: number[] = [];
  objets.forEach((o, i) => { decalages.push(corps.length); corps += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = corps.length;
  corps += `xref\n0 ${objets.length + 1}\n0000000000 65535 f \n${decalages.map((d) => `${String(d).padStart(10, "0")} 00000 n \n`).join("")}`;
  corps += `trailer\n<< /Size ${objets.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(corps, "latin1");
}

suite("Assistant IA — documents au-delà de l'édition", () => {
  beforeAll(async () => {
    admin = await compte("admin", "SUPER_ADMIN");
    spoId = (await prisma.sponsoringRequest.create({ data: { reference: `${TAG}SPO-9`, institution: `${TAG}Société de cardiologie`, type: "Congrès", requesterId: admin.id, createdById: admin.id, status: "AWAITING_PRELIMINARY" } })).id;
    posteId = (await prisma.adProItem.create({ data: { sponsoringId: spoId, kind: "TICKETING", label: `${TAG}Billets d'avion` } })).id;
  });

  afterEach(() => remplacerModelesPourTests(null));

  afterAll(async () => {
    await effacerJournalDe([admin?.id]);
    await prisma.document.deleteMany({ where: { entityType: "AD_PRO_ITEM", entityId: posteId } }).catch(() => {});
    await prisma.adProVoyageur.deleteMany({ where: { itemId: posteId } }).catch(() => {});
    await prisma.adProItem.deleteMany({ where: { sponsoringId: spoId } }).catch(() => {});
    await prisma.sponsoringRequest.deleteMany({ where: { id: spoId } }).catch(() => {});
    await prisma.fileVersion.deleteMany({ where: { node: { name: { contains: TAG } } } }).catch(() => {});
    await prisma.driveNode.deleteMany({ where: { name: { contains: TAG } } }).catch(() => {});
    await prisma.assistantActionIntent.deleteMany({ where: { userId: admin?.id } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("LIMITE : le passeport devient un voyageur — le modèle n'en reçoit ni nom, ni numéro, ni date", async () => {
    const passeport = await fichier(admin, `${TAG}passeport.txt`, Buffer.from(`REPUBLIQUE ALGERIENNE\n${mrz()}\n`), "text/plain");
    const propositions: PropositionCarte[] = [];
    const outil = outilsOperations(admin, propositions).find((o) => o.def.name === VOYAGEUR_PASSEPORT.nom)!;
    const sortie = await outil.run({ fichier: passeport, demande: `${TAG}SPO-9`, retour: "2030-11-01" }, admin);
    // Ce que le MODÈLE lit : ni le nom, ni le prénom, ni le numéro, ni l'expiration.
    expect(sortie).toMatch(/EN_ATTENTE_DE_CONFIRMATION/);
    for (const secret of ["Benalix", "BENALIX", "Mohamed", "123456789", "2031"]) expect(sortie).not.toContain(secret);
    expect(sortie).toMatch(/expire moins de six mois/);
    // Ce que la PERSONNE voit : la carte, avec les valeurs.
    const carte = propositions[0]!.proposition;
    expect(carte.title).not.toMatch(/Benalix/i);
    expect(carte.fields.find((f) => f.label === "Nom (passeport)")?.value).toBe("Benalix");
    expect(carte.fields.find((f) => f.label === "Prénom(s) (passeport)")?.value).toBe("Mohamed Amine");

    ACTOR = admin;
    const r = await executerOperationIA(admin, propositions[0]!.proposition.payload);
    expect(r.ok, r.error).toBe(true);
    expect(r.message).not.toMatch(/Benalix/i);
    const v = await prisma.adProVoyageur.findFirstOrThrow({ where: { itemId: posteId } });
    expect([v.nom, v.prenom]).toEqual(["Benalix", "Mohamed Amine"]);
    expect(await prisma.document.count({ where: { entityType: "AD_PRO_ITEM", entityId: posteId, category: "ID_DOCUMENT", stepKey: v.id } })).toBe(1);
  });

  it("LIMITE : un passeport n'est ni lu, ni résumé, ni traduit pour le modèle", async () => {
    const passeport = await fichier(admin, `${TAG}scan-passeport.txt`, Buffer.from(mrz()), "text/plain");
    const lire = lecturesDocuments(admin).find((o) => o.def.name === "lire_document")!;
    const sortie = await lire.run({ fichier: passeport }, admin);
    expect(sortie).toMatch(/REFUS/);
    expect(sortie).not.toContain("BENALIX");
  });

  it("LIMITE (assistante de direction) : un bulletin de paie qu'elle voit dans son Drive n'entre pas dans le contexte", async () => {
    const assistante = await compte("assistante", "DIRECTION_ASSISTANT");
    const id = await fichier(assistante, `${TAG}bulletin-octobre.txt`, Buffer.from("BULLETIN DE PAIE — Octobre 2026\nSalaire de base 245 000 DZD\nNet à payer 198 500 DZD"), "text/plain");
    for (const nom of ["lire_document", "comparer_versions"]) {
      const sortie = await lecturesDocuments(assistante).find((o) => o.def.name === nom)!.run({ fichier: id, autre: id }, assistante);
      expect(sortie).toMatch(/REFUS/);
      expect(sortie).not.toMatch(/245 000|198 500/);
    }
    const docx = composerDocx({ blocs: [paragraphe("BULLETIN DE PAIE — Octobre 2026"), paragraphe("Salaire de base 245 000 DZD")], titre: "x", auteur: "x", maintenant: new Date() });
    const idDocx = await fichier(assistante, `${TAG}bulletin-octobre.docx`, docx.octets, MIME_DOCX);
    const t = await TRADUCTION.proposer({ fichier: idDocx, langue: "en" }, assistante);
    expect("erreur" in t && t.erreur).toMatch(/rémunération ne part jamais/);
  });

  it("traduction d'un Word EN PLACE : styles gardés, RIB jamais envoyé au modèle et remis à sa place", async () => {
    const doc = composerDocx({ blocs: [paragraphe("Objet : contrat de prestation", { style: "Titre" }), paragraphe("Payé sur le RIB 00799999000123456789 sous 30 jours.")], titre: "x", auteur: "x", maintenant: new Date() });
    const id = await fichier(admin, `${TAG}contrat.docx`, doc.octets, MIME_DOCX);
    const faux = modeleFactice([{ texte: JSON.stringify(["Subject: service agreement", "Paid to RIB ⟦S1⟧ within 30 days."]) }]);
    remplacerModelesPourTests([faux.modele as never]);
    const p = await TRADUCTION.proposer({ fichier: id, langue: "anglais" }, admin);
    if (!("carte" in p)) throw new Error(JSON.stringify(p));
    const r = await executerOperationIA(admin, { kind: "assistant_ia_op", op: TRADUCTION.nom, args: p.args });
    expect(r.ok, r.error).toBe(true);
    expect(JSON.stringify(faux.promptsRecus)).not.toContain("00799999000123456789");
    const node = await prisma.driveNode.findFirstOrThrow({ where: { name: `${TAG}contrat (EN).docx` } });
    const v = await prisma.fileVersion.findFirstOrThrow({ where: { nodeId: node.id } });
    const xml = new PizZip((await getBlob(v.blobId))!).file("word/document.xml")!.asText();
    expect(xml).toContain("Subject: service agreement");
    expect(xml).toContain("Paid to RIB 00799999000123456789 within 30 days.");
    expect(xml).toContain("<w:pStyle w:val=\"Title\"/>");
    expect(xml).not.toContain("contrat de prestation");
  });

  it("traduction en arabe : les paragraphes passent de droite à gauche", async () => {
    const doc = composerDocx({ blocs: [paragraphe("Bonjour à tous", { gras: true })], titre: "x", auteur: "x", maintenant: new Date() });
    const id = await fichier(admin, `${TAG}mot.docx`, doc.octets, MIME_DOCX);
    remplacerModelesPourTests([modeleFactice([{ texte: "[\"مرحبا بالجميع\"]" }]).modele as never]);
    const p = await TRADUCTION.proposer({ fichier: id, langue: "ar" }, admin);
    if (!("carte" in p)) throw new Error(JSON.stringify(p));
    const r = await executerOperationIA(admin, { kind: "assistant_ia_op", op: TRADUCTION.nom, args: p.args });
    expect(r.ok, r.error).toBe(true);
    const node = await prisma.driveNode.findFirstOrThrow({ where: { name: `${TAG}mot (AR).docx` } });
    const v = await prisma.fileVersion.findFirstOrThrow({ where: { nodeId: node.id } });
    const xml = new PizZip((await getBlob(v.blobId))!).file("word/document.xml")!.asText();
    expect(xml).toContain("مرحبا بالجميع");
    expect(xml).toContain("<w:bidi/>");
    expect(xml).toContain("<w:rtl/>");
  });

  it("formulaire PDF : lu, rempli en copie — le champ IBAN n'est ni montré ni rempli par l'assistant", async () => {
    const id = await fichier(admin, `${TAG}inscription.pdf`, pdfFormulaire(), "application/pdf");
    const lu = await lectureFormulaire(admin).run({ fichier: id }, admin);
    expect(lu).toContain("Nom complet");
    expect(lu).not.toContain("DZ5800400174401234567890");
    const p = await FORMULAIRE_PDF.proposer({ fichier: id, valeurs: { nom: "Dr Amine Benali", iban: "DZ00 1111", accord: "oui" } }, admin);
    if (!("carte" in p)) throw new Error(JSON.stringify(p));
    expect(p.carte.fields.map((f) => f.label)).toEqual(["Nom complet", "J'accepte", "Fichier produit"]);
    expect(p.carte.warnings.join(" ")).toMatch(/À compléter par vous.*IBAN/);
    const r = await executerOperationIA(admin, { kind: "assistant_ia_op", op: FORMULAIRE_PDF.nom, args: p.args });
    expect(r.ok, r.error).toBe(true);
    const node = await prisma.driveNode.findFirstOrThrow({ where: { name: `${TAG}inscription (rempli).pdf` } });
    const v = await prisma.fileVersion.findFirstOrThrow({ where: { nodeId: node.id } });
    const champs = await champsDuFormulaire((await getBlob(v.blobId))!);
    expect(champs.find((c) => c.nom === "nom")?.valeur).toBe("Dr Amine Benali");
    expect(champs.find((c) => c.nom === "accord")?.valeur).not.toMatch(/^(Off)?$/);
  });

  it("un long document se résume par parties ; le texte d'une partie part, ses chiffres bancaires non", async () => {
    const long = Array.from({ length: 900 }, (_, i) => `Section ${i}. Obligations du titulaire et calendrier de livraison ${"détail ".repeat(10)}`).join("\n\n")
      + "\n\nPaiement sur le RIB 00799999000123456789.";
    const id = await fichier(admin, `${TAG}cahier-des-charges.txt`, Buffer.from(long), "text/plain");
    const faux = modeleFactice([{ texte: "- obligations et calendrier" }]);
    remplacerModelesPourTests([faux.modele as never]);
    const sortie = JSON.parse(await lecturesDocuments(admin).find((o) => o.def.name === "lire_document")!.run({ fichier: id }, admin)) as { resumesParPartie: string[] };
    expect(sortie.resumesParPartie.length).toBeGreaterThan(2);
    expect(sortie.resumesParPartie[0]).toMatch(/^Partie 1 — - obligations/);
    expect(JSON.stringify(faux.promptsRecus)).not.toContain("00799999000123456789");
  });

  it("comparer les deux dernières versions d'un même fichier", async () => {
    const id = await fichier(admin, `${TAG}convention.txt`, Buffer.from("Article 1 : objet\nArticle 2 : montant 100 000 DZD\nArticle 3 : durée"), "text/plain");
    await fichier(admin, `${TAG}convention.txt`, Buffer.from("Article 1 : objet\nArticle 2 : montant 150 000 DZD\nArticle 3 : durée\nArticle 4 : résiliation"), "text/plain", id);
    const sortie = JSON.parse(await lecturesDocuments(admin).find((o) => o.def.name === "comparer_versions")!.run({ fichier: id }, admin)) as Record<string, unknown>;
    expect(sortie.comparaison).toMatch(/version 1 → version 2/);
    expect(sortie.modifiees).toEqual([{ avant: "Article 2 : montant 100 000 DZD", apres: "Article 2 : montant 150 000 DZD" }]);
    expect(sortie.ajoutees).toEqual(["Article 4 : résiliation"]);
  });
});
