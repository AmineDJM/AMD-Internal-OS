import type {
  AdProTrajet, AdProTransport, CareBeneficiaryStatus, CareCellKind, CareCellStatus, CareCurrency, CareMode,
  CareOpinion, CareQuoteStatus, CareServiceKind,
} from "@prisma/client";
import {
  lireVoyageur, manquesPourReserver, prochainGesteVoyageur, lireEtapes, jourLisible, TRAJET_LIBELLE,
  TRANSPORT_LIBELLE, type EtapeTrajet, type VoyageurPourReservation,
} from "@/lib/ad-pro/voyageurs";
import { lireHebergement, nuitsDe } from "@/lib/ad-pro/hebergements";
import { arrondirAuCentime } from "@/lib/utils";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES FICHES VOYAGEUR D'UNE PRISE EN CHARGE (Direction, 10/2026) — nationale et internationale.
 *
 * « On crée la demande avec l'événement seulement ; chaque professionnel ajouté reçoit SA fiche, avec la
 * billetterie et l'hôtellerie déjà ouvertes, puis des postes en plus, à la carte. Même circuit que le
 * sponsoring : passeport, devis de l'agence, devis retenu, réservation et BC à l'assistante de direction. »
 *
 * ── LA DÉCISION DE MODÈLE : ON ÉTEND LA PRISE EN CHARGE, ON NE LA DOUBLE PAS ───────────────────
 *
 *   • Une FICHE = une `CareBeneficiary` (la personne, sa décision par la Direction). Rien de neuf.
 *   • Un POSTE de la fiche = une `CareCell` SERVICE. Le billet et l'hôtel « ouverts par défaut » sont
 *     simplement les PREMIÈRES cases TICKET et HOTEL de la personne ; « + Billetterie » en ajoute une
 *     autre (Paris → Lyon), « + Hôtellerie » un autre hôtel, « + Déjeuner » un autre repas… — un « + »
 *     par catégorie, autant de fois qu'il le faut. Les détails (trajet, étapes, dates, hôtel, chambre,
 *     montant et sa devise) sont des colonnes de la case : les cases d'avant restent lisibles telles quelles.
 *   • « Sans billet », « sans hôtel » = la case principale « sans objet » (WAIVED) : la trace qu'on a regardé.
 *   • Les DEVIS restent des `CareQuote` couvrant N cases (n-n) : un devis d'agence peut couvrir plusieurs
 *     fiches — c'est exactement le mode « de groupe ». La proposition RETENUE (comme au sponsoring) puis le
 *     BC demandé sont des dates sur le devis ; l'acceptation par la Direction émet l'ordre de dépense, inchangée.
 *   • Les PIÈCES (passeport, visa…) restent les cases DOCUMENT d'aujourd'hui (`piecesDuProfessionnel`).
 *
 * ── LE MODE : INDIVIDUELLE OU DE GROUPE ────────────────────────────────────────────────────────
 *
 * Individuelle : chaque fiche porte ses postes et leurs montants. De groupe : les fiches gardent l'identité,
 * le trajet, les dates et la chambre de chacun, mais les PRIX vivent au niveau du groupe — un devis par
 * catégorie couvre les cases de tout le monde, et un POSTE DE GROUPE (`CareGroupPoste`) « repas 100 par
 * personne » s'applique à chacun (unitaire × personnes, une personne s'exclut une à une). Le calcul des
 * totaux ne dépend PAS du mode : il compte ce qui existe (devis qui comptent, montants saisis, postes de
 * groupe). Changer de mode change l'écran, jamais un total.
 *
 * ── LA DEVISE : LE DOLLAR À L'INTERNATIONAL, SAUF LE BILLET ────────────────────────────────────
 *
 * À l'international, tout poste AUTRE que la billetterie se saisit en dollars et entre au budget à
 * `montant × taux`, le taux étant FIGÉ sur la demande (`usdDzdRate`, 240 par défaut). Le montant saisi et
 * sa devise sont gardés ; `amountDzd` en est l'équivalent — c'est lui que lisent les totaux, l'enveloppe,
 * le budget et l'ordre de dépense. Au national, tout est en DZD ; la billetterie est toujours en DZD.
 *
 * ── LE TOTAL FACE À L'ENVELOPPE ────────────────────────────────────────────────────────────────
 *
 * Un dépassement se DIT, il ne bloque rien (`depassementEnveloppe`).
 *
 * Module PUR (sûr pour le navigateur) : aucune base, aucune session, aucun fichier.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type Perimetre = "NATIONAL" | "INTERNATIONAL";

export const MODE_LIBELLE: Record<CareMode, string> = { INDIVIDUAL: "Individuelle", GROUP: "De groupe" };

export function lireMode(v: string | null | undefined): CareMode | null {
  return v === "INDIVIDUAL" || v === "GROUP" ? v : null;
}

/** LE taux de la Direction : 1 USD = 240 DZD. Figé sur chaque demande internationale à sa création. */
export const TAUX_USD_DZD_DEFAUT = 240;

/** La devise de SAISIE d'un poste : le dollar à l'international, sauf la billetterie ; le dinar sinon. */
export function deviseDuPoste(scope: Perimetre, serviceKind: CareServiceKind | null | undefined): CareCurrency {
  return scope === "INTERNATIONAL" && serviceKind !== "TICKET" ? "USD" : "DZD";
}

/** Le taux qui s'applique à une demande : le sien s'il est posé, sinon le taux par défaut ; aucun au national. */
export function tauxDeLaDemande(scope: Perimetre, stocke: number | null | undefined): number | null {
  if (scope !== "INTERNATIONAL") return null;
  return typeof stocke === "number" && Number.isFinite(stocke) && stocke > 0 ? stocke : TAUX_USD_DZD_DEFAUT;
}

