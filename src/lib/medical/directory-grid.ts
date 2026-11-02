import { DOCTOR_TITLE, MEDICAL_SECTOR, SEGMENT_LEVEL, ALGERIA_WILAYAS } from "@/lib/labels";
import { lienDeSpecialiteValide } from "@/lib/annuaires/specialites";

/**
 * L'ANNUAIRE ÉDITABLE — les colonnes exactes du terrain, et leur éditeur.
 *
 * L'écran de l'annuaire est une FEUILLE que l'on corrige à la main, cellule par cellule. Les
 * colonnes sont celles que la promotion médicale emploie réellement — Nom, Prénom, Adresse,
 * Wilaya, Potentiel, Code postal, Téléphone, Spécialité, Grade, Mail, Privé/Public — et chaque
 * colonne sait comment elle s'édite : au clavier (texte) ou dans une liste fermée (menu
 * déroulant). Les listes fermées — wilaya, grade, secteur, potentiel — évitent qu'« Alger » et
 * « ALGER », « Pr » et « Professeur » se comptent séparément : c'est précisément le comptage
 * qu'un annuaire vient chercher.
 *
 * LA « VILLE » A QUITTÉ LA FEUILLE (décision de la Direction, 09/2026). Le découpage qui compte
 * pour une force de vente algérienne est la WILAYA, liste fermée de 58 noms ; la ville était un
 * texte libre à côté, tapé de trois façons pour le même endroit, et qui ne servait ni au comptage
 * ni au secteur. Un fichier importé qui porte une colonne « Ville » n'est pas perdu pour autant :
 * elle sert à DÉDUIRE la wilaya (`directory-sheet.ts`), et c'est la wilaya qu'on garde.
 *
 * L'ÉTABLISSEMENT ET LE SERVICE SONT DES LIENS (décision de la Direction, 01/10 — §118.172).
 * « Les annuaires des médecins et des pharmaciens doivent tous posséder un lien avec [l'annuaire
 * des établissements] pour la colonne établissement et la colonne service. » Les deux cellules se
 * CHOISISSENT : l'établissement dans l'annuaire, le service parmi ceux de cet établissement.
 *
 * Module PUR — aucune base, aucune lecture de fichier. Il décrit les colonnes et VALIDE une
 * valeur avant écriture ; il est testé, et il est partagé tel quel par la grille (client) et par
 * l'export (serveur). Un seul endroit décide de ce qu'est une colonne valide.
 */

/** Un champ éditable de l'annuaire — chacun correspond à une colonne de `MedicalDoctor`. */
export type AnnuaireField =
  | "lastName" | "firstName" | "address" | "wilaya" | "potential"
  | "postalCode" | "phone" | "specialty" | "institution" | "service" | "title" | "email" | "sector";

/**
 * `reference` : une cellule qui ne contient PAS une valeur mais un LIEN vers un autre annuaire
 * (§118.172). Ses options ne sont pas fixes — la liste des établissements, les services DE
 * l'établissement de la ligne — et c'est l'écran qui les fournit, ligne par ligne ; ce module ne
 * fait que déclarer la colonne et dire ce qu'elle affiche.
 */
export type CellEditor = "text" | "select" | "reference";

/** L'annuaire qu'une colonne `reference` désigne. */
export type CibleReference = "etablissement" | "service";

export interface AnnuaireColumn {
  field: AnnuaireField;
  /** En-tête exact, à l'écran comme dans le classeur exporté. */
  header: string;
  editor: CellEditor;
  /** Pour un menu déroulant : les seules valeurs acceptées, déjà en clair. */
  options?: { value: string; label: string }[];
  /** Une colonne texte peut proposer une saisie assistée (spécialités connues). */
  suggest?: boolean;
  /** Largeur indicative (rem) — un annuaire qu'il faut élargir à la main agace. */
  width?: number;
  /** Pour une colonne `reference` : l'annuaire qu'elle désigne. */
  reference?: CibleReference;
}

const fromMap = (map: Record<string, unknown>): { value: string; label: string }[] =>
  Object.entries(map).map(([value, entry]) => ({
    value,
    label: typeof entry === "string" ? entry : ((entry as { label?: string })?.label ?? value),
  }));

