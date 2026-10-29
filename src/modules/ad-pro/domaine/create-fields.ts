import type { FieldDef } from "@/components/shared/create-record-button";
import { PRIORITY, SPONSORING_TYPES, SPONSORING_NATURE, CONSULTING_BILLING_OPTIONS } from "@/lib/labels";
import { wilayaOptions } from "@/lib/geo/algeria";
import { availableProductOptions, doctorOptions, specialtyOptions, CHAMPS_MEDECINS, type DoctorRow, type ProductRow, type SpecialtyRow } from "./pickers";
import type { AdProKind } from "./unified";
import type { OptionCatalogue } from "@/lib/promo-material/achats";

/**
 * LES CHAMPS DE CRÉATION AD & PRO, ÉCRITS UNE SEULE FOIS.
 *
 * Depuis que « Nouvelle demande » ouvre le formulaire SUR l'écran Ad & Pro, chaque formulaire a
 * deux points de montage : l'écran de la nature (Sponsoring, Matériel promotionnel…) et le panneau
 * commun. Deux listes de champs recopiées, c'est la garantie qu'un champ ajouté d'un côté
 * manquera de l'autre — et le demandeur ne saura pas pourquoi sa demande est incomplète selon la
 * porte d'entrée. La définition vit donc ici, et les deux écrans la lisent.
 *
 * Module PUR : aucune lecture de base, aucun composant — seulement des données de formulaire.
 * C'est ce qui lui permet d'être importé aussi bien par une page serveur que par le panneau
 * client.
 */

export interface PersonOption { id: string; name: string }
export interface DoctorOption { id: string; name: string; specialty: string; city: string }
export interface UserOption { id: string; name: string; role: string }

/** Tout ce qu'il faut au panneau commun pour dresser les formulaires des natures créables. */
export interface AdProCreateData {
  /** Médecins invitables (prises en charge) — vient de la Promotion médicale. */
  doctors: DoctorOption[];
  /** Les produits dont le traitement réglementaire est TERMINÉ — les seuls promouvables. */
  products: ProductRow[];
  /** Collaborateurs actifs : participants, responsable d'événement. */
  users: UserOption[];
  /**
   * LE CATALOGUE PROMOTIONNEL ET LES PRODUITS — une demande de matériel promotionnel se compose de
   * LIGNES dès sa création (§118.171). Vides quand la nature n'est pas demandée.
   */
  catalogueMateriel: { catalogue: OptionCatalogue[]; produits: { id: string; nom: string }[] };
  /** Le référentiel des spécialités médicales (`MedicalSpecialty`). */
  specialties: SpecialtyRow[];
  /** Les libellés de spécialité HÉRITÉS des fiches médecins non rattachées — la réalité y est. */
  specialtiesHeritees: string[];
  /**
   * La gamme DÉDUITE du demandeur, quand elle se lit à coup sûr (KAM par sa fiche, superviseur
   * national par la gamme qu'il supervise). `null` ⇒ le choix reste manuel.
   */
  businessUnitDeduite: { id: string; name: string; raison: string } | null;
  /** Entités (consulting, autres demandes), déjà réduites à des options. */
  companies: { value: string; label: string }[];
  /** LES GAMMES : c'est le budget Ad&Pro de l'une d'elles que la demande engage. */
  businessUnits: { id: string; name: string }[];
}

const optionsOf = (map: Record<string, string | { label: string }>): { value: string; label: string }[] =>
  Object.entries(map).map(([value, v]) => ({ value, label: typeof v === "string" ? v : v.label }));

/** Ne garde que les personnes — l'appelant passe souvent la liste complète des collaborateurs. */
export function toPeople(users: readonly UserOption[]): PersonOption[] {
  return users.map((u) => ({ id: u.id, name: u.name }));
}