/** L'équivalent DZD d'un montant saisi — `null` pour un montant en dollars sans taux (jamais deviné). */
export function versDzd(montant: number | null, devise: CareCurrency, taux: number | null): number | null {
  if (montant == null || !Number.isFinite(montant)) return null;
  if (devise === "DZD") return arrondirAuCentime(montant);
  if (taux == null || !Number.isFinite(taux) || taux <= 0) return null;
  return arrondirAuCentime(montant * taux);
}

export function montantLisible(montant: number, devise: CareCurrency = "DZD"): string {
  return `${montant.toLocaleString("fr-FR", { maximumFractionDigits: 2 })} ${devise}`;
}

/**
 * LA DEVISE D'UN DEVIS, d'après ce qu'il couvre. Un devis est saisi dans UNE devise : à l'international, un
 * devis qui couvre à la fois des billets (DZD) et d'autres postes (USD) se refuse — on ne devine pas la part
 * de chacun ; on le scinde. Au national, tout est en DZD.
 */
export function deviseDuDevis(scope: Perimetre, natures: readonly (CareServiceKind | null)[]): { ok: true; devise: CareCurrency } | { ok: false; error: string } {
  const devises = new Set(natures.map((k) => deviseDuPoste(scope, k)));
  if (devises.size > 1) {
    return { ok: false, error: "Un devis couvre soit des billets (en DZD), soit d'autres postes (en dollars) : enregistrez-en un pour chaque." };
  }
  return { ok: true, devise: [...devises][0] ?? "DZD" };
}

/** Un montant saisi : « 38 000 », « 1 250,50 » ; vide = `null` ; illisible ou négatif = refus. */
export function lireMontant(v: string | null | undefined): { ok: true; montant: number | null } | { ok: false } {
  const t = (v ?? "").replace(/[\s  ]/g, "").replace(",", ".");
  if (!t) return { ok: true, montant: null };
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return { ok: false };
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? { ok: true, montant: n } : { ok: false };
}

// ───────────────────────────── Les postes d'une fiche ─────────────────────────────

export type ClePoste = "BILLET" | "HOTEL" | "TRANSPORT" | "DEJEUNER" | "DINER" | "ACCES" | "AUTRE";

export interface TypePoste {
  cle: ClePoste;
  serviceKind: CareServiceKind;
  libelle: string;
  aide: string;
}

/** Ce qu'on ajoute à une fiche — un « + » par catégorie (Direction : « toujours un petit plus dans chaque catégorie »). */
export const TYPES_POSTE: readonly TypePoste[] = [
  { cle: "BILLET", serviceKind: "TICKET", libelle: "Billetterie", aide: "Un autre trajet (ex. Paris → Lyon)" },
  { cle: "HOTEL", serviceKind: "HOTEL", libelle: "Hôtellerie", aide: "Une nuit ou un autre hôtel" },
  { cle: "TRANSPORT", serviceKind: "TRANSPORT", libelle: "Transport", aide: "Transfert, taxi, location, train local" },
  { cle: "DEJEUNER", serviceKind: "CATERING", libelle: "Déjeuner", aide: "Repas du midi" },
  { cle: "DINER", serviceKind: "CATERING", libelle: "Dîner", aide: "Repas du soir" },
  { cle: "ACCES", serviceKind: "REGISTRATION", libelle: "Accès à l'événement", aide: "Inscription, badge, pass, atelier" },
  { cle: "AUTRE", serviceKind: "OTHER", libelle: "Autre", aide: "Visa, assurance, frais divers…" },
];

export function typePoste(cle: string | null | undefined): TypePoste | null {
  return TYPES_POSTE.find((t) => t.cle === cle) ?? null;
}

/** Le libellé par défaut d'un poste ajouté : « Billetterie supplémentaire » quand la fiche a déjà son billet. */
export function libelleNouveauPoste(t: TypePoste, existants: number): string {
  if (t.cle === "BILLET") return existants > 0 ? "Billetterie supplémentaire" : "Billetterie";
  if (t.cle === "HOTEL") return existants > 0 ? "Hôtellerie supplémentaire" : "Hôtellerie";
  return t.libelle;
}

/** Une case d'une fiche, telle que l'écran et les règles la lisent. Dates en AAAA-MM-JJ. */
export interface CellRow {
  id: string;
  kind: CareCellKind;
  serviceKind: CareServiceKind | null;
  label: string;
  notes: string | null;
  status: CareCellStatus;
  /** L'équivalent DZD (budget). */
  amountDzd: number | null;
  /** Le montant saisi, dans sa devise. `null` sur une case d'avant : `amountDzd` fait foi. */
  amount: number | null;
  currency: CareCurrency;
  expenseOrderId: string | null;
  promoMaterialId: string | null;
  documentId: string | null;
  /** Case PIÈCE : TOUS ses fichiers (recto, verso, pages, visa… — `lib/care-pieces`). Absent hors de la lecture de la fiche. */
  fichiers?: { id: string; name: string; hasFile: boolean }[];
  promoMaterial: { reference: string; title: string; status: string } | null;
  dateStart: string | null;
  dateEnd: string | null;
  trajet: AdProTrajet | null;
  transport: AdProTransport | null;
  fromCity: string | null;
  toCity: string | null;
  segments: EtapeTrajet[];
  hotelName: string | null;
  city: string | null;
  roomType: string | null;
  /** Le billet émis / le voucher d'hôtel déposé (Document.id). */
  issuedDocumentId: string | null;
  /** PNR du billet / n° de confirmation de l'hôtel. */
  bookingRef: string | null;
  /** Le détail de chaque trajet du billet, aligné sur `etapesDuBillet`. */
  legDetails: DetailTrajet[];
  /** Autre poste : heure « HH:MM » et lieu / adresse. */
  timeStart: string | null;
  address: string | null;
}