/** Les options d'une wilaya : la valeur EST le libellé (on ne stocke que le nom). */
const WILAYA_OPTIONS = ALGERIA_WILAYAS.map((w) => ({ value: w, label: w }));

/**
 * LES COLONNES, DANS L'ORDRE DEMANDÉ. C'est cette liste — et elle seule — qui gouverne l'écran
 * ET l'export : les deux ne peuvent donc pas diverger.
 */
export const ANNUAIRE_COLUMNS: AnnuaireColumn[] = [
  { field: "lastName", header: "Nom", editor: "text", width: 14 },
  { field: "firstName", header: "Prénom", editor: "text", width: 12 },
  { field: "address", header: "Adresse", editor: "text", width: 20 },
  { field: "wilaya", header: "Wilaya", editor: "select", options: WILAYA_OPTIONS, width: 14 },
  { field: "potential", header: "Potentiel", editor: "select", options: fromMap(SEGMENT_LEVEL), width: 11 },
  { field: "postalCode", header: "Code postal", editor: "text", width: 10 },
  { field: "phone", header: "Numéro de téléphone", editor: "text", width: 15 },
  { field: "specialty", header: "Spécialité 1", editor: "text", suggest: true, width: 16 },
  // LE LIEN VERS L'ANNUAIRE DES ÉTABLISSEMENTS (§118.172) — choisi dans la liste, jamais tapé :
  // « CHU Mustapha », « C.H.U Mustapha » et « chu mustapha » étaient trois hôpitaux pour les
  // humains et zéro pour le logiciel. Le service est celui DE l'établissement de la ligne.
  { field: "institution", header: "Établissement", editor: "reference", reference: "etablissement", width: 20 },
  { field: "service", header: "Service", editor: "reference", reference: "service", width: 15 },
  { field: "title", header: "Grade", editor: "select", options: fromMap(DOCTOR_TITLE), width: 15 },
  { field: "email", header: "Mail", editor: "text", width: 18 },
  { field: "sector", header: "Privé/Public", editor: "select", options: fromMap(MEDICAL_SECTOR), width: 13 },
];

const BY_FIELD = new Map<string, AnnuaireColumn>(ANNUAIRE_COLUMNS.map((c) => [c.field, c]));

/** Ce texte est-il bien un champ éditable de l'annuaire ? Garde d'entrée de l'action serveur. */
export function isAnnuaireField(x: unknown): x is AnnuaireField {
  return typeof x === "string" && BY_FIELD.has(x);
}

/** Les valeurs enum stockées telles quelles (validées avant écriture). */
const SEGMENT_VALUES = Object.keys(SEGMENT_LEVEL);
const TITLE_VALUES = Object.keys(DOCTOR_TITLE);
const plierGrade = (t: string) => t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z]+/g, "");
/** Un grade dit par sa clé, son libellé, ou « Dr » / « Docteur » (aucun grade précis) ; inconnu → null. */
export function gradeDuTexte(v: string): string | null {
  if (TITLE_VALUES.includes(v)) return v;
  const p = plierGrade(v);
  if (["dr", "docteur", "doctor"].includes(p)) return "AUTRE";
  return TITLE_VALUES.find((k) => plierGrade(k) === p || plierGrade(DOCTOR_TITLE[k]!) === p) ?? null;
}
const SECTOR_VALUES = Object.keys(MEDICAL_SECTOR);

/**
 * Valide et normalise une valeur avant écriture.
 *
 * Les menus déroulants n'acceptent QUE leurs options — une valeur hors liste est refusée, jamais
 * écrite en silence (sinon la wilaya « Algr » se glisse à côté d'« Alger » et casse le comptage).
 * Le texte est simplement mis au propre ; vide devient `null` — une cellule effacée n'est pas la
 * chaîne vide, c'est l'absence de valeur.
 */
