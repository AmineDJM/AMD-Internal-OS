/**
 * Fabrique de documents — LA DEMANDE D'ÉMISSION ET SA COMPOSITION : forme de la demande, fabriques par
 * type, PDF de la pièce, réserves, coordonnées et mentions retenues, spécification du document, échéance
 * légale, attribution du numéro.
 */
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { CurrentUser } from "@/lib/session";
import { docxToPdf } from "@/lib/payslip/to-pdf";
import { convertConfigured, convertDocument } from "@/lib/office-convert";
import { appBaseUrl, makeFileReadToken } from "@/lib/onlyoffice";
import { ajouterJours, type CoordonneesEmetteur, type LigneCommerciale, type ModePaiement, type PartieCommerciale, type SpecDocumentCommercial, type TaxeAdditionnelle, type TotauxCommerciaux, type TypeDocumentCommercial } from "@/lib/artifact/factory/commercial";
import { mentionsDe, signatairePour } from "@/lib/brand/model";
import { reserveDeLAiguillage, type PorteBC } from "@/lib/bons-de-commande/regle";
import type { ProfilDocumentaire } from "./profil";

// ─────────────────────────── L'émission ───────────────────────────

export interface DemandeDocument {
  type: TypeDocumentCommercial;
  /** Identifiant, raison sociale ou nom court. Vide = la société de la personne. */
  societe?: string | null;
  tiers: PartieCommerciale;
  lignes: LigneCommerciale[];
  /** ISO `AAAA-MM-JJ`. Vide = aujourd'hui. */
  date?: string | null;
  echeance?: string | null;
  validiteJours?: number | null;
  tvaDefaut?: number | null;
  remiseGlobale?: number | null;
  modePaiement?: ModePaiement | null;
  conditionsPaiement?: string | null;
  objet?: string | null;
  /** La pièce amont, en clair : « 26/0576 » sous « Devis N° » d'un bon de commande. */
  referenceAmont?: string | null;
  /** La date de la pièce amont (« Du 20/07/2026 »), ISO. */
  referenceAmontDate?: string | null;
  /** Facture : le numéro de client de la société (« 00003 »). */
  numeroClient?: string | null;
  /** Bon de commande / devis : l'interlocuteur nommé sur la pièce. */
  contact?: { nom?: string | null; telephone?: string | null } | null;
  /**
   * LES COORDONNÉES DE L'ÉMETTEUR pour CETTE pièce (adresse du siège, téléphone, e-mail) — absent = celles de la société
   * émettrice ; une clé présente les remplace, `null` ou vide n'imprime rien (`SpecDocumentCommercial.coordonneesEmetteur`).
   */
  coordonneesEmetteur?: CoordonneesEmetteur | null;
  /**
   * LE SIGNATAIRE imprimé sur CETTE pièce — absent : celui de la marque (par type), sinon celui du profil ; `null` : aucun.
   */
  signataire?: { nom: string; qualite?: string | null } | null;
  /** Les mentions propres à la pièce, imprimées au pied après celles de la société (`SpecDocumentCommercial.mentionsPiece`). */
  mentions?: string[] | null;
  /** Taxes additionnelles sur le HT, hors base de TVA (« Taxe Pub » 2 %). */
  taxes?: TaxeAdditionnelle[] | null;
  livraison?: { adresse?: string | null; delai?: string | null; date?: string | null } | null;
  notes?: string | null;
  /** Un papier en-tête Word précis de la société, à la place de celui du profil. */
  letterheadId?: string | null;
  /** La pièce Legal dont celle-ci découle (le devis d'un BC, le BC d'une facture). */
  chainFromId?: string | null;
  /** Le dossier du Drive personnel. Vide = « Documents Adam ». */
  dossier?: string | null;
  /** Émettre même si une pièce au contenu identique existe déjà. */
  forcerDoublon?: boolean;
  sansPdf?: boolean;
  /**
   * BON DE COMMANDE composé depuis « Demandes de validations » : il naît EN PRÉ-VALIDATION — aucun centre ne le voit
   * tant que le demandeur n'a pas demandé la validation finale (`bons-de-commande/prevalidation.ts`).
   */
  prevalidation?: boolean;
  /**
   * Pour une pièce au REGISTRE COMMUN NNN/DG/AAAA (`ApercuDocument.surRegistre`) : la référence choisie à la génération
   * (ex. « 040/DG/2026 »), unique pour la société et l'année, tous documents confondus. Vide = le prochain numéro libre.
   */
  numeroChoisi?: string | null;
}