/** LE DÉTAIL D'UN TRAJET ÉMIS — ce que lira le livret de séjour : n° de vol / train, heures, référence. */
export interface DetailTrajet {
  numero: string | null;
  heureDepart: string | null;
  heureArrivee: string | null;
  reference: string | null;
}

export interface BeneficiaryRow {
  id: string;
  name: string;
  subtitle: string;
  fromDirectory: boolean;
  requesterOpinion: CareOpinion;
  requesterNote: string | null;
  status: CareBeneficiaryStatus;
  decisionNote: string | null;
  cells: CellRow[];
}

export interface QuoteRow {
  id: string;
  supplier: string;
  reference: string | null;
  amountDzd: number;
  amount: number | null;
  currency: CareCurrency;
  serviceKind: CareServiceKind | null;
  status: CareQuoteStatus;
  note: string | null;
  cellIds: string[];
  cellLabels: string[];
  retained: boolean;
  bcRequested: boolean;
  documentId: string | null;
}

export interface GroupPosteRow {
  id: string;
  serviceKind: CareServiceKind;
  label: string;
  notes: string | null;
  date: string | null;
  timeStart: string | null;
  address: string | null;
  unitAmount: number | null;
  currency: CareCurrency;
  unitAmountDzd: number | null;
  excludedBeneficiaryIds: string[];
  status: CareCellStatus;
}

/** Une personne est VIVANTE tant qu'elle n'est ni écartée ni retirée : elle compte dans l'estimé. */
export function personneVivante(status: CareBeneficiaryStatus): boolean {
  return status === "PROPOSED" || status === "APPROVED";
}

const services = (cells: readonly CellRow[]) => cells.filter((c) => c.kind === "SERVICE");

/** Les postes d'une catégorie, dans l'ordre de la fiche — le premier billet / le premier hôtel est le PRINCIPAL. */
export function postesDeNature(cells: readonly CellRow[], kind: CareServiceKind): CellRow[] {
  return services(cells).filter((c) => c.serviceKind === kind);
}

export function billetPrincipal(cells: readonly CellRow[]): CellRow | null {
  return postesDeNature(cells, "TICKET")[0] ?? null;
}

export function hotelPrincipal(cells: readonly CellRow[]): CellRow | null {
  return postesDeNature(cells, "HOTEL")[0] ?? null;
}

/** Les AUTRES postes : tout service qui n'est pas le billet principal ni l'hôtel principal. */
export function autresPostes(cells: readonly CellRow[]): CellRow[] {
  const b = billetPrincipal(cells)?.id;
  const h = hotelPrincipal(cells)?.id;
  return services(cells).filter((c) => c.id !== b && c.id !== h);
}

/** Les puces de la colonne « Autres postes » : « Dîner », « Déjeuner ×2 »… (les postes sans objet ne s'affichent pas). */
export function pucesAutresPostes(cells: readonly CellRow[]): string[] {
  const compte = new Map<string, number>();
  for (const c of autresPostes(cells)) {
    if (c.status === "WAIVED") continue;
    compte.set(c.label, (compte.get(c.label) ?? 0) + 1);
  }
  return [...compte].map(([l, n]) => (n > 1 ? `${l} ×${n}` : l));
}

// ───────────────────────────── Billet et hôtel ─────────────────────────────

const jour = (iso: string | null) => (iso ? new Date(`${iso}T00:00:00.000Z`) : null);

/** Le billet vu comme un voyageur du sponsoring — pour réutiliser ses règles telles quelles. */
export function voyageurDuBillet(nom: string, b: CellRow, passeport: boolean): VoyageurPourReservation {
  return {
    nom, prenom: null, segments: b.segments,
    villeDepart: b.fromCity, villeArrivee: b.toCity,
    dateDepart: jour(b.dateStart), dateRetour: jour(b.dateEnd),
    passeport, notes: b.notes, trajet: b.trajet ?? "ALLER_RETOUR", transport: b.transport,
  };
}

/**
 * CE QUI MANQUE POUR RÉSERVER LE BILLET — la règle du sponsoring (`manquesPourReserver`). Le prénom n'est
 * pas demandé (l'identité vient de la fiche) ; le passeport n'est exigé qu'à l'international — au national,
 * la pièce d'identité reste facultative (décision par défaut, Direction 10/2026).
 */
export function manquesBillet(scope: Perimetre, nom: string, b: CellRow, passeport: boolean): string[] {
  return manquesPourReserver(voyageurDuBillet(nom, b, scope === "INTERNATIONAL" ? passeport : true)).filter((m) => m !== "prénom");
}

/** Ce qui manque pour réserver l'hôtel : l'hôtel (ou au moins la ville) et les deux dates. */
export function manquesHotel(h: CellRow): string[] {
  const m: string[] = [];
  if (!h.hotelName && !h.city) m.push("hôtel");
  if (!h.dateStart || !h.dateEnd) m.push("dates de l'hôtel");
  return m;
}

export function nuitsDuPoste(h: Pick<CellRow, "dateStart" | "dateEnd">): number | null {
  return nuitsDe({ dateArrivee: jour(h.dateStart), dateDepart: jour(h.dateEnd) });
}