/*
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * IL N'Y A PLUS DE « RÉFÉRENT DIRECTION MARKETING » À NOMMER SUR UNE NOUVELLE DEMANDE.
 *
 * Décision de la Direction (22/09/2026) : « on n'a pas besoin d'un référent Direction Marketing,
 * ça va DIRECT chez le directeur/directrice du département marketing. »
 *
 * Le champ ne conditionnait déjà plus rien — l'arbitrage est porté par le RÔLE Direction
 * Marketing tout entier, et l'étape le dit dans sa portée. Il ne restait qu'un menu facultatif
 * de plus sur un formulaire que la Direction vient de rendre quasi entièrement obligatoire, et
 * qui demandait au demandeur de désigner quelqu'un dans une direction qu'il ne connaît pas.
 *
 * CE QUE CE RETRAIT LAISSE EN PLACE, et c'est délibéré : `productManagerId` reste LU (droits de
 * la fiche, déclaration d'information médicale) et reste ACCEPTÉ par les actions serveur. Le
 * référent se configurera PAR BUSINESS UNIT (« chaque BU aura son ou ses référents de la
 * direction marketing depuis la configuration des BU ») ; d'ici là, plus rien ne l'écrit et ses
 * lecteurs se dégradent dans le sens sûr — un droit de moins, jamais un droit de plus.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/**
 * LA BUSINESS UNIT QUI PORTE LA DEMANDE — c'est SON budget Ad&Pro qui est engagé.
 *
 * Sans ce champ, la dépense pesait sur un total commercial que personne ne pouvait répartir :
 * « combien l'oncologie a-t-elle dépensé cette année ? » n'avait pas de réponse, et l'on
 * reconstituait le chiffre à la main en filtrant sur des noms de produits.
 *
 * Le choix est OBLIGATOIRE dès qu'il y a des gammes à proposer — une demande sans gamme retombe
 * dans l'indistinct, et personne ne revient la rattacher. Il DISPARAÎT quand aucune BU n'existe :
 * exiger un choix dans une liste vide n'est pas une règle, c'est une impasse. Et il DISPARAÎT aussi
 * quand la gamme se déduit du demandeur : le serveur l'impose, la lui redemander est du bruit.
 */
export function businessUnitField(
  businessUnits: readonly { id: string; name: string }[],
  deduite?: { id: string; name: string; raison: string } | null,
): FieldDef[] {
  // LA GAMME SE LIT SUR LA PERSONNE : un KAM par sa fiche force de vente, un superviseur
  // national par la gamme qu'il supervise. Le champ DISPARAÎT alors — « si un KAM fait
  // déjà partie d'une BU, ça ne doit pas lui proposer le champ » — et le serveur la pose
  // (`gammeImposee`) : un champ de formulaire se forge, et une gamme forgée fait peser la dépense
  // sur le budget Ad&Pro d'une autre équipe (`business-unit-auto.ts`).
  if (deduite) return [];
  if (businessUnits.length === 0) return [];
  return [{
    type: "select", name: "businessUnitId", label: "Business Unit", required: true, full: true,
    options: businessUnits.map((b) => ({ value: b.id, label: b.name })),
    placeholder: "— Choisir la gamme —",
    hint: "C'est son budget Ad&Pro qui est engagé — et c'est par elle que la dépense se lit dans Budgets.",
  }];
}

