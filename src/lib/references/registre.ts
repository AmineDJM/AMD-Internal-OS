/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE REGISTRE COMMUN DES RÉFÉRENCES NNN/DG/AAAA (Direction, 10/2026).
 *
 * « Tout document ou BC généré doit avoir la numérotation NNN/DG/AAAA » ; « commence par 040 […] pour Adventum, Pharmagene et
 * AMD, et permets de modifier les numéros de référence à la génération » ; « un compteur commun pour les références ».
 *
 *   • UN compteur par société et par année (`DocumentSequence`, kind `REGISTRE_DG`), partagé par TOUS les documents qui
 *     portent une référence : bon de commande, ordre de mission, attestation de travail, lettre de demande de devis (et toute
 *     pièce de la fabrique dont
 *     le motif porte « /DG/ »). L'année civile suivante repart à 001 (le plancher n'est réglé que pour l'année qu'il nomme).
 *   • UN registre (`DocumentReference`) : une ligne par numéro attribué, jamais supprimée — l'unicité (société, année, numéro)
 *     vaut pour tous les types à la fois : le 041 d'un ordre de mission n'est pas aussi celui d'un BC.
 *   • Le numéro est attribué quand le document est FINALISÉ (jamais sur un brouillon ni un aperçu), prérempli avec le prochain
 *     et MODIFIABLE : une valeur libre est acceptée si elle est libre pour la société et l'année ; plus haute que le compteur,
 *     elle le fait avancer ; un numéro attribué ne se réutilise jamais.
 *
 * PUR, SANS AUCUN IMPORT : les formulaires (navigateur) et le serveur lisent la même règle. L'attribution se joue contre un
 * MAGASIN abstrait — Prisma au serveur (`registre-serveur.ts`), la mémoire dans les tests.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Le motif du registre : trois chiffres au moins, « DG », l'année sur quatre chiffres. */
export const MOTIF_REGISTRE = "{n:3}/DG/{aaaa}";

/** La nature du compteur commun dans `DocumentSequence`. */
export const KIND_REGISTRE = "REGISTRE_DG";

/** Au-delà, une saisie est une faute de frappe, pas un numéro. */
export const NUMERO_MAX = 99_999;

export const TYPES_REFERENCE = ["BON_DE_COMMANDE", "ORDRE_MISSION", "DEMANDE_DEVIS", "DEVIS", "FACTURE", "AVOIR", "ATTESTATION_TRAVAIL"] as const;
export type TypeReference = (typeof TYPES_REFERENCE)[number];

export const LIBELLE_TYPE_REFERENCE: Record<TypeReference, string> = {
  BON_DE_COMMANDE: "bon de commande",
  ORDRE_MISSION: "ordre de mission",
  DEMANDE_DEVIS: "demande de devis",
  DEVIS: "devis",
  FACTURE: "facture",
  AVOIR: "avoir",
  ATTESTATION_TRAVAIL: "attestation de travail",
};

const libelleType = (t: string): string => (LIBELLE_TYPE_REFERENCE as Record<string, string>)[t] ?? "document";

// ─────────────────────────── Le format ───────────────────────────

/** Le motif porte-t-il la série DG ? (« {n:3}/DG/{aaaa} », « {n:4}/DG/{aaaa} »…) */
export const estMotifDg = (motif: string | null | undefined): boolean => typeof motif === "string" && /\/DG\//i.test(motif);

/** Le nombre de chiffres minimal du numéro, lu dans le motif (`{n:4}` → 4) ; 3 par défaut. */
export function largeurDuMotif(motif: string | null | undefined): number {
  const m = typeof motif === "string" ? /\{n:(\d)\}/.exec(motif) : null;
  const l = m ? Number(m[1]) : 3;
  return l >= 1 && l <= 6 ? l : 3;
}

/** « 040/DG/2026 » — jamais tronqué : 1234 reste 1234. */
export function formaterReference(numero: number, annee: number, largeur = 3): string {
  return `${String(Math.trunc(numero)).padStart(largeur, "0")}/DG/${annee}`;
}

/** Lit une saisie « 40/dg/2026 », « 040 / DG / 2026 » : le numéro et l'année, ou `null` si ce n'est pas une référence DG. */
export function lireReference(saisie: string | null | undefined): { numero: number; annee: number } | null {
  if (typeof saisie !== "string") return null;
  const m = /^\s*(\d{1,6})\s*\/\s*DG\s*\/\s*(\d{4})\s*$/i.exec(saisie);
  if (!m) return null;
  return { numero: Number(m[1]), annee: Number(m[2]) };
}

export type ValidationReference =
  | { ok: true; numero: number; annee: number; reference: string }
  | { ok: false; motif: string };

