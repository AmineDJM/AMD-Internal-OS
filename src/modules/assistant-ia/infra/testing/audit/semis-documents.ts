/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LOT T1 — LE SEMIS DU DOMAINE « DOCUMENTS, JURIDIQUE ET DRIVE » (préfixe de banc DOC-, décision 0053).
 *
 * Ajouté au semis des personas (`semerAudit`) : de VRAIES pièces (PDF, Word, image) dans le Drive des personas, l'annuaire
 * des partenaires (les parties), des dossiers de classement, et un registre juridique déjà vivant — deux contrats
 * successifs d'un même fournisseur (« le dernier »), une attestation qui expire dans 20 jours, une police expirée non
 * classée, un bail, et un protocole RESTREINT au Super Admin (la juriste ne doit même pas en apprendre le titre).
 *
 * Synthétique, étiqueté (les contacts et dossiers portent `audit-doc<étiquette>` en note), retirable (`retirerDocuments`).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
import { prisma } from "@/lib/prisma";
import { attendu } from "@/lib/journal";
import type { Titulaire } from "./personas";
import { deposerPiece, docx as docxDe, dossierDrive } from "./taches/aides";
import type { PieceSemee, SemisDeDomaine } from "./taches/types";

export const DOSSIER_A_CLASSER = "À classer — novembre";
export const DOSSIER_ARCHIVES = "Archives juridiques 2025";
export const TITRE_RESTREINT = "Protocole d'accord QZ-PROTO-7731 — transaction Hamidi";
export const MOT_PLEIN_TEXTE = "non-concurrence d'une durée de vingt-quatre mois";

/** Les parties, à l'annuaire des partenaires. */
export const PARTIES = [
  ["Pharmalliance Distribution", "PRIVE", "Distributeur"], ["ANPP", "PUBLIC", "Agence nationale des produits pharmaceutiques"], ["MediSupply", "PRIVE", "Fournisseur"],
  ["SAA Assurances", "PRIVE", "Assureur"], ["SCI El Djazair", "PRIVE", "Bailleur"], ["CNAS", "PUBLIC", "Sécurité sociale"], ["Frigomed", "PRIVE", "Maintenance froid"],
  ["BioSimilaire Lab", "PRIVE", "Laboratoire"], ["Université Alger 1", "PUBLIC", "Université"], ["Ministère de l'Industrie pharmaceutique", "PUBLIC", "Ministère"],
  ["Logitrans", "PRIVE", "Transporteur"], ["Imprimerie Atlas", "PRIVE", "Imprimeur"],
] as const;

/** Un PDF de plusieurs PAGES (« --- » sépare les pages). */
export async function pdfPages(pages: string[][]): Promise<Buffer> {
  const PDFDocument = (await import("pdfkit")).default;
  const doc = new PDFDocument({ size: "A4", margin: 56, autoFirstPage: false });
  const morceaux: Buffer[] = [];
  doc.on("data", (c: Buffer) => morceaux.push(c));
  const fini = new Promise<void>((r) => doc.on("end", () => r()));
  for (const lignes of pages) {
    doc.addPage();
    doc.fontSize(14).text(lignes[0]!, { underline: true }).moveDown();
    doc.fontSize(10.5);
    for (const l of lignes.slice(1)) doc.text(l).moveDown(0.5);
  }
  doc.end();
  await fini;
  return Buffer.concat(morceaux);
}

const contrat = (titre: string, partie: string, debut: string, fin: string, extra: string[] = []) => pdfPages([[
  titre.toUpperCase(), `Entre Adventum Pharma SPA, Alger, et ${partie}.`, `Le présent contrat est conclu du ${debut} au ${fin}.`, ...extra,
  "Fait à Alger, en deux exemplaires originaux.",
]]);

