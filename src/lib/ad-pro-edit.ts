/**
 * MODIFIER UNE DEMANDE AD & PRO APRÈS SA CRÉATION.
 *
 * Une demande se saisit vite et mal : une ville oubliée, un montant mal tapé, un intitulé
 * approximatif. Jusqu'ici la seule issue était de supprimer et recommencer — en perdant la
 * référence, les pièces jointes, les postes et l'avancement du circuit.
 *
 * Deux règles portent tout le reste :
 *
 *   1. **Ce qui a fondé une décision ne se réécrit pas.** Une fois la Direction ayant tranché,
 *      le demandeur ne modifie plus : changer « 200 000 DZD demandés » en « 400 000 » après un
 *      accord transformerait la décision en autre chose que ce qui a été décidé. Seule la
 *      Direction (vue globale) garde la main, pour corriger une coquille en connaissance de
 *      cause — et chaque modification est tracée.
 *
 *   2. **Les champs de décision ne sont JAMAIS modifiables ici.** Montant accordé, statut, chef
 *      de produit désigné, avis, motifs : ils appartiennent au circuit. Les exposer dans un
 *      formulaire de correction reviendrait à offrir un raccourci autour du workflow. C'est
 *      pourquoi ce module énumère les champs autorisés au lieu d'interdire les autres : une
 *      liste blanche ne se trompe pas quand un champ nouveau apparaît dans le modèle.
 */

import { SPONSORING_TYPES, PRIORITY, NATIONAL_EVENT_TYPE, EVENT_TYPE, EVENT_FORMAT, CONSULTING_BILLING_OPTIONS } from "@/lib/labels";
import { etatAdProDuDossier } from "@/lib/promo-material/statut";
import { MODE_LIBELLE } from "@/lib/care-fiches";

// LE CONSULTING ET LES « AUTRES DEMANDES » (audit 360°, R11 et rapport 17 R13/R14) : absents de cette
// liste, ils ne se corrigeaient jamais — même en brouillon —, et la seule issue d'un montant mal tapé
// était le refus, donc l'annulation. Ils entrent par la MÊME porte que les cinq autres natures.
export type AdProKind = "SPONSORING" | "CONGRESS_NATIONAL" | "CONGRESS_INTERNATIONAL" | "PROMO_MATERIAL" | "EVENT" | "CONSULTING_CONTRACT" | "AD_PRO_OTHER";

/** Ce qu'on sait de la personne qui veut modifier. */
export interface AdProEditor {
  id: string;
  /** Vue globale : Direction, Directeur des opérations, Super Admin. */
  hasGlobalView: boolean;
  /**
   * Droit de TRANCHER le module (VALIDATE : Direction Marketing, Direction, Directeur Général) — ce
   * qui permet de corriger la demande d'un AUTRE avant la décision. Le droit UPDATE seul ne le
   * permet pas : un délégué ou un National Sales l'ont (CONTRIBUTE) pour déposer et corriger SES
   * demandes, et l'audit 360° a mesuré qu'il leur ouvrait celles de tous leurs collègues (§118.184).
   */
  canManage: boolean;
}

/** Ce qu'on sait de la demande. */
export interface AdProEditTarget {
  requesterId: string | null;
  /** La décision est-elle rendue (accordée, refusée, clôturée) ? */
  decided: boolean;
}

/**
 * Cette personne peut-elle modifier cette demande ?
 *
 * • **vue globale** → toujours (y compris après décision : c'est le seul niveau qui peut
 *   corriger un dossier tranché en assumant ce que ça veut dire) ;
 * • **demandeur** ou **qui tranche le module** → tant que la décision n'est pas rendue ;
 * • sinon → non. Contribuer au module ne suffit pas : c'est écrire SES demandes.
 */
export function canEditAdProRequest(editor: AdProEditor, target: AdProEditTarget): boolean {
  if (editor.hasGlobalView) return true;
  if (target.decided) return false;
  if (target.requesterId && target.requesterId === editor.id) return true;
  return editor.canManage;
}

/**
 * Statuts terminaux par type de demande. « Terminal » = la Direction a tranché ; ce qui suit
 * (paiement, clôture) ne rouvre pas la saisie.
 */