/** Le résumé d'un billet : « Alger → Paris, aller-retour · avion · 26/11 → 29/11 ». */
export function resumeBillet(b: CellRow): string {
  const trajet = b.trajet ?? "ALLER_RETOUR";
  const lieux = trajet === "MULTI_DESTINATIONS"
    ? `${b.segments.length} étape${b.segments.length > 1 ? "s" : ""}`
    : b.fromCity || b.toCity ? `${b.fromCity ?? "?"} → ${b.toCity ?? "?"}` : "trajet à préciser";
  const dates = trajet === "ALLER_SIMPLE"
    ? jourLisible(jour(b.dateStart))
    : `${jourLisible(jour(b.dateStart))} → ${jourLisible(jour(b.dateEnd))}`;
  return [`${lieux}, ${TRAJET_LIBELLE[trajet]}`, b.transport ? TRANSPORT_LIBELLE[b.transport] : null, dates].filter(Boolean).join(" · ");
}

/** Le résumé d'un hôtel : « Hôtel du Palais, Paris · 3 nuits · chambre Single ». */
export function resumeHotel(h: CellRow): string {
  const n = nuitsDuPoste(h);
  return [
    [h.hotelName, h.city].filter(Boolean).join(", ") || "hôtel à préciser",
    n == null ? "nuits à préciser" : `${n} nuit${n > 1 ? "s" : ""}`,
    h.roomType ? `chambre ${h.roomType}` : null,
  ].filter(Boolean).join(" · ");
}

/**
 * L'HÔTEL PRÉ-REMPLI à son ouverture : la ville de l'événement, les dates du billet (arrivée = départ du
 * billet, départ = son retour ; en plusieurs destinations, la première et la dernière étape). Ce sont des
 * PROPOSITIONS, que la personne corrige — l'écran dit d'où elles viennent.
 */
export function hotelPrerempli(evenement: { city: string | null }, billet: CellRow | null): { city: string | null; dateStart: string | null; dateEnd: string | null } {
  if (!billet || billet.status === "WAIVED") return { city: evenement.city, dateStart: null, dateEnd: null };
  if (billet.trajet === "MULTI_DESTINATIONS") {
    const s = billet.segments;
    return { city: evenement.city, dateStart: s[0]?.date ?? null, dateEnd: s.length > 1 ? s[s.length - 1]!.date : null };
  }
  return { city: evenement.city, dateStart: billet.dateStart, dateEnd: billet.trajet === "ALLER_SIMPLE" ? null : billet.dateEnd };
}

// ───────────────────────────── Billet émis, horaires, voucher ─────────────────────────────

/**
 * LES TRAJETS D'UN BILLET, dans l'ordre du voyage — ce à quoi s'alignent les détails émis (n° de vol, heures,
 * PNR). Plusieurs destinations : chaque étape ; aller simple : l'aller ; aller-retour : l'aller puis le retour
 * (le retour refait le trajet à l'envers, à la date de retour).
 */
export function etapesDuBillet(b: Pick<CellRow, "trajet" | "segments" | "fromCity" | "toCity" | "dateStart" | "dateEnd">): EtapeTrajet[] {
  const trajet = b.trajet ?? "ALLER_RETOUR";
  if (trajet === "MULTI_DESTINATIONS") return b.segments;
  const aller: EtapeTrajet = { de: b.fromCity, vers: b.toCity, date: b.dateStart };
  if (trajet === "ALLER_SIMPLE") return [aller];
  return [aller, { de: b.toCity, vers: b.fromCity, date: b.dateEnd }];
}

const HEURE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Une heure « HH:MM » (« 9:05 » se lit « 09:05 ») ; vide = `null` ; illisible = refus. */
export function lireHeure(v: string | null | undefined): { ok: true; heure: string | null } | { ok: false } {
  const t = (v ?? "").trim().replace("h", ":").replace("H", ":");
  if (!t) return { ok: true, heure: null };
  const n = /^\d:\d\d$/.test(t) ? `0${t}` : t;
  return HEURE.test(n) ? { ok: true, heure: n } : { ok: false };
}

/**
 * LES DÉTAILS DES TRAJETS SAISIS (JSON ou liste), alignés sur `n` trajets : un détail en trop est écarté, un
 * manquant est vide. Une heure illisible se refuse en nommant le trajet.
 */
export function lireDetailsTrajets(brut: unknown, n: number): { ok: true; details: DetailTrajet[] } | { ok: false; error: string } {
  let liste: unknown = brut;
  if (typeof brut === "string") {
    const t = brut.trim();
    if (!t) liste = [];
    else {
      try { liste = JSON.parse(t); } catch { return { ok: false, error: "Le détail des trajets est illisible." }; }
    }
  }
  if (liste == null) liste = [];
  if (!Array.isArray(liste)) return { ok: false, error: "Le détail des trajets est illisible." };
  const out: DetailTrajet[] = [];
  for (let i = 0; i < n; i++) {
    const r = (liste[i] && typeof liste[i] === "object" ? liste[i] : {}) as Record<string, unknown>;
    const s = (k: string) => (typeof r[k] === "string" ? (r[k] as string) : null);
    const dep = lireHeure(s("heureDepart"));
    const arr = lireHeure(s("heureArrivee"));
    if (!dep.ok || !arr.ok) return { ok: false, error: `Trajet ${i + 1} : heure illisible (HH:MM).` };
    out.push({ numero: texte(s("numero"), 40), heureDepart: dep.heure, heureArrivee: arr.heure, reference: texte(s("reference"), 60) });
  }
  return { ok: true, details: out };
}

/** Les détails stockés d'une case (JSON) — illisibles = aucun (jamais une erreur à l'affichage). */
export function detailsStockes(brut: unknown, n: number): DetailTrajet[] {
  const r = lireDetailsTrajets(brut ?? null, n);
  return r.ok ? r.details : Array.from({ length: n }, () => ({ numero: null, heureDepart: null, heureArrivee: null, reference: null }));
}