/** Ce que le registre garde de la pièce, sous `LegalDocument.custom.fabrique`. */
export interface Fabrique {
  version: number;
  etat: "EN_COURS" | "EMIS";
  type: TypeDocumentCommercial;
  empreinte: string;
  societeId: string;
  numero: string;
  spec: SpecDocumentCommercial;
  totaux: ResumeTotaux;
  docx: { nodeId: string; version: number } | null;
  /** `methode` : « editeur » = imprimé par l'éditeur Office du serveur ; « rendu » = redessiné ici (repli). */
  pdf: { nodeId: string; version: number; pages: number; methode?: MethodePdf } | null;
  surPapierEnTete: boolean;
  papierEnTeteId: string | null;
  emisPar: string;
  emisLe: string;
  historique: { version: number; le: string; par: string; resume: string; numeroSeul?: boolean }[];
}

interface ResumeTotaux { totalHt: number; totalTva: number; totalTaxes?: number; timbre: number; totalTtc: number; enLettres: string }

export const resumeTotaux = (t: TotauxCommerciaux): ResumeTotaux => ({ totalHt: t.totalHt, totalTva: t.totalTva, totalTaxes: t.totalTaxes, timbre: t.timbre, totalTtc: t.totalTtc, enLettres: t.enLettres });

export type MethodePdf = "editeur" | "rendu";

/** Le nombre de pages d'un PDF, lu dans ses objets — suffisant pour le dire, sans ouvrir un moteur. */
const compterPagesPdf = (pdf: Buffer): number => {
  const m = pdf.toString("latin1").match(/\/Type\s*\/Page(?![s\w])/g);
  return Math.max(1, m ? m.length : 1);
};

/**
 * LE PDF DE LA PIÈCE — par l'ÉDITEUR OFFICE du serveur quand il est configuré (l'impression
 * fidèle du .docx, papier en-tête compris), sinon par le RENDU de ce dépôt (`docxToPdf`), qui
 * redessine texte, tableaux, en-tête et pied. La méthode VOYAGE avec le fichier : « le PDF
 * existe » ne dit pas la même chose selon qui l'a imprimé (§118.121), et c'est à l'écran de le
 * dire. Un échec de l'éditeur retombe sur le rendu : ajouter un chemin ne doit pas retirer celui
 * qui marchait.
 */
export async function pdfDeLaPiece(user: CurrentUser, docx: { nodeId: string; version: number }, octets: Buffer): Promise<{ ok: true; pdf: Buffer; pages: number; methode: MethodePdf } | { ok: false; error: string }> {
  if (convertConfigured()) {
    try {
      const token = makeFileReadToken(docx.nodeId, user.id, 300);
      const pdf = await convertDocument({ srcUrl: `${appBaseUrl()}/api/onlyoffice/file?token=${token}`, fromExt: "docx", outputType: "pdf", key: `fabrique_${docx.nodeId}_${docx.version}` });
      if (pdf.length > 0) return { ok: true, pdf, pages: compterPagesPdf(pdf), methode: "editeur" };
    } catch (e) {
      console.error("[fabrique] impression PDF par l'éditeur Office échouée — repli sur le rendu du serveur", e);
    }
  }
  const r = await docxToPdf(octets);
  return r.ok ? { ok: true, pdf: r.pdf, pages: r.pages, methode: "rendu" } : r;
}

/** La réserve à dire quand le PDF est un rendu du serveur — et rien quand l'éditeur l'a imprimé. */
export const reservePdf = (methode: MethodePdf, surPapierEnTete: boolean): string | null =>
  methode === "editeur"
    ? null
    : surPapierEnTete
      ? "Le PDF est un rendu du serveur : l'en-tête et le pied du papier y sont redessinés (logo, textes, couleurs), pas imprimés par un traitement de texte — le .docx fait foi pour l'impression officielle."
      : "Le PDF est un rendu du serveur du .docx ; le .docx fait foi pour l'impression.";

