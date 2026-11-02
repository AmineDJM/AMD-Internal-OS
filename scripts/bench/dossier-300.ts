/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * BANC DU DÉPÔT DE DOSSIER (J11, décision 0030) — un dossier de 300 fichiers (PDF texte, Word, images, scans)
 * déposé dans l'Assistant IA, puis LU par la Bibliothèque (texte, OCR local, passages, vecteurs).
 *
 * Sur une base LOCALE (`amd_bench`, jamais une base distante), par les VRAIES portes :
 *   1. le lot s'ouvre comme à l'écran (`ouvrirLotDossier` + `creerArborescenceDrive`) : racine nommée, sous-dossiers ;
 *   2. chaque fichier entre par le dépôt du Drive (`putBlob` + `enregistrerFichierDrive` → `inscrireFichierDrive`) ;
 *   3. la file se vide comme sur le worker : des PASSAGES de la tâche `bibliotheque.ingestion` (`traiterFile` avec
 *      le budget et le parallélisme de `scheduled.ts`), l'embedder FAUX (déterministe, aucun réseau, aucun coût) ;
 *   4. l'assistant répond sur le dossier (`lire_dossier_depose` : classement CTD, pièces manquantes) — sans relire.
 *
 * La PROJECTION sur le worker : un passage part à chaque battement (60 s) ; le temps mesuré ici est celui du calcul.
 *
 *   npm run bench:dossier                        (300 fichiers, 2 lecteurs, budget 45 s)
 *   npm run bench:dossier -- --parallele=3 --n=300
 *   npm run bench:dossier -- --nettoyer          retire le corpus semé
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
import PDFDocument from "pdfkit";
import JSZip from "jszip";
import sharp from "sharp";
import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import { putBlob } from "@/lib/drive-storage";
import { enregistrerFichierDrive } from "@/lib/drive/depot";
import { creerArborescenceDrive } from "@/lib/drive/arborescence";
import { embedderDeterministe, traiterFile } from "@/modules/bibliotheque/api";
import { etatDesLots, lectureDossierDepose, ouvrirLotDossier } from "@/modules/assistant-ia/api";

const TAG = "__banc_dossier300__";
const arg = (nom: string, defaut: number) => Number(process.argv.find((a) => a.startsWith(`--${nom}=`))?.split("=")[1] ?? defaut);
const N = arg("n", 300);
const PARALLELE = arg("parallele", 2);
const BUDGET_MS = arg("budget", 45) * 1000;
const BATTEMENT_S = 60;

// ── Le contenu : un dossier d'enregistrement, section par section ─────────────────────────────
const SECTIONS: [string, string, string][] = [
  ["Module 1", "Lettre de demande", "Lettre de demande d'enregistrement adressée à l'Agence nationale des produits pharmaceutiques."],
  ["Module 1", "RCP", "Résumé des caractéristiques du produit : indications, posologie, contre-indications, mises en garde."],
  ["Module 1", "Notice", "Notice patient : lisez attentivement cette notice avant de prendre ce médicament."],
  ["Module 1/Certificats", "Certificat GMP", "Certificate of GMP compliance — bonnes pratiques de fabrication du site."],
  ["Module 2", "QOS", "Quality overall summary — résumé global de la qualité du produit fini et de la substance active."],
  ["Module 3/3.2.S", "3.2.S.4 Specification", "Specification of the drug substance, analytical procedures and batch analyses."],
  ["Module 3/3.2.S", "3.2.S.7 Stability", "Stability of the drug substance, retest period and storage conditions."],
  ["Module 3/3.2.P", "3.2.P.3 Manufacture", "Batch formula, description of the manufacturing process and process validation."],
  ["Module 3/3.2.P", "3.2.P.5 Control", "Specifications of the finished product, analytical procedures, validation and batch analyses."],
  ["Module 3/3.2.P", "3.2.P.8 Stability", "Stability study of the finished product, zone IVb, 30°C/75% RH, shelf life 24 months."],
  ["Module 5", "Bioequivalence study", "Bioequivalence study report: Cmax, AUC, 90% confidence intervals within 80-125%."],
];

const phrase = (i: number, s: string) => `${s} Paragraphe ${i + 1} : les résultats sont conformes aux spécifications et aux exigences de l'ANPP. `;

function pdfTexte(titre: string, corps: string, pages: number): Promise<Buffer> {
  return new Promise((ok) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const morceaux: Buffer[] = [];
    doc.on("data", (b: Buffer) => morceaux.push(b));
    doc.on("end", () => ok(Buffer.concat(morceaux)));
    for (let p = 0; p < pages; p++) {
      if (p) doc.addPage();
      doc.fontSize(16).text(titre).moveDown();
      doc.fontSize(11).text(Array.from({ length: 12 }, (_, i) => phrase(i + p * 12, corps)).join("\n\n"));
    }
    doc.end();
  });
}