/**
 * QUELLE NATURE DÉSIGNE DES PRATICIENS ET DES PRODUITS — la décision, écrite une fois.
 *
 * Décision de la Direction (22/09/2026) : « dans la nouvelle demande dans Ad&Pro (HORS matériel
 * promotionnel), on doit pouvoir sélectionner un ou plusieurs médecins et un ou plusieurs
 * produits concernés. » Une seule nature est exclue, nommément ; les six autres sont concernées.
 *
 * `Record<AdProKind, …>` SANS valeur optionnelle : une huitième nature ajoutée à `AdProKind`
 * fait échouer le typecheck ICI, au lieu de sortir en silence sans ces deux champs — c'est
 * exactement le trou que ce lot referme, mesuré sur QUATRE natures sur six (§118.130).
 *
 * TROIS ÉTATS ET NON UN BOOLÉEN, parce que « pas de champ » et « champ facultatif » ne sont pas
 * la même décision et que l'exception doit porter sa raison (§118.130) :
 *
 *  · OBLIGATOIRE — la demande N'A PAS DE SENS sans eux : un sponsoring et un événement
 *    promotionnels se justifient PAR le praticien sollicité et le produit promu, et c'est sur ce
 *    couple que l'arbitrage budgétaire se fait. La Direction les a rendus obligatoires (§118.142).
 *
 *  · FACULTATIF — le champ existe, on ne le REFUSE pas vide. « On doit POUVOIR sélectionner »
 *    n'est pas « on doit sélectionner », et exiger un praticien sur un contrat de consulting
 *    réglementaire — qui n'en a aucun — serait un refus à tort, plus coûteux que le défaut qu'on
 *    corrige (§118.27). Pour les deux prises en charge, la raison est plus précise : les
 *    personnes prises en charge s'ajoutent SUR LA FICHE (`careBeneficiaries`), et le panneau le
 *    dit ; les médecins cochés à la création sont les praticiens INVITÉS, pas les bénéficiaires.
 *    Les exiger bloquerait une création parfaitement légitime.
 *
 *  · { medecinsSeuls } — la nature désigne des PRATICIENS et pas de produit, avec la raison. Les
 *    deux prises en charge depuis la décision du 04/10/2026.
 *
 *  · { sans } — la nature ne désigne NI praticien NI produit, avec la raison à côté. Une
 *    exception qui se compte, jamais un trou.
 */
export type ExigenceReferentiels = "OBLIGATOIRE" | "FACULTATIF" | { medecinsSeuls: string } | { sans: string };

const PRISE_EN_CHARGE_SANS_PRODUIT =
  "Une prise en charge emmène des PROFESSIONNELS à un événement : la Direction a retiré la spécialité "
  + "et les produits promus de sa saisie (04/10/2026). Ses médecins sont les professionnels proposés, "
  + "facultatifs à la création : la liste se complète sur la fiche.";

export const REFERENTIELS_PAR_NATURE: Record<AdProKind, ExigenceReferentiels> = {
  SPONSORING: "OBLIGATOIRE",
  EVENT: "OBLIGATOIRE",
  CONGRESS_INTERNATIONAL: { medecinsSeuls: PRISE_EN_CHARGE_SANS_PRODUIT },
  CONGRESS_NATIONAL: { medecinsSeuls: PRISE_EN_CHARGE_SANS_PRODUIT },
  CONSULTING: "FACULTATIF",
  OTHER: "FACULTATIF",
  PROMO_MATERIAL: {
    sans: "Le matériel promotionnel est produit par une agence : il porte une campagne et un type "
      + "de support, pas un praticien sollicité. La Direction l'a exclu nommément.",
  },
};

/** La nature propose-t-elle les deux référentiels ? Lu par le chargeur, qui ne lit que l'utile. */
export function natureDesigneMedecinsEtProduits(kind: AdProKind): boolean {
  return typeof REFERENTIELS_PAR_NATURE[kind] === "string";
}

/** La nature désigne-t-elle des PRATICIENS (avec ou sans produit) ? */
export function natureDesigneMedecins(kind: AdProKind): boolean {
  const e = REFERENTIELS_PAR_NATURE[kind];
  return typeof e === "string" || "medecinsSeuls" in e;
}

/**
 * LE MÉDECIN ET LE PRODUIT CONCERNÉS — deux menus, et un repli quand le référentiel est muet.
 *
 * Ils étaient libres, et la colonne devenait inexploitable : un produit écrit de six façons (et
 * parfois un dossier réglementaire EN COURS, dont la promotion est interdite), un médecin nommé
 * de mémoire qui ne se rapproche d'aucune fiche.
 *
 * On choisit désormais dans le réel, et PLUSIEURS de chaque : une prise en charge concerne
 * souvent deux praticiens et trois produits, et n'en accepter qu'un faisait écrire le reste dans
 * la description — où rien ne le compte.
 *
 * Le repli en saisie libre reste offert quand le référentiel est vide : un menu sans option est
 * un cul-de-sac, et une demande légitime ne doit pas attendre qu'on peuple une table. Il PORTE
 * ALORS le nom singulier (`doctor`, `product`), celui de la colonne — c'est `readMultiField` qui
 * réunit les deux chemins côté serveur, une seule fois (§118.5).
 */