/** Ce qu'une saisie doit être pour entrer au registre : NNN/DG/AAAA, de l'année du document, numéro de 1 à 99 999. */
export function validerReferenceSaisie(saisie: string | null | undefined, annee: number, largeur = 3): ValidationReference {
  const brut = (saisie ?? "").trim();
  if (!brut) return { ok: false, motif: "La référence est obligatoire." };
  const lu = lireReference(brut);
  if (!lu) return { ok: false, motif: `La référence s'écrit NNN/DG/AAAA (ex. ${formaterReference(40, annee, largeur)}).` };
  if (lu.numero < 1) return { ok: false, motif: "Le numéro de la référence commence à 001." };
  if (lu.numero > NUMERO_MAX) return { ok: false, motif: `Le numéro de la référence ne dépasse pas ${NUMERO_MAX}.` };
  if (lu.annee !== annee) return { ok: false, motif: `La référence doit être de l'année ${annee} (…/DG/${annee}).` };
  return { ok: true, numero: lu.numero, annee: lu.annee, reference: formaterReference(lu.numero, lu.annee, largeur) };
}

/**
 * LA SAISIE QUI COMPTE : le formulaire est PRÉREMPLI avec le prochain numéro. Laissé tel quel, il ne fige rien — le
 * registre attribue le prochain libre au moment de finaliser (le même, sauf si quelqu'un vient d'en prendre un) ; modifié,
 * c'est un numéro CHOISI, vérifié. `null` = attribution automatique.
 */
export function saisieEffective(saisie: string | null | undefined, suggeree: string | null | undefined): string | null {
  const s = (saisie ?? "").trim();
  if (!s) return null;
  const sug = (suggeree ?? "").trim();
  if (sug) {
    const a = lireReference(s);
    const b = lireReference(sug);
    if (a && b && a.numero === b.numero && a.annee === b.annee) return null;
  }
  return s;
}

// ─────────────────────────── Les réglages de la société ───────────────────────────

const objet = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/**
 * LA SOCIÉTÉ TIENT-ELLE LE REGISTRE ? Oui si son profil documentaire le dit (`settings.registreDG`, posé par la migration pour
 * Adventum, Pharmagene et AMD) ou si ses bons de commande portent déjà le motif /DG/. Les autres gardent leur numérotation.
 */
export function registreActif(settings: unknown): boolean {
  const s = objet(settings);
  if (!s) return false;
  if (s.registreDG === true) return true;
  const num = objet(s.numerotation);
  return estMotifDg(typeof num?.BON_DE_COMMANDE === "string" ? num.BON_DE_COMMANDE : null);
}

/** Une pièce de la FABRIQUE va-t-elle au registre ? Le BC d'une société au registre, et toute nature dont le motif porte /DG/. */
export function typeSurRegistre(type: string, motifDuType: string | null | undefined, actif: boolean): boolean {
  return estMotifDg(motifDuType) || (actif && type === "BON_DE_COMMANDE");
}

/**
 * LE PLANCHER DE L'ANNÉE (« commencer à 040 ») : le plus haut départ réglé pour l'année parmi les séries qui alimentent le
 * registre — le bon de commande, et toute nature au motif /DG/. 1 quand rien n'est réglé : une nouvelle année repart à 001.
 */
export function plancherRegistre(settings: unknown, annee: number): number {
  const s = objet(settings);
  const departs = objet(s?.numerotationDepart);
  if (!departs) return 1;
  const num = objet(s?.numerotation);
  let plancher = 1;
  for (const [type, parAnnee] of Object.entries(departs)) {
    const motif = typeof num?.[type] === "string" ? (num[type] as string) : null;
    if (type !== "BON_DE_COMMANDE" && !estMotifDg(motif)) continue;
    const v = objet(parAnnee)?.[String(annee)];
    if (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= NUMERO_MAX && v > plancher) plancher = v;
  }
  return plancher;
}

/** La largeur du numéro de la société : celle du motif de ses BC s'il est /DG/, sinon 3. */
export function largeurRegistre(settings: unknown): number {
  const num = objet(objet(settings)?.numerotation);
  const motif = typeof num?.BON_DE_COMMANDE === "string" ? num.BON_DE_COMMANDE : null;
  return estMotifDg(motif) ? largeurDuMotif(motif) : 3;
}

/** Le numéro que le compteur donnera après `dernier` : jamais sous le plancher. */
export const prochainNumero = (dernier: number, plancher: number): number => Math.max(dernier + 1, plancher, 1);

// ─────────────────────────── L'attribution ───────────────────────────

export interface EntreeRegistre {
  companyId: string;
  annee: number;
  numero: number;
  reference: string;
  docType: TypeReference;
  entityType: string | null;
  entityId: string | null;
  createdById: string | null;
}

/**
 * Ce que l'attribution demande au stockage. Au serveur, chaque méthode s'exécute DANS la transaction du document ; le compteur
 * est la ligne que toute attribution de la société verrouille en premier — deux attributions de la même société s'attendent.
 */
