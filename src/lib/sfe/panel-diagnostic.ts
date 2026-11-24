/**
 * POURQUOI LE PANEL D'UN KAM EST VIDE — la vraie cause, nommée (04/10/2026).
 *
 * Rapporté en production : « j'ai donné un secteur à chaque KAM mais ils ne peuvent toujours pas
 * mettre leur plan de tournée ni sélectionner les wilayas ». L'écran disait une seule chose —
 * « Votre panel est vide… demandez un secteur » — à une KAM qui EN AVAIT un. Le panel
 * (`clausePanelDuKam`, §118.179/§118.184) se vide pour au moins sept raisons distinctes, et une
 * phrase unique fait chercher au mauvais endroit (§118.30) : le superviseur réaffecte un secteur qui
 * l'était déjà, pendant que la vraie panne — des fiches de médecins jamais rattachées à
 * l'établissement — reste invisible.
 *
 * Ce module est PUR : il reçoit les faits (lus par `diagnostiquerPanelVide`, `queries/tour-schedule`)
 * et rend la PREMIÈRE cause dans l'ordre où elle se répare. Le menu des wilayas se nourrit du panel :
 * il est vide pour la même raison, et la phrase le dit.
 */

export type CausePanelVide =
  | "SANS_BU"
  | "SECTEUR_AUTRE_BU"
  | "SECTEUR_INACTIF"
  | "SANS_SECTEUR"
  | "SECTEUR_SANS_ETABLISSEMENT"
  | "PRATICIENS_NON_RATTACHES"
  | "SERVICES_SANS_PRATICIEN"
  | "AUCUN_PRATICIEN";

export interface FaitsPanel {
  /** Le nom de la BU où le KAM est rattaché (`SalesRepProfile.businessUnitId`), ou null. */
  bu: string | null;
  /**
   * LE « SECTEUR » TAPÉ EN TEXTE sur sa ligne (`SalesRepProfile.region`). C'est la cause la plus
   * probable du rapport de production : on « donne un secteur » en tapant « Est » dans ce champ, qui
   * n'a jamais rien couvert — il n'est relié à aucun établissement. Le dire évite qu'on le retape.
   */
  secteurTexte?: string | null;
  /** Les secteurs où il est affecté, avec leur BU et leur état. */
  secteurs: { nom: string; bu: string; dansSaBu: boolean; actif: boolean; etablissements: number }[];
  /** Les praticiens RATTACHÉS (par identifiant) aux établissements que ses secteurs couvrent. */
  praticiensRattaches: number;
  /** Parmi eux, ceux qui sortent de la couverture parce que le secteur ne retient que certains services. */
  horsServicesChoisis: number;
  /** Les fiches dont l'établissement n'est écrit qu'en TEXTE, au nom exact d'un établissement couvert. */
  praticiensEnTexte: number;
}

const BU_ECRAN = "Business Units";
const ANNUAIRE = "Annuaires › Médecins (« Rattacher les établissements »)";

export function diagnosticPanelVide(f: FaitsPanel): { cause: CausePanelVide; phrase: string } {
  const dansSaBu = f.secteurs.filter((s) => s.dansSaBu);
  const actifs = dansSaBu.filter((s) => s.actif);
  if (!f.bu) {
    return {
      cause: "SANS_BU",
      phrase: `Vous n'êtes rattaché(e) à aucune Business Unit : un panel ne se lit que dans la BU du KAM. `
        + `Demandez à la Direction de vous rattacher à votre BU (${BU_ECRAN}, « Rattacher un KAM »).`,
    };
  }
  if (actifs.length === 0 && f.secteurs.some((s) => !s.dansSaBu)) {
    const ailleurs = [...new Set(f.secteurs.filter((s) => !s.dansSaBu).map((s) => s.bu))].join(", ");
    return {
      cause: "SECTEUR_AUTRE_BU",
      phrase: `Votre territoire est dans une autre BU (${ailleurs}) que celle où vous êtes rattaché(e) (${f.bu}) : `
        + `il ne compte pas. Choisissez votre territoire dans « ${f.bu} » (${BU_ECRAN}, ligne du KAM, « Territoire »), `
        + "ou rattachez-vous à la bonne BU.",
    };
  }
  if (actifs.length === 0 && dansSaBu.length > 0) {
    return {
      cause: "SECTEUR_INACTIF",
      phrase: `Votre secteur dans « ${f.bu} » est désactivé : il ne compte plus. `
        + `Choisissez votre territoire sur votre ligne (${BU_ECRAN}, « Territoire »).`,
    };
  }
  if (actifs.length === 0) {
    const texte = f.secteurTexte?.trim();
    return {
      cause: "SANS_SECTEUR",
      phrase: (texte
        ? `Le secteur « ${texte} » saisi en texte sur votre ligne n'est relié à aucun établissement : il ne donne aucun médecin. `
        : `Aucun territoire ne vous est affecté dans « ${f.bu} ». `)
        + `Demandez au superviseur de votre BU de choisir vos établissements (${BU_ECRAN}, votre ligne, « Territoire »).`,
    };
  }
  if (actifs.every((s) => s.etablissements === 0)) {
    return {
      cause: "SECTEUR_SANS_ETABLISSEMENT",
      phrase: "Votre territoire ne contient aucun établissement : un nom sans hôpital ne donne aucun médecin. "
        + `Faites-y cocher vos établissements (${BU_ECRAN}, votre ligne, « Territoire »).`,
    };
  }
  if (f.praticiensRattaches === 0 && f.praticiensEnTexte > 0) {
    const n = f.praticiensEnTexte;
    return {
      cause: "PRATICIENS_NON_RATTACHES",
      phrase: `${n} fiche(s) de médecin portent le nom d'un établissement de votre territoire en texte seulement, `
        + "sans y être rattachées : elles n'entrent pas dans un panel. Le responsable de l'annuaire (Visite médicale) "
        + `les rattache depuis ${ANNUAIRE}.`,
    };
  }
  if (f.praticiensRattaches > 0 && f.horsServicesChoisis >= f.praticiensRattaches) {
    return {
      cause: "SERVICES_SANS_PRATICIEN",
      phrase: `Les établissements de votre territoire ont ${f.praticiensRattaches} médecin(s), mais aucun dans les services `
        + "retenus (ou leur fiche ne porte pas de service) : élargissez à « Tous les services », ou renseignez le service "
        + `des fiches dans ${ANNUAIRE.replace(" (« Rattacher les établissements »)", "")}.`,
    };
  }
  return {
    cause: "AUCUN_PRATICIEN",
    phrase: "Aucun médecin de l'annuaire n'est rattaché aux établissements de votre territoire. Ajoutez-les, ou "
      + `rattachez les fiches existantes, depuis ${ANNUAIRE}.`,
  };
}