export function validateAnnuaireValue(
  field: AnnuaireField,
  raw: string,
): { ok: true; value: string | null } | { ok: false; error: string } {
  const v = String(raw ?? "").replace(/\s+/g, " ").trim();
  switch (field) {
    case "wilaya":
      if (!v) return { ok: true, value: null };
      return ALGERIA_WILAYAS.includes(v)
        ? { ok: true, value: v }
        : { ok: false, error: "Wilaya hors de la liste des 58 wilayas." };
    case "potential":
      return SEGMENT_VALUES.includes(v) ? { ok: true, value: v } : { ok: false, error: "Niveau invalide." };
    case "title": {
      // Le grade se dit aussi par son LIBELLÉ (« Professeur »), et « Dr » / « Docteur » n'est pas un grade (lot T2 :
      // « ajoute le Dr Walid OUNISSI » était refusé — « Grade invalide ») : la fiche reste sans grade précis (« Autre »).
      const grade = gradeDuTexte(v);
      return grade ? { ok: true, value: grade } : { ok: false, error: "Grade invalide." };
    }
    case "sector":
      return SECTOR_VALUES.includes(v) ? { ok: true, value: v } : { ok: false, error: "Secteur invalide." };
    case "institution":
    case "service":
      // UN IDENTIFIANT, pas un texte : son existence — et, pour un service, son appartenance à
      // l'établissement de la fiche — se vérifient en base, dans l'action. Vide = retirer le lien.
      return { ok: true, value: v || null };
    default:
      // Champs texte : nom, prénom, adresse, code postal, téléphone, spécialité, mail.
      return { ok: true, value: v || null };
  }
}

/** Une colonne PROPRE à un annuaire, telle que la feuille la rend (§118.133). */
export interface CustomColumnVue {
  id: string;
  key: string;
  label: string;
  kind: "TEXT" | "NUMBER" | "DATE" | "CHOICE";
  options: string[];
}

/** La fiche telle que la grille et l'export la lisent — valeurs brutes (enum non traduits). */
export interface AnnuaireRow {
  id: string;
  lastName: string | null;
  firstName: string | null;
  address: string | null;
  wilaya: string | null;
  potential: string;
  postalCode: string | null;
  phone: string | null;
  /**
   * LA SPÉCIALITÉ RATTACHÉE (§118.180) — l'identifiant du référentiel quand le lien VAUT, sinon
   * `null`. Une fiche peut porter une spécialité écrite SANS lien (« Cardio »), ou un texte qui
   * contredit son lien (un import d'avant) : elle est « à rattacher », et la feuille le montre.
   */
  specialtyId: string | null;
  /** Le nom affiché : celui du référentiel quand le lien vaut, sinon le texte écrit. */
  specialty: string | null;
  /**
   * L'ÉTABLISSEMENT RATTACHÉ (§118.172) — l'identifiant de l'annuaire des établissements, ou
   * `null`. Une fiche d'avant le lien peut porter un nom tapé à la main SANS identifiant : elle
   * est « à rattacher », et la feuille le montre comme tel.
   */
  institutionId: string | null;
  /** Le nom affiché : celui de l'établissement rattaché, sinon le texte hérité. */
  institution: string | null;
  /** Le SERVICE, toujours un service de `institutionId`. */
  serviceId: string | null;
  service: string | null;
  title: string;
  email: string | null;
  sector: string;
  /** Les valeurs des colonnes PROPRES à l'annuaire (`MedicalDoctor.custom`), par clé de colonne. */
  custom?: Record<string, unknown>;
  /**
   * L'ÉTABLISSEMENT DÉDUIT (Direction, 06/10) pour une fiche sans établissement : « unique » = le rattachement
   * automatique le pose ; « a_trancher » = plusieurs hôpitaux possibles, proposés en tête de la cellule.
   */
  deduction?: { statut: "unique" | "a_trancher"; candidats: string[]; raison: string };
}

/** Une fiche porte-t-elle une spécialité écrite, sans lien vers le référentiel ? (§118.180) */
export function specialiteEstARattacher(row: Pick<AnnuaireRow, "specialtyId" | "specialty">): boolean {
  return row.specialtyId === null && Boolean(row.specialty?.trim());
}

/** Une fiche porte-t-elle un établissement tapé à la main, sans lien vers l'annuaire ? */
export function estARattacher(row: Pick<AnnuaireRow, "institutionId" | "institution">): boolean {
  return row.institutionId === null && Boolean(row.institution?.trim());
}

