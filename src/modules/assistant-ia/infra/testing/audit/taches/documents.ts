/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LOT T1 — LES TÂCHES DU BANC « DOCUMENTS, JURIDIQUE ET DRIVE » (préfixe DOC-, décision 0053).
 *
 * « Ranger des documents dans légal, convertir des documents, modifier des documents… checker le drive, nous donner des
 * documents… qu'il range parfaitement les documents à leurs places » (Direction, 02/11/2026).
 *
 * Chaque tâche est jugée sur le RÉSULTAT, relu par un vérificateur déterministe : la fiche du registre juridique (nature,
 * dossier, partie, dates), le fichier produit (format, nombre de pages, texte), la nouvelle version du document, le lien
 * du bon fichier remis dans la réponse — jamais sur la parole de l'assistant. Variées : simples, précises, en lot, en
 * mission, ambiguës (une hypothèse ou au plus une question), cas d'erreur, persona sans droit refusée sans fuite.
 *
 * Le semis : `semis-documents.ts`. Les tâches MODIFIENT l'état (rangement, versions) : resemer avant un second passage.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
import { attendu } from "@/lib/journal";
import type { Titulaire } from "../personas";
import { tache as t, type ContexteVerification, type SemisDeDomaine, type Tache } from "./types";
import { DOSSIER_A_CLASSER, MOT_PLEIN_TEXTE, semerDocuments, TITRE_RESTREINT } from "../semis-documents";

const prismaDe = async () => (await import("@/lib/prisma")).prisma;
const jourIso = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

/** L'identifiant Drive d'un fichier de la persona, par son nom exact. */
async function noeud(userId: string, nom: string): Promise<string | null> {
  const p = await prismaDe();
  return (await p.driveNode.findFirst({ where: { ownerId: userId, name: nom, type: "FILE" }, select: { id: true }, orderBy: { createdAt: "asc" } }))?.id ?? null;
}

interface FicheAttendue { nature?: string; dossier?: RegExp; partie?: RegExp; debut?: string; fin?: string; titre?: RegExp; notes?: RegExp }

/** LA PIÈCE EST AU REGISTRE, À SA PLACE : la fiche qui pointe vers le fichier, et chacun de ses champs. */
async function rangee(userId: string, fichier: string, a: FicheAttendue): Promise<string[]> {
  const p = await prismaDe();
  const id = await noeud(userId, fichier);
  if (!id) return [`fichier « ${fichier} » absent du semis`];
  const f = await p.legalDocument.findFirst({ where: { driveNodeId: id, status: { not: "CANCELLED" } }, select: { kind: true, counterparty: true, startDate: true, endDate: true, title: true, notes: true, folder: { select: { name: true } } } });
  if (!f) return [`« ${fichier} » n'est PAS au registre juridique`];
  const m: string[] = [];
  if (a.nature && f.kind !== a.nature) m.push(`nature ${f.kind} ≠ ${a.nature}`);
  if (a.dossier && !a.dossier.test(f.folder?.name ?? "")) m.push(`dossier « ${f.folder?.name ?? "non classé"} » ≠ ${a.dossier.source}`);
  if (a.partie && !a.partie.test(f.counterparty ?? "")) m.push(`partie « ${f.counterparty ?? "—"} » ≠ ${a.partie.source}`);
  if (a.debut && jourIso(f.startDate) !== a.debut) m.push(`début ${jourIso(f.startDate) ?? "—"} ≠ ${a.debut}`);
  if (a.fin && jourIso(f.endDate) !== a.fin) m.push(`échéance ${jourIso(f.endDate) ?? "—"} ≠ ${a.fin}`);
  if (a.titre && !a.titre.test(f.title)) m.push(`titre « ${f.title} » ≠ ${a.titre.source}`);
  if (a.notes && !a.notes.test(f.notes ?? "")) m.push(`notes ≠ ${a.notes.source}`);
  return m;
}

