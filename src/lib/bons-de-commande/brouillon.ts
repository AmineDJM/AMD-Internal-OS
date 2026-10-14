import type {
  CoordonneesEmetteur, LigneCommerciale, ModePaiement, PartieCommerciale, TaxeAdditionnelle,
} from "@/lib/artifact/factory/commercial";
import { MODES_PAIEMENT } from "@/lib/artifact/factory/commercial";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE BROUILLON D'UN BON DE COMMANDE — « à vérifier par le demandeur » (Direction, 10/2026).
 *
 * « Ne pas générer et envoyer le BC direct aux Finances : il faut d'abord pré-valider le preview du BC par le
 * demandeur, avec modification possible. » Générer ne fait donc PLUS de BC : cela dépose un BROUILLON sur le devis
 * (`AdProDevis.bcBrouillon`) — ce que le demandeur relit, corrige, et ne valide qu'ensuite. Tant que le brouillon
 * existe : AUCUN numéro n'est attribué (la série NNN/DG/AAAA reste continue, sans trou), aucune pièce n'est écrite au
 * registre, rien ne part aux Finances ni au centre de validation. « Valider et envoyer aux Finances » attribue le
 * numéro, produit le Word et le PDF définitifs et lance la marche existante (visa du centre, signature).
 *
 * Module PUR (aucun import lourd) : lu par l'écran (composant client) comme par les actions serveur.
 *
 * POURQUOI ICI, sous `bons-de-commande/` et non sous `ad-pro/` : deux circuits le partagent (le poste Ad & Pro et le
 * devis de matériel promotionnel, `promo-material/bc-brouillon-promo.ts`), et il parle le vocabulaire de la pièce
 * commerciale (`artifact/factory/commercial`, domaine `office`). Logé dans le domaine `adpro`, il en faisait deux
 * traversées inter-domaines (`platform/domains.test.ts`) ; c'est la règle du BC, pas celle d'un circuit.
 * Une valeur `null` d'un champ dit « telle que le devis la donne » ; une valeur écrite remplace.
 *
 * ── L'APERÇU OBLIGATOIRE ET « ULTRA COMPLET » (Direction, 14/10/2026) ───────────────────────
 *
 * « Je veux l'aperçu obligatoire ; modification et révision possibles du BC ultra complètes, chaque détail peut être
 * modifié dans le BC. » Le brouillon se corrige dans le MÊME composeur que la révision d'un BC émis
 * (`components/pieces/composer-piece.tsx`) et porte donc EXACTEMENT ce que la révision porte (`ModificationsDocument` de
 * la fabrique) : `corrections` — fournisseur complet, date, références amont, paiement, TVA par défaut, remise globale,
 * taxes, livraison (lieu, date, délai), contact, notes, papier en-tête, coordonnées imprimées de l'émetteur, signataire,
 * mentions. Les LIGNES restent à part (`lignes` + `signature`) : c'est sur elles que se juge la péremption. Les champs
 * d'avant (`objet`, `notes`, `contact`…) restent lus pour les brouillons déjà en base ; ce que le composeur écrit les
 * recouvre (`correctionsDuBrouillon`).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const ETIQUETTE_BROUILLON = "Brouillon — à vérifier par le demandeur";

/**
 * CE QUE LE COMPOSEUR CORRIGE (hors lignes) — la forme de `ModificationsDocument` (fabrique), écrite ici avec le vocabulaire
 * de la pièce commerciale pour que ce module reste PUR (il est lu par l'écran). Une clé ABSENTE garde ce que le devis donne ;
 * présente, elle remplace (`null` efface — ou, pour le papier et les coordonnées de l'émetteur, rend ceux de la société).
 */
export interface CorrectionsBc {
  tiers?: PartieCommerciale;
  date?: string | null;
  tvaDefaut?: number | null;
  remiseGlobale?: number | null;
  modePaiement?: ModePaiement | null;
  conditionsPaiement?: string | null;
  objet?: string | null;
  referenceAmont?: string | null;
  referenceAmontDate?: string | null;
  contact?: { nom?: string | null; telephone?: string | null } | null;
  taxes?: TaxeAdditionnelle[] | null;
  livraison?: { adresse?: string | null; delai?: string | null; date?: string | null } | null;
  notes?: string | null;
  coordonneesEmetteur?: CoordonneesEmetteur | null;
  letterheadId?: string | null;
  signataire?: { nom: string; qualite?: string | null } | null;
  mentions?: string[] | null;
}

/** Ce que le composeur envoie : les corrections, et les lignes quand il en porte. */
export type SaisieBc = CorrectionsBc & { lignes?: LigneCommerciale[] };