export interface DocumentEmis {
  ok: true;
  /** Vrai quand une pièce au contenu identique existait déjà : elle est rendue, rien n'est émis. */
  dejaEmis: boolean;
  /** Vrai quand une émission interrompue (numérotée, sans fichier) a été terminée. */
  repris: boolean;
  legalDocumentId: string;
  reference: string;
  type: TypeDocumentCommercial;
  version: number;
  societe: { id: string; nom: string };
  tiers: string;
  docx: { nodeId: string; nom: string; version: number };
  pdf: { nodeId: string; nom: string; pages: number; methode: MethodePdf } | null;
  totaux: ResumeTotaux;
  surPapierEnTete: boolean;
  avertissements: string[];
  /** Les règles Teach Adam qui ont réglé la pièce (préfixe, validité, TVA…), pour le dire. */
  reglesAppliquees: { id: string; cle: string; effet: string }[];
  /**
   * LA PORTE D'UN BON DE COMMANDE (§118.148) — `null` pour un devis ou une facture.
   *
   * « Émis » veut dire « composé, numéroté, inscrit » ; ce n'est PAS « validé ». Un BC que son
   * centre n'a pas encore validé n'engage pas la société, et la phrase qui l'annonce doit le dire
   * (`reserveBC`) — sinon il part chez le fournisseur parce qu'il en a l'air.
   */
  porteBC: PorteBC | null;
  /**
   * LA PHRASE qui accompagne un BC émis (§118.148), calculée ICI, une fois. Deux écrans
   * l'affichent — l'action des Finances et l'outil d'Adam — et chacun la recalculait depuis
   * `porteBC` : deux vérités sur la même réserve (§118.5), et toutes deux oubliaient le cas où
   * PERSONNE ne siège au centre (la porte est `null`, la réserve aussi, et le BC partait sans un
   * mot). La rendre d'ici permet aussi à l'outil d'Adam de ne plus importer la règle du socle :
   * le cliquet de frontière a compté 430 pour 428 quand il le faisait (§118.114).
   */
  reserveBonDeCommande: string | null;
  /**
   * UNE RÉVISION QUI NE CHANGE QUE LE NUMÉRO (Direction, 14/10/2026) : le BC garde son état — aucun réaiguillage, étapes et
   * signature conservées. Décidé au serveur en comparant l'enregistré et le soumis (`bons-de-commande/numero-seul.ts`).
   */
  numeroSeul?: boolean;
  ms: number;
}

/**
 * La réserve d'un BC : aucune porte posée (et pourquoi), ce que dit sa porte, ou l'attente de la
 * signature des Finances (§118.149). Rien pour un BC signé.
 */
export function reserveDuBC(a: Parameters<typeof reserveDeLAiguillage>[0]): string | null {
  return reserveDeLAiguillage(a);
}

export function fabriqueDe(custom: Prisma.JsonValue | null): Fabrique | null {
  if (!custom || typeof custom !== "object" || Array.isArray(custom)) return null;
  const f = (custom as Record<string, unknown>).fabrique;
  return f && typeof f === "object" && !Array.isArray(f) && typeof (f as Fabrique).numero === "string" ? (f as unknown as Fabrique) : null;
}

const aujourdhui = (): string => new Date().toISOString().slice(0, 10);

const present = (v: string | null | undefined): v is string => !!v && v.trim() !== "";

export const nomFichier = (numero: string, tiers: string, ext: string): string => `${numero} — ${tiers.trim().replace(/[\\/:*?"<>|]+/g, " ").slice(0, 60)}.${ext}`;

/**
 * LES COORDONNÉES CHOISIES, nettoyées : seules les clés présentes restent, une valeur vide devient `null` (rien
 * d'imprimé). `null` quand rien n'est choisi — la pièce suit la carte de SA société, jamais celle d'une autre.
 */