/**
 * Les deux champs sont DÉCLARÉS SÉPARÉMENT — et ce n'est pas de la décoration.
 *
 * Les formulaires des prises en charge sont écrits à la main (ils ont un choix de médecins par
 * spécialité que `FieldDef` ne sait pas exprimer) et n'ont besoin QUE du produit. Prendre
 * `medecinsEtProduitsFields(...)[1]` marcherait aujourd'hui et désignerait le mauvais champ le
 * jour où l'on en ajoute un troisième au milieu.
 */
export function champMedecins(opts: { doctors: readonly DoctorRow[]; obligatoire: boolean }): FieldDef {
  const medecins = doctorOptions(opts.doctors);
  const req = opts.obligatoire;
  const facultatif = req ? "" : " Facultatif.";
  return medecins.length > 0
    ? {
        type: "multiselect", name: "doctorIds", label: "Médecin(s) concerné(s)", required: req, full: true,
        options: medecins, searchPlaceholder: "Chercher un médecin de l'annuaire…",
        emptyLabel: "Aucun médecin dans l'annuaire.",
        hint: `Depuis l'annuaire des praticiens. Plusieurs choix possibles.${facultatif}`,
        // LE MÉDECIN ABSENT DE L'ANNUAIRE (§118.175) : coché « non présent », il s'écrit à la main et
        // s'AJOUTE aux médecins cochés — `lireMedecinsDemande` les réunit côté serveur.
        horsListe: { name: CHAMPS_MEDECINS.horsAnnuaire, label: "Médecin non présent dans l'annuaire", placeholder: "Un nom par ligne — Dr …" },
      }
    : { type: "text", name: "doctor", label: "Médecin concerné", required: req, full: true, hint: `L'annuaire des praticiens est vide : saisissez le nom.${facultatif}` };
}

export function champProduits(opts: { products: readonly ProductRow[]; obligatoire: boolean }): FieldDef {
  const produits = availableProductOptions(opts.products);
  const req = opts.obligatoire;
  const facultatif = req ? "" : " Facultatif.";
  return produits.length > 0
    ? {
        type: "multiselect", name: "productIds", label: "Produit(s) concerné(s)", required: req, full: true,
        options: produits, searchPlaceholder: "Chercher un produit…",
        emptyLabel: "Aucun produit au traitement terminé.",
        hint: `Seuls les produits dont le traitement réglementaire est TERMINÉ — les seuls qu'on ait le droit de promouvoir.${facultatif}`,
      }
    : { type: "text", name: "product", label: "Produit concerné", required: req, full: true, hint: `Aucun dossier réglementaire n'est encore au traitement terminé.${facultatif}` };
}

export function medecinsEtProduitsFields(opts: {
  products: readonly ProductRow[];
  doctors: readonly DoctorRow[];
  /** `false` ⇒ les champs existent et ne sont pas exigés (voir `REFERENTIELS_PAR_NATURE`). */
  obligatoire: boolean;
}): FieldDef[] {
  return [
    champMedecins({ doctors: opts.doctors, obligatoire: opts.obligatoire }),
    champProduits({ products: opts.products, obligatoire: opts.obligatoire }),
  ];
}

/** Le couple de référentiels PLUS la ville — la forme du sponsoring, qui porte une wilaya. */
function referentielFields(opts: { products: readonly ProductRow[]; doctors: readonly DoctorRow[] }): FieldDef[] {
  return [
    ...medecinsEtProduitsFields({ products: opts.products, doctors: opts.doctors, obligatoire: true }),
    {
      type: "select", name: "city", label: "Ville (wilaya)", required: true,
      options: wilayaOptions(), placeholder: "— Choisir la wilaya —",
    },
  ];
}

/** Le nom du champ des pièces jointes LIBRES d'une création Ad & Pro — lu par les actions serveur. */
export const CHAMP_PIECES_COMPLEMENTAIRES = "annexes";

/**
 * LES PIÈCES JOINTES LIBRES D'UNE CRÉATION — sans `accept` : tout type (Excel compris), le serveur
 * refusant seul ce qui s'exécute (`validateAttachments`). Facultatives.
 */
