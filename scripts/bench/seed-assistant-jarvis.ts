/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE SEMIS DU BANC « JARVIS » DE L'ASSISTANT IA — synthétique, LOCAL, retirable.
 *
 *   BENCH_SEED_ALLOW=1 npm run bench:live -- scripts/bench/seed-assistant-jarvis.ts          # (re)sème
 *   BENCH_SEED_ALLOW=1 npm run bench:live -- scripts/bench/seed-assistant-jarvis.ts --clean  # retire
 *
 * Il se pose PAR-DESSUS le jeu du banc Adam (`seed-adam-bench.ts` : sociétés, départements, PDG,
 * Regulatory, Drive de direction) et ajoute ce que les scénarios du banc Jarvis interrogent :
 *   • Assia Benmoussa (Marketing), son manager, son salaire, son contrat Word, ses congés ;
 *   • une ASSISTANTE DE DIRECTION à qui l'Assistant IA est ouvert (Administration › Accès) ;
 *   • deux documents du Drive retrouvables par leur CONTENU (pas leur nom) ;
 *   • une enveloppe budgétaire Ad & Pro, des validations qui attendent l'acteur, les demandes de l'année ;
 *   • les pièces jointes (photo de facture, PDF) déjà déposées dans le Drive de l'acteur.
 *
 * Mêmes gardes que le semis Adam : base de banc LOCALE (garde de `@/lib/prisma`), BENCH_SEED_ALLOW=1,
 * manifeste (`bench-out/assistant-jarvis-manifest.json`) qui retire EXACTEMENT ce qui a été créé.
 * Tous les noms sont fictifs. La vérité terrain est exportée (`JARVIS`) : le banc l'importe.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
import bcrypt from "bcryptjs";
import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { prisma, estUneBaseDeBancOuDEssai } from "@/lib/prisma";

const MANIFEST = path.join(process.cwd(), "bench-out", "assistant-jarvis-manifest.json");
const DOMAINE = "adventum-bench.dz";
const MOT_DE_PASSE = "Bench12345!";
const ANNEE = new Date().getUTCFullYear();

/** La vérité terrain — ce que le banc a le droit d'attendre. */
export const JARVIS = {
  superAdmin: { email: `super@${DOMAINE}` },
  assistante: { name: "Lina Ouali", email: `lina.ouali@${DOMAINE}`, poste: "Assistante de Direction" },
  assia: {
    name: "Assia Benmoussa", email: `assia.benmoussa@${DOMAINE}`, poste: "Cheffe de produit Hépatologie",
    salaireBase: 165_000, netAPayer: 128_400, manager: "Karim Ziani", embauche: "2024-03-04",
    conges: { pris: { du: `${ANNEE}-08-03`, au: `${ANNEE}-08-14`, jours: 10 }, demande: { du: `${ANNEE}-12-21`, au: `${ANNEE}-12-31`, jours: 8 } },
  },
  karim: { name: "Karim Ziani", email: `karim.ziani@${DOMAINE}`, poste: "Directeur Marketing" },
  walid: { name: "Walid Saidi", email: `walid.saidi@${DOMAINE}`, poste: "Chef de produit Oncologie" },
  service: { name: "Marketing", code: "MKT" },
  contrat: { nom: "CT-2024-031.docx", phrase: "CONTRAT DE TRAVAIL À DURÉE INDÉTERMINÉE" },
  docContenu: { nom: "Note interne n°14.txt", indice: "Ouargla", fait: "340 boîtes" },
  docCR: { nom: "CR réunion BU 2026-10-07.txt", fait: "Daclavir", decision: "lancement au 1er trimestre" },
  enveloppe: { nom: `Budget Ad & Pro Hépatologie ${ANNEE}`, total: 12_000_000, alloue: 9_500_000 },
  validationSA: { ref: `VAL-${ANNEE}-311`, titre: "Validation — bon de commande Imprimerie Atlas (860 000 DZD)" },
  validationAD: { ref: `VAL-${ANNEE}-312`, titre: "Validation — réservation salle séminaire Hépatologie (240 000 DZD)" },
  demandesAnnee: 6,
  facture: { nom: "photo-facture.png", fournisseur: "Imprimerie Atlas", numero: "FA-2026-1187", ttc: "595 000" },
  pdf: { nom: "compte-rendu-visite-anpp.pdf", fait: "inspection", date: "22 octobre 2026" },
  produitAbsent: "daclatasvir",
} as const;

