import type { PrismaClient } from "@prisma/client";
import { P, type CleCompte } from "./comptes";
import { graine } from "./banc";
import { prismaRecette } from "./seed";

/**
 * LES DONNÉES DE CHAQUE PARCOURS — de TEST, préfixées `__recette__`, posées par le parcours qui en a
 * besoin (jamais par la graine). Quand l'écran sait créer la chose lui-même (une demande de BV, une
 * remise de caisse, un courrier), le parcours la crée PAR L'ÉCRAN : c'est ce qu'on recette. On ne
 * pose ici que l'AMONT qu'un parcours ne recette pas (un ordre déjà émis qui attend le centre…).
 */

let client: PrismaClient | null = null;
export function db(): PrismaClient {
  client ??= prismaRecette();
  return client;
}

let seq = 0;
const reference = () => `RCT-${Date.now().toString(36).toUpperCase()}-${++seq}`;

export interface OrdreDeTest {
  libelle: string;
  montant: number;
  demandeur: CleCompte;
  beneficiaire?: string;
  /** Statut au centre : `AWAITING` par défaut (en attente de décision). */
  statutCentre?: string;
  societe?: "test" | "fermee";
  sourceType?: string | null;
}

/**
 * Un ordre de dépense déjà émis — l'amont d'un parcours qui commence au centre de paiement ou à la Banque.
 * IDEMPOTENT : un ordre du même libellé déjà posé pendant ce run est RETROUVÉ, pas recréé (un ouvrier relancé
 * après un échec rejoue `beforeAll` ; il doit retrouver le décor, décisions comprises).
 */
export async function ordre(o: OrdreDeTest): Promise<{ id: string; reference: string; libelle: string }> {
  const g = graine();
  const libelle = o.libelle.startsWith(P) ? o.libelle : `${P} ${o.libelle}`;
  const deja = await db().expenseOrder.findFirst({ where: { label: libelle }, select: { id: true, reference: true } });
  if (deja) return { id: deja.id, reference: deja.reference, libelle };
  const ref = reference();
  const cree = await db().expenseOrder.create({
    data: {
      reference: ref, label: libelle, amount: o.montant, category: "AUTRE", beneficiary: o.beneficiaire ?? null,
      companyId: o.societe === "fermee" ? g.societeFermeeId : g.societeId,
      centralStatus: o.statutCentre ?? "AWAITING", requestedById: g.comptes[o.demandeur],
      sourceType: (o.sourceType ?? null) as never,
    },
  });
  return { id: cree.id, reference: ref, libelle };
}

/** L'état d'un ordre, relu en base (le contrôle « en coulisse » qui complète ce que l'écran affiche). */
export async function etatOrdre(id: string): Promise<{ centralStatus: string; status: string }> {
  const o = await db().expenseOrder.findUniqueOrThrow({ where: { id }, select: { centralStatus: true, status: true } });
  return { centralStatus: o.centralStatus, status: String(o.status) };
}

/** Une enveloppe budgétaire de l'année en cours pour la société de test, avec une ligne — pour qu'un paiement s'impute. */
export async function enveloppe(nom = "Enveloppe générale", ligne = "Frais généraux", montant = 10_000_000, domaine = "GENERAL"): Promise<{ id: string; ligneId: string }> {
  const an = new Date().getFullYear();
  const deja = await db().budgetEnvelope.findFirst({ where: { name: `${P} ${nom} ${an}` }, include: { categories: true } });
  if (deja?.categories[0]) return { id: deja.id, ligneId: deja.categories[0].id };
  const e = await db().budgetEnvelope.create({
    data: {
      name: `${P} ${nom} ${an}`, periodStart: new Date(`${an}-01-01`), periodEnd: new Date(`${an}-12-31`),
      totalAmount: montant, companyId: graine().societeId, domaine,
    },
  });
  const l = await db().budgetCategoryLine.create({ data: { envelopeId: e.id, name: `${P} ${ligne}`, allocated: montant } });
  return { id: e.id, ligneId: l.id };
}

/** Un compte bancaire de la société de test, ancré à un relevé (la Banque paie « depuis » un compte). */
export async function compteBancaire(nom = "BNA Hydra", solde = 25_000_000): Promise<string> {
  const deja = await db().treasuryAccount.findFirst({ where: { name: `${P} ${nom}` }, select: { id: true } });
  if (deja) return deja.id;
  return (await db().treasuryAccount.create({
    data: { name: `${P} ${nom}`, bank: nom, rib: "00100123000012345678", openingBalance: solde, openingDate: new Date(), companyId: graine().societeId },
  })).id;
}

/** Rattache un ordre à une ligne budgétaire (le choix fait en amont par la Direction). */
export async function imputer(ordreId: string, ligneId: string): Promise<void> {
  await db().expenseOrder.update({ where: { id: ordreId }, data: { budgetCategoryId: ligneId } });
}