/** Les fichiers du domaine, par persona : [nom, octets, sous-dossier]. */
async function fichiersDe(): Promise<Partial<Record<Titulaire, [string, Buffer, string | null][]>>> {
  const pharmalliance = await contrat("Contrat de distribution exclusive", "Pharmalliance Distribution, Oran", "01/01/2026", "31/12/2027", ["Montant annuel minimal : 12 000 000 DZD."]);
  const archives: [string, Buffer, string | null][] = [];
  const natures = ["Contrat de prestation", "Convention de partenariat", "Accord de confidentialité", "Attestation d'assurance", "Contrat de maintenance"];
  for (let i = 1; i <= 14; i++) {
    const n = natures[i % natures.length]!;
    archives.push([`Archive ${String(i).padStart(2, "0")} — ${n}.pdf`, await contrat(n, i % 2 ? "Logitrans" : "Frigomed", "01/01/2025", "31/12/2025"), DOSSIER_ARCHIVES]);
  }
  return {
    juriste: [
      ["Contrat de distribution Pharmalliance 2026.pdf", pharmalliance, null],
      ["Contrat Pharmalliance 2026 (copie).pdf", pharmalliance, null],
      ["Décision AMM Daclavir 60 mg.pdf", await pdfPages([["DÉCISION D'ENREGISTREMENT — AUTORISATION DE MISE SUR LE MARCHÉ", "ANPP — Agence nationale des produits pharmaceutiques.", "Produit : Daclavir 60 mg, comprimés pelliculés. Titulaire : Adventum Pharma SPA.", "Décision délivrée le 15/03/2025. La présente autorisation est valable jusqu'au 14/03/2030."]]), null],
      ["AMM Sofosbuvir 400 mg.pdf", await pdfPages([["AUTORISATION DE MISE SUR LE MARCHÉ — SOFOSBUVIR 400 MG", "ANPP.", "Délivrée le 02/06/2024. Valable jusqu'au 01/06/2029."]]), null],
      ["Statuts Adventum Pharma SPA 2024.pdf", await pdfPages([["STATUTS DE LA SOCIÉTÉ ADVENTUM PHARMA SPA", "Société par actions au capital de 500 000 000 DZD.", "Statuts mis à jour par l'assemblée générale extraordinaire du 12/05/2024."]]), null],
      ["Bail entrepôt Rouiba.pdf", await contrat("Contrat de bail commercial — entrepôt de Rouiba", "SCI El Djazair, bailleur", "01/09/2025", "31/08/2028", ["Loyer mensuel : 450 000 DZD."]), null],
      ["Avenant n°1 contrat Pharmalliance.docx", await docxDe(["AVENANT N°1 AU CONTRAT DE DISTRIBUTION", "Entre Adventum Pharma SPA et Pharmalliance Distribution.", "Le présent avenant prend effet le 01/03/2026 : la zone est étendue aux wilayas du Sud."]), null],
      ["Convention de stage Université Alger 1.pdf", await contrat("Convention de stage", "Université Alger 1", "01/02/2026", "30/06/2026"), DOSSIER_A_CLASSER],
      ["NDA BioSimilaire Lab.pdf", await contrat("Accord de confidentialité (NDA)", "BioSimilaire Lab", "10/10/2026", "09/10/2029"), DOSSIER_A_CLASSER],
      ["Attestation CASNOS 2026.pdf", await pdfPages([["ATTESTATION DE MISE À JOUR", "CNAS — Caisse nationale des assurances sociales.", "Délivrée le 05/01/2026, valable jusqu'au 31/12/2026."]]), DOSSIER_A_CLASSER],
      ["Licence d'importation 2026.pdf", await pdfPages([["LICENCE D'IMPORTATION DE PRODUITS PHARMACEUTIQUES", "Ministère de l'Industrie pharmaceutique.", "Délivrée le 15/01/2026, valable jusqu'au 14/01/2027."]]), DOSSIER_A_CLASSER],
      ["Contrat de maintenance froid Frigomed.pdf", await contrat("Contrat de maintenance des chambres froides", "Frigomed", "01/04/2026", "31/03/2027"), DOSSIER_A_CLASSER],
      ...archives,
      ["Contrat de prestation Atlas.docx", await docxDe(["CONTRAT DE PRESTATION D'IMPRESSION", "Entre Adventum Pharma SPA et Imprimerie Atlas.", "Article 4 — Paiement : les factures sont réglées à 30 jours fin de mois.", "Article 5 — Durée : un an à compter de la signature."]), null],
      ["Contrat de transport Logitrans.docx", await docxDe(["CONTRAT DE TRANSPORT", "Entre Adventum Pharma SPA et Logitrans.", "Le transporteur assure la livraison sous température dirigée."]), null],
      ["Contrat consultant Benyahia.docx", await docxDe(["CONTRAT DE CONSULTANT", "Mission de conseil réglementaire.", `Article 9 — Le consultant est tenu par une clause de ${MOT_PLEIN_TEXTE} à compter de la fin du contrat.`]), null],
      ["Licence d'exploitation Blida (reçue).pdf", await pdfPages([["DÉCISION — LICENCE D'EXPLOITATION D'UN ÉTABLISSEMENT", "Ministère de l'Industrie pharmaceutique.", "Établissement de Blida. Délivrée le 20/09/2026, valable jusqu'au 19/09/2031."]]), null],
    ],
    assistante: [
      ["PV AGO 2025.pdf", await pdfPages([["PROCÈS-VERBAL DE L'ASSEMBLÉE GÉNÉRALE ORDINAIRE", "Adventum Pharma SPA — séance du 28/06/2025.", "Approbation des comptes de l'exercice 2024."]]), null],
      ["Grille tarifaire 2026.pdf", await pdfPages([["GRILLE TARIFAIRE 2026", "Produit | Prix grossiste (DZD) | Prix public (DZD)", "Daclavir 60 mg | 18 500 | 22 900", "Sofosbuvir 400 mg | 24 000 | 29 700"]]), null],
    ],
    superadmin: [
      ["Attestation assurance RC SAA 2026.pdf", await pdfPages([["ATTESTATION D'ASSURANCE RESPONSABILITÉ CIVILE", "SAA Assurances certifie que Adventum Pharma SPA est assurée.", "Période de garantie : du 01/01/2026 au 31/12/2026. Police n° RC-2026-0091."]]), null],
    ],
    kam: [
      ["Annexe 1 tarifs.pdf", await pdfPages([["ANNEXE 1 — TARIFS"], ["ANNEXE 1 — TARIFS (suite)"]]), null],
      ["Annexe 2 logistique.pdf", await pdfPages([["ANNEXE 2 — LOGISTIQUE", "Livraison sous 72 h."]]), null],
    ],
    regulatory: [
      ["Dossier ANPP complet.pdf", await pdfPages([["MODULE 1 — ADMINISTRATIF"], ["MODULE 2 — RÉSUMÉS"], ["MODULE 3 — QUALITÉ"], ["MODULE 4 — NON CLINIQUE"]]), null],
    ],
    delegue: [
      ["Scan cachet pharmacie.png", await (await import("sharp")).default({ create: { width: 320, height: 160, channels: 3, background: { r: 30, g: 90, b: 160 } } }).png().toBuffer(), null],
    ],
    commercial: [
      ["Compte rendu visite CHU Blida.docx", await docxDe(["COMPTE RENDU DE VISITE", "CHU de Blida — service d'hépatologie.", "Le Pr Kaci souhaite une présentation de Daclavir en décembre."]), null],
    ],
  };
}