export function piecesComplementairesField(hint: string, label = "Autres pièces jointes"): FieldDef {
  return { type: "file", name: CHAMP_PIECES_COMPLEMENTAIRES, label, multiple: true, full: true, hint };
}

export function sponsoringCreateFields(opts: {
  products?: readonly ProductRow[];
  doctors?: readonly DoctorRow[];
  businessUnits?: readonly { id: string; name: string }[];
  /** La gamme déduite du demandeur — le menu ne propose alors que celle-là. */
  businessUnitDeduite?: { id: string; name: string; raison: string } | null;
  /** Le référentiel des spécialités médicales (`MedicalSpecialty`) + les libellés hérités des fiches. */
  specialties?: readonly SpecialtyRow[];
  specialtiesHeritees?: readonly (string | null | undefined)[];
}): FieldDef[] {
  return [
    ...businessUnitField(opts.businessUnits ?? [], opts.businessUnitDeduite ?? null),
    { type: "text", name: "institution", label: "Institution / Association", required: true },
    // LA DEMANDE DU MÉDECIN — pièce OBLIGATOIRE, et scannée.
    //
    // C'est le document que tout le circuit lit : le National Sales pour juger l'opportunité,
    // Direction Marketing pour arbitrer le budget. Une demande sans elle faisait un aller-retour
    // par la messagerie à chaque fois. Les formats sont bornés à ceux d'un scan ou d'un courrier
    // (PDF, Word) — le serveur revérifie, un `accept` ne fait que guider le sélecteur.
    {
      type: "file", name: "files", label: "Demande(s) du médecin (scan PDF ou Word)",
      required: true, multiple: true, full: true, accept: ".pdf,.doc,.docx",
      hint: "Courrier ou demande du praticien, SCANNÉ (PDF ou Word). Plusieurs fichiers possibles. "
        + "+ Document original obligatoirement au bureau du secrétariat.",
    },
    // LES AUTRES PIÈCES — un tableau Excel de participants, un programme, un devis (Direction,
    // 10/2026). Elles ne remplacent pas la demande du médecin, qui reste un scan : elles
    // l'accompagnent, en tout type sauf ce qui s'exécute (`politique-televersement`).
    piecesComplementairesField("Excel, programme, devis… Tout type sauf programmes et scripts."),
    ...referentielFields({ products: opts.products ?? [], doctors: opts.doctors ?? [] }),
    ...specialtyField(opts.specialties ?? [], opts.specialtiesHeritees ?? []),
    // TYPE ET IMPORTANCE : un choix EXPLICITE, plus une valeur par défaut.
    //
    // Ils avaient tous deux une valeur pré-remplie (« Congrès », « Moyenne ») : une demande
    // envoyée sans y toucher sortait donc avec une nature et une priorité que personne n'avait
    // décidées, et c'est sur elles que l'arbitrage se fait.
    {
      type: "select", name: "type", label: "Type", required: true,
      options: SPONSORING_TYPES.map((t) => ({ value: t, label: t })),
      placeholder: "— Choisir le type —",
    },
    // LE SPONSORING DEMANDÉ ET LE SPONSORING SUGGÉRÉ — pas un « budget » (§118.151).
    //
    // « On ne lui demande pas un budget suggéré ou quoi : on lui demande un sponsoring demandé par
    // le médecin et un sponsoring suggéré par le délégué » (Direction, 09/2026). Le budget se
    // décide APRÈS — poste par poste, puis à la validation finale — et c'est ce libellé qui le dit.
    // La NATURE vient avec : c'est elle qui décide le poste créé automatiquement avec la demande.
    {
      type: "select", name: "nature", label: "Nature du sponsoring", required: true, full: true,
      options: Object.entries(SPONSORING_NATURE).map(([value, label]) => ({ value, label })),
      placeholder: "— Direct ou indirect —",
      hint: "Le sponsoring s'ajoute automatiquement comme premier POSTE de la demande, chiffré à ce que suggère le délégué. "
        + "Les autres postes (stand, prises en charge…) s'ajoutent après la pré-validation de la tenue.",
    },
    { type: "number", name: "amountRequested", label: "Sponsoring demandé par le médecin (DZD)", required: true },
    { type: "number", name: "amountProposed", label: "Sponsoring suggéré par le délégué (DZD)", required: true },
    {
      type: "select", name: "strategicImportance", label: "Importance stratégique", required: true,
      options: optionsOf(PRIORITY), placeholder: "— Choisir l'importance —",
    },
    { type: "textarea", name: "description", label: "Description de la demande" },
    { type: "textarea", name: "comments", label: "Appréciation personnelle / recommandation" },
  ];
}

