/**
 * ═════════════════════════════════════════════════════════════════
 * UNE PIÈCE ÉMISE PAR LA PLATEFORME — ce que son FICHIER porte, et que le formulaire Legal ne
 * réécrit donc pas (§118.194 — audit 360°, R15).
 *
 * La fabrique (`platform/in-process/artifact/factory.ts`) émet devis, bons de commande et factures :
 * un numéro, un Word et un PDF dans le Drive, et la pièce au registre Legal. Le formulaire générique
 * de la fiche Legal changeait pourtant le montant, la partie, le numéro ou les dates SANS régénérer le
 * fichier : la fiche disait un montant, la pièce partie chez le fournisseur en disait un autre — et
 * c'est la fiche qui part au règlement. Ces champs sont désormais ceux du fichier : une vraie
 * correction passe par la RÉVISION (même numéro, nouvelle version, historique), qui réécrit les deux
 * ensemble.
 *
 * Module PUR, zéro import : la fiche (serveur), son formulaire et l'action le lisent — deux copies de
 * « quels champs le fichier porte » finiraient par en oublier un (§118.5).
 * ═════════════════════════════════════════════════════════════════
 */

export type TypePieceEmise = "DEVIS" | "BON_DE_COMMANDE" | "FACTURE" | "AVOIR";

/** Ce que l'on sait d'une pièce émise, lu dans `custom.fabrique` — `null` pour une pièce déposée. */
export interface FaitsPieceEmise {
  type: TypePieceEmise;
  numero: string;
  version: number;
}

const TYPES: readonly string[] = ["DEVIS", "BON_DE_COMMANDE", "FACTURE", "AVOIR"];

/** La pièce a-t-elle été émise par la fabrique ? On ne devine rien : sans type ni numéro lisibles, `null`. */
export function pieceEmise(custom: unknown): FaitsPieceEmise | null {
  if (!custom || typeof custom !== "object" || Array.isArray(custom)) return null;
  const f = (custom as { fabrique?: unknown }).fabrique;
  if (!f || typeof f !== "object" || Array.isArray(f)) return null;
  const { type, numero, version } = f as { type?: unknown; numero?: unknown; version?: unknown };
  if (typeof type !== "string" || !TYPES.includes(type) || typeof numero !== "string" || !numero.trim()) return null;
  return { type: type as TypePieceEmise, numero, version: typeof version === "number" && Number.isInteger(version) && version > 0 ? version : 1 };
}

/** Les champs du registre que le FICHIER porte — et leur nom dans une phrase. */
export interface ValeursDuFichier {
  amount: number | null;
  reference: string | null;
  kind: string;
  startDate: Date | null;
  endDate: Date | null;
  direction: string | null;
  counterpartyIds: string[];
}
export type ChampDuFichier = keyof ValeursDuFichier;

export const LIBELLE_CHAMP_DU_FICHIER: Record<ChampDuFichier, string> = {
  amount: "le montant",
  reference: "le numéro",
  kind: "la nature",
  startDate: "la date",
  endDate: "l'échéance",
  direction: "le sens de l'argent",
  counterpartyIds: "la partie",
};