export function coordonneesChoisies(c: CoordonneesEmetteur | null | undefined): CoordonneesEmetteur | null {
  if (!c || typeof c !== "object") return null;
  const propre = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
  const a = Object.prototype.hasOwnProperty.bind(c);
  const r: CoordonneesEmetteur = {
    ...(a("adresse") ? { adresse: propre(c.adresse) } : {}),
    ...(a("telephone") ? { telephone: propre(c.telephone) } : {}),
    ...(a("email") ? { email: propre(c.email) } : {}),
  };
  return Object.keys(r).length ? r : null;
}

/** L'ÉMETTEUR tel que la pièce l'imprime : la carte de la société, et par-dessus les coordonnées choisies pour la pièce. */
export function emetteurDeLaPiece(p: ProfilDocumentaire, c: CoordonneesEmetteur | null): PartieCommerciale {
  return c ? { ...p.identite, ...c } : p.identite;
}

/** Les mentions de la pièce, nettoyées : une par ligne, sans vide ; `null` quand il n'y en a pas. */
export function mentionsNettoyees(m: string[] | null | undefined): string[] | null {
  const l = Array.isArray(m) ? m.map((x) => String(x ?? "").trim()).filter(Boolean).slice(0, 12) : [];
  return l.length ? l : null;
}

/** Le signataire choisi, nettoyé : un nom vide n'est pas un signataire (`null`). */
export function signataireChoisi(s: { nom?: string | null; qualite?: string | null } | null | undefined): { nom: string; qualite: string | null } | null {
  const nom = (s?.nom ?? "").trim();
  return nom ? { nom, qualite: (s?.qualite ?? "").trim() || null } : null;
}

/** Le PIED de la pièce : la note du profil, puis les mentions de la marque — coordonnées de la pièce comprises —, puis les siennes. */
export function piedDePageDe(p: ProfilDocumentaire, c: CoordonneesEmetteur | null, mentionsPiece: string[] | null = null): string[] | null {
  const lignes = [...(p.reglages.footerNote ? [p.reglages.footerNote] : []), ...mentionsDe(p.marque, p.identite, c), ...(mentionsPiece ?? [])].filter(Boolean);
  return lignes.length ? lignes : null;
}

/**
 * LES COORDONNÉES QUE LA SOCIÉTÉ IMPRIME PAR DÉFAUT — ce que l'écran de composition pré-remplit : le siège de la carte
 * Legal, le téléphone et l'e-mail de la marque sinon de la carte. Rien d'autre : une société sans e-mail n'en imprime pas.
 */
export function coordonneesParDefaut(p: ProfilDocumentaire): { adresse: string | null; telephone: string | null; email: string | null } {
  return {
    adresse: p.identite.adresse?.trim() || null,
    telephone: p.marque.coordonnees.telephone?.trim() || p.identite.telephone?.trim() || null,
    email: p.marque.coordonnees.email?.trim() || p.identite.email?.trim() || null,
  };
}