interface Manifest { createdAt: string; ids: Record<string, string[]>; fixtures: Record<string, string> }

function garde(): void {
  if (!estUneBaseDeBancOuDEssai(process.env.DATABASE_URL ?? "")) throw new Error("Refus : ce n'est pas une base de banc locale (hôte local + nom contenant « bench »).");
  if (process.env.BENCH_SEED_ALLOW !== "1") throw new Error("Refus : BENCH_SEED_ALLOW=1 est exigé.");
}

export function lireFixtures(): Record<string, string> {
  try { return (JSON.parse(fs.readFileSync(MANIFEST, "utf8")) as Manifest).fixtures; } catch { return {}; }
}

async function nettoyer(): Promise<void> {
  let m: Manifest;
  try { m = JSON.parse(fs.readFileSync(MANIFEST, "utf8")) as Manifest; } catch { return; }
  const del = async (label: string, fn: (ids: string[]) => Promise<unknown>) => {
    const ids = m.ids[label] ?? [];
    if (!ids.length) return;
    try { await fn(ids); } catch (e) { console.warn(`  · ${label} non retiré — ${(e as Error).message.slice(0, 120)}`); }
  };
  await del("validationRequest", (ids) => prisma.validationRequest.deleteMany({ where: { id: { in: ids } } }));
  await del("adProOtherRequest", (ids) => prisma.adProOtherRequest.deleteMany({ where: { id: { in: ids } } }));
  await del("budgetEnvelope", (ids) => prisma.budgetEnvelope.deleteMany({ where: { id: { in: ids } } }));
  await del("leaveRequest", (ids) => prisma.leaveRequest.deleteMany({ where: { id: { in: ids } } }));
  await del("employeeDocument", (ids) => prisma.employeeDocument.deleteMany({ where: { id: { in: ids } } }));
  await del("driveTextIndex", (ids) => prisma.driveTextIndex.deleteMany({ where: { id: { in: ids } } }));
  await del("fileVersion", (ids) => prisma.fileVersion.deleteMany({ where: { id: { in: ids } } }));
  await del("driveNode", (ids) => prisma.driveNode.deleteMany({ where: { id: { in: [...ids].reverse() } } }));
  await del("fileBlob", (ids) => prisma.fileBlob.deleteMany({ where: { id: { in: ids } } }));
  await del("userAccess", (ids) => prisma.userAccess.deleteMany({ where: { id: { in: ids } } }));
  await del("employee", (ids) => prisma.employee.deleteMany({ where: { id: { in: ids } } }));
  // Les fils de l'Assistant IA et le journal des appels des comptes du banc partent avec eux.
  const users = m.ids.user ?? [];
  if (users.length) {
    await prisma.assistantIaTour.deleteMany({ where: { userId: { in: users } } }).catch(() => {});
    await prisma.assistantIaFil.deleteMany({ where: { userId: { in: users } } }).catch(() => {});
  }
  await del("user", (ids) => prisma.user.deleteMany({ where: { id: { in: ids } } }));
  await del("department", (ids) => prisma.department.deleteMany({ where: { id: { in: ids } } }));
  fs.rmSync(MANIFEST, { force: true });
  console.log("Semis Jarvis retiré.");
}

/** Un .docx minimal mais VALIDE (Word l'ouvre, l'ERP en extrait le texte). */
async function docx(paragraphes: string[]): Promise<Buffer> {
  const zip = new JSZip();
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphes.map((p) => `<w:p><w:r><w:t xml:space="preserve">${esc(p)}</w:t></w:r></w:p>`).join("")}</w:body></w:document>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

async function pdf(lignes: string[]): Promise<Buffer> {
  const PDFDocument = (await import("pdfkit")).default;
  const doc = new PDFDocument({ size: "A4", margin: 56 });
  const morceaux: Buffer[] = [];
  doc.on("data", (c: Buffer) => morceaux.push(c));
  const fini = new Promise<void>((r) => doc.on("end", () => r()));
  doc.fontSize(15).text(lignes[0]!, { underline: true }).moveDown();
  doc.fontSize(11);
  for (const l of lignes.slice(1)) doc.text(l).moveDown(0.6);
  doc.end();
  await fini;
  return Buffer.concat(morceaux);
}