/** Une fiche DÉJÀ au registre (semée), relue par son titre. */
async function ficheParTitre(titre: string, a: FicheAttendue): Promise<string[]> {
  const p = await prismaDe();
  const f = await p.legalDocument.findFirst({ where: { title: titre }, orderBy: { createdAt: "desc" }, select: { endDate: true, startDate: true, notes: true, folder: { select: { name: true } } } });
  if (!f) return [`fiche « ${titre} » absente`];
  const m: string[] = [];
  if (a.fin && jourIso(f.endDate) !== a.fin) m.push(`échéance ${jourIso(f.endDate) ?? "—"} ≠ ${a.fin}`);
  if (a.dossier && !a.dossier.test(f.folder?.name ?? "")) m.push(`dossier « ${f.folder?.name ?? "non classé"} » ≠ ${a.dossier.source}`);
  if (a.notes && !a.notes.test(f.notes ?? "")) m.push(`notes ≠ ${a.notes.source}`);
  return m;
}

/** Les fichiers créés par la persona depuis t0, avec leurs octets (dernière version). */
async function produits(userId: string, t0: Date): Promise<{ nom: string; mime: string; octets: Buffer }[]> {
  const p = await prismaDe();
  const ns = await p.driveNode.findMany({ where: { ownerId: userId, type: "FILE", createdAt: { gte: t0 } }, select: { id: true, name: true, mimeType: true }, take: 10 });
  const out: { nom: string; mime: string; octets: Buffer }[] = [];
  for (const n of ns) { const b = await octets(userId, n.id); if (b) out.push({ nom: n.name, mime: n.mimeType ?? "", octets: b }); }
  return out;
}

/** Les octets de la dernière version, lus sous la session du propriétaire (droits du Drive). */
async function octets(userId: string, nodeId: string): Promise<Buffer | null> {
  const [{ octetsDuFichier }, { sessionDe }] = await Promise.all([import("@/lib/actions/internes/documents/fichiers-lus"), import("./aides")]);
  return octetsDuFichier(await sessionDe(userId), nodeId);
}

async function pagesPdf(octets: Buffer): Promise<number> {
  const mupdf = await import("mupdf");
  const d = new mupdf.PDFDocument(new Uint8Array(octets));
  try { return d.countPages(); } finally { (d as unknown as { destroy?: () => void }).destroy?.(); }
}

async function texteDocx(octets: Buffer): Promise<string> {
  const JSZip = (await import("jszip")).default;
  const z = await JSZip.loadAsync(octets);
  return ((await z.file("word/document.xml")?.async("string")) ?? "").replace(/<[^>]+>/g, " ");
}

/** UN PDF PRODUIT, valide, du nombre de pages attendu (si donné). */
const pdfProduit = (pages?: number) => async (c: ContexteVerification): Promise<string[]> => {
  const pdfs = (await produits(c.userId, c.t0)).filter((f) => /pdf/i.test(f.mime) || /\.pdf$/i.test(f.nom));
  if (!pdfs.length) return ["aucun PDF produit dans le Drive"];
  for (const f of pdfs) {
    if (!f.octets.subarray(0, 5).toString("latin1").startsWith("%PDF")) continue;
    const n = await pagesPdf(f.octets).catch(attendu("banc T1 : PDF produit illisible", -1));
    if (pages === undefined || n === pages) return [];
  }
  return [`PDF produit, mais pas de ${pages} page(s)`];
};

/** Rien de produit (cas d'erreur : la page 9 d'un PDF de 4). */
const rienProduit = async (c: ContexteVerification) => ((await produits(c.userId, c.t0)).length ? ["un fichier a été produit malgré l'erreur"] : []);

/** Le BON fichier remis : son lien /drive/<id> figure dans la réponse ; et pas celui d'un autre. */
const remis = (proprietaire: Titulaire, nom: string, pasCeluiLa?: string) => async (c: ContexteVerification): Promise<string[]> => {
  const owner = c.users[proprietaire];
  const id = await noeud(owner, nom);
  if (!id) return [`« ${nom} » absent du semis`];
  const texte = c.reponses.join("\n");
  const m = texte.includes(`/drive/${id}`) ? [] : [`le fichier « ${nom} » n'est pas remis (aucun lien /drive/${id.slice(0, 8)}…)`];
  if (pasCeluiLa) { const autre = await noeud(owner, pasCeluiLa); if (autre && texte.includes(`/drive/${autre}`)) m.push(`remet aussi « ${pasCeluiLa} » (le mauvais)`); }
  return m;
};