export interface MagasinRegistre {
  /** Avance ATOMIQUEMENT le compteur à max(dernier + 1, plancher) et rend la nouvelle valeur. */
  avancer(companyId: string, annee: number, plancher: number): Promise<number>;
  /** Porte le compteur AU MOINS à `numero` (jamais en arrière) — `0` le verrouille sans le bouger. */
  porterAuMoins(companyId: string, annee: number, numero: number): Promise<void>;
  /** L'entrée qui porte déjà ce numéro, s'il y en a une. */
  occupant(companyId: string, annee: number, numero: number): Promise<{ reference: string; docType: string } | null>;
  /** Inscrit l'entrée ; rend son identifiant, ou `null` si le numéro vient d'être pris (sans lever : la transaction continue). */
  inscrire(e: EntreeRegistre): Promise<string | null>;
}

export interface DemandeReference {
  companyId: string;
  annee: number;
  /** Le départ de l'année (`plancherRegistre`). */
  plancher: number;
  largeur?: number;
  docType: TypeReference;
  entityType?: string | null;
  entityId?: string | null;
  createdById?: string | null;
  /** La référence CHOISIE (`saisieEffective`) ; vide = le prochain numéro libre. */
  saisie?: string | null;
}

export type ReferenceAttribuee =
  | { ok: true; id: string; numero: number; reference: string; choisie: boolean }
  | { ok: false; motif: string };

/** La phrase du refus d'un numéro déjà pris — qui dit par quel type de document. */
export function phraseDejaAttribuee(reference: string, occupant: { docType: string } | null): string {
  return `La référence ${reference} est déjà attribuée${occupant ? ` (${libelleType(occupant.docType)})` : ""} : un numéro du registre ne se réutilise jamais. Choisissez-en un autre, ou gardez le numéro proposé.`;
}

/**
 * ATTRIBUER UNE RÉFÉRENCE — choisie (vérifiée, unique pour la société et l'année, tous types confondus ; le compteur avance
 * jusqu'à elle si elle est plus haute) ou automatique (le prochain numéro libre au-dessus du compteur et du plancher).
 */
export async function attribuerReference(m: MagasinRegistre, d: DemandeReference): Promise<ReferenceAttribuee> {
  const largeur = d.largeur ?? 3;
  const base = { companyId: d.companyId, annee: d.annee, docType: d.docType, entityType: d.entityType ?? null, entityId: d.entityId ?? null, createdById: d.createdById ?? null };
  const saisie = (d.saisie ?? "").trim();
  if (saisie) {
    const v = validerReferenceSaisie(saisie, d.annee, largeur);
    if (!v.ok) return v;
    // Le verrou de la société d'abord (sans bouger le compteur) : une attribution automatique concurrente attend.
    await m.porterAuMoins(d.companyId, d.annee, 0);
    const pris = await m.occupant(d.companyId, d.annee, v.numero);
    if (pris) return { ok: false, motif: phraseDejaAttribuee(v.reference, pris) };
    const id = await m.inscrire({ ...base, numero: v.numero, reference: v.reference });
    if (!id) return { ok: false, motif: phraseDejaAttribuee(v.reference, null) };
    await m.porterAuMoins(d.companyId, d.annee, v.numero);
    return { ok: true, id, numero: v.numero, reference: v.reference, choisie: true };
  }
  // Le compteur est au-dessus de tout numéro choisi : la boucle n'est qu'un filet (un registre repris à la main).
  for (let essai = 0; essai < 500; essai++) {
    const numero = await m.avancer(d.companyId, d.annee, d.plancher);
    if (numero > NUMERO_MAX) break;
    const reference = formaterReference(numero, d.annee, largeur);
    const id = await m.inscrire({ ...base, numero, reference });
    if (id) return { ok: true, id, numero, reference, choisie: false };
  }
  return { ok: false, motif: `Aucun numéro libre n'a pu être attribué au registre pour ${d.annee} : prévenez l'administrateur.` };
}

/**
 * Ce que le formulaire lit avant de générer : la société tient-elle le registre, laquelle, et son prochain numéro (prévu).
 * `actif: false` : le document garde sa numérotation d'avant (le champ ne s'affiche pas, ou reste libre).
 */
export type ReferenceProchaine =
  | { ok: true; actif: boolean; societeId: string | null; prochaine: string | null }
  | { ok: false; error: string };

/** Le numéro que la PROCHAINE attribution automatique recevrait — PRÉVU, jamais réservé (aperçus, formulaires). */
export function numeroPrevu(dernier: number, plancher: number, estPris: (n: number) => boolean): number {
  let n = prochainNumero(dernier, plancher);
  for (let i = 0; i < 500 && estPris(n); i++) n++;
  return n;
}