/** Un dossier d'enregistrement (Regulatory) dont la présoumission est favorable : l'étape « Demande du BV 25 % » est ouverte. */
export async function dossierRegulatory(nom: string): Promise<string> {
  const deja = await db().regulatoryProduct.findFirst({ where: { dci: `${P} ${nom.toUpperCase()}` }, select: { id: true } });
  if (deja) return deja.id;
  return (await db().regulatoryProduct.create({
    data: {
      dci: `${P} ${nom.toUpperCase()}`, brandName: `${P} ${nom}`, reference: `${P}REG-${++seq}`, companyId: graine().societeId,
      workflow: { presub_ans: { status: "DONE", outcome: "FAVORABLE" } },
    },
  })).id;
}

/** Le budget Regulatory de la société de test : lignes « BV 25 % » et « BV 75 % » (clés lues par le circuit BV). */
export async function budgetRegulatory(): Promise<{ id: string; bv25: string; bv75: string }> {
  const an = new Date().getUTCFullYear();
  const deja = await db().budgetEnvelope.findFirst({ where: { name: `${P} Budget Regulatory ${an}` }, include: { categories: true } });
  if (deja) return { id: deja.id, bv25: deja.categories.find((c) => c.cle === "BV_25")!.id, bv75: deja.categories.find((c) => c.cle === "BV_75")!.id };
  const env = await db().budgetEnvelope.create({
    data: {
      name: `${P} Budget Regulatory ${an}`, domaine: "REGULATORY", companyId: graine().societeId, totalAmount: 5_000_000, isActive: true,
      periodStart: new Date(Date.UTC(an, 0, 1)), periodEnd: new Date(Date.UTC(an, 11, 31)),
      categories: { create: [{ name: "BV 25 %", cle: "BV_25", allocated: 1_000_000 }, { name: "BV 75 %", cle: "BV_75", allocated: 3_000_000 }] },
    },
    include: { categories: true },
  });
  return { id: env.id, bv25: env.categories.find((c) => c.cle === "BV_25")!.id, bv75: env.categories.find((c) => c.cle === "BV_75")!.id };
}

/** Un PDF minimal valide (une page), pour les dépôts de pièces : proforma, facture, G50… */
export function pdfDeTest(titre = "Piece de recette"): { name: string; mimeType: string; buffer: Buffer } {
  const texte = titre.normalize("NFD").replace(/[^\x20-\x7e]/g, "");
  const corps = `BT /F1 18 Tf 72 720 Td (${texte}) Tj ET`;
  const objets = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${corps.length} >>\nstream\n${corps}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const decalages: number[] = [];
  objets.forEach((o, i) => { decalages.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objets.length + 1}\n0000000000 65535 f \n${decalages.map((d) => `${String(d).padStart(10, "0")} 00000 n \n`).join("")}`;
  pdf += `trailer\n<< /Size ${objets.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return { name: `${slugFichier(titre)}.pdf`, mimeType: "application/pdf", buffer: Buffer.from(pdf, "latin1") };
}

/** Un fichier de N Mo (contenu pseudo-aléatoire, incompressible) — pour le dépôt de plus de 10 Mo au Drive. */
export function gros(nomFichier: string, mo: number): { name: string; mimeType: string; buffer: Buffer } {
  const buffer = Buffer.alloc(mo * 1024 * 1024);
  let x = 2463534242;
  for (let i = 0; i < buffer.length; i += 4) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; buffer.writeUInt32LE(x >>> 0, i); }
  return { name: nomFichier, mimeType: "application/octet-stream", buffer };
}

/** Le décor de la visite médicale : un produit et un message dans la gamme (la BU), deux médecins dans le panel. */
export async function decorVisite(cle: CleCompte): Promise<{ produit: string; message: string; medecins: string[] }> {
  const g = graine();
  const produit = `${P} Cardiolex 5 mg`;
  const message = `${P} Contrôle tensionnel en une prise par jour`;
  if (!(await db().promoProduct.findFirst({ where: { name: produit } }))) {
    await db().promoProduct.create({ data: { name: produit, businessUnitId: g.buId } });
  }
  if (!(await db().promoMessage.findFirst({ where: { title: message } }))) {
    await db().promoMessage.create({ data: { title: message, businessUnitId: g.buId } });
  }
  const medecins = [`${P} Dr Amina Belkacem (${cle})`, `${P} Dr Yacine Haddad (${cle})`];
  for (const nom of medecins) {
    if (!(await db().medicalDoctor.findFirst({ where: { name: nom } }))) {
      await db().medicalDoctor.create({ data: { name: nom, delegateId: g.comptes[cle], city: "Alger" } });
    }
  }
  return { produit, message, medecins };
}

const slugFichier = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");

export async function fermer(): Promise<void> {
  if (client) await client.$disconnect();
  client = null;
}