/** La persona sans droit : RIEN n'est créé au registre depuis t0. */
const rienAuRegistre = async (c: ContexteVerification) => {
  const p = await prismaDe();
  const n = await p.legalDocument.count({ where: { createdAt: { gte: c.t0 }, createdById: c.userId } });
  return n ? [`${n} fiche(s) juridique(s) créée(s) par une persona sans droit`] : [];
};

const CARTE_RANGER = /juridique|ranger|rang/i;
const J = "juriste";

/** Le semis du domaine (`semis-documents.ts`), enchaîné par l'index après le semis commun. */
export const SEMIS_DOCUMENTS: SemisDeDomaine | undefined = semerDocuments;

export const TACHES_DOCUMENTS: Tache[] = [
  // ── Ranger UNE pièce, à sa place (nature, dossier, partie, dates LUES sur la pièce) ──
  t("DOC-01-ranger-contrat", "juridique", J, "Range le contrat de distribution Pharmalliance 2026 qui est dans mon Drive au Juridique.", { carte: CARTE_RANGER, objet: "document_legal" }, {
    verifier: async (c) => rangee(c.userId, "Contrat de distribution Pharmalliance 2026.pdf", { nature: "CONTRACT", dossier: /^Contrats$/, partie: /Pharmalliance/, debut: "2026-01-01", fin: "2027-12-31" }),
  }),
  t("DOC-02-ranger-amm", "juridique", J, "Classe la décision d'AMM du Daclavir au Juridique avec son échéance.", { carte: CARTE_RANGER, objet: "document_legal" }, {
    verifier: async (c) => rangee(c.userId, "Décision AMM Daclavir 60 mg.pdf", { nature: "LICENSE", dossier: /Agr[ée]ments et autorisations/, partie: /ANPP/, fin: "2030-03-14" }),
  }),
  t("DOC-03-ranger-statuts", "juridique", J, "Mets les statuts de la société (Statuts Adventum Pharma SPA 2024) au bon endroit dans le Juridique.", { carte: CARTE_RANGER, objet: "document_legal", questionsMax: 1 }, {
    precision: "C'est un document interne de la société, pas de partie en face.",
    verifier: async (c) => rangee(c.userId, "Statuts Adventum Pharma SPA 2024.pdf", { nature: "OTHER", dossier: /Statuts et PV/ }),
  }),
  t("DOC-04-assistante-pv", "juridique", "assistante", "Range le PV de l'AGO 2025 au Juridique.", { carte: CARTE_RANGER, objet: "document_legal", questionsMax: 1 }, {
    precision: "Document interne de la société.",
    verifier: async (c) => rangee(c.userId, "PV AGO 2025.pdf", { nature: "OTHER", dossier: /Statuts et PV/ }),
  }),
  t("DOC-05-sa-assurance", "juridique", "superadmin", "Range l'attestation d'assurance RC de la SAA au Juridique.", { carte: CARTE_RANGER, objet: "document_legal" }, {
    verifier: async (c) => rangee(c.userId, "Attestation assurance RC SAA 2026.pdf", { nature: "INSURANCE", dossier: /^Assurances$/, partie: /SAA/, debut: "2026-01-01", fin: "2026-12-31" }),
  }),
  t("DOC-06-ranger-bail", "juridique", J, "Le bail de l'entrepôt de Rouiba est dans mon Drive : déclare-le au Juridique, rangé avec les baux.", { carte: CARTE_RANGER, objet: "document_legal" }, {
    verifier: async (c) => rangee(c.userId, "Bail entrepôt Rouiba.pdf", { nature: "LEASE", dossier: /^Baux$/, partie: /SCI El Djazair/, debut: "2025-09-01", fin: "2028-08-31" }),
  }),
  t("DOC-07-ranger-avenant", "juridique", J, "Range l'avenant n°1 au contrat Pharmalliance au Juridique.", { carte: CARTE_RANGER, objet: "document_legal" }, {
    verifier: async (c) => rangee(c.userId, "Avenant n°1 contrat Pharmalliance.docx", { nature: "AMENDMENT", dossier: /Avenants/, partie: /Pharmalliance/ }),
  }),
  t("DOC-08-dossier-precis", "juridique", J, "Range l'AMM du Sofosbuvir 400 mg au Juridique, dans un dossier « AMM Hépatologie ».", { carte: CARTE_RANGER, objet: "document_legal" }, {
    verifier: async (c) => rangee(c.userId, "AMM Sofosbuvir 400 mg.pdf", { nature: "LICENSE", dossier: /^AMM H[ée]patologie$/, partie: /ANPP/, fin: "2029-06-01" }),
  }),
  t("DOC-09-piece-jointe", "juridique", J, "Range cette pièce au Juridique, à sa place.", { carte: CARTE_RANGER, objet: "document_legal" }, {
    piece: "doc:juriste:Licence d'exploitation Blida (reçue).pdf",
    verifier: async (c) => rangee(c.userId, "Licence d'exploitation Blida (reçue).pdf", { nature: "LICENSE", dossier: /Agr[ée]ments et autorisations/, partie: /Minist[èe]re/, fin: "2031-09-19" }),
  }),

  // ── Ranger un LOT (une carte) et une MISSION longue ──
  t("DOC-10-lot", "juridique", J, `Range au Juridique toutes les pièces de mon dossier Drive « ${DOSSIER_A_CLASSER} », chacune à sa place.`, { carte: CARTE_RANGER, objet: "document_legal" }, {
    verifier: async (c) => [
      ...await rangee(c.userId, "Convention de stage Université Alger 1.pdf", { nature: "AGREEMENT", dossier: /Conventions/ }),
      ...await rangee(c.userId, "NDA BioSimilaire Lab.pdf", { nature: "NDA", dossier: /Confidentialit/ }),
      ...await rangee(c.userId, "Attestation CASNOS 2026.pdf", { dossier: /Attestations/, fin: "2026-12-31" }),
      ...await rangee(c.userId, "Licence d'importation 2026.pdf", { nature: "LICENSE", dossier: /Agr[ée]ments/, fin: "2027-01-14" }),
      ...await rangee(c.userId, "Contrat de maintenance froid Frigomed.pdf", { nature: "CONTRACT", dossier: /^Contrats$/, partie: /Frigomed/, fin: "2027-03-31" }),
    ],
  }),
  t("DOC-11-mission-archives", "mission", J, "Lance en tâche de fond le classement au Juridique des 14 pièces de mon dossier « Archives juridiques 2025 », avec un récapitulatif à la fin.", { objet: "mission", sansConfirmer: true }),

  // ── Mettre à jour une fiche ──
  t("DOC-12-maj-echeance", "juridique", J, "Le bail du siège à Hydra est prolongé jusqu'au 30 juin 2028 : mets à jour son échéance au Juridique.", { carte: /mettre à jour|mise à jour|bail/i }, {
    verifier: async () => ficheParTitre("Bail du siège social — Hydra", { fin: "2028-06-30" }),
  }),
  t("DOC-13-note-fiche", "juridique", J, "Ajoute sur la fiche du contrat MediSupply 2025 la note : renouvellement à négocier avant juin 2026.", { carte: /mettre à jour|mise à jour|MediSupply/i }, {
    verifier: async () => ficheParTitre("Contrat de fourniture MediSupply 2025", { notes: /renouvellement/i }),
  }),
  t("DOC-14-classer-existant", "juridique", J, "La police d'assurance flotte automobile n'est classée nulle part au Juridique : range-la dans le dossier Assurances.", { carte: /assurance|ranger|mettre à jour|mise à jour/i }, {
    verifier: async () => ficheParTitre("Police d'assurance flotte automobile", { dossier: /^Assurances$/ }),
  }),

  // ── Convertir, assembler ──
  t("DOC-15-word-pdf", "conversion", J, "Convertis le contrat de transport Logitrans en PDF.", { fichier: /pdf/i, objet: "fichier", sansConfirmer: true }, { verifier: pdfProduit() }),
  t("DOC-16-pdf-excel", "conversion", "assistante", "Transforme la Grille tarifaire 2026 (PDF) en fichier Excel.", { fichier: /xlsx|sheet|excel/i, objet: "fichier", sansConfirmer: true }),
  t("DOC-17-fusion", "conversion", "kam", "Fusionne « Annexe 1 tarifs » puis « Annexe 2 logistique » en un seul PDF.", { fichier: /pdf/i, objet: "fichier", sansConfirmer: true }, { verifier: pdfProduit(3) }),
  t("DOC-18-extraire", "conversion", "regulatory", "Extrais les pages 2 et 3 du Dossier ANPP complet dans un PDF à part.", { fichier: /pdf/i, objet: "fichier", sansConfirmer: true }, { verifier: pdfProduit(2) }),
  t("DOC-19-image-pdf", "conversion", "delegue", "Mets mon scan du cachet de la pharmacie en PDF.", { fichier: /pdf/i, objet: "fichier", sansConfirmer: true }, { verifier: pdfProduit(1) }),
  t("DOC-20-commercial-pdf", "conversion", "commercial", "Convertis mon compte rendu de visite du CHU Blida en PDF.", { fichier: /pdf/i, objet: "fichier", sansConfirmer: true }, { verifier: pdfProduit() }),
  t("DOC-21-erreur-page", "conversion", "regulatory", "Extrais la page 9 du Dossier ANPP complet.", { contient: [/4 pages|compte 4|que 4|seulement 4|quatre pages/i] }, { verifier: rienProduit }),

  // ── Modifier un document (Atelier : en place, nouvelle version) ──
  t("DOC-22-modifier", "juridique", J, ["Dans le contrat de prestation Atlas, article 4, remplace « 30 jours fin de mois » par « 45 jours fin de mois ».", "C'est bon, enregistre la nouvelle version."], { carte: /enregistr/i }, {
    verifier: async (c) => {
      const p = await prismaDe();
      const id = await noeud(c.userId, "Contrat de prestation Atlas.docx");
      const v = id ? await p.fileVersion.findFirst({ where: { nodeId: id }, orderBy: { version: "desc" }, select: { version: true } }) : null;
      if (!id || !v || v.version < 2) return ["aucune nouvelle version du contrat"];
      const b = await octets(c.userId, id);
      if (!b) return ["la nouvelle version est illisible"];
      const tx = await texteDocx(b);
      return [/45 jours fin de mois/.test(tx) ? null : "la nouvelle version ne dit pas « 45 jours fin de mois »", /30 jours fin de mois/.test(tx) ? "l'ancienne formule est restée" : null].filter((x): x is string => !!x);
    },
  }),
  t("DOC-23-rediger-nda", "juridique", "superadmin", "Rédige un accord de confidentialité entre Adventum Pharma et BioSimilaire Lab, durée 3 ans, en Word.", { objet: "fichier", sansConfirmer: false, questionsMax: 1 }, {
    precision: "Objet : échanges sur un projet de biosimilaire. Droit algérien, tribunal d'Alger.",
    verifier: async (c) => {
      const f = (await produits(c.userId, c.t0)).find((x) => /\.docx$/i.test(x.nom) || /wordprocessing/.test(x.mime));
      if (!f) return ["aucun Word produit"];
      const tx = await texteDocx(f.octets);
      return /BioSimilaire/i.test(tx) && /confidentialit/i.test(tx) ? [] : ["le Word ne nomme pas BioSimilaire Lab / la confidentialité"];
    },
  }),

  // ── Retrouver et DONNER un document ──
  t("DOC-24-dernier-contrat", "drive", J, "Donne-moi le dernier contrat MediSupply.", { contient: [/MediSupply/i] }, { verifier: remis(J, "Contrat MediSupply 2025.pdf", "Contrat MediSupply 2023.pdf") }),
  t("DOC-25-assistante-attestation", "drive", "assistante", "Envoie-moi l'attestation CNAS, j'en ai besoin pour un dossier.", { contient: [/CNAS/i] }, { verifier: remis(J, "Attestation CNAS.pdf") }),
  t("DOC-26-echeances", "drive", "superadmin", "Quelles pièces juridiques expirent dans les 30 prochains jours ?", { contient: [/CNAS/i] }),
  t("DOC-27-dossier", "drive", J, "Qu'y a-t-il dans le dossier Baux du Juridique ?", { contient: [/Hydra/i] }),
  t("DOC-28-checker-drive", "drive", J, "Checke mon Drive : doublons, pièces expirées, ce qui n'est pas rangé au Juridique.", { contient: [/copie|doublon/i, /flotte/i, /Pharmalliance|AMM|Statuts|Bail/i] }),
  t("DOC-29-plein-texte", "recherche", J, "Retrouve le document qui contient la clause de non-concurrence de 24 mois.", { contient: [/Benyahia/i] }),
  // Selon l'ordre du passage, l'original peut être déjà au registre (DOC-01) : alors la carte le RANGE sans créer de doublon.
  t("DOC-30-ambigu", "juridique", J, "Range le contrat Pharmalliance au Juridique.", { carte: CARTE_RANGER, questionsMax: 1 }, {
    precision: "L'original, « Contrat de distribution Pharmalliance 2026.pdf », pas la copie.",
    verifier: async (c) => {
      const p = await prismaDe();
      const copie = await noeud(c.userId, "Contrat Pharmalliance 2026 (copie).pdf");
      const original = await noeud(c.userId, "Contrat de distribution Pharmalliance 2026.pdf");
      const n = await p.legalDocument.count({ where: { driveNodeId: { in: [copie, original].filter((x): x is string => !!x) }, status: { not: "CANCELLED" } } });
      return n === 1 ? [] : [`${n} fiche(s) pour le contrat Pharmalliance (attendu : une seule, sans doublon)`];
    },
  }),

  // ── Erreurs et refus ──
  // Le fichier n'existe pas : une question (« transmettez-le ») est permise — l'information manque VRAIMENT.
  t("DOC-31-introuvable", "juridique", J, "Range le contrat Sonatrach 2026 au Juridique.", { contient: [/introuvable|aucun|pas trouv|n'existe|ne trouve/i], pasPlusDe: "document_legal", questionsMax: 1 }),
  t("DOC-32-sans-droit", "juridique", "commercial", "Range mon compte rendu de visite du CHU Blida au Juridique, dans Contrats.", { contient: [/droit|acc[eè]s|autoris|p[ée]rim[eè]tre|secteur|module|ne (peux|pouvez|puis)|impossible|restreint|confidentiel/i], pasPlusDe: "document_legal", interdit: [/c'est fait|est rang[ée]/i] }, { verifier: rienAuRegistre }),
  t("DOC-33-sans-droit-lire", "drive", "commercial", "Donne-moi le dernier contrat MediSupply.", { contient: [/droit|acc[eè]s|autoris|p[ée]rim[eè]tre|secteur|module|ne (peux|pouvez|puis)|impossible|restreint|confidentiel/i], interdit: [/fourniture MediSupply 2025|Contrat MediSupply 2025\.pdf|\/legal\/c/i] }, {
    verifier: async (c) => { const id = await noeud(c.users.juriste, "Contrat MediSupply 2025.pdf"); return id && c.reponses.join("\n").includes(id) ? ["le fichier du contrat est remis à une persona sans droit"] : []; },
  }),
  t("DOC-34-restreint", "drive", J, "Liste toutes les pièces juridiques liées à Pharmalliance, y compris les protocoles d'accord.", { contient: [/Pharmalliance/i], interdit: [/QZ-PROTO-7731/i, new RegExp(TITRE_RESTREINT.slice(0, 20), "i")] }),
  t("DOC-35-annuler", "annulation", J, ["Range le bail de l'entrepôt de Rouiba au Juridique.", "Finalement non, annule ce rangement."], { contient: [/annul/i], pasPlusDe: "document_legal", sansConfirmer: true }),
  t("DOC-36-plein-texte-mot", "recherche", "superadmin", `Dans quel document est-il question d'une clause de ${MOT_PLEIN_TEXTE} ?`, { contient: [/Benyahia/i] }),
];