/**
 * QUI TÉLÉVERSE LE BILLET ÉMIS ET LA CONFIRMATION D'HÔTEL (Direction, 10/2026) : l'assistante de direction (qui
 * réserve), le demandeur, la Direction Marketing, le Super Admin — et la Direction (vue globale).
 */
export function peutTeleverserBillet(
  u: { id: string; roles: readonly string[]; vueGlobale: boolean }, demande: { requesterId: string | null },
): boolean {
  if (u.vueGlobale) return true;
  if (demande.requesterId && demande.requesterId === u.id) return true;
  return u.roles.some((r) => r === "DIRECTION_ASSISTANT" || r === "PRODUCT_MANAGER" || r === "SUPER_ADMIN");
}

/**
 * MARQUER UNE PRISE EN CHARGE « RÉALISÉE » (Direction, 27/10) — le demandeur ou la Direction Marketing (et le Super
 * Admin). Le geste ne s'ouvre qu'APRÈS l'envoi aux Finances : c'est l'action serveur qui le revérifie.
 */
export function peutMarquerRealisee(
  u: { id: string; roles: readonly string[] }, demande: { requesterId: string | null },
): boolean {
  if (demande.requesterId && demande.requesterId === u.id) return true;
  return u.roles.some((r) => r === "PRODUCT_MANAGER" || r === "SUPER_ADMIN");
}

// ───────────────────────────── La saisie d'un poste ─────────────────────────────

export interface SaisiePoste {
  label?: string | null;
  notes?: string | null;
  dateStart?: string | null;
  dateEnd?: string | null;
  trajet?: string | null;
  transport?: string | null;
  fromCity?: string | null;
  toCity?: string | null;
  segments?: unknown;
  hotelName?: string | null;
  city?: string | null;
  roomType?: string | null;
  amount?: string | null;
  timeStart?: string | null;
  address?: string | null;
}

export interface PosteLu {
  label: string | null;
  notes: string | null;
  dateStart: Date | null;
  dateEnd: Date | null;
  trajet: AdProTrajet | null;
  transport: AdProTransport | null;
  fromCity: string | null;
  toCity: string | null;
  segments: EtapeTrajet[] | null;
  hotelName: string | null;
  city: string | null;
  roomType: string | null;
  amount: number | null;
  timeStart: string | null;
  address: string | null;
}

const texte =(v: string | null | undefined, max = 200) => {
  const t = (v ?? "").trim();
  return t ? t.slice(0, max) : null;
};