/** La spécification (sans numéro) telle que la fabrique la compose depuis la demande et le profil. */
export function specDepuisDemande(d: DemandeDocument, p: ProfilDocumentaire): Omit<SpecDocumentCommercial, "numero"> {
  const date = (d.date ?? "").trim() || aujourdhui();
  const validite = d.validiteJours ?? p.reglages.quoteValidityDays;
  const coordonnees = coordonneesChoisies(d.coordonneesEmetteur);
  const mentionsPiece = mentionsNettoyees(d.mentions);
  return {
    type: d.type,
    date,
    emetteur: emetteurDeLaPiece(p, coordonnees),
    // Le CHOIX est gardé (pas seulement son effet) : une révision le reprend au lieu de revenir à la carte.
    ...(coordonnees ? { coordonneesEmetteur: coordonnees } : {}),
    ...(mentionsPiece ? { mentionsPiece } : {}),
    tiers: { ...d.tiers, nom: (d.tiers?.nom ?? "").trim() },
    lignes: (d.lignes ?? []).map((l) => ({
      ...l, designation: String(l.designation ?? "").trim(),
      // Une SECTION n'a ni quantité ni prix : on n'en invente pas, on les met à zéro et le calcul les ignore.
      ...(l.section ? { section: true, quantite: 0, prixUnitaire: 0 } : {}),
      details: Array.isArray(l.details) ? l.details.map((x) => String(x ?? "").trim()).filter(Boolean) : null,
    })),
    tvaDefaut: d.tvaDefaut ?? p.reglages.vatRate,
    remiseGlobale: d.remiseGlobale ?? null,
    // UN AVOIR NE SE PAIE PAS (§118.195) : ni mode, ni conditions, ni timbre — il crédite.
    modePaiement: d.type === "AVOIR" ? null : d.modePaiement ?? (d.type === "FACTURE" ? "VIREMENT" : null),
    conditionsPaiement: d.type === "AVOIR" ? null : d.conditionsPaiement ?? p.reglages.paymentTerms,
    echeance: d.type === "FACTURE" ? (d.echeance ?? null) : null,
    validiteJours: d.type === "DEVIS" ? validite : null,
    objet: d.objet ?? null,
    referenceAmont: d.referenceAmont ?? null,
    referenceAmontDate: (d.referenceAmontDate ?? "").trim() || null,
    numeroClient: (d.numeroClient ?? "").trim() || null,
    contact: d.contact && (present(d.contact.nom) || present(d.contact.telephone)) ? { nom: d.contact.nom?.trim() || null, telephone: d.contact.telephone?.trim() || null } : null,
    taxes: Array.isArray(d.taxes) && d.taxes.length ? d.taxes.map((x) => ({ libelle: String(x.libelle ?? "").trim(), taux: Number(x.taux) })) : null,
    livraison: d.livraison ?? null,
    notes: d.notes ?? null,
    // LA MARQUE tranche : le signataire du type de pièce, sinon celui par défaut, sinon celui du
    // profil ; les mentions choisies par la société s'ajoutent à la note de pied ; l'accent est
    // celui de la charte (marque > bleu canard de la maison).
    // Un signataire CHOISI pour la pièce l'emporte ; `null` choisi = aucun.
    signataire: d.signataire !== undefined
      ? signataireChoisi(d.signataire)
      : signatairePour(p.marque, d.type === "AVOIR" ? "FACTURE" : d.type, p.reglages.signatoryName ? { nom: p.reglages.signatoryName, qualite: p.reglages.signatoryTitle } : null),
    piedDePage: piedDePageDe(p, coordonnees, mentionsPiece),
    couleur: p.charte.accent,
  };
}

/** La même composition, offerte aux TESTS : rejouer la spec d'une demande sans numéroter ni écrire au registre. */
export const specDepuisDemandePourTest = (d: Partial<DemandeDocument> & { type: TypeDocumentCommercial }, p: ProfilDocumentaire): Omit<SpecDocumentCommercial, "numero"> =>
  specDepuisDemande(d as DemandeDocument, p);

export function echeanceLegale(spec: Omit<SpecDocumentCommercial, "numero">): Date | null {
  if (spec.type === "FACTURE" && spec.echeance) return new Date(`${spec.echeance}T00:00:00Z`);
  if (spec.type === "DEVIS") return new Date(`${ajouterJours(spec.date, spec.validiteJours ?? 30)}T00:00:00Z`);
  return null;
}

/** Le compteur avance ATOMIQUEMENT : deux émissions parallèles ne peuvent pas lire le même `last`. */
export async function attribuerNumero(tx: Prisma.TransactionClient, companyId: string, kind: string, year: number, depart: number): Promise<number> {
  // LE DÉPART EST UN PLANCHER (`departDe`) : la première ligne de la série vaut le départ, les suivantes
  // `max(dernier + 1, départ)` — un départ plus bas que le compteur ne le fait jamais reculer.
  const rows = await tx.$queryRaw<{ last: number }[]>`
    INSERT INTO "DocumentSequence" ("id", "companyId", "kind", "year", "last", "updatedAt")
    VALUES (${randomUUID()}, ${companyId}, ${kind}, ${year}, ${depart}::int, now())
    ON CONFLICT ("companyId", "kind", "year")
    DO UPDATE SET "last" = GREATEST("DocumentSequence"."last" + 1, ${depart}::int), "updatedAt" = now()
    RETURNING "last"`;
  return Number(rows[0].last);
}