// « REFUSED » n'existe pas dans le statut d'une demande de congrès ou d'événement : leur refus s'écrit
// « REJECTED » (`CongressRequestStatus`). La liste portait le premier — une valeur que la base ne peut
// pas contenir —, donc une demande refusée gardait « Modifier », sur un dossier qu'on ne peut plus
// resoumettre (audit 360°, R16). `CANCELLED` est terminal pour la même raison : rien ne le rouvre.
const DECIDED_STATUS: Record<AdProKind, readonly string[]> = {
  // `PRE_VALIDATED` (§118.151) : la TENUE est décidée — réécrire l'institution ou les montants
  // demandés après coup ferait diverger la demande de ce qui a été pré-validé. La vue globale
  // garde la main, comme pour toute demande tranchée.
  SPONSORING: ["APPROVED", "REFUSED", "ACCEPTED", "PAID", "CLOSED", "PRE_VALIDATED", "CANCELLED"],
  CONGRESS_NATIONAL: ["APPROVED", "REJECTED", "COMPLETED", "CANCELLED"],
  CONGRESS_INTERNATIONAL: ["APPROVED", "REJECTED", "COMPLETED", "CANCELLED"],
  // Matériel promotionnel : « décidé » = l'agence est choisie. Au-delà, le bon de commande, le
  // visa publicitaire et la conformité s'appuient sur ce qui a été arrêté — corriger le titre ou
  // le montant après coup ferait diverger la pièce et le dossier.
  PROMO_MATERIAL: ["AGENCY_CHOSEN", "BC_FINANCE_REVIEW", "BC_VALIDATED", "BC_SENT", "PAYMENT_INITIATED", "PAYMENT_DONE", "MATERIAL_PRODUCED", "CONFORMITY_REVIEW", "COMPLETED", "CANCELLED"],
  EVENT: ["APPROVED", "REJECTED", "COMPLETED", "CANCELLED"],
  // Un contrat ACTIF engage déjà les deux parties : ses termes font foi tels qu'ils ont été validés
  // (`isContractEditable` ne garde ouverts que ses tâches et ses pièces). Un contrat RENVOYÉ pour
  // correction redevient un brouillon : il se corrige de nouveau.
  CONSULTING_CONTRACT: ["ACTIVE", "EXPIRED", "CANCELLED"],
  // Refusée, une « autre demande » se RESOUMET (avec ce qui a changé) : elle ne se corrige pas en
  // silence sous une décision qui la refuse.
  AD_PRO_OTHER: ["APPROVED", "REFUSED", "DONE", "CANCELLED"],
};

/**
 * La demande est-elle tranchée ?
 *
 * Un dossier de matériel promotionnel À CIRCUIT garde son `status` de création pour toujours
 * (§118.153) : c'est son `circuitState` qui dit où il en est. Le lire par le `status` le déclarait
 * « jamais tranché », donc modifiable par son demandeur jusqu'au paiement (audit 360°, R16). On lit
 * l'état UNIFIÉ que la liste « Toutes les demandes » affiche — refusé, validé jusqu'au bout, terminé —,
 * pas une seconde définition.
 */
export function isAdProDecided(kind: AdProKind, status: string, circuitState?: string | null): boolean {
  if (kind === "PROMO_MATERIAL" && circuitState) {
    // Un dossier RENVOYÉ pour correction n'est pas tranché : il est chez son demandeur, qui doit
    // justement pouvoir le corriger (§118.190). La marque ne change rien à cette question — on la
    // tait, et seules les issues réelles (refusé, validé jusqu'au bout, terminé) ferment la porte.
    return etatAdProDuDossier({ status, circuitState, circuitVersion: null, returnedAt: null }) !== "AWAITING";
  }
  return DECIDED_STATUS[kind].includes(status);
}

/**
 * Champs modifiables, par type de demande — LISTE BLANCHE (cf. règle 2 ci-dessus).
 * `num` : champs numériques (montants) ; `date` : champs date ; le reste est du texte.
 */
export interface EditableField {
  key: string;
  label: string;
  type: "text" | "textarea" | "number" | "date" | "select";
  /**
   * Choix d'un champ à liste. Un champ qui se saisissait dans un MENU à la création doit se
   * remodifier dans le même menu : offrir un champ libre à la correction, c'est laisser entrer
   * « congres », « Congrés » et « CONGRÈS » à côté du « Congrès » du formulaire d'origine — et
   * les compteurs par type ne veulent alors plus rien dire.
   */
  options?: readonly { value: string; label: string }[];
  /**
   * Champ qu'une correction ne peut pas VIDER — la phrase est le refus, écrit une fois. Avant, seul
   * l'intitulé était gardé, par un nom de colonne deviné (« institution » ou « name ») : l'intitulé
   * d'un dossier de matériel promotionnel, qui s'appelle « title », pouvait donc s'effacer.
   */
  requis?: string;
}