/**
 * LA SPÉCIALITÉ EN MENU DÉROULANT — et un repli quand le référentiel est muet.
 *
 * Le champ était libre : « Cardio », « cardiologie », « CARDIOLOGIE » faisaient trois lignes
 * dans un regroupement qui devrait en faire une. La liste vient du référentiel `MedicalSpecialty`
 * fusionné aux libellés hérités des fiches médecins (`pickers.ts`) — jamais d'une liste écrite à
 * la main, fausse le jour où quelqu'un en ajoute une (§118.73).
 *
 * Référentiel ET fiches vides : la saisie redevient LIBRE, obligatoire mais libre. Un menu sans
 * option est un cul-de-sac, et une demande légitime ne doit pas attendre qu'on peuple une table.
 */
export function specialtyField(
  referentiel: readonly SpecialtyRow[],
  heritees: readonly (string | null | undefined)[],
): FieldDef[] {
  const options = specialtyOptions(referentiel, heritees);
  if (options.length === 0) {
    return [{
      type: "text", name: "specialty", label: "Spécialité", required: true,
      hint: "Le référentiel des spécialités est vide : saisissez-la.",
    }];
  }
  return [{
    type: "select", name: "specialty", label: "Spécialité", required: true,
    options, placeholder: "— Choisir la spécialité —",
  }];
}

/**
 * LE CONTRAT DE CONSULTING — deux parties, une période, une rémunération, des tâches.
 *
 * Le montant ne se comprend qu'avec son RYTHME : 200 000 DZD par mois et 200 000 DZD pour la
 * mission entière n'engagent pas la même somme, et c'est exactement la confusion qui coûte cher
 * au moment de la facture. Les deux champs se suivent donc, jamais séparés.
 *
 * Les tâches se saisissent une par ligne — c'est ainsi qu'on les dicte. Un formulaire qui
 * demanderait de les ajouter une par une aurait tout l'air d'une corvée, et l'on écrirait tout
 * dans le champ « objet ».
 */
export function consultingCreateFields(opts: {
  companies: readonly { value: string; label: string }[];
  businessUnits?: readonly { id: string; name: string }[];
  businessUnitDeduite?: { id: string; name: string; raison: string } | null;
  products?: readonly ProductRow[];
  doctors?: readonly DoctorRow[];
}): FieldDef[] {
  return [
    ...businessUnitField(opts.businessUnits ?? [], opts.businessUnitDeduite ?? null),
    { type: "text", name: "title", label: "Intitulé du contrat", required: true, full: true, placeholder: "Ex. Accompagnement réglementaire 2026" },
    { type: "text", name: "counterparty", label: "Consultant / cabinet", required: true, placeholder: "L'autre partie au contrat" },
    { type: "text", name: "counterpartyContact", label: "Contact (e-mail, téléphone)" },
    { type: "select", name: "companyId", label: "Entité signataire", options: [...opts.companies], placeholder: "— Entité —" },
    { type: "date", name: "startDate", label: "Début" },
    { type: "date", name: "endDate", label: "Fin" },
    { type: "number", name: "amount", label: "Rémunération (DZD)" },
    { type: "select", name: "billing", label: "Rythme de la rémunération", options: CONSULTING_BILLING_OPTIONS, defaultValue: "ONE_OFF" },
    { type: "textarea", name: "scope", label: "Objet de la mission", full: true, placeholder: "Ce pour quoi on paie." },
    // LE PRATICIEN ET LE PRODUIT CONCERNÉS — facultatifs ici, et la raison est dans le registre :
    // un accompagnement réglementaire n'a pas de praticien, et exiger un choix qui n'existe pas
    // aurait refusé une demande légitime.
    ...medecinsEtProduitsFields({ products: opts.products ?? [], doctors: opts.doctors ?? [], obligatoire: false }),
    // Le contrat signé, les CV, une proposition commerciale : ils existent AU MOMENT où l'on
    // saisit le contrat. Renvoyer leur dépôt « à l'écran suivant », c'est les voir manquer une
    // fois sur deux.
    { type: "file", name: "files", label: "Pièces jointes", multiple: true, full: true, hint: "Contrat signé, proposition, CV, tout type de fichier." },
    { type: "textarea", name: "tasks", label: "Tâches attendues (une par ligne)", full: true, placeholder: "Audit des dossiers\nFormation de l'équipe\nRapport final" },
    { type: "textarea", name: "paymentTerms", label: "Modalités de paiement", full: true },
    { type: "textarea", name: "notes", label: "Notes internes", full: true },
  ];
}