/** La « photo » d'une facture : une image (PNG) sans texte natif — seul l'OCR ou la vision la lit. */
async function photoFacture(): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  const F = JARVIS.facture;
  const lignes = [
    [40, 70, 30, "bold", F.fournisseur.toUpperCase()],
    [40, 105, 16, "normal", "12, rue Didouche Mourad — Alger · RC 16/00-0998877 B 21"],
    [40, 170, 26, "bold", `FACTURE N° ${F.numero}`],
    [40, 205, 16, "normal", "Date : 19/10/2026 — Client : Adventum Pharma (Direction Marketing)"],
    [40, 270, 17, "normal", "Désignation                                  Qté     P.U. HT        Total HT"],
    [40, 305, 17, "normal", "Brochures Hépatologie A4 quadri               2 000    150,00      300 000,00"],
    [40, 340, 17, "normal", "Kakémonos 85x200 séminaire                       10  20 000,00      200 000,00"],
    [40, 410, 18, "normal", "Total HT : 500 000,00 DZD      TVA 19 % : 95 000,00 DZD"],
    [40, 450, 24, "bold", `NET À PAYER TTC : ${F.ttc},00 DZD`],
    [40, 510, 15, "normal", "Règlement par virement à 30 jours fin de mois."],
  ] as const;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="580"><rect width="100%" height="100%" fill="#fbfaf6"/>${lignes.map(([x, y, s, w, t]) => `<text x="${x}" y="${y}" font-family="DejaVu Sans" font-size="${s}" font-weight="${w}" fill="#1b1b1b" xml:space="preserve">${t.replace(/&/g, "&amp;")}</text>`).join("")}</svg>`;
  // Une légère rotation : une photo, pas un export.
  return sharp(Buffer.from(svg)).rotate(1.5, { background: "#d8d4c8" }).png().toBuffer();
}

async function semer(): Promise<void> {
  const ids: Record<string, string[]> = {};
  const fixtures: Record<string, string> = {};
  const flush = () => {
    fs.mkdirSync(path.dirname(MANIFEST), { recursive: true });
    fs.writeFileSync(MANIFEST, JSON.stringify({ createdAt: new Date().toISOString(), ids, fixtures } satisfies Manifest, null, 2));
  };
  const note = (label: string, id: string) => { (ids[label] ??= []).push(id); flush(); return id; };
  const hash = bcrypt.hashSync(MOT_DE_PASSE, 10);

  const adventum = await prisma.company.findUnique({ where: { name: "Adventum Pharma" }, select: { id: true } });
  const sa = await prisma.user.findUnique({ where: { email: JARVIS.superAdmin.email }, select: { id: true } });
  const pdgEmp = await prisma.employee.findFirst({ where: { email: `yacine.benali@${DOMAINE}` }, select: { id: true } });
  const dDG = await prisma.department.findUnique({ where: { code: "DG" }, select: { id: true } });
  if (!adventum || !sa || !pdgEmp || !dDG) throw new Error("Le jeu du banc Adam manque : lancer d'abord `BENCH_SEED_ALLOW=1 npm run adam:bench:seed`.");
  fixtures.superAdmin = sa.id;

  // ── Service Marketing et ses personnes ───────────────────────────────────────────────
  const existant = await prisma.department.findUnique({ where: { code: JARVIS.service.code }, select: { id: true } });
  const dMKT = existant?.id ?? note("department", (await prisma.department.create({ data: { name: JARVIS.service.name, code: JARVIS.service.code, companyId: adventum.id } })).id);

  const personne = async (p: { name: string; email: string; poste: string }, role: "PRODUCT_MANAGER" | "DIRECTION_ASSISTANT" | "MEDICAL_PROMOTION_MANAGER", deptId: string, salaire: number, net: number, embauche: string, managerId: string | null) => {
    const u = await prisma.user.create({ data: { name: p.name, email: p.email, passwordHash: hash, role, title: p.poste, departmentId: deptId, isActive: true } });
    note("user", u.id);
    const e = await prisma.employee.create({
      data: {
        // Le LIBELLÉ du département aussi : en production `org/source-unique.ts` l'écrit à chaque rattachement,
        // et `directory_list` filtre sur lui (pas sur `departmentId`).
        fullName: p.name, email: p.email, position: p.poste, departmentId: deptId, department: deptId === dMKT ? JARVIS.service.name : "Direction Générale", companyId: adventum.id, userId: u.id,
        baseSalary: salaire, netToPay: net, grossSalary: Math.round(salaire * 1.18), employerCost: Math.round(salaire * 1.45),
        hireDate: new Date(`${embauche}T00:00:00Z`), contractType: "CDI", isActive: true, managerId,
      },
    });
    note("employee", e.id);
    return { userId: u.id, employeeId: e.id };
  };
  const karim = await personne(JARVIS.karim, "MEDICAL_PROMOTION_MANAGER", dMKT, 260_000, 196_000, "2022-01-09", pdgEmp.id);
  await prisma.department.update({ where: { id: dMKT }, data: { headId: karim.employeeId } });
  const A = JARVIS.assia;
  const assia = await personne(A, "PRODUCT_MANAGER", dMKT, A.salaireBase, A.netAPayer, A.embauche, karim.employeeId);
  await personne(JARVIS.walid, "PRODUCT_MANAGER", dMKT, 158_000, 123_000, "2023-06-11", karim.employeeId);
  const lina = await personne(JARVIS.assistante, "DIRECTION_ASSISTANT", dDG.id, 110_000, 86_000, "2021-09-01", pdgEmp.id);
  fixtures.assistante = lina.userId;
  fixtures.assia = assia.userId;
  // L'Assistant IA est FERMÉ par défaut : le Super Admin l'ouvre dans Administration › Accès.
  note("userAccess", (await prisma.userAccess.create({ data: { userId: lina.userId, module: "ASSISTANT_IA", canView: true, canCreate: true } })).id);

  // ── Congés d'Assia ───────────────────────────────────────────────────────────────────
  const C = A.conges;
  note("leaveRequest", (await prisma.leaveRequest.create({ data: { employeeId: assia.employeeId, type: "ANNUAL", startDate: new Date(`${C.pris.du}T00:00:00Z`), endDate: new Date(`${C.pris.au}T00:00:00Z`), days: C.pris.jours, status: "APPROVED", stage: "DONE", reason: "Congé annuel d'été", createdById: assia.userId } })).id);
  note("leaveRequest", (await prisma.leaveRequest.create({ data: { employeeId: assia.employeeId, type: "ANNUAL", startDate: new Date(`${C.demande.du}T00:00:00Z`), endDate: new Date(`${C.demande.au}T00:00:00Z`), days: C.demande.jours, status: "PENDING", stage: "MANAGER", managerId: karim.userId, reason: "Fêtes de fin d'année", createdById: assia.userId } })).id);

  // ── Drive ────────────────────────────────────────────────────────────────────────────
  const { putBlob } = await import("@/lib/drive-storage");
  const { indexDriveNodeText } = await import("@/lib/assistant/document-discovery");
  const dossier = async (name: string, ownerId: string, parentId: string | null) =>
    note("driveNode", (await prisma.driveNode.create({ data: { name, type: "FOLDER", ownerId, parentId, createdById: ownerId }, select: { id: true } })).id);
  const fichier = async (name: string, ownerId: string, parentId: string | null, mimeType: string, octets: Buffer, texte: string | null) => {
    const blob = await putBlob(octets);
    note("fileBlob", blob.blobId);
    const n = await prisma.driveNode.create({ data: { name, type: "FILE", ownerId, parentId, mimeType, size: octets.length, createdById: ownerId }, select: { id: true } });
    note("driveNode", n.id);
    const v = await prisma.fileVersion.create({ data: { nodeId: n.id, blobId: blob.blobId, version: 1, size: octets.length, mimeType, createdById: ownerId }, select: { id: true } });
    note("fileVersion", v.id);
    if (texte) {
      await indexDriveNodeText(n.id, v.id, texte, null, name);
      const idx = await prisma.driveTextIndex.findUnique({ where: { nodeId: n.id }, select: { id: true } });
      if (idx) note("driveTextIndex", idx.id);
    }
    return { id: n.id, blobId: blob.blobId, size: octets.length };
  };

  const rh = await dossier("RH", sa.id, null);
  const contrats = await dossier("Contrats de travail", sa.id, rh);
  const paras = [
    JARVIS.contrat.phrase,
    "Entre Adventum Pharma SPA, représentée par son Président-Directeur Général, et Mme Assia Benmoussa.",
    `Article 1 — Fonction : Mme Assia Benmoussa est engagée en qualité de ${A.poste}, au sein de la Direction Marketing, sous l'autorité de M. ${A.manager}.`,
    `Article 2 — Prise d'effet : le présent contrat prend effet le 4 mars 2024. Période d'essai de six mois.`,
    `Article 3 — Rémunération : salaire de base mensuel brut de ${A.salaireBase.toLocaleString("fr-FR")} DZD.`,
    "Article 4 — Durée du travail : 40 heures hebdomadaires. Congé annuel : 30 jours calendaires.",
    "Fait à Alger, le 1er mars 2024, en deux exemplaires originaux.",
  ];
  const ct = await fichier(JARVIS.contrat.nom, sa.id, contrats, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", await docx(paras), paras.join("\n"));
  fixtures.contrat = ct.id;
  // Le même contrat, rangé dans le dossier RH de la salariée (écran RH › documents).
  note("employeeDocument", (await prisma.employeeDocument.create({ data: { employeeId: assia.employeeId, category: "CONTRACT", name: "Contrat de travail CDI — Assia Benmoussa.docx", blobId: ct.blobId, mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: ct.size, uploadedById: sa.id } })).id);

  const notes = await dossier("Notes internes", sa.id, null);
  const texteNote = [
    "NOTE INTERNE N°14 — Direction Supply Chain — diffusion restreinte",
    "Objet : incident de température au dépôt régional du Sud.",
    "Le 12 octobre 2026, une panne du groupe froid a provoqué une rupture de la chaîne du froid au dépôt de Ouargla pendant environ 9 heures.",
    `${JARVIS.docContenu.fait} de Daclavir 60 mg (lot DCV-2609) ont été mises en quarantaine dans l'attente de l'avis du pharmacien responsable.`,
    "Actions : enregistreur de température remplacé, audit du transporteur Sahara Log prévu le 4 novembre.",
  ].join("\n");
  fixtures.docContenu = (await fichier(JARVIS.docContenu.nom, sa.id, notes, "text/plain", Buffer.from(texteNote, "utf8"), texteNote)).id;
  const texteCR = [
    "COMPTE RENDU — Réunion de la Business Unit Hépatologie — 7 octobre 2026",
    `Présents : ${JARVIS.karim.name} (Directeur Marketing), ${A.name} (Cheffe de produit), ${JARVIS.walid.name}.`,
    `1. ${JARVIS.docCR.fait} (daclatasvir 60 mg) : le dossier d'enregistrement n'est pas encore ouvert ; décision : ${JARVIS.docCR.decision} 2027 sous réserve de l'AMM.`,
    "2. Séminaire Hépatologie du 15 octobre à Oran : 45 médecins attendus, budget salle 240 000 DZD.",
    "3. Matériel promotionnel : 2 000 brochures commandées à l'Imprimerie Atlas.",
    "Prochaine réunion : 4 novembre 2026.",
  ].join("\n");
  fixtures.docCR = (await fichier(JARVIS.docCR.nom, sa.id, notes, "text/plain", Buffer.from(texteCR, "utf8"), texteCR)).id;

  // Les PIÈCES JOINTES, déjà dans le Drive de l'acteur (comme après un glisser-déposer).
  fixtures.facture = (await fichier(JARVIS.facture.nom, sa.id, null, "image/png", await photoFacture(), null)).id;
  fixtures.pdf = (await fichier(JARVIS.pdf.nom, sa.id, null, "application/pdf", await pdf([
    "Compte rendu — visite d'inspection ANPP",
    `Date de la visite : ${JARVIS.pdf.date}. Site : entrepôt Adventum Pharma de Rouiba.`,
    "Inspecteurs : deux pharmaciens inspecteurs de l'ANPP.",
    "Constats : 1) registre des températures de la chambre froide incomplet sur septembre ; 2) procédure de rappel de lot à mettre à jour (version 2019).",
    "Aucun écart critique. Délai accordé pour le plan d'actions correctives : 30 jours.",
    "Conclusion : l'inspection est favorable sous réserve du plan d'actions.",
  ]), null)).id;

  // ── Budget, validations, demandes de l'année ─────────────────────────────────────────
  const E = JARVIS.enveloppe;
  note("budgetEnvelope", (await prisma.budgetEnvelope.create({
    data: {
      companyId: adventum.id, name: E.nom, modules: ["SPONSORING", "CONGRESS_NATIONAL", "EVENTS", "PROMO_MATERIAL"], domaine: "MARKETING",
      periodStart: new Date(`${ANNEE}-01-01T00:00:00Z`), periodEnd: new Date(`${ANNEE}-12-31T23:59:59Z`), totalAmount: E.total, createdById: sa.id,
      accessUserIds: [lina.userId],
      categories: { create: [{ name: "Séminaires", allocated: 6_000_000 }, { name: "Matériel promotionnel", allocated: 3_500_000 }] },
    } as never,
  })).id);

  const validation = async (ref: string, titre: string, validatorId: string, montant: number) => note("validationRequest", (await prisma.validationRequest.create({
    data: {
      reference: ref, module: "Finances", title: titre, requesterId: assia.userId, entityType: "ADMIN_REQUEST", entityId: ref,
      createdAt: new Date(Date.now() - 3 * 86_400_000), currentOrder: 1, amount: montant,
      steps: { create: [{ order: 1, validatorId, status: "PENDING" }] },
    } as never, select: { id: true },
  })).id);
  await validation(JARVIS.validationSA.ref, JARVIS.validationSA.titre, sa.id, 860_000);
  await validation(JARVIS.validationAD.ref, JARVIS.validationAD.titre, lina.userId, 240_000);

  const demandes: [string, string, number, "AWAITING_DECISION" | "APPROVED" | "REFUSED" | "DONE", number][] = [
    ["Kits stylos séminaire Hépatologie", "Achat de 300 kits pour le séminaire d'Oran", 180_000, "DONE", 2],
    ["Abonnement base bibliographique", "Accès annuel PubMed premium pour la BU", 420_000, "APPROVED", 4],
    ["Traduction notice Daclavir", "Traduction arabe de la notice patient", 95_000, "DONE", 5],
    ["Location stand journée SAHGE", "Stand 9 m² — Société algérienne d'hépato-gastro-entérologie", 650_000, "AWAITING_DECISION", 8],
    ["Goodies congrès national", "Clés USB et carnets logotés", 310_000, "REFUSED", 6],
    ["Atelier formation délégués", "Formation produit Hépatologie, 20 délégués", 540_000, "AWAITING_DECISION", 9],
  ];
  for (const [i, [title, description, amount, status, mois]] of demandes.entries()) {
    note("adProOtherRequest", (await prisma.adProOtherRequest.create({
      data: { reference: `AUT-${ANNEE}-J${String(i + 1).padStart(2, "0")}`, title, description, amount, status, companyId: adventum.id, requesterId: assia.userId, createdById: assia.userId, createdAt: new Date(Date.UTC(ANNEE, mois - 1, 10)) },
    })).id);
  }

  // Le banc enchaîne une vingtaine de tours d'un même compte : le plafond quotidien par défaut (600 000 jetons)
  // tomberait au milieu. Relevé ICI, dans la base du banc, comme l'écran Consommation le permet — et dit.
  await prisma.assistantIaReglage.upsert({ where: { id: "global" }, update: { plafondJetonsJour: 5_000_000 }, create: { id: "global", plafondJetonsJour: 5_000_000 } as never });
  flush();
  // J4 : la BIBLIOTHÈQUE lit les fichiers du banc (inscription + lecture), comme le rattrapage et la file de fond le
  // font en production — sans quoi `chercher_documents` n'aurait rien à retrouver.
  const { rattraper, traiterFile } = await import("@/modules/bibliotheque/api");
  await rattraper({ lot: 500 });
  let lues = 0;
  for (let i = 0; i < 20; i++) {
    const b = await traiterFile({ max: 50 });
    lues += b.faites;
    if (b.prises === 0) break;
  }
  console.log(`Bibliothèque : ${lues} pièce(s) lue(s).`);

  console.log(`Semis Jarvis : ${Object.values(ids).reduce((s, x) => s + x.length, 0)} lignes · fixtures ${Object.keys(fixtures).join(", ")} · plafond jour relevé à 5 000 000 jetons (base de banc).`);
}

async function main() {
  garde();
  await nettoyer();
  if (!process.argv.includes("--clean")) await semer();
}

const lanceDirectement = (process.argv[1] ?? "").replace(/\\/g, "/").endsWith("scripts/bench/seed-assistant-jarvis.ts");
if (lanceDirectement) {
  main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
}