const mapOptions = (m: Record<string, string | { label: string }>) =>
  Object.entries(m).map(([value, v]) => ({ value, label: typeof v === "string" ? v : v.label }));

export const EDITABLE_FIELDS: Record<AdProKind, readonly EditableField[]> = {
  SPONSORING: [
    { key: "institution", label: "Institution / service / association", type: "text", requis: "L'institution est obligatoire." },
    { key: "type", label: "Type de sponsoring", type: "select", options: SPONSORING_TYPES.map((t) => ({ value: t, label: t })) },
    { key: "doctor", label: "Médecin concerné", type: "text" },
    { key: "specialty", label: "Spécialité", type: "text" },
    { key: "city", label: "Ville", type: "text" },
    { key: "product", label: "Produit concerné", type: "text" },
    { key: "amountRequested", label: "Sponsoring demandé par le médecin (DZD)", type: "number" },
    { key: "amountProposed", label: "Sponsoring suggéré par le délégué (DZD)", type: "number" },
    { key: "description", label: "Description", type: "textarea" },
    { key: "comments", label: "Appréciation / recommandation", type: "textarea" },
  ],
  // PRISES EN CHARGE (décision de la Direction, 04/10/2026) : ni pays (national), ni spécialité, ni
  // produits promus, ni « Délégués présents ». « Médecins présents » / « Médecins invités » sont
  // devenus les PROFESSIONNELS PROPOSÉS, une liste de la fiche (annuaire, nouveau profil, personne
  // libre) — plus un texte libre ici. L'événement se date par son DÉBUT et sa FIN. Les colonnes
  // retirées restent en base : une liste blanche qui ne les nomme plus ne les écrit plus (§118.152c).
  CONGRESS_NATIONAL: [
    { key: "name", label: "Événement", type: "text", requis: "Le nom de l'événement est obligatoire." },
    { key: "eventType", label: "Type d'événement", type: "select", options: mapOptions(NATIONAL_EVENT_TYPE) },
    { key: "hostInstitution", label: "Établissement / association hôte", type: "text" },
    { key: "city", label: "Ville", type: "text" },
    { key: "date", label: "Date de début", type: "date", requis: "La date de début est obligatoire." },
    { key: "endDate", label: "Date de fin", type: "date", requis: "La date de fin est obligatoire." },
    // LE MODE DE PRISE EN CHARGE (Direction, 10/2026) — corrigeable par le demandeur avant la décision, par la Direction toujours.
    { key: "careMode", label: "Mode de prise en charge", type: "select", options: mapOptions(MODE_LIBELLE), requis: "Choisissez le mode de prise en charge." },
    { key: "estimatedBudget", label: "Budget estimé", type: "number" },
  ],
  CONGRESS_INTERNATIONAL: [
    { key: "name", label: "Événement", type: "text", requis: "Le nom de l'événement est obligatoire." },
    { key: "country", label: "Pays", type: "text" },
    { key: "city", label: "Ville", type: "text" },
    { key: "startDate", label: "Date de début", type: "date", requis: "La date de début est obligatoire." },
    { key: "endDate", label: "Date de fin", type: "date", requis: "La date de fin est obligatoire." },
    { key: "careMode", label: "Mode de prise en charge", type: "select", options: mapOptions(MODE_LIBELLE), requis: "Choisissez le mode de prise en charge." },
    { key: "estimatedBudget", label: "Budget estimé", type: "number" },
    { key: "participants", label: "Participants Adventum", type: "textarea" },
  ],
  PROMO_MATERIAL: [
    { key: "title", label: "Intitulé du matériel", type: "text", requis: "L'intitulé du matériel est obligatoire." },
    { key: "description", label: "Description / besoin", type: "textarea" },
    { key: "amount", label: "Budget global", type: "number" },
  ],
  EVENT: [
    { key: "name", label: "Nom de l'événement", type: "text", requis: "Le nom de l'événement est obligatoire." },
    { key: "type", label: "Type", type: "select", options: mapOptions(EVENT_TYPE) },
    // QUI ORGANISE — un événement Ad & Pro est externe (Direction, 27/10).
    { key: "organizer", label: "Organisateur", type: "text" },
    { key: "format", label: "Format", type: "select", options: mapOptions(EVENT_FORMAT) },
    { key: "location", label: "Lieu", type: "text" },
    { key: "city", label: "Ville", type: "text" },
    { key: "country", label: "Pays", type: "text" },
    { key: "startDate", label: "Date de début", type: "date" },
    { key: "endDate", label: "Date de fin", type: "date" },
    { key: "specialty", label: "Spécialité", type: "text" },
    { key: "products", label: "Produits promus", type: "text" },
    { key: "estimatedBudget", label: "Budget estimé", type: "number" },
    { key: "description", label: "Description", type: "textarea" },
  ],
  CONSULTING_CONTRACT: [
    { key: "title", label: "Intitulé du contrat", type: "text", requis: "L'intitulé du contrat est obligatoire." },
    { key: "counterparty", label: "Consultant / cabinet", type: "text", requis: "Indiquez le consultant ou le cabinet — un contrat a deux parties." },
    { key: "counterpartyContact", label: "Contact", type: "text" },
    { key: "startDate", label: "Début", type: "date" },
    { key: "endDate", label: "Fin", type: "date" },
    { key: "amount", label: "Rémunération (DZD)", type: "number" },
    { key: "billing", label: "Rythme", type: "select", options: CONSULTING_BILLING_OPTIONS, requis: "Choisissez le rythme de la rémunération." },
    { key: "scope", label: "Objet de la mission", type: "textarea" },
    { key: "paymentTerms", label: "Modalités de paiement", type: "textarea" },
    { key: "notes", label: "Notes internes", type: "textarea" },
  ],
  AD_PRO_OTHER: [
    { key: "title", label: "Objet de la demande", type: "text", requis: "L'objet de la demande est obligatoire." },
    { key: "description", label: "Description", type: "textarea", requis: "Décrivez la demande — c'est sur cette description que la décision se prendra." },
    { key: "beneficiary", label: "Pour qui / avec qui", type: "text" },
    { key: "amount", label: "Montant (DZD)", type: "number" },
  ],
};