/**
 * LE SEMIS DU DOMAINE (`SemisDeDomaine`, appelé après le semis commun) — rend ses pièces : `doc:<persona>:<fichier>` (nœuds du
 * Drive) et `doc_fiche:<clé>` (fiches du registre, `nom` = leur titre).
 */
export const semerDocuments: SemisDeDomaine = async ({ etiquette, users, companyId }) => {
  const tag = `audit-doc${etiquette}`;
  const contacts: Record<string, string> = {};
  // La société elle-même, partie de ses pièces internes (statuts, PV) — à l'annuaire sous son nom, comme en réel.
  const societe = (await prisma.company.findUniqueOrThrow({ where: { id: companyId }, select: { name: true } })).name;
  for (const [name, sphere, kind] of [...PARTIES, [`${societe} SPA`, "PRIVE", "Société du groupe"] as const]) {
    const c = await prisma.companyContact.create({ data: { name, sphere, kind, companyId, notes: tag }, select: { id: true } });
    contacts[name] = c.id;
  }
  const dossiers: Record<string, string> = {};
  for (const name of ["Contrats", "Baux", "Assurances", "Attestations et certificats"]) {
    dossiers[name] = (await prisma.legalFolder.create({ data: { name, companyId, description: tag, createdById: users.juriste }, select: { id: true } })).id;
  }

  // Les fichiers, chacun dans le Drive de sa persona (sous-dossier au besoin).
  const pieces: Record<string, PieceSemee> = {};
  for (const [t, liste] of Object.entries(await fichiersDe()) as [Titulaire, [string, Buffer, string | null][]][]) {
    const sousDossiers: Record<string, string> = {};
    for (const [nom, octets, sous] of liste) {
      if (sous) sousDossiers[sous] ??= (await dossierDrive(users[t], sous)).id;
      pieces[`doc:${t}:${nom}`] = await deposerPiece(users[t], nom, octets, sous ? sousDossiers[sous]! : null, nom.endsWith(".png") ? "image/png" : undefined);
    }
  }

  // Le registre déjà vivant.
  const jour = (j: number) => new Date(Date.now() + j * 86_400_000);
  // La NATURE de chaque pièce est écrite EN DUR à sa création (aucun bon de commande ici — `centre-ecrivains.test.ts`).
  type Semee = { titre: string; partie: string; debut: Date | null; fin: Date | null; statut?: string; dossier?: string; fichier?: [Titulaire, string, Buffer]; createur?: Titulaire; notes?: string };
  const champs = async (o: Semee) => {
    let driveNodeId: string | null = null;
    if (o.fichier) {
      const [t, nom, octets] = o.fichier;
      driveNodeId = (await deposerPiece(users[t], nom, octets)).id;
      pieces[`doc:${t}:${nom}`] = { id: driveNodeId, nom };
    }
    return {
      title: o.titre, counterparty: o.partie, counterpartyIds: [contacts[o.partie]!], startDate: o.debut, endDate: o.fin, status: (o.statut ?? "ACTIVE") as never,
      folderId: o.dossier ? dossiers[o.dossier] ?? null : null, driveNodeId, companyId, createdById: users[o.createur ?? "juriste"], updatedById: users[o.createur ?? "juriste"], notes: o.notes ?? null,
    };
  };
  const SEL = { id: true, driveNodeId: true } as const;
  const contratSeme = async (o: Semee) => prisma.legalDocument.create({ data: { kind: "CONTRACT", ...(await champs(o)) }, select: SEL });
  const autreSeme = async (o: Semee) => prisma.legalDocument.create({ data: { kind: "OTHER", ...(await champs(o)) }, select: SEL });
  const assuranceSemee = async (o: Semee) => prisma.legalDocument.create({ data: { kind: "INSURANCE", ...(await champs(o)) }, select: SEL });
  const bailSeme = async (o: Semee) => prisma.legalDocument.create({ data: { kind: "LEASE", ...(await champs(o)) }, select: SEL });
  const conventionSemee = async (o: Semee) => prisma.legalDocument.create({ data: { kind: "AGREEMENT", ...(await champs(o)) }, select: SEL });
  // Le contrat Pharmalliance précédent : l'avenant n°1 en a besoin pour naître (`createAmendment`), quel que soit l'ordre des tâches.
  const ph24 = await contratSeme({ titre: "Contrat de distribution Pharmalliance 2024-2025", partie: "Pharmalliance Distribution", debut: new Date("2024-01-01"), fin: new Date("2025-12-31"), statut: "EXPIRED", dossier: "Contrats" });
  const m23 = await contratSeme({ titre: "Contrat de fourniture MediSupply 2023", partie: "MediSupply", debut: new Date("2023-01-01"), fin: new Date("2024-12-31"), statut: "RENEWED", dossier: "Contrats", fichier: ["juriste", "Contrat MediSupply 2023.pdf", await contrat("Contrat de fourniture", "MediSupply", "01/01/2023", "31/12/2024")] });
  const m25 = await contratSeme({ titre: "Contrat de fourniture MediSupply 2025", partie: "MediSupply", debut: new Date("2025-01-01"), fin: new Date("2026-12-31"), dossier: "Contrats", fichier: ["juriste", "Contrat MediSupply 2025.pdf", await contrat("Contrat de fourniture", "MediSupply", "01/01/2025", "31/12/2026")] });
  await prisma.legalDocument.update({ where: { id: m25.id }, data: { renewedFromId: m23.id } });
  const cnas = await autreSeme({ titre: "Attestation de mise à jour CNAS", partie: "CNAS", debut: jour(-345), fin: jour(20), dossier: "Attestations et certificats", fichier: ["juriste", "Attestation CNAS.pdf", await pdfPages([["ATTESTATION DE MISE À JOUR CNAS", "Adventum Pharma SPA est à jour de ses cotisations."]])] });
  // L'assistante et la juriste lisent ce fichier au Drive : il est partagé avec l'assistante (le Juridique ne donne pas le Drive).
  await prisma.driveShare.create({ data: { nodeId: cnas.driveNodeId!, userId: users.assistante, access: "VIEW" as never } });
  const flotte = await assuranceSemee({ titre: "Police d'assurance flotte automobile", partie: "SAA Assurances", debut: jour(-405), fin: jour(-40), fichier: ["juriste", "Police flotte automobile SAA.pdf", await contrat("Police d'assurance flotte automobile", "SAA Assurances", "01/01/2025", "31/12/2025")] });
  const bail = await bailSeme({ titre: "Bail du siège social — Hydra", partie: "SCI El Djazair", debut: new Date("2024-07-01"), fin: new Date("2027-06-30"), dossier: "Baux", fichier: ["juriste", "Bail siège Hydra.pdf", await contrat("Bail du siège social", "SCI El Djazair", "01/07/2024", "30/06/2027")] });
  const proto = await conventionSemee({ titre: TITRE_RESTREINT, partie: "Pharmalliance Distribution", debut: jour(-30), fin: null, createur: "superadmin", fichier: ["superadmin", "Protocole QZ-PROTO-7731.pdf", await pdfPages([[TITRE_RESTREINT, "Confidentiel."]])] });
  await prisma.legalDocumentReader.create({ data: { documentId: proto.id, userId: users.superadmin, grantedById: users.superadmin } });
  for (const [cle, f, titre] of [["pharmalliance2024", ph24, "Contrat de distribution Pharmalliance 2024-2025"], ["medisupply2023", m23, "Contrat de fourniture MediSupply 2023"],
    ["medisupply2025", m25, "Contrat de fourniture MediSupply 2025"], ["cnas", cnas, "Attestation de mise à jour CNAS"], ["flotte", flotte, "Police d'assurance flotte automobile"],
    ["bail", bail, "Bail du siège social — Hydra"], ["protocole", proto, TITRE_RESTREINT]] as const) pieces[`doc_fiche:${cle}`] = { id: f.id, nom: titre };
  return pieces;
};

/** Retire ce que `semerDocuments` a semé, et ce que les tâches DOC- ont créé (fiches, dossiers, contacts) — AVANT les comptes. */
export async function retirerDocuments(etiquette: string, userIds: string[]): Promise<void> {
  const tag = `audit-doc${etiquette}`;
  const sur = <T>(p: Promise<T>) => p.catch(attendu("banc d'audit T1 : ligne déjà retirée", null));
  await sur(prisma.legalDocumentReader.deleteMany({ where: { document: { OR: [{ createdById: { in: userIds } }, { driveNode: { ownerId: { in: userIds } } }] } } }));
  await sur(prisma.legalDocument.updateMany({ where: { createdById: { in: userIds } }, data: { renewedFromId: null, amendsId: null, chainFromId: null } }));
  await sur(prisma.legalDocument.deleteMany({ where: { OR: [{ createdById: { in: userIds } }, { driveNode: { ownerId: { in: userIds } } }] } }));
  await sur(prisma.legalFolder.deleteMany({ where: { OR: [{ description: tag }, { createdById: { in: userIds } }] } }));
  await sur(prisma.companyContact.deleteMany({ where: { OR: [{ notes: tag }, { createdById: { in: userIds } }] } }));
}