export interface BrouillonBc {
  /** Le poste pour lequel le brouillon a été préparé. */
  itemId: string;
  /** Qui l'a préparé, et quand (ISO). */
  par: string;
  parNom: string | null;
  le: string;
  /** Dernière modification (ISO) et par qui. */
  modifieLe: string | null;
  modifiePar: string | null;
  /** Les lignes corrigées par le demandeur ; `null` = celles que les lignes validées du devis donnent. */
  lignes: LigneCommerciale[] | null;
  /** L'empreinte des lignes du devis AU MOMENT où `lignes` a été écrit : si les lignes validées bougent ensuite, le brouillon est périmé. */
  signature: string | null;
  /** « Référence » de la bande (objet du BC). */
  objet: string | null;
  notes: string | null;
  /** « Contact » de la bande. */
  contact: { nom: string | null; telephone: string | null } | null;
  /** « Modalités de paiement » de la bande : le mode, puis le texte libre. */
  modePaiement: ModePaiement | null;
  conditionsPaiement: string | null;
  /** Lieu (« Adresse de livraison »), date (ISO, mention) et délai de livraison. */
  livraison: { adresse: string | null; date: string | null; delai: string | null } | null;
  /** Le bloc « A : » du fournisseur : seuls les champs écrits remplacent ceux du devis. */
  tiers: Partial<Pick<PartieCommerciale, "nom" | "adresse" | "telephone" | "email" | "rc" | "nif">> | null;
  /** Le numéro de BC choisi par le demandeur (ex. « 040/DG/2026 ») ; `null` = attribué automatiquement à la validation. */
  numeroChoisi: string | null;
  /** TOUT ce que le composeur a corrigé hors lignes (voir `CorrectionsBc`) ; `null` = rien (ou un brouillon d'avant). */
  corrections: CorrectionsBc | null;
}

const texte = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const nombre = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const objetLu = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
/** Une clé présente se relit (même à `null`) ; absente, elle reste absente — c'est ce qui distingue « garder » de « effacer ». */
const present = (o: Record<string, unknown>, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

function ligneLue(v: unknown): LigneCommerciale | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const designation = texte(o.designation);
  if (!designation) return null;
  const section = o.section === true;
  return {
    designation,
    section,
    unite: texte(o.unite),
    details: Array.isArray(o.details) ? o.details.map(texte).filter((x): x is string => x !== null) : [],
    quantite: section ? 0 : (nombre(o.quantite) ?? Number.NaN),
    prixUnitaire: section ? 0 : (nombre(o.prixUnitaire) ?? Number.NaN),
    remise: nombre(o.remise),
    tva: nombre(o.tva),
    reference: texte(o.reference),
  };
}

/** Les corrections gardées en JSON → typées. Rien d'illisible n'est inventé : une clé mal formée est écartée. */
export function lireCorrections(brut: unknown): CorrectionsBc | null {
  const o = objetLu(brut);
  if (!o) return null;
  const c: CorrectionsBc = {};
  const t = objetLu(o.tiers);
  if (t) {
    const tiers: Record<string, string | null> & { nom: string } = { nom: typeof t.nom === "string" ? t.nom.trim() : "" };
    for (const k of ["adresse", "telephone", "email", "rc", "nif", "ai", "nis", "rib", "banque"]) if (present(t, k)) tiers[k] = texte(t[k]);
    c.tiers = tiers as PartieCommerciale;
  }
  for (const k of ["date", "conditionsPaiement", "objet", "referenceAmont", "referenceAmontDate", "notes", "letterheadId"] as const) {
    if (present(o, k)) c[k] = texte(o[k]);
  }
  for (const k of ["tvaDefaut", "remiseGlobale"] as const) if (present(o, k)) c[k] = nombre(o[k]);
  if (present(o, "modePaiement")) {
    c.modePaiement = typeof o.modePaiement === "string" && (MODES_PAIEMENT as readonly string[]).includes(o.modePaiement) ? (o.modePaiement as ModePaiement) : null;
  }
  const sousObjet = (cle: string, cles: readonly string[]): Record<string, string | null> | null => {
    const x = objetLu(o[cle]);
    return x ? Object.fromEntries(cles.filter((k) => present(x, k)).map((k) => [k, texte(x[k])])) : null;
  };
  if (present(o, "contact")) c.contact = sousObjet("contact", ["nom", "telephone"]);
  if (present(o, "livraison")) c.livraison = sousObjet("livraison", ["adresse", "delai", "date"]);
  if (present(o, "coordonneesEmetteur")) c.coordonneesEmetteur = sousObjet("coordonneesEmetteur", ["adresse", "telephone", "email"]);
  if (present(o, "signataire")) {
    const x = objetLu(o.signataire);
    const nom = x ? texte(x.nom) : null;
    c.signataire = nom ? { nom, qualite: texte(x?.qualite) } : null;
  }
  if (present(o, "mentions")) c.mentions = Array.isArray(o.mentions) ? o.mentions.map(texte).filter((x): x is string => x !== null) : null;
  if (present(o, "taxes")) {
    c.taxes = Array.isArray(o.taxes)
      ? o.taxes.flatMap((x) => { const tx = objetLu(x); return tx && typeof tx.libelle === "string" ? [{ libelle: tx.libelle.trim(), taux: nombre(tx.taux) ?? Number.NaN }] : []; })
      : null;
  }
  return c;
}