/**
 * LES DEUX BOUTS D'UNE PÉRIODE, par nature — lus ENSEMBLE par la correction : corriger la seule fin
 * avant le début enregistrait un événement qui se termine avant d'avoir commencé. Une table, et non
 * une condition par nature recopiée dans l'action.
 */
export const PERIODE_DE_LA_DEMANDE: Partial<Record<AdProKind, { debut: string; fin: string }>> = {
  CONSULTING_CONTRACT: { debut: "startDate", fin: "endDate" },
  CONGRESS_NATIONAL: { debut: "date", fin: "endDate" },
  CONGRESS_INTERNATIONAL: { debut: "startDate", fin: "endDate" },
};

/** Le champ existe-t-il dans la liste blanche de ce type de demande ? */
export function editableField(kind: AdProKind, key: string): EditableField | null {
  return EDITABLE_FIELDS[kind].find((f) => f.key === key) ?? null;
}

/**
 * Résumé lisible d'une modification, pour le journal d'audit. On note ce qui CHANGE (avant →
 * après), pas l'état final : relire « ville : Alger » n'apprend rien, « ville : Oran → Alger »
 * dit exactement ce qui s'est passé.
 */
export function describeChanges(
  kind: AdProKind,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string[] {
  const out: string[] = [];
  for (const f of EDITABLE_FIELDS[kind]) {
    if (!(f.key in after)) continue;
    const a = normalize(before[f.key]);
    const b = normalize(after[f.key]);
    if (a === b) continue;
    // Un menu se raconte par ses LIBELLÉS : « Rythme : MONTHLY → ONE_OFF » n'apprend rien à personne.
    const dit = (v: string) => (f.options?.find((o) => o.value === v)?.label ?? v) || "—";
    out.push(`${f.label} : ${dit(a)} → ${dit(b)}`);
  }
  return out;
}

function normalize(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  // Les Decimal de Prisma s'affichent correctement via String() (ils portent un toString()).
  return String(v).trim();
}