async function docx(titre: string, corps: string): Promise<Buffer> {
  const z = new JSZip();
  const para = (t: string) => `<w:p><w:r><w:t xml:space="preserve">${t.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</w:t></w:r></w:p>`;
  z.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  z.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  z.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${para(titre)}${Array.from({ length: 30 }, (_, i) => para(phrase(i, corps))).join("")}</w:body></w:document>`);
  return z.generateAsync({ type: "nodebuffer" });
}

/** Une image de texte (une page photographiée) : ce que l'OCR local doit lire. */
function image(titre: string, corps: string): Promise<Buffer> {
  const lignes = [titre, ...corps.match(/.{1,60}(\s|$)/g)!.slice(0, 6), "Lot 2214 — conforme"];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1240" height="700"><rect width="100%" height="100%" fill="white"/>${lignes.map((l, i) => `<text x="60" y="${90 + i * 80}" font-family="DejaVu Sans, Arial" font-size="40" fill="black">${l.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</text>`).join("")}</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** Un SCAN : un PDF sans couche texte, une image par page. */
async function scan(titre: string, corps: string): Promise<Buffer> {
  const png = await image(titre, corps);
  return new Promise((ok) => {
    const doc = new PDFDocument({ size: "A4", margin: 20 });
    const morceaux: Buffer[] = [];
    doc.on("data", (b: Buffer) => morceaux.push(b));
    doc.on("end", () => ok(Buffer.concat(morceaux)));
    doc.image(png, 20, 20, { width: 555 });
    doc.end();
  });
}

interface Fichier { chemin: string; octets: Buffer; mime: string; genre: "pdf" | "word" | "image" | "scan" }

async function corpus(): Promise<Fichier[]> {
  const out: Fichier[] = [];
  for (let i = 0; i < N; i++) {
    const [dossier, titre, corps] = SECTIONS[i % SECTIONS.length]!;
    const r = i % 10; // 4 PDF, 3 Word, 2 images, 1 scan sur 10
    const base = `Dossier Amlodipine ${TAG}/${dossier}/${titre} ${String(i).padStart(3, "0")}`;
    // Chaque fichier est UNIQUE (un vrai dossier ne se déduplique pas) : la pièce n° i porte son numéro et son lot.
    const titreUnique = `${titre} — pièce ${i + 1}, lot ${2200 + i}`;
    if (r < 4) out.push({ chemin: `${base}.pdf`, octets: await pdfTexte(titreUnique, corps, 1 + (i % 4)), mime: "application/pdf", genre: "pdf" });
    else if (r < 7) out.push({ chemin: `${base}.docx`, octets: await docx(titreUnique, corps), mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", genre: "word" });
    else if (r < 9) out.push({ chemin: `${base}.png`, octets: await image(titreUnique, corps), mime: "image/png", genre: "image" });
    else out.push({ chemin: `${base} scan.pdf`, octets: await scan(titreUnique, corps), mime: "application/pdf", genre: "scan" });
  }
  return out;
}

async function nettoyer() {
  const lots = await prisma.assistantIaDepotDossier.findMany({ where: { nom: { contains: TAG } }, select: { id: true, racineId: true } });
  for (const l of lots) await prisma.driveNode.deleteMany({ where: { id: l.racineId } });
  await prisma.assistantIaDepotDossier.deleteMany({ where: { nom: { contains: TAG } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } });
}

async function main() {
  if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL ?? "")) throw new Error("Base LOCALE exigée.");
  await nettoyer();
  if (process.argv.includes("--nettoyer")) { console.log("Corpus retiré."); return; }

  const u = await prisma.user.create({ data: { name: `Banc ${TAG}`, email: `${TAG}@t.dz`, passwordHash: "x", role: "SUPER_ADMIN" } });
  const access = await getAccess(u.id, u.role);
  const user = { id: u.id, name: u.name, email: u.email, role: "SUPER_ADMIN", secondaryRole: null, access, mustChangePassword: false } as unknown as CurrentUser;

  let t = Date.now();
  const fichiers = await corpus();
  const octets = fichiers.reduce((n, f) => n + f.octets.length, 0);
  console.log(`Corpus : ${fichiers.length} fichiers (${(octets / 1048576).toFixed(1)} Mo) généré en ${((Date.now() - t) / 1000).toFixed(1)} s`);

  // 1. Le lot, comme à l'écran.
  t = Date.now();
  const lot = await ouvrirLotDossier(user, { fichiers: fichiers.map((f) => ({ chemin: f.chemin, taille: f.octets.length })), mode: "DOSSIER" }, {
    creerArborescence: ({ ownerId, parentId, paths }) => creerArborescenceDrive({ ownerId, parentId, spaceId: null, paths }),
  });
  if (!lot.ok) throw new Error(lot.error);
  // 2. Chaque fichier par le dépôt du Drive (inscription à la Bibliothèque comprise).
  for (const f of fichiers) {
    const relatif = f.chemin.split("/").slice(1).join("/");
    const dir = relatif.includes("/") ? relatif.slice(0, relatif.lastIndexOf("/")) : "";
    const ecrit = await putBlob(f.octets);
    await enregistrerFichierDrive(user, { parentId: dir ? lot.map[dir] : lot.racineId }, { blobId: ecrit.blobId, size: ecrit.size, mimeType: f.mime, name: relatif.split("/").pop()!, sha256: ecrit.sha256 });
  }
  const depotS = (Date.now() - t) / 1000;
  console.log(`Dépôt (racine « ${lot.nom} », ${Object.keys(lot.map).length} sous-dossiers, ${fichiers.length} pièces inscrites) : ${depotS.toFixed(1)} s`);

  // 3. La file, passage après passage, comme le worker.
  const embed = embedderDeterministe();
  const passages: { ms: number; faites: number; ignorees: number; echecs: number }[] = [];
  t = Date.now();
  for (let i = 0; i < 200; i++) {
    const t0 = Date.now();
    const b = await traiterFile({ max: 10, budgetMs: BUDGET_MS, parallele: PARALLELE, deps: { embed } });
    passages.push({ ms: Date.now() - t0, faites: b.faites, ignorees: b.ignorees, echecs: b.echecs });
    const [e] = await etatDesLots(user, { lotId: lot.lotId, max: 1 });
    console.log(`  passage ${i + 1} : ${(passages.at(-1)!.ms / 1000).toFixed(1)} s — ${e ? `${e.lus} lus, ${e.echoues} échoués, ${e.enFile} en file` : ""}`);
    if (!b.prises || (e && e.enFile === 0)) break;
  }
  const calculS = (Date.now() - t) / 1000;
  const [etat] = await etatDesLots(user, { lotId: lot.lotId, max: 1 });
  const fiches = await prisma.bibliothequeFiche.findMany({
    where: { cles: { hasSome: (await prisma.driveNode.findMany({ where: { ownerId: user.id, type: "FILE" }, select: { id: true } })).map((n) => `DRIVE_NODE:${n.id}`) } },
    select: { methode: true, nbPassages: true, statut: true, format: true },
  });
  const parMethode = fiches.reduce<Record<string, number>>((m, f) => ({ ...m, [`${f.format}/${f.methode ?? f.statut}`]: (m[`${f.format}/${f.methode ?? f.statut}`] ?? 0) + 1 }), {});
  const vecteurs = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM "BibliothequePassage" p JOIN "BibliothequeFiche" f ON f."pieceId" = p."pieceId" WHERE f."auteurId" = ${user.id}`.catch(() => [{ n: 0n }]);
  const projectionS = (passages.length - 1) * BATTEMENT_S + passages.at(-1)!.ms / 1000;

  // 4. L'assistant répond sur le dossier, sans relire.
  t = Date.now();
  const outil = lectureDossierDepose(user);
  const ctd = JSON.parse(await outil.run({ analyse: "ctd" }, user)) as { parModule: Record<string, number>; manquantes: { code: string }[]; nonClassees: string[] };
  const lectureMs = Date.now() - t;

  console.log("\n══ RÉSULTAT ══");
  console.log(JSON.stringify({
    fichiers: fichiers.length, octetsMo: Math.round(octets / 1048576),
    depotS: Math.round(depotS), calculS: Math.round(calculS), passages: passages.length, parallele: PARALLELE, budgetS: BUDGET_MS / 1000,
    projectionWorkerS: Math.round(projectionS), projectionWorkerMin: Math.round(projectionS / 6) / 10, cible: "≤ 15 min",
    etat: etat && { lus: etat.lus, ignores: etat.ignores, echoues: etat.echoues, enFile: etat.enFile },
    parMethode, passagesTexte: Number(vecteurs[0]?.n ?? 0),
    assistant: { lectureMs, parModule: ctd.parModule, manquantes: ctd.manquantes.map((m) => m.code), nonClassees: ctd.nonClassees.length },
  }, null, 2));
  if (!process.argv.includes("--garder")) await nettoyer();
}

main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