/** Le JSON gardé en base → le brouillon typé, ou `null` s'il n'y en a pas (ou s'il est illisible : on n'invente rien). */
export function lireBrouillon(brut: unknown): BrouillonBc | null {
  if (!brut || typeof brut !== "object" || Array.isArray(brut)) return null;
  const o = brut as Record<string, unknown>;
  const itemId = texte(o.itemId);
  const par = texte(o.par);
  const le = texte(o.le);
  if (!itemId || !par || !le) return null;
  const c = o.contact && typeof o.contact === "object" ? (o.contact as Record<string, unknown>) : null;
  const l = o.livraison && typeof o.livraison === "object" ? (o.livraison as Record<string, unknown>) : null;
  const t = o.tiers && typeof o.tiers === "object" ? (o.tiers as Record<string, unknown>) : null;
  const mode = typeof o.modePaiement === "string" && (MODES_PAIEMENT as readonly string[]).includes(o.modePaiement) ? (o.modePaiement as ModePaiement) : null;
  return {
    itemId, par, parNom: texte(o.parNom), le, modifieLe: texte(o.modifieLe), modifiePar: texte(o.modifiePar),
    lignes: Array.isArray(o.lignes) ? o.lignes.map(ligneLue).filter((x): x is LigneCommerciale => x !== null) : null,
    signature: texte(o.signature),
    objet: texte(o.objet), notes: texte(o.notes),
    contact: c ? { nom: texte(c.nom), telephone: texte(c.telephone) } : null,
    modePaiement: mode, conditionsPaiement: texte(o.conditionsPaiement),
    livraison: l ? { adresse: texte(l.adresse), date: texte(l.date), delai: texte(l.delai) } : null,
    tiers: t ? { nom: texte(t.nom) ?? undefined, adresse: texte(t.adresse), telephone: texte(t.telephone), email: texte(t.email), rc: texte(t.rc), nif: texte(t.nif) } : null,
    numeroChoisi: texte(o.numeroChoisi),
    corrections: lireCorrections(o.corrections),
  };
}

/** Un brouillon neuf : rien n'est corrigé, tout vient du devis. */
export function brouillonNeuf(p: { itemId: string; par: string; parNom: string | null; maintenant?: Date }): BrouillonBc {
  return {
    itemId: p.itemId, par: p.par, parNom: p.parNom, le: (p.maintenant ?? new Date()).toISOString(), modifieLe: null, modifiePar: null,
    lignes: null, signature: null, objet: null, notes: null, contact: null, modePaiement: null, conditionsPaiement: null, livraison: null, tiers: null,
    numeroChoisi: null, corrections: null,
  };
}

/**
 * LE BROUILLON CORRIGÉ PAR LE COMPOSEUR — ce qu'il montre est ce qui est gardé : les lignes (avec l'empreinte des lignes validées
 * qu'elles corrigent) et TOUTES les corrections. Les champs d'avant sont vidés : les corrections les recouvrent désormais.
 */
export function brouillonCorrige(b: BrouillonBc, saisie: SaisieBc, p: { lignesDuDevis: readonly LigneCommerciale[]; par: string; maintenant?: Date }): BrouillonBc {
  const { lignes, ...corrections } = saisie;
  return {
    ...b,
    lignes: lignes ?? b.lignes,
    signature: lignes ? signatureDesLignes(p.lignesDuDevis) : b.signature,
    objet: null, notes: null, contact: null, modePaiement: null, conditionsPaiement: null, livraison: null, tiers: null,
    corrections: { ...correctionsDuBrouillon(b), ...corrections },
    modifieLe: (p.maintenant ?? new Date()).toISOString(), modifiePar: p.par,
  };
}

/** L'empreinte des lignes du devis (désignation, unité, quantité, prix) : ce que le brouillon corrigé a pris pour base. */
export function signatureDesLignes(lignes: readonly LigneCommerciale[]): string {
  return lignes.map((l) => [l.designation, l.unite ?? "", l.quantite, l.prixUnitaire, l.section ? "S" : ""].join("¦")).join("§");
}