/**
 * LE CONTRAT D'UN CONSULTANT SUIVI PAR LES RH (§118.150) — le même contrat, sans ce qui fait
 * d'un contrat une dépense de PROMOTION.
 *
 * Ni gamme, ni praticien, ni produit : ce sont des faits d'Ad & Pro, et un contrat RH ne pèse sur
 * aucun budget Ad & Pro. Les proposer ici ferait remplir des champs que l'action JETTE pour ce
 * pôle — le défaut exact du menu de gamme qui a coûté §118.140. Le pôle voyage en champ caché :
 * c'est l'action qui décide, sur le droit de CRÉER dans le module de ce pôle, jamais le formulaire.
 */
export function consultingRhCreateFields(opts: {
  companies: readonly { value: string; label: string }[];
}): FieldDef[] {
  const PROMOTION = new Set(["businessUnitId", "doctorIds", "doctor", "productIds", "product"]);
  return [
    { type: "hidden", name: "pole", value: "RH" },
    ...consultingCreateFields({ companies: opts.companies }).filter((f) => !PROMOTION.has(f.name)),
  ];
}

/**
 * LA DEMANDE « AUTRE » — volontairement courte.
 *
 * Elle n'a pas de champs propres, par définition : c'est la DESCRIPTION qui portera tout, puisque
 * aucun formulaire ne décrit pour nous ce dont il s'agit. Elle est donc obligatoire — une case
 * vide ne se tranche pas.
 */
export function adProOtherCreateFields(opts: {
  companies: readonly { value: string; label: string }[];
  businessUnits?: readonly { id: string; name: string }[];
  businessUnitDeduite?: { id: string; name: string; raison: string } | null;
  products?: readonly ProductRow[];
  doctors?: readonly DoctorRow[];
}): FieldDef[] {
  return [
    ...businessUnitField(opts.businessUnits ?? [], opts.businessUnitDeduite ?? null),
    { type: "text", name: "title", label: "Objet de la demande", required: true, full: true, placeholder: "En une phrase" },
    { type: "textarea", name: "description", label: "Description", required: true, full: true, placeholder: "Ce que vous demandez, pour qui, et pourquoi." },
    { type: "text", name: "beneficiary", label: "Pour qui / avec qui" },
    // Facultatifs, par définition de la nature : « autre » ne sait pas d'avance de quoi il s'agit.
    // Le champ EXISTE quand même — sans lui, le praticien et le produit repartaient dans la
    // description, où rien ne les compte.
    ...medecinsEtProduitsFields({ products: opts.products ?? [], doctors: opts.doctors ?? [], obligatoire: false }),
    { type: "number", name: "amount", label: "Montant estimé (DZD)" },
    { type: "select", name: "companyId", label: "Entité", options: [...opts.companies], placeholder: "— Entité —" },
    // Les pièces se joignaient seulement depuis la fiche, après coup (Direction, 10/2026).
    piecesComplementairesField("Excel, devis, courrier… Tout type sauf programmes et scripts.", "Pièces jointes"),
  ];
}