/** Le jour d'une date, dans le fuseau du serveur — celui où le formulaire l'a écrite et la relit. */
function jour(d: Date | null): string | null {
  if (!d || Number.isNaN(d.getTime())) return null;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const memeTexte = (a: string | null, b: string | null): boolean => (a ?? "").trim() === (b ?? "").trim();
const memeMontant = (a: number | null, b: number | null): boolean =>
  a === null || b === null ? a === b : Math.abs(a - b) < 0.005;
const memesIds = (a: string[], b: string[]): boolean => {
  const x = [...a].sort();
  const y = [...b].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

/**
 * Les champs du fichier que la demande CHANGE. Ce que le formulaire ne porte pas (`porte(champ)`
 * faux) ne change rien — il garde sa valeur (§118.152). Ce qu'il porte à l'identique non plus :
 * le formulaire pré-rempli renvoie le montant tel qu'il l'a lu, et ce n'est pas une modification.
 */
export function champsDuFichierChanges(
  avant: ValeursDuFichier,
  demande: ValeursDuFichier,
  porte: (champ: ChampDuFichier) => boolean,
): ChampDuFichier[] {
  const changes: ChampDuFichier[] = [];
  if (porte("amount") && !memeMontant(avant.amount, demande.amount)) changes.push("amount");
  if (porte("reference") && !memeTexte(avant.reference, demande.reference)) changes.push("reference");
  if (porte("kind") && avant.kind !== demande.kind) changes.push("kind");
  if (porte("startDate") && jour(avant.startDate) !== jour(demande.startDate)) changes.push("startDate");
  if (porte("endDate") && jour(avant.endDate) !== jour(demande.endDate)) changes.push("endDate");
  if (porte("direction") && (avant.direction ?? null) !== (demande.direction ?? null)) changes.push("direction");
  if (porte("counterpartyIds") && !memesIds(avant.counterpartyIds, demande.counterpartyIds)) changes.push("counterpartyIds");
  return changes;
}

const liste = (mots: string[]): string =>
  mots.length <= 1 ? (mots[0] ?? "") : `${mots.slice(0, -1).join(", ")} et ${mots[mots.length - 1]}`;

/**
 * LE GESTE QUI CORRIGE une pièce émise, dit là où on le cherche. Un devis et un bon de commande se
 * RÉVISENT (même numéro, nouvelle version). Une facture émise ne se réécrit pas : un AVOIR la corrige,
 * en totalité ou en partie, sous son propre numéro (§118.195). Un avoir non plus : il s'annule, motif à
 * l'appui, et un autre s'émet depuis la facture.
 */
export function remedePieceEmise(p: FaitsPieceEmise): string {
  if (p.type === "FACTURE") return `une facture émise ne se réécrit pas : « Émettre un avoir », sur sa fiche, la corrige en totalité ou en partie, sous son propre numéro.`;
  if (p.type === "AVOIR") return `un avoir émis ne se réécrit pas : annulez-le (motif à l'appui), puis émettez-en un autre depuis la fiche de la facture.`;
  return `« Réviser la pièce » en produit une nouvelle version, sous le même numéro — le fichier et la fiche restent d'accord.`;
}

/** Une pièce émise qui ne se RÉVISE pas : la facture et l'avoir, pièces fiscales — on les corrige par une autre pièce. */
export function pieceDefinitive(type: TypePieceEmise): type is "FACTURE" | "AVOIR" {
  return type === "FACTURE" || type === "AVOIR";
}

/** Le refus du formulaire générique sur un champ que le fichier porte — nommé, avec son remède (§118.30). */
export function refusChampsDuFichier(p: FaitsPieceEmise, champs: ChampDuFichier[]): string {
  const noms = liste(champs.map((c) => LIBELLE_CHAMP_DU_FICHIER[c]));
  const article = p.type === "FACTURE" ? "Cette facture a été émise" : p.type === "AVOIR" ? "Cet avoir a été émis" : "Cette pièce a été émise";
  return `${article} par la plateforme (${p.numero}) : ${noms} ${champs.length > 1 ? "viennent" : "vient"} de son fichier, et ce formulaire ne ${champs.length > 1 ? "les" : "le"} réécrit pas — ${remedePieceEmise(p)}`;
}

/**
 * CE QUI, EN AVAL, FIGE UNE PIÈCE ÉMISE (§118.194) — les natures du registre Legal qui DÉCOULENT d'elle
 * commercialement. Réviser un bon de commande déjà facturé changerait la commande sous la facture qui en
 * découle ; réviser un devis déjà commandé (ou facturé), le devis sous la pièce qui en découle. Un courrier ou
 * un contrat « faisant suite » à un bon de commande ne facture rien : il ne fige rien.
 */
export const AVAL_QUI_FIGE: Record<TypePieceEmise, readonly string[]> = {
  DEVIS: ["PURCHASE_ORDER", "INVOICE"],
  BON_DE_COMMANDE: ["INVOICE"],
  // Une facture et un avoir ne se révisent pas du tout (`pieceDefinitive`) : rien en aval n'a à les figer.
  FACTURE: [],
  AVOIR: [],
};

const NATURE_AVAL: Record<string, { article: string; nom: string }> = {
  INVOICE: { article: "Une facture", nom: "la facture" },
  PURCHASE_ORDER: { article: "Un bon de commande", nom: "le bon de commande" },
};

/**
 * Le refus d'une révision retenue par ce qui en découle — la nature de la pièce aval est NOMMÉE, jamais
 * supposée, et le geste qui lève le refus aussi : c'est la pièce aval qui se corrige, ou s'annule, et alors
 * l'amont redevient révisable.
 */
export function refusRevisionAval(type: TypePieceEmise, aval: { kind: string; reference: string | null }): string {
  const ref = aval.reference?.trim() ? ` (${aval.reference.trim()})` : "";
  const n = NATURE_AVAL[aval.kind] ?? { article: "Une pièce", nom: "la pièce" };
  const amont = type === "BON_DE_COMMANDE" ? "ce bon de commande" : "ce devis";
  const lui = type === "BON_DE_COMMANDE" ? "le bon de commande" : "le devis";
  return `${n.article} découle déjà de ${amont}${ref} : il ne se révise plus. Annulez d'abord ${n.nom} qui en découle — ${lui} redeviendra révisable.`;
}

/**
 * LA PIÈCE DONT UNE PIÈCE ÉMISE DÉCOULE (audit 360°, lot D1c — F1) — le pendant d'`AVAL_QUI_FIGE`, lu dans
 * l'autre sens : un bon de commande suit un devis ; une facture suit un devis ou un bon de commande ; un avoir
 * suit SA facture (relue par la fabrique, `factureDeLAvoir`) ; un devis ne suit rien.
 *
 * Le compositeur n'envoyait jamais la pièce amont, et la fabrique n'en vérifiait que l'existence et la société :
 * un BC pouvait « suivre » une facture, un devis annulé, ou — par un identifiant forgé — un devis que la personne
 * ne lit pas. Un BC non chaîné à son devis part au mauvais centre de validation (son origine se lit sur le devis)
 * et laisse le devis révisable sous lui. La fabrique (refus), le compositeur (son menu) et son chargeur lisent
 * cette table — une seule (§118.5).
 */
export const NATURES_AMONT: Record<TypePieceEmise, readonly string[]> = {
  DEVIS: [],
  BON_DE_COMMANDE: ["QUOTE"],
  FACTURE: ["QUOTE", "PURCHASE_ORDER"],
  AVOIR: ["INVOICE"],
};

/** La pièce amont introuvable — ou illisible pour la personne : la MÊME phrase, pour ne rien révéler (§118.71). */
export const PIECE_AMONT_INTROUVABLE = "La pièce amont (devis / bon de commande) n'existe plus.";

const NATURE_ARTICLE: Record<string, string> = {
  QUOTE: "un devis", PURCHASE_ORDER: "un bon de commande", INVOICE: "une facture", CREDIT_NOTE: "un avoir",
  CONTRACT: "un contrat", AMENDMENT: "un avenant",
};

const TYPE_AMONT: Record<TypePieceEmise, { article: string; suit: string; dont: string }> = {
  DEVIS: { article: "Un devis", suit: "", dont: "" },
  BON_DE_COMMANDE: { article: "Un bon de commande", suit: "un devis", dont: "choisissez le devis dont il découle, ou aucune pièce" },
  FACTURE: { article: "Une facture", suit: "un devis ou à un bon de commande", dont: "choisissez la pièce dont elle découle, ou aucune" },
  AVOIR: { article: "Un avoir", suit: "sa facture", dont: "émettez-le depuis la fiche de la facture" },
};

/**
 * Peut-on émettre une pièce de ce type À LA SUITE de cette pièce ? La NATURE d'abord, le statut ensuite ;
 * `null` = elle se suit. La lecture (et l'absence) se jugent AVANT, chez l'appelant — avec la phrase de
 * l'absence, pour qu'un identifiant forgé n'apprenne rien de la pièce qu'il désigne.
 */
export function refusPieceAmont(type: TypePieceEmise, amont: { kind: string; status: string; nom: string }): string | null {
  const t = TYPE_AMONT[type];
  if (NATURES_AMONT[type].length === 0) return `${t.article} ne fait suite à aucune pièce : retirez la pièce amont.`;
  if (!NATURES_AMONT[type].includes(amont.kind)) {
    return `${t.article} fait suite à ${t.suit} : la pièce « ${amont.nom} » est ${NATURE_ARTICLE[amont.kind] ?? "d'une autre nature"} — ${t.dont}.`;
  }
  if (amont.status === "CANCELLED") {
    return `La pièce « ${amont.nom} » est annulée : une pièce ne fait pas suite à une pièce annulée — choisissez la pièce en vigueur, ou aucune.`;
  }
  return null;
}

/**
 * La pièce IDENTIQUE déjà émise, rendue au lieu d'une nouvelle (§118.135) — et la pièce amont demandée qu'elle
 * ne porte pas, DITE : sans cette phrase, réémettre un BC identique AVEC son devis rendait l'ancien, non
 * chaîné, sans un mot. `null` quand rien n'est demandé, ou que la pièce rendue porte déjà cette pièce amont.
 */
export function phrasePieceAmontNonRattachee(numero: string, amontExistant: string | null, amontDemande: string | null): string | null {
  if (!amontDemande || amontDemande === amontExistant) return null;
  return `La pièce identique ${numero} ${amontExistant ? "fait suite à une autre pièce" : "ne fait suite à aucune pièce"} : la pièce amont demandée ne lui a pas été rattachée — ouvrez sa fiche, « Modifier » › « Fait suite à ».`;
}

/** Ce que l'écran de révision pré-remplit, lu dans la spécification de la version courante. */
export interface SpecRevisable {
  lignes: {
    designation: string; details: string[]; quantite: number; prixUnitaire: number;
    remise: number | null; tva: number | null; section: boolean;
  }[];
  objet: string | null;
  notes: string | null;
  validiteJours: number | null;
  livraison: { adresse: string | null; delai: string | null } | null;
  contact: { nom: string | null; telephone: string | null } | null;
}

const chaine = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const nombreOuNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * La spécification d'une pièce émise, telle que la révision la REPREND — `null` quand elle ne se lit pas.
 * Une ligne dont la désignation n'est pas un texte n'est pas inventée : elle est écartée, et la révision
 * ne la réécrira pas sans qu'on la voie.
 */
export function specRevisable(custom: unknown): SpecRevisable | null {
  if (!pieceEmise(custom)) return null;
  const spec = ((custom as { fabrique: { spec?: unknown } }).fabrique.spec ?? null) as Record<string, unknown> | null;
  if (!spec || typeof spec !== "object") return null;
  const brutes = Array.isArray(spec.lignes) ? spec.lignes : [];
  const lignes = brutes.flatMap((l) => {
    if (!l || typeof l !== "object") return [];
    const x = l as Record<string, unknown>;
    if (typeof x.designation !== "string") return [];
    return [{
      designation: x.designation,
      details: Array.isArray(x.details) ? x.details.filter((d): d is string => typeof d === "string") : [],
      quantite: nombreOuNull(x.quantite) ?? 0,
      prixUnitaire: nombreOuNull(x.prixUnitaire) ?? 0,
      remise: nombreOuNull(x.remise),
      tva: nombreOuNull(x.tva),
      section: x.section === true,
    }];
  });
  const liv = spec.livraison && typeof spec.livraison === "object" ? (spec.livraison as Record<string, unknown>) : null;
  const ctc = spec.contact && typeof spec.contact === "object" ? (spec.contact as Record<string, unknown>) : null;
  return {
    lignes,
    objet: chaine(spec.objet),
    notes: chaine(spec.notes),
    validiteJours: nombreOuNull(spec.validiteJours),
    livraison: liv ? { adresse: chaine(liv.adresse), delai: chaine(liv.delai) } : null,
    contact: ctc ? { nom: chaine(ctc.nom), telephone: chaine(ctc.telephone) } : null,
  };
}

/**
 * CE QUE LE COMPOSEUR PRÉ-REMPLIT pour « Modifier la pièce » (Direction, 10/2026 — « modifiables totalement, de A à Z ») :
 * TOUTE la spécification de la version courante, en valeurs d'écran (textes, pourcentages en « 19 », pas en 0,19). Le
 * composeur rouvre ainsi la pièce telle qu'elle a été émise — tiers, lignes, dates, références, paiement, TVA, remise,
 * taxes, livraison, contact, notes, papier et coordonnées imprimées de l'émetteur — et la révision écrit ce qu'il montre.
 */
export interface ValeursComposables {
  tiers: { nom: string; adresse: string; telephone: string; email: string; rc: string; nif: string; ai: string; nis: string };
  champs: {
    numeroClient: string; date: string; echeance: string; validiteJours: string; objet: string; referenceAmont: string; referenceAmontDate: string;
    contactNom: string; contactTelephone: string; livraisonAdresse: string; livraisonDelai: string; modePaiement: string; conditionsPaiement: string;
    tvaDefaut: string; remiseGlobale: string; notes: string;
  };
  lignes: { designation: string; details: string; quantite: string; prix: string; remise: string; tva: string; section: boolean }[];
  taxes: { libelle: string; taux: string }[];
  /** Le papier de l'émission (`""` = celui du profil). */
  letterheadId: string;
  /** Les coordonnées choisies pour la pièce ; `null` = celles de la société émettrice (rien n'avait été choisi). */
  emetteur: { adresse: string; telephone: string; email: string } | null;
  /** Le signataire imprimé sur la version courante (`null` : aucun). */
  signataire: { nom: string; qualite: string } | null;
  /** Les mentions propres à la pièce, une par ligne. */
  mentions: string;
}

const texteEcran = (v: unknown): string => (typeof v === "string" ? v : "");
const nombreEcran = (v: unknown): string => (typeof v === "number" && Number.isFinite(v) ? String(v) : "");
/** 0,19 → « 19 » ; 0,025 → « 2.5 » — arrondi au centième de point, pour ne pas montrer 19.000000000000004. */
const pourcentEcran = (v: unknown): string => (typeof v === "number" && Number.isFinite(v) ? String(Math.round(v * 10000) / 100) : "");
const objetLu = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export function valeursComposables(custom: unknown): ValeursComposables | null {
  if (!pieceEmise(custom)) return null;
  const f = (custom as { fabrique: Record<string, unknown> }).fabrique;
  const spec = objetLu(f.spec);
  if (!f.spec || typeof f.spec !== "object") return null;
  const tiers = objetLu(spec.tiers);
  const contact = objetLu(spec.contact);
  const livraison = objetLu(spec.livraison);
  const lignes = (Array.isArray(spec.lignes) ? spec.lignes : []).flatMap((l) => {
    const x = objetLu(l);
    if (typeof x.designation !== "string") return [];
    const section = x.section === true;
    return [{
      designation: x.designation,
      details: Array.isArray(x.details) ? x.details.filter((d): d is string => typeof d === "string").join("\n") : "",
      quantite: section ? "" : nombreEcran(x.quantite),
      prix: section ? "" : nombreEcran(x.prixUnitaire),
      remise: pourcentEcran(x.remise),
      tva: pourcentEcran(x.tva),
      section,
    }];
  });
  const taxes = (Array.isArray(spec.taxes) ? spec.taxes : []).flatMap((t) => {
    const x = objetLu(t);
    return typeof x.libelle === "string" ? [{ libelle: x.libelle, taux: pourcentEcran(x.taux) }] : [];
  });
  const choisies = spec.coordonneesEmetteur && typeof spec.coordonneesEmetteur === "object" ? objetLu(spec.coordonneesEmetteur) : null;
  const emetteur = objetLu(spec.emetteur);
  const signataire = objetLu(spec.signataire);
  return {
    tiers: {
      nom: texteEcran(tiers.nom), adresse: texteEcran(tiers.adresse), telephone: texteEcran(tiers.telephone), email: texteEcran(tiers.email),
      rc: texteEcran(tiers.rc), nif: texteEcran(tiers.nif), ai: texteEcran(tiers.ai), nis: texteEcran(tiers.nis),
    },
    champs: {
      numeroClient: texteEcran(spec.numeroClient), date: texteEcran(spec.date), echeance: texteEcran(spec.echeance),
      validiteJours: nombreEcran(spec.validiteJours), objet: texteEcran(spec.objet), referenceAmont: texteEcran(spec.referenceAmont),
      referenceAmontDate: texteEcran(spec.referenceAmontDate), contactNom: texteEcran(contact.nom), contactTelephone: texteEcran(contact.telephone),
      livraisonAdresse: texteEcran(livraison.adresse), livraisonDelai: texteEcran(livraison.delai), modePaiement: texteEcran(spec.modePaiement),
      conditionsPaiement: texteEcran(spec.conditionsPaiement), tvaDefaut: pourcentEcran(spec.tvaDefaut), remiseGlobale: pourcentEcran(spec.remiseGlobale),
      notes: texteEcran(spec.notes),
    },
    lignes,
    taxes,
    letterheadId: typeof f.papierEnTeteId === "string" ? f.papierEnTeteId : "",
    // Un choix fait à l'émission se montre tel quel ; une clé non choisie montre ce que la pièce imprimait.
    emetteur: choisies
      ? {
        adresse: "adresse" in choisies ? texteEcran(choisies.adresse) : texteEcran(emetteur.adresse),
        telephone: "telephone" in choisies ? texteEcran(choisies.telephone) : texteEcran(emetteur.telephone),
        email: "email" in choisies ? texteEcran(choisies.email) : texteEcran(emetteur.email),
      }
      : null,
    signataire: typeof signataire.nom === "string" && signataire.nom.trim() ? { nom: signataire.nom, qualite: texteEcran(signataire.qualite) } : null,
    mentions: (Array.isArray(spec.mentionsPiece) ? spec.mentionsPiece : []).filter((x): x is string => typeof x === "string").join("\n"),
  };
}