/** Le brouillon est PÉRIMÉ quand ses lignes corrigées reposent sur d'autres lignes validées que celles d'aujourd'hui. */
export function brouillonPerime(b: BrouillonBc, lignesDuDevis: readonly LigneCommerciale[]): boolean {
  return b.lignes !== null && b.signature !== signatureDesLignes(lignesDuDevis);
}

/** QUI VALIDE : le demandeur de la demande, ou le Super Admin — pas l'assistante qui a préparé, pas un autre rôle. */
export function peutValiderLeBrouillon(p: { userId: string; role: string; demandeurId: string | null | undefined }): boolean {
  return p.role === "SUPER_ADMIN" || (p.demandeurId != null && p.demandeurId === p.userId);
}

export const REFUS_VALIDATION_BROUILLON =
  "Seul le demandeur de la demande (ou le Super Admin) valide l'aperçu du bon de commande et l'envoie aux Finances.";

/** Le hors-taxe des lignes chiffrées (net de remise), en DZD. */
export function totalHtDesLignes(lignes: readonly LigneCommerciale[]): number {
  return lignes.filter((l) => !l.section).reduce((s, l) => s + l.quantite * l.prixUnitaire * (1 - (l.remise ?? 0)), 0);
}

/** Les lignes que le brouillon porte ou, à défaut, celles du devis. */
export const lignesEffectives = (b: BrouillonBc | null, duDevis: readonly LigneCommerciale[]): LigneCommerciale[] =>
  b?.lignes && b.lignes.length > 0 ? b.lignes : [...duDevis];

/**
 * CE QUE LE BROUILLON CORRIGE (hors lignes) — les champs d'avant (seuls les champs écrits remplacent), puis, PAR-DESSUS, les
 * corrections du composeur. Une seule lecture pour l'aperçu, l'émission et la révision d'un BC à régénérer (§118.5).
 */
export function correctionsDuBrouillon(b: BrouillonBc): CorrectionsBc {
  const m: CorrectionsBc = {};
  if (b.objet) m.objet = b.objet;
  if (b.notes) m.notes = b.notes;
  if (b.contact) m.contact = { ...(b.contact.nom ? { nom: b.contact.nom } : {}), ...(b.contact.telephone ? { telephone: b.contact.telephone } : {}) };
  if (b.modePaiement) m.modePaiement = b.modePaiement;
  if (b.conditionsPaiement) m.conditionsPaiement = b.conditionsPaiement;
  if (b.livraison) m.livraison = { ...(b.livraison.adresse ? { adresse: b.livraison.adresse } : {}), ...(b.livraison.date ? { date: b.livraison.date } : {}), ...(b.livraison.delai ? { delai: b.livraison.delai } : {}) };
  if (b.tiers) {
    const t = Object.fromEntries(Object.entries(b.tiers).filter(([, v]) => typeof v === "string" && v.trim()));
    if (Object.keys(t).length > 0) m.tiers = t as unknown as PartieCommerciale;
  }
  return { ...m, ...(b.corrections ?? {}) };
}

/** La forme d'une demande de BC que les corrections savent remplacer — celle de la fabrique (`DemandeDocument`). */
export type DemandeCorrigeable = Omit<CorrectionsBc, "tiers"> & { tiers: PartieCommerciale; lignes: LigneCommerciale[] };

/**
 * APPLIQUER LES CORRECTIONS À LA DEMANDE COMPOSÉE DEPUIS LE DEVIS — tout ce que le composeur a écrit l'emporte, clé par clé ;
 * le fournisseur, le contact et la livraison se FUSIONNENT (une clé absente garde la valeur du devis : le RIB de l'annuaire,
 * que le composeur ne montre pas, n'est pas perdu). `null` sur le contact ou la livraison les retire.
 */
export function appliquerCorrections<D extends DemandeCorrigeable>(d: D, c: CorrectionsBc | null | undefined): D {
  if (!c) return d;
  const { tiers, contact, livraison, ...reste } = c;
  const ecrits = Object.fromEntries(Object.entries(reste).filter(([, v]) => v !== undefined));
  return {
    ...d,
    ...ecrits,
    tiers: tiers ? { ...d.tiers, ...tiers, nom: (tiers.nom ?? "").trim() || d.tiers.nom } : d.tiers,
    ...(contact !== undefined ? { contact: contact === null ? null : { ...(d.contact ?? {}), ...contact } } : {}),
    ...(livraison !== undefined ? { livraison: livraison === null ? null : { ...(d.livraison ?? {}), ...livraison } } : {}),
  };
}