const JOUR = /^\d{4}-\d{2}-\d{2}$/;
function lireJour(v: string | null | undefined): { ok: true; date: Date | null } | { ok: false } {
  const t = (v ?? "").trim();
  if (!t) return { ok: true, date: null };
  if (!JOUR.test(t)) return { ok: false };
  const d = new Date(`${t}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== t ? { ok: false } : { ok: true, date: d };
}

/**
 * LIT LA SAISIE D'UN POSTE, selon sa nature. Le billet passe par la lecture du voyageur du sponsoring
 * (trajet, étapes, dates qui se suivent, aller simple sans retour), l'hôtel par celle de la fiche hôtellerie
 * (le départ ne précède pas l'arrivée) ; les autres postes ont une date. Le montant se lit partout. Tout ce
 * qui ne va pas se dit en une fois.
 */
export function lirePosteSaisi(serviceKind: CareServiceKind, nomPersonne: string, s: SaisiePoste): { ok: true; poste: PosteLu } | { ok: false; error: string } {
  const montant = lireMontant(s.amount ?? null);
  if (!montant.ok) return { ok: false, error: "Le montant est illisible (ex. 38000 ou 1250,50)." };
  const base: PosteLu = {
    label: texte(s.label, 160), notes: texte(s.notes, 1000), dateStart: null, dateEnd: null,
    trajet: null, transport: null, fromCity: null, toCity: null, segments: null,
    hotelName: null, city: null, roomType: null, amount: montant.montant, timeStart: null, address: null,
  };
  const nom = nomPersonne.trim() || "Personne";
  if (serviceKind === "TICKET") {
    const v = lireVoyageur({
      nom, segments: s.segments, villeDepart: s.fromCity ?? null, villeArrivee: s.toCity ?? null,
      dateDepart: s.dateStart ?? null, dateRetour: s.dateEnd ?? null, notes: s.notes ?? null,
      trajet: s.trajet ?? null, transport: s.transport ?? null,
    });
    if (!v.ok) return { ok: false, error: v.error.replace("Voyageur incomplet", "Billet incomplet") };
    const x = v.voyageur;
    return {
      ok: true,
      poste: {
        ...base, notes: x.notes, trajet: x.trajet, transport: x.transport, fromCity: x.villeDepart, toCity: x.villeArrivee,
        dateStart: x.dateDepart, dateEnd: x.dateRetour, segments: x.trajet === "MULTI_DESTINATIONS" ? x.segments : null,
      },
    };
  }
  if (serviceKind === "HOTEL") {
    const h = lireHebergement({
      nom, hotel: s.hotelName ?? null, ville: s.city ?? null, dateArrivee: s.dateStart ?? null,
      dateDepart: s.dateEnd ?? null, typeChambre: s.roomType ?? null, notes: s.notes ?? null,
    });
    if (!h.ok) return { ok: false, error: h.error.replace("Fiche hôtellerie incomplète", "Hôtel incomplet") };
    const x = h.hebergement;
    return { ok: true, poste: { ...base, notes: x.notes, hotelName: x.hotel, city: x.ville, roomType: x.typeChambre, dateStart: x.dateArrivee, dateEnd: x.dateDepart } };
  }
  const d = lireJour(s.dateStart);
  const h = lireHeure(s.timeStart);
  const fautes = [d.ok ? null : "une date lisible (AAAA-MM-JJ)", h.ok ? null : "une heure lisible (HH:MM)"].filter(Boolean);
  if (fautes.length) return { ok: false, error: `Poste incomplet — il manque ${fautes.join(", ")}.` };
  return {
    ok: true,
    poste: { ...base, dateStart: d.ok ? d.date : null, timeStart: h.ok ? h.heure : null, address: texte(s.address, 300) },
  };
}

/** Les étapes stockées d'une case (JSON) — illisibles = aucune (jamais une erreur à l'affichage). */
export function etapesStockees(brut: unknown): EtapeTrajet[] {
  const r = lireEtapes(brut ?? null);
  return r.ok ? r.etapes : [];
}

// ───────────────────────────── Devis ─────────────────────────────

export interface DevisLike {
  id: string;
  status: CareQuoteStatus;
  amountDzd: number;
  cellIds: readonly string[];
  retained: boolean;
}

/** Un devis COMPTE dans l'estimé quand il est accepté par la Direction, ou retenu par le demandeur et pas encore tranché. */
export function devisQuiCompte(q: DevisLike): boolean {
  return q.status === "ACCEPTED" || (q.status === "PENDING" && q.retained);
}

/** Les devis d'une case — ceux qui la couvrent. */
export function devisDeLaCase(cellId: string, devis: readonly DevisLike[]): DevisLike[] {
  return devis.filter((q) => q.cellIds.includes(cellId));
}

/**
 * EN MODE « DE GROUPE », ce que couvre le devis d'une catégorie : les cases de cette nature de toutes les
 * personnes vivantes, sauf celles déclarées sans objet. Une personne ajoutée APRÈS le devis n'y est pas : il
 * faut un autre devis (ou un avenant) — rien ne s'étend en silence.
 */
export function casesDeLaCategorie(personnes: readonly { status: CareBeneficiaryStatus; cells: readonly CellRow[] }[], kind: CareServiceKind): string[] {
  return personnes
    .filter((p) => personneVivante(p.status))
    .flatMap((p) => postesDeNature(p.cells, kind).filter((c) => c.status !== "WAIVED").map((c) => c.id));
}

// ───────────────────────────── Postes de groupe ─────────────────────────────

/** Les personnes concernées par un poste de groupe : les vivantes, moins celles exclues une à une. */
export function personnesDuPosteGroupe<T extends { id: string; status: CareBeneficiaryStatus }>(
  poste: Pick<GroupPosteRow, "excludedBeneficiaryIds">, personnes: readonly T[],
): T[] {
  const exclues = new Set(poste.excludedBeneficiaryIds);
  return personnes.filter((p) => personneVivante(p.status) && !exclues.has(p.id));
}

/** Le montant d'un poste de groupe : unitaire (DZD) × personnes concernées ; `null` tant que l'unitaire manque. */
export function montantPosteGroupe(
  poste: Pick<GroupPosteRow, "excludedBeneficiaryIds" | "unitAmountDzd" | "status">,
  personnes: readonly { id: string; status: CareBeneficiaryStatus }[],
): number | null {
  if (poste.status === "WAIVED") return 0;
  if (poste.unitAmountDzd == null) return null;
  return arrondirAuCentime(poste.unitAmountDzd * personnesDuPosteGroupe(poste, personnes).length);
}

// ───────────────────────────── Estimé et totaux ─────────────────────────────

export interface Estimations {
  /** L'estimé de chaque personne (sa part des devis, ses montants saisis, sa part des postes de groupe). */
  parPersonne: Map<string, number>;
  /** La valeur de chaque case (part des devis qui la couvrent, ou son montant saisi) — le détail d'une fiche. */
  parCase: Map<string, number>;
  /** Le total de la demande — ce qui sera réellement dépensé si rien ne change. */
  total: number;
  /** Dont : les devis qui comptent (en entier). */
  devis: number;
  /** Dont : les montants saisis hors devis, des personnes vivantes. */
  saisis: number;
  /** Dont : les postes de groupe. */
  groupe: number;
}

/**
 * L'ESTIMÉ — « devis retenus + montants saisis ».
 *
 *   • Un devis qui COMPTE (accepté, ou retenu et pas encore tranché) compte EN ENTIER au total — c'est ce
 *     qu'on paiera — et se répartit entre les cases qu'il couvre, à parts égales, pour l'estimé de chacun.
 *     Un devis retenu dont toutes les cases sont déjà couvertes par un devis accepté ne compte pas deux fois.
 *   • Une case qu'aucun devis qui compte ne couvre compte pour son montant saisi (en DZD), sauf sans objet.
 *     Les montants saisis d'une personne écartée ou retirée sortent du total.
 *   • Un poste de groupe compte pour unitaire × personnes concernées.
 *
 * Fonction PURE — testée. Indépendante du mode : le mode change l'écran, jamais un total.
 */
export function estimations(input: {
  personnes: readonly { id: string; status: CareBeneficiaryStatus; cells: readonly Pick<CellRow, "id" | "kind" | "status" | "amountDzd">[] }[];
  devis: readonly DevisLike[];
  groupe?: readonly Pick<GroupPosteRow, "excludedBeneficiaryIds" | "unitAmountDzd" | "status">[];
}): Estimations {
  const parPersonne = new Map<string, number>(input.personnes.map((p) => [p.id, 0]));
  const proprietaire = new Map<string, string>();
  for (const p of input.personnes) for (const c of p.cells) proprietaire.set(c.id, p.id);

  const couvertes = new Set<string>();
  const parCase = new Map<string, number>();
  let devisTotal = 0;
  const qui = [...input.devis].filter(devisQuiCompte).sort((a, b) => (a.status === "ACCEPTED" ? 0 : 1) - (b.status === "ACCEPTED" ? 0 : 1));
  for (const q of qui) {
    if (q.cellIds.length === 0) continue;
    if (q.status !== "ACCEPTED" && q.cellIds.every((id) => couvertes.has(id))) continue;
    devisTotal += q.amountDzd;
    const part = q.amountDzd / q.cellIds.length;
    for (const id of q.cellIds) {
      couvertes.add(id);
      parCase.set(id, (parCase.get(id) ?? 0) + part);
      const p = proprietaire.get(id);
      if (p) parPersonne.set(p, (parPersonne.get(p) ?? 0) + part);
    }
  }

  let saisis = 0;
  for (const p of input.personnes) {
    for (const c of p.cells) {
      if (c.kind !== "SERVICE" || c.status === "WAIVED" || couvertes.has(c.id)) continue;
      const m = typeof c.amountDzd === "number" && Number.isFinite(c.amountDzd) ? c.amountDzd : 0;
      parCase.set(c.id, m);
      parPersonne.set(p.id, (parPersonne.get(p.id) ?? 0) + m);
      if (personneVivante(p.status)) saisis += m;
    }
  }

  let groupe = 0;
  for (const g of input.groupe ?? []) {
    const m = montantPosteGroupe(g, input.personnes);
    if (!m) continue;
    groupe += m;
    for (const p of personnesDuPosteGroupe(g, input.personnes)) parPersonne.set(p.id, (parPersonne.get(p.id) ?? 0) + (g.unitAmountDzd ?? 0));
  }

  for (const [k, v] of parPersonne) parPersonne.set(k, arrondirAuCentime(v));
  for (const [k, v] of parCase) parCase.set(k, arrondirAuCentime(v));
  return { parPersonne, parCase, total: arrondirAuCentime(devisTotal + saisis + groupe), devis: arrondirAuCentime(devisTotal), saisis: arrondirAuCentime(saisis), groupe: arrondirAuCentime(groupe) };
}

/** LE TOTAL FACE À L'ENVELOPPE — la phrase du dépassement, ou `null`. Un dépassement se DIT, il ne bloque rien. */
export function depassementEnveloppe(total: number, enveloppe: number | null): string | null {
  if (enveloppe == null || !Number.isFinite(enveloppe)) return null;
  const t = Math.round(total * 100);
  const e = Math.round(enveloppe * 100);
  if (t <= e) return null;
  const f = (c: number) => (c / 100).toLocaleString("fr-FR");
  return `L'estimé (${f(t)} DZD) dépasse l'enveloppe accordée (${f(e)} DZD) de ${f(t - e)} DZD. Rien n'est bloqué : la Direction le voit.`;
}

// ───────────────────────────── L'état d'une fiche ─────────────────────────────

export type Ton = "succes" | "attente" | "info" | "neutre" | "alerte";

export interface EtatPoste {
  libelle: string;
  ton: Ton;
}

/** La décision de la Direction, en mots de tableau. */
export const DECISION_LIBELLE: Record<CareBeneficiaryStatus, string> = {
  PROPOSED: "proposé — Direction", APPROVED: "accordé", REJECTED: "écarté", WITHDRAWN: "retiré",
};

/** Où en est le DEVIS d'une case : accepté, retenu, à choisir, à retenir, ou rien. */
function etatDevis(cellId: string, devis: readonly DevisLike[]): EtatPoste | null {
  const qs = devisDeLaCase(cellId, devis).filter((q) => q.status !== "REJECTED");
  if (qs.some((q) => q.status === "ACCEPTED")) return { libelle: "devis accepté", ton: "succes" };
  if (qs.some((q) => q.retained)) return { libelle: "devis retenu", ton: "succes" };
  if (qs.length > 1) return { libelle: `${qs.length} devis à choisir`, ton: "info" };
  if (qs.length === 1) return { libelle: "devis reçu — à retenir", ton: "info" };
  return null;
}

/** L'état de la billetterie d'une fiche, en une étiquette « état — chez qui » courte. */
export function etatBilletterie(scope: Perimetre, nom: string, cells: readonly CellRow[], passeport: boolean, devis: readonly DevisLike[]): EtatPoste {
  const b = billetPrincipal(cells);
  if (!b) return { libelle: "pas de billet ouvert", ton: "neutre" };
  if (b.status === "WAIVED") return { libelle: "sans billet", ton: "neutre" };
  if (b.status === "SETTLED") return { libelle: "réglé", ton: "succes" };
  if (scope === "INTERNATIONAL" && !passeport) return { libelle: "passeport manquant — demandeur", ton: "attente" };
  const d = etatDevis(b.id, devis);
  if (d) return d;
  const manque = manquesBillet(scope, nom, b, passeport);
  if (manque.length) return { libelle: `${manque[0]} à préciser`, ton: "attente" };
  return { libelle: "devis à demander — agence", ton: "info" };
}

export function etatHotellerie(cells: readonly CellRow[], devis: readonly DevisLike[]): EtatPoste {
  const h = hotelPrincipal(cells);
  if (!h) return { libelle: "pas d'hôtel ouvert", ton: "neutre" };
  if (h.status === "WAIVED") return { libelle: "sans hôtel", ton: "neutre" };
  const n = nuitsDuPoste(h);
  const nuits = n == null ? null : `${n} nuit${n > 1 ? "s" : ""}`;
  if (h.status === "SETTLED") return { libelle: [nuits, "réglé"].filter(Boolean).join(" · "), ton: "succes" };
  const d = etatDevis(h.id, devis);
  if (d) return { libelle: [nuits, d.libelle].filter(Boolean).join(" · "), ton: d.ton };
  const manque = manquesHotel(h);
  if (manque.length) return { libelle: `${manque[0]} à préciser`, ton: "attente" };
  return { libelle: [nuits, "devis à demander"].filter(Boolean).join(" · "), ton: "info" };
}

/**
 * LA FICHE EST-ELLE PRÊTE POUR RÉSERVER ? Le billet (s'il n'est pas « sans ») ne manque de rien selon la règle du
 * sponsoring, l'hôtel (s'il n'est pas « sans ») a son hôtel et ses dates — et il y a au moins l'un des deux à réserver.
 */
export function manquesPourReserverFiche(scope: Perimetre, nom: string, cells: readonly CellRow[], passeport: boolean): string[] {
  const b = billetPrincipal(cells);
  const h = hotelPrincipal(cells);
  const bVivant = b && b.status !== "WAIVED" ? b : null;
  const hVivant = h && h.status !== "WAIVED" ? h : null;
  if (!bVivant && !hVivant) return ["rien à réserver (sans billet ni hôtel)"];
  return [
    ...(bVivant ? manquesBillet(scope, nom, bVivant, passeport) : []),
    ...(hVivant ? manquesHotel(hVivant) : []),
  ];
}

export function fichePrete(scope: Perimetre, nom: string, cells: readonly CellRow[], passeport: boolean): boolean {
  return manquesPourReserverFiche(scope, nom, cells, passeport).length === 0;
}

export type GesteFiche = "PASSEPORT" | "COMPLETER" | "DEVIS" | "RETENIR" | "BC" | null;

/**
 * LE SEUL GESTE VISIBLE D'UNE FICHE — le prochain qui manque : le passeport (international, la règle du
 * voyageur), compléter la fiche, le devis de l'agence, en retenir un, puis demander le BC. `null` : rien ne
 * manque, ou la personne ne peut rien faire ici.
 */
export function prochainGesteFiche(
  scope: Perimetre, nom: string, cells: readonly CellRow[], passeport: boolean, devis: readonly (DevisLike & { bcRequested?: boolean })[], peutEditer: boolean,
): GesteFiche {
  if (!peutEditer) return null;
  const vivants = services(cells).filter((c) => c.status !== "WAIVED" && c.status !== "SETTLED");
  const b = billetPrincipal(cells);
  const billetVivant = b && b.status !== "WAIVED";
  const lies = devis.filter((q) => q.status !== "REJECTED" && vivants.some((c) => q.cellIds.includes(c.id)));
  const geste = prochainGesteVoyageur(
    { passeport: !billetVivant || scope !== "INTERNATIONAL" || passeport, devis: lies.map((q) => ({ montant: q.amountDzd, retenu: q.retained || q.status === "ACCEPTED" })) },
    true,
  );
  if (geste === "PASSEPORT") return "PASSEPORT";
  if (manquesPourReserverFiche(scope, nom, cells, passeport).length > 0 && vivants.length > 0) return "COMPLETER";
  if (vivants.length === 0) return null;
  const sansPrix = vivants.filter((c) => !lies.some((q) => q.cellIds.includes(c.id)) && c.amountDzd == null);
  if (geste === "DEVIS" || sansPrix.length > 0) return "DEVIS";
  if (geste === "VALIDER") return "RETENIR";
  if (lies.some((q) => q.status === "PENDING" && q.retained && !q.bcRequested)) return "BC";
  return null;
}

export const GESTE_LIBELLE: Record<NonNullable<GesteFiche>, string> = {
  PASSEPORT: "Joindre le passeport",
  COMPLETER: "Compléter la fiche",
  DEVIS: "Joindre le devis de l'agence",
  RETENIR: "Retenir un devis",
  BC: "Demander le BC",
};

// ───────────────────────────── Le résumé d'une demande ─────────────────────────────

export interface ResumeFiches {
  estimations: Estimations;
  /** Personnes vivantes (proposées ou accordées) et accordées. */
  vivantes: number;
  accordees: number;
  /** Fiches vivantes prêtes pour réserver. */
  pretes: number;
  /** Ce que la demande inclut : billets, nuits, autres postes (hors « sans objet », personnes vivantes). */
  billets: number;
  nuits: number;
  autres: number;
}

/** LE BANDEAU ET LE PIED DU TABLEAU — une lecture, pour la page (serveur) et la liste (écran). */
export function resumeDesFiches(scope: Perimetre, personnes: readonly BeneficiaryRow[], devis: readonly QuoteRow[], groupe: readonly GroupPosteRow[]): ResumeFiches {
  const vivantes = personnes.filter((p) => personneVivante(p.status));
  const passeport = (p: BeneficiaryRow) => personnePasseport(p.cells);
  let billets = 0, nuits = 0, autres = 0;
  for (const p of vivantes) {
    for (const c of services(p.cells)) {
      if (c.status === "WAIVED") continue;
      if (c.serviceKind === "TICKET") billets += 1;
      else if (c.serviceKind === "HOTEL") nuits += nuitsDuPoste(c) ?? 0;
      else autres += 1;
    }
  }
  return {
    estimations: estimations({ personnes, devis, groupe }),
    vivantes: vivantes.length,
    accordees: personnes.filter((p) => p.status === "APPROVED").length,
    pretes: vivantes.filter((p) => fichePrete(scope, p.name, p.cells, passeport(p))).length,
    billets, nuits, autres,
  };
}

/** Le passeport d'une personne est-il reçu ? La case PIÈCE « Passeport » (ou d'avant : « Copie du passeport »…), reçue. */
export function personnePasseport(cells: readonly CellRow[]): boolean {
  return cells.some((c) => c.kind === "DOCUMENT" && /passeport/i.test(c.label) && (c.status === "PROVIDED" || c.status === "SETTLED"));
}