/**
 * LA LIGNE D'UN PRATICIEN, telle que la feuille ET le classeur la lisent — UNE seule traduction
 * de la fiche en ligne. Le chargeur et l'export la recopiaient chacun ; la seconde copie n'avait
 * pas les colonnes sur mesure, et c'est ainsi qu'un export « reprend les colonnes de l'écran »…
 * sauf celles qu'on y a ajoutées depuis (§118.5).
 */
export function ligneAnnuaire(d: {
  id: string;
  lastName: string | null;
  firstName: string | null;
  address: string | null;
  wilaya: string | null;
  potential: string;
  postalCode: string | null;
  phone: string | null;
  specialty: string | null;
  specialtyId?: string | null;
  specialtyRef?: { name: string } | null;
  institution: string | null;
  institutionId: string | null;
  institutionRef?: { name: string } | null;
  serviceId: string | null;
  serviceRef?: { name: string } | null;
  title: string;
  email: string | null;
  sector: string;
  custom?: unknown;
}): AnnuaireRow {
  // LE LIEN NE VAUT QUE SI LE TEXTE LE DÉSIGNE (§118.180) : alors le NOM du référentiel s'affiche,
  // dans son écriture propre. Un texte qui contredit le lien est une saisie plus récente (l'ancien
  // import remplaçait le texte sans toucher au lien) : la saisie l'emporte, comme à l'édition, et la
  // fiche se dit « à rattacher » — afficher le lien défairait cette saisie en silence (§118.172).
  const lien = d.specialtyRef && lienDeSpecialiteValide(d.specialty, d.specialtyRef.name) ? d.specialtyRef : null;
  return {
    id: d.id,
    lastName: d.lastName,
    firstName: d.firstName,
    address: d.address,
    wilaya: d.wilaya,
    potential: d.potential,
    postalCode: d.postalCode,
    phone: d.phone,
    specialtyId: lien ? d.specialtyId ?? null : null,
    specialty: lien ? lien.name : d.specialty ?? null,
    // Le nom de l'établissement RATTACHÉ fait foi (un renommage dans l'annuaire suit) ; le texte
    // hérité ne s'affiche que faute de lien. Un lien vers une ligne disparue retombe sur le texte.
    institutionId: d.institutionRef ? d.institutionId : null,
    institution: d.institutionRef?.name ?? d.institution ?? null,
    // Un service n'a de sens que dans son établissement : sans établissement rattaché, aucun.
    serviceId: d.institutionRef && d.serviceRef ? d.serviceId : null,
    service: d.institutionRef ? d.serviceRef?.name ?? null : null,
    title: d.title,
    email: d.email,
    sector: d.sector,
    custom: d.custom && typeof d.custom === "object" && !Array.isArray(d.custom) ? (d.custom as Record<string, unknown>) : {},
  };
}

const optionLabel = (col: AnnuaireColumn, value: string | null): string => {
  if (!value) return "";
  return col.options?.find((o) => o.value === value)?.label ?? value;
};

/** La valeur AFFICHÉE d'une cellule — un seul endroit décide, écran comme classeur. */
export function annuaireCell(row: AnnuaireRow, field: AnnuaireField): string {
  const col = BY_FIELD.get(field)!;
  const raw = row[field];
  if (col.editor === "select") return optionLabel(col, raw as string | null);
  // Une colonne `reference` porte déjà le NOM dans la ligne (`institution`, `service`) : c'est lui
  // qu'on lit et qu'on exporte — un identifiant ne dit rien à personne dans un tableur.
  return (raw as string | null) ?? "";
}

/** L'en-tête du classeur exporté — l'ordre exact des colonnes de l'annuaire. */
export function annuaireHeaderRow(): string[] {
  return ANNUAIRE_COLUMNS.map((c) => c.header);
}

/** Le nom d'affichage recomposé à partir du prénom et du nom (« Amina MOUFFOK »). */
export function composeDoctorName(firstName: string | null, lastName: string | null): string {
  return [firstName, lastName].map((s) => (s ?? "").trim()).filter(Boolean).join(" ").trim();
}
