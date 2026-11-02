import { type DomainToolSpec, zipOps, opsSummary, opEnum } from "./assemblage";
import { STOCK_OPS_IMPL } from "../impl-commercial";
import { PCH_OPS_IMPL, STOCK4_OPS_IMPL, SALES_OPS_IMPL, LOGISTICS_OPS_IMPL } from "../impl-wave4";
import { STOCK_RECURRENCE_OPS_IMPL } from "../impl-stock-recurrence";
import { MEDICAL_OPS_IMPL } from "../impl-wave4b";
import { VALIDATION_OPS_IMPL, FIELD_REPORT_OPS_IMPL, SUPPLY_OPS_IMPL } from "../impl-wave6b";
import { PLANNING_OPS_IMPL } from "../impl-wave6c";
import { TOUR_PLAN_OPS_IMPL, TOUR_VISIT_OPS_IMPL, PROMO_MESSAGE_OPS_IMPL } from "../impl-tournee";
import { ADMIN_REQUEST_OPS_IMPL } from "../impl-wave7";
import { FILE_MEDICAL_OPS_IMPL, FILE_PCH_OPS_IMPL } from "../impl-wave8-files";
import { MARKET360_OPS_IMPL } from "../impl-market360";

/**
 * OUTILS DE DOMAINE — validations, rapports terrain, moyens généraux, planning, demandes administratives, annuaire
 * médical, stocks, PCH, ventes, logistique.
 *
 * Morceau de `DOMAIN_TOOLS` (`../index.ts`), recomposé dans l'ordre d'origine : l'ordre des outils
 * fait partie du prompt de l'IA. Chaque entrée zippe le catalogue avec ses implémentations.
 */
export const OUTILS_TERRAIN_LOGISTIQUE: Record<string, DomainToolSpec> = {
  validation_operation: {
    module: "VALIDATIONS",
    ops: zipOps("validation_operation", VALIDATION_OPS_IMPL),
    def: {
      name: "validation_operation",
      description:
        "VALIDATIONS — les règles de routage (Super Admin : 1-2 validateurs, séquentiel / parallèle, critères module / montants / rôle, FUSION à la modification), les demandes VAL- (validateurs désignés OU routage automatique), la DÉCISION d'étape (approuver / refuser / demander une modification — intérim de congé respecté, chacun son tour en séquentiel), le verdict PIÈCE PAR PIÈCE retirable, et la relance tracée du validateur qui bloque — par les actions canoniques. "
        + `Champ « op » : ${opsSummary("validation_operation")}. `
        + "La demande se donne par référence VAL-… ou objet (« target ») ; la règle par son nom ; l'élément revu par son nom de pièce (« label », ou « message »).",
      input_schema: {
        type: "object",
        properties: {
          op: { type: "string", enum: opEnum("validation_operation"), description: "Le geste à faire." },
          target: { type: "string", description: "La demande (VAL-… ou objet) ou la règle visée (nom)." },
          name: { type: "string", description: "create_validation_rule : le nom de la règle." },
          newName: { type: "string", description: "update_validation_rule : nouveau nom." },
          label: { type: "string", description: "create_validation_request : l'objet à valider ; review_validation_item : la pièce visée (« message » pour le message)." },
          person: { type: "string", description: "Validateur 1 (règle / demande directe) ; decide/remind : le validateur de l'étape visée (si plusieurs en attente)." },
          person2: { type: "string", description: "Validateur 2 (« aucun » le retire à la modification)." },
          decision: { type: "string", description: "Décision : approuver / refuser / demander une modification — review : aussi « retirer le verdict »." },
          mode: { type: "string", description: "Règle : séquentiel (défaut) ou parallèle." },
          module: { type: "string", description: "Module ciblé (règle) ou module de routage (demande sans validateur désigné)." },
          priority: { type: "string", description: "Basse, moyenne, haute, critique." },
          role: { type: "string", description: "create_validation_rule : rôle du demandeur ciblé." },
          amount: { type: "string", description: "Montant (DZD) — règle : seuil minimum ; demande : montant de l'objet." },
          maxAmount: { type: "string", description: "create/update_validation_rule : seuil maximum (DZD)." },
          department: { type: "string", description: "Département ciblé / concerné." },
          category: { type: "string", description: "Catégorie (règle / demande)." },
          date: { type: "string", description: "create_validation_request : échéance (AAAA-MM-JJ)." },
          note: { type: "string", description: "Commentaire de décision / mot de relance." },
          notes: { type: "string", description: "Description (règle / demande)." },
          message: { type: "string", description: "create_validation_request : description de l'objet." },
        },
        required: ["op"],
      },
    },
  },
  field_report_operation: {
    module: "FIELD_REPORTS",
    ops: zipOps("field_report_operation", FIELD_REPORT_OPS_IMPL),
    def: {
      name: "field_report_operation",
      description:
        "RAPPORTS TERRAIN — brouillon dicté qui appartient à son auteur, mise à jour de la fiche en FUSION (synthèse, médecins de l'annuaire, établissement, spécialité, date), analyse IA qui STRUCTURE et persiste sans jamais valider, envoi (VALIDÉ horodaté), validation, réouverture en brouillon, suppressions (rapport avec pièces comptées, ou une pièce par son nom) — par les actions canoniques. "
        + `Champ « op » : ${opsSummary("field_report_operation")}. `
        + "Le rapport se donne par « target » : médecin, extrait de synthèse, nom du délégué, ou « mon dernier ».",
      input_schema: {
        type: "object",
        properties: {
          op: { type: "string", enum: opEnum("field_report_operation"), description: "Le geste à faire." },
          target: { type: "string", description: "Le rapport visé (médecin, extrait, délégué, ou « mon dernier »)." },
          message: { type: "string", description: "La synthèse / le compte rendu (update, submit)." },
          doctor: { type: "string", description: "update : médecin(s) de l'annuaire (noms, virgules)." },
          institution: { type: "string", description: "update : établissement." },
          specialty: { type: "string", description: "update : spécialité." },
          date: { type: "string", description: "Date de la visite (AAAA-MM-JJ)." },
          label: { type: "string", description: "delete_field_report_attachment : la pièce visée (nom)." },
        },
        required: ["op"],
      },
    },
  },
  supply_operation: {
    module: "GENERAL_MEANS",
    ops: zipOps("supply_operation", SUPPLY_OPS_IMPL),
    def: {
      name: "supply_operation",
      description:
        "CATALOGUE D'ARTICLES (Bureau du secrétariat + Moyens généraux — le MÊME catalogue) — ajout à écriture uniformisée (doublon refusé sur la clé), modification en FUSION (renommage sur libellé pris refusé), activation / désactivation, et l'uniformisation de TOUT le catalogue montrée avant d'être appliquée — par les actions canoniques. "
        + `Champ « op » : ${opsSummary("supply_operation")}. `
        + "L'article se donne par son nom (« name »).",
      input_schema: {
        type: "object",
        properties: {
          op: { type: "string", enum: opEnum("supply_operation"), description: "Le geste à faire." },
          name: { type: "string", description: "L'article visé / à créer." },
          newName: { type: "string", description: "update_supply_article : nouveau libellé." },
          category: { type: "string", description: "Catégorie (papeterie, informatique…)." },
          unit: { type: "string", description: "Unité de compte (pièce, boîte, lot de 50…)." },
          reference: { type: "string", description: "Référence interne / fournisseur." },
          amount: { type: "string", description: "Prix estimé (DZD)." },
          supplier: { type: "string", description: "Fournisseur indicatif." },
          notes: { type: "string", description: "Notes de la fiche." },
        },
        required: ["op"],
      },
    },
  },
  planning_operation: {
    module: "SALES_PLANNING",
    ops: zipOps("planning_operation", { ...PLANNING_OPS_IMPL, ...TOUR_PLAN_OPS_IMPL, ...PROMO_MESSAGE_OPS_IMPL }),
    def: {
      name: "planning_operation",
      description:
        "PLANNING FORCE DE VENTE (SFE) — business units, produits promus (canal ville / hôpital / les deux), équipes, profils KAM, prévisions produit × CYCLE MENSUEL, matrice d'affectations KAM × produit (0 visite sans note = retrait), report d'un cycle vers un autre, paramètres SFE globaux. Les « save » de l'écran écrasent avec des DÉFAUTS-PIÈGES : chaque op relit l'existant et le REJOUE (FUSION) — par les actions canoniques. "
        + `Champ « op » : ${opsSummary("planning_operation")}. `
        + "Le cycle se donne en français (« septembre 2026 » ou 2026-09, champ « date ») ; BU / équipe par « target », produit par « product », KAM par « person ». "
        + "SECTEURS (territoires nommés d'une BU : « Est », « Oranais ») — c'est le secteur qui donne au KAM son panel de médecins : nom par « name », BU par « target », établissements par « institutions » et KAM par « person » (noms séparés par des virgules). "
        + "PLAN DE TOURNÉE — préparer la période (« open_tour_plan », KAM par « person », maille par « mode », période par « date » ; sans date, la période À VENIR ; sans maille, celle du réglage en vigueur), le soumettre à son validateur, ou demander une validation au N+2. Le RÉGLAGE global (« set_tour_planning », Super Admin) : la maille par « mode » et l'échéance de soumission en jours par « days ». Les VISITES elles-mêmes se posent à l'écran : l'action remplace la grille entière, donc une phrase qui n'en nomme qu'une effacerait les autres. VALIDER un plan et RAPPORTER une visite sont des attestations réservées à un clic humain. "
        + "MESSAGES DE LA DIRECTION MARKETING (ce que le KAM doit dire au médecin, exigé sur chaque rapport terrain) : intitulé par « name », texte par « note », gamme par « target » (vide = toutes).",
      input_schema: {
        type: "object",
        properties: {
          op: { type: "string", enum: opEnum("planning_operation"), description: "Le geste à faire." },
          target: { type: "string", description: "BU visée (nom) — produits : la BU de rattachement." },
          name: { type: "string", description: "Nom (création) ou cible (produit / BU / équipe)." },
          newName: { type: "string", description: "Nouveau nom (BU, produit, équipe)." },
          product: { type: "string", description: "Le produit promu visé (nom)." },
          person: { type: "string", description: "Responsable de BU / superviseur / référent Direction Marketing / KAM (nom ; « aucun » retire) — SECTEUR : les KAM affectés, noms séparés par des virgules." },
          label: { type: "string", description: "save_rep_profile : la BU du KAM (« aucune » détache) ; create/update_business_unit : le chef de BU ; carry_forward : cycle cible." },
          date: { type: "string", description: "Le cycle mensuel (« septembre 2026 » ou 2026-09) — carry_forward : cycle SOURCE." },
          endDate: { type: "string", description: "carry_forward_assignments : cycle CIBLE." },
          mode: { type: "string", description: "BU et produit : terrain / canal (ville / hôpital / les deux) ; affectation : position 1-3 ; profil KAM : séniorité ; PLAN DE TOURNÉE : la maille (WEEK / MONTH / QUARTER / HALF_YEAR)." },
          quantity: { type: "string", description: "Prévision : FTE cible ; profil KAM : FTE budget ; affectation : visites prévues." },
          visits: { type: "string", description: "Visites (prévision produit, capacité/jour, affectation)." },
          days: { type: "string", description: "Jours terrain par mois (paramètres / profil KAM) ; set_tour_planning : jours avant l'échéance de soumission." },
          threshold: { type: "string", description: "Pourcentage : couverture cible (prévision), % terrain (paramètres / profil)." },
          amount: { type: "string", description: "save_forecast : budget (DZD)." },
          location: { type: "string", description: "save_rep_profile : région ; secteur : sa ville pivot." },
          institutions: { type: "string", description: "SECTEUR : les établissements, par leurs NOMS séparés par des virgules (« CHU de Constantine, EPH d'Annaba »). Non cité en modification = liste inchangée." },
          reference: { type: "string", description: "Code (BU, produit, équipe)." },
          note: { type: "string", description: "Note (prévision, profil, affectation)." },
          p1: { type: "string", description: "save_sfe_settings : poids position 1." },
          p2: { type: "string", description: "save_sfe_settings : poids position 2." },
          p3: { type: "string", description: "save_sfe_settings : poids position 3." },
          freqVeryHigh: { type: "string", description: "save_sfe_settings : fréquence potentiel très haut." },
          freqHigh: { type: "string", description: "save_sfe_settings : fréquence potentiel haut." },
          freqMedium: { type: "string", description: "save_sfe_settings : fréquence potentiel moyen." },
          freqLow: { type: "string", description: "save_sfe_settings : fréquence potentiel bas." },
          freqVeryLow: { type: "string", description: "save_sfe_settings : fréquence potentiel très bas." },
        },
        required: ["op"],
      },
    },
  },
  request_operation: {
    module: "ADMIN_REQUESTS",
    ops: zipOps("request_operation", ADMIN_REQUEST_OPS_IMPL),
    def: {
      name: "request_operation",
      description:
        "DEMANDES ADMINISTRATIVES (bureau du secrétariat) de bout en bout — validation hiérarchique (demande + décision : l'approbation avec montant ÉMET l'ordre de dépense), courses chauffeur DÉJÀ posées (points de passage, statuts, preuve — on n'en crée plus, ni de lot de demandes), fenêtre demandeur 30 min (modifier en FUSION / retirer), suppression TRAÇABLE à motif + restauration, flux assistante (traitement, validation Finances / interne, FIN avec facture exigée et imputation moyens généraux), pièces soumises à validation UNE PAR UNE (retirables) — et l'ACHAT depuis les Moyens généraux (validateur = N+1 d'organigramme, retrait avant décision). Par les actions canoniques. "
        + `Champ « op » : ${opsSummary("request_operation")}. `
        + "La demande se donne par référence REQ-… ou objet (« target ») ; la course par son titre ; la pièce par son nom (« label »).",
      input_schema: {
        type: "object",
        properties: {
          op: { type: "string", enum: opEnum("request_operation"), description: "Le geste à faire." },
          target: { type: "string", description: "La demande visée (REQ-… ou objet) — delete_requests : plusieurs références (virgules) ; missions : la course (titre)." },
          person: { type: "string", description: "Validateur / chauffeur / traitant (nom)." },
          person2: { type: "string", description: "Second validateur (nom)." },
          people: { type: "string", description: "submit_attachment_validation : les validateurs (noms, virgules)." },
          decision: { type: "string", description: "decide_approval : approuver / refuser / demander une modification." },
          label: { type: "string", description: "Pièces : la pièce visée (nom)." },
          name: { type: "string", description: "create_purchase_request : l'objet de la demande d'achat ; toggle_mission_stop : le point visé." },
          newName: { type: "string", description: "edit_own_request : nouveau titre." },
          status: { type: "string", description: "update_mission : nouvelle, acceptée, en route, terminée, problème, annulée." },
          cells: { type: "string", description: "Achat : les lignes (« une par ligne » ou points-virgules, « article xN ») ; suppression : les références." },
          amount: { type: "string", description: "Montant (DZD) — validation hiérarchique, pièce, estimation Finances, imputation de clôture." },
          department: { type: "string", description: "finish_request : département dont les moyens généraux sont débités." },
          location: { type: "string", description: "toggle_mission_stop : le point visé." },
          date: { type: "string", description: "Échéance (AAAA-MM-JJ)." },
          note: { type: "string", description: "Commentaire / motif (suppression : OBLIGATOIRE) / preuve de course / note d'imputation." },
          notes: { type: "string", description: "Description (édition de demande, consignes de course)." },
          message: { type: "string", description: "create_purchase_request : description du besoin." },
        },
        required: ["op"],
      },
    },
  },
  medical_operation: {
    module: "MEDICAL",
    ops: zipOps("medical_operation", { ...MEDICAL_OPS_IMPL, ...FILE_MEDICAL_OPS_IMPL, ...TOUR_VISIT_OPS_IMPL }),
    def: {
      name: "medical_operation",
      description:
        "ANNUAIRE MÉDICAL — praticiens (fiche complète ou cellule de la feuille, suppressions bornées par la portée), visites (planification et compte rendu champ-par-champ), établissements, spécialités, annuaires nommés (rangement + accès désignés), plans de tournée — par les actions canoniques. "
        + `Champ « op » : ${opsSummary("medical_operation")}. `
        + "Le praticien se donne par NOM (« doctor »), la visite par praticien + date, le plan par délégué + date de début. "
        + "log_visit : la visite QUI A EU LIEU — « products » liste les produits présentés (noms exacts, résolus au catalogue), « followUp » ce qu'il reste à faire. "
        + "order_visit : « demain va voir Achour » — la Direction COMMANDE une visite à un KAM (« person »), chez un praticien (« doctor »), un jour donné (« date ») : elle arrive dans son emploi du temps comme une visite À FAIRE, hors de son plan validé, et le compte rendu reste à sa charge.",
      input_schema: {
        type: "object",
        properties: {
          op: { type: "string", enum: opEnum("medical_operation"), description: "Le geste à faire." },
          file: { type: "string", description: "import_directory_sheet : classeur Excel / CSV — Le FICHIER : nom d'un fichier de votre Drive (glissé dans la conversation ou déposé) — résolu par nom, droits Drive revérifiés à l'exécution." },
          doctor: { type: "string", description: "Le praticien visé (nom) — plusieurs noms séparés par des virgules pour les gestes en lot." },
          newName: { type: "string", description: "update_doctor / update_directory : nouveau nom." },
          title: { type: "string", description: "Grade : professeur, maître de conférences, maître assistant, praticien spécialiste, assistant, résident, généraliste, pharmacien, autre." },
          specialty: { type: "string", description: "Spécialité (texte, ou cible des ops de spécialité)." },
          sector: { type: "string", description: "Secteur : hospitalier, libéral, les deux." },
          institution: { type: "string", description: "Établissement (texte, ou cible de delete_institution)." },
          city: { type: "string", description: "Ville." },
          region: { type: "string", description: "Wilaya / région (fiche, plan de tournée)." },
          phone: { type: "string", description: "Téléphone." },
          email: { type: "string", description: "E-mail." },
          influence: { type: "string", description: "Influence : très élevé / élevé / moyen / faible / très faible." },
          potential: { type: "string", description: "Potentiel (mêmes niveaux)." },
          affinity: { type: "string", description: "Affinité (mêmes niveaux)." },
          person: { type: "string", description: "Le délégué (visite, fiche, plan de tournée)." },
          people: { type: "string", description: "set_directory_access : noms, virgules (« tous » = ouvrir)." },
          field: { type: "string", description: "set_doctor_cell / color_directory_cells : la colonne (lastName, firstName, address, wilaya, postalCode, phone, email, title, sector, specialty, potential, ou la clé « c_… » d'une colonne propre à l'annuaire ; établissements : name, type, sector, wilaya)." },
          value: { type: "string", description: "set_doctor_cell : la valeur (vide = effacer)." },
          lastName: { type: "string", description: "add_doctor_row : nom." },
          firstName: { type: "string", description: "add_doctor_row : prénom." },
          date: { type: "string", description: "Visites / plans : la date (AAAA-MM-JJ)." },
          newDate: { type: "string", description: "duplicate_plan : début de la nouvelle période (défaut : mois suivant)." },
          objective: { type: "string", description: "order_visit : la raison de la visite commandée (« point sur le Nivolex »)." },
          status: { type: "string", description: "update_visit : planifiée seulement — réalisée passe par log_visit, reportée ou annulée se dit depuis « Ma journée »." },
          report: { type: "string", description: "update_visit : compte rendu." },
          feedback: { type: "string", description: "update_visit : retour du médecin." },
          followUp: { type: "string", description: "Actions de suivi : update_visit (compte rendu) ou log_visit (ce qu'il reste à faire après la visite)." },
          products: { type: "string", description: "Produits (cibles de la fiche, présentés en visite, cible du plan)." },
          quantity: { type: "string", description: "create/update_plan : visites cibles." },
          keyTargets: { type: "string", description: "create/update_plan : médecins clés cibles." },
          achieved: { type: "string", description: "update_plan : visites réalisées." },
          directory: { type: "string", description: "Annuaires nommés : l'annuaire visé (« général » pour en sortir)." },
          color: { type: "string", description: "Spécialités : couleur (hex). color_directory_cells : jaune, vert, bleu, orange, rose, violet, rouge, gris — ou « aucune » pour effacer." },
          notes: { type: "string", description: "Notes / objectif / description / commentaire manager." },
        },
        required: ["op"],
      },
    },
  },
  stock_operation: {
    module: "STOCKS",
    ops: zipOps("stock_operation", { ...STOCK_OPS_IMPL, ...STOCK4_OPS_IMPL, ...STOCK_RECURRENCE_OPS_IMPL }),
    def: {
      name: "stock_operation",
      description:
        "STOCKS PCH — demander un état de stock à une personne, une fois ou en RÉCURRENCE (« le 1er de chaque mois, demande à ce KAM l'état de ces hôpitaux » : poser, modifier, suspendre, reprendre, retirer), gérer les LIEUX (hôpitaux / annexes PCH, Super Admin) et enregistrer les ÉTATS DATÉS (« à cette date il reste X unités »), par les actions canoniques. "
        + `Champ « op » : ${opsSummary("stock_operation")}.`,
      input_schema: {
        type: "object",
        properties: {
          op: { type: "string", enum: opEnum("stock_operation"), description: "Le geste à faire." },
          assigneeName: { type: "string", description: "request_state / récurrences : à qui demander l'état de stock (son nom)." },
          hospitals: { type: "string", description: "request_state / récurrences : hôpitaux ciblés, séparés par des virgules. Facultatif — sans aucun, la demande porte sur l'état de stock en général." },
          note: { type: "string", description: "Précision de la demande." },
          location: { type: "string", description: "Nom de l'hôpital / annexe visé(e) (création, suppression, état)." },
          product: { type: "string", description: "États : le produit (DCI ou nom commercial)." },
          kind: { type: "string", description: "record_snapshot : lieu de l'état — PCH (défaut), hôpital, ou annexe." },
          date: { type: "string", description: "États : la date de la mesure (AAAA-MM-JJ)." },
          quantity: { type: "string", description: "record_snapshot : quantité restante (unités, ≥ 0)." },
          // ── LES RÉCURRENCES ────────────────────────────────────────────────────────────
          // Une récurrence réutilise `assigneeName`, `hospitals` et `note` : c'est LA MÊME
          // demande, répétée. Deux jeux de champs pour la même chose feraient écrire
          // « assigneeName » au geste ponctuel et « person » au récurrent, et le modèle
          // choisirait mal la moitié du temps.
          recurrenceName: { type: "string", description: "Récurrences : son NOM — à donner en création, à citer pour modifier / suspendre / retirer." },
          newName: { type: "string", description: "update_stock_recurrence : nouveau nom (renommage)." },
          cadence: { type: "string", description: "Récurrences : DAILY, WEEKLY ou MONTHLY (défaut MONTHLY). Pas d'HOURLY — un relevé de stock est un comptage physique qu'une personne va faire." },
          hourLocal: { type: "string", description: "Récurrences : heure d'Alger, 0 à 23 (défaut 8)." },
          day: { type: "string", description: "Récurrences : jour de la SEMAINE (0 = dimanche … 6 = jeudi) si WEEKLY, jour du MOIS (1 à 31) si MONTHLY." },
          status: { type: "string", description: "set_stock_recurrence_status : ACTIVE ou PAUSED. Sans précision, l'état est basculé." },
        },
        required: ["op"],
      },
    },
  },
  pch_operation: {
    module: "PCH",
    ops: zipOps("pch_operation", { ...PCH_OPS_IMPL, ...FILE_PCH_OPS_IMPL, ...MARKET360_OPS_IMPL }),
    def: {
      name: "pch_operation",
      description:
        "PCH — MARCHÉS 360° : appels d'offres (fiche, caution rejouée), SOUMISSIONS versionnées (créer, déposer-verrouiller), RÉSULTATS par lot (gagné/perdu/infructueux/annulé, attribution partielle), CONTRAT depuis l'attribution + avenants à delta + lignes contractuelles, bons de commande et leurs LIGNES contrôlées contre le restant contractuel, LIVRAISONS (BL, lot, péremption, stock optionnel), analyse IA d'un TEXTE d'AO collé, enrichissement marché, suivi d'arrivée — par les actions canoniques. "
        + `Champ « op » : ${opsSummary("pch_operation")}. `
        + "Le marché se donne par référence AO-AAAA-NNN, titre ou produits ; la ligne par sa désignation ; le bon de commande par son n°.",
      input_schema: {
        type: "object",
        properties: {
          op: { type: "string", enum: opEnum("pch_operation"), description: "Le geste à faire." },
          file: { type: "string", description: "analyze_tender_document : PDF / image de l'appel d'offres — Le FICHIER : nom d'un fichier de votre Drive (glissé dans la conversation ou déposé) — résolu par nom, droits Drive revérifiés à l'exécution." },
          reference: { type: "string", description: "L'appel d'offres visé (AO-AAAA-NNN, titre ou produits)." },
          newReference: { type: "string", description: "update_tender : CORRIGER la référence du marché (elle reste unique — refus nommant le marché qui la porte déjà)." },
          name: { type: "string", description: "create_tender : titre du marché." },
          products: { type: "string", description: "Produits concernés (texte)." },
          supplier: { type: "string", description: "Fournisseur." },
          country: { type: "string", description: "Pays du fournisseur." },
          quantity: { type: "string", description: "Quantité (marché / bon / ligne / vente depuis ligne)." },
          amount: { type: "string", description: "Valeur en DZD (marché, bon) ou prix unitaire (ligne)." },
          status: { type: "string", description: "Statut : marché (non commencé/en cours/terminé/annulé), bon (en attente/validé/livré/payé/annulé), ligne (en attente/chiffré/soumis/gagné/perdu)." },
          date: { type: "string", description: "Date (attribution du marché, réception du bon, arrivée prévue) AAAA-MM-JJ." },
          order: { type: "string", description: "Le bon de commande visé (n° ou produits) — ou le n° à donner à un nouveau bon." },
          line: { type: "string", description: "La ligne visée, par désignation (ligne-produit de l'AO, ligne contractuelle, ligne de BC) — ou la désignation d'une ligne à créer." },
          contract: { type: "string", description: "Le contrat ou l'avenant visé (titre ou référence de la pièce Legal)." },
          delta: { type: "string", description: "create_amendment : impact en DZD sur la valeur du contrat (négatif permis)." },
          force: { type: "string", description: "add_order_line : « oui » pour passer OUTRE un dépassement contractuel refusé — le passage en force est tracé dans l'audit avec son excès." },
          bl: { type: "string", description: "Livraisons : n° du bon de livraison." },
          batch: { type: "string", description: "create_delivery : n° de lot pharmaceutique." },
          expiry: { type: "string", description: "create_delivery : date de péremption (AAAA-MM-JJ)." },
          stock: { type: "string", description: "create_delivery : « oui » pour créer les mouvements de stock (sortie) — uniquement pour un produit résolu sans ambiguïté." },
          newName: { type: "string", description: "update_order / update_line : nouveau n° / nouvelle désignation." },
          dci: { type: "string", description: "update_line : DCI." },
          dosage: { type: "string", description: "update_line : dosage." },
          form: { type: "string", description: "update_line : forme galénique." },
          awardedPrice: { type: "string", description: "update_line : prix unitaire ATTRIBUÉ (DZD)." },
          paymentDate: { type: "string", description: "update_order : date de paiement (AAAA-MM-JJ)." },
          arrivedDate: { type: "string", description: "set_order_arrival : date d'arrivée RÉELLE (AAAA-MM-JJ)." },
          text: { type: "string", description: "analyze_tender_text : le texte du document d'AO, collé." },
          notes: { type: "string", description: "Notes libres." },
        },
        required: ["op"],
      },
    },
  },
  sales_operation: {
    module: "SALES",
    ops: zipOps("sales_operation", SALES_OPS_IMPL),
    def: {
      name: "sales_operation",
      description:
        "VENTES — enregistrer une vente réelle (produit ou service, quantité × prix DZD) ou importer un CSV COLLÉ de ventes, par les actions canoniques. "
        + `Champ « op » : ${opsSummary("sales_operation")}.`,
      input_schema: {
        type: "object",
        properties: {
          op: { type: "string", enum: opEnum("sales_operation"), description: "Le geste à faire." },
          product: { type: "string", description: "create_sale : le produit (ou l'intitulé du service)." },
          client: { type: "string", description: "create_sale : le client (obligatoire)." },
          quantity: { type: "string", description: "create_sale : quantité vendue." },
          amount: { type: "string", description: "create_sale : prix unitaire en DZD." },
          date: { type: "string", description: "create_sale : date de la vente (AAAA-MM-JJ, défaut aujourd'hui)." },
          kind: { type: "string", description: "create_sale : « service » si ce n'est pas un produit." },
          dci: { type: "string", description: "create_sale : DCI du produit." },
          dosage: { type: "string", description: "create_sale : dosage." },
          institution: { type: "string", description: "create_sale : établissement du client." },
          isPch: { type: "string", description: "create_sale : « oui » si vente PCH." },
          csv: { type: "string", description: "import_sales : le CSV collé (en-tête : date,produit,dci,dosage,forme,client,institution,pch,quantité,prix unitaire)." },
        },
        required: ["op"],
      },
    },
  },
  logistics_operation: {
    module: "LOGISTICS",
    ops: zipOps("logistics_operation", LOGISTICS_OPS_IMPL),
    def: {
      name: "logistics_operation",
      description:
        "LOGISTIQUE — créer une commande d'acheminement (fournisseur → PCH) et faire avancer son suivi (expédié, terminal, dédouanement, livré) en datant les jalons, par les actions canoniques. "
        + `Champ « op » : ${opsSummary("logistics_operation")}. `
        + "La commande se donne par référence CMD-AAAA-NNN ou produit.",
      input_schema: {
        type: "object",
        properties: {
          op: { type: "string", enum: opEnum("logistics_operation"), description: "Le geste à faire." },
          reference: { type: "string", description: "update_shipment_status : la commande (CMD-AAAA-NNN ou produit)." },
          product: { type: "string", description: "create_shipment : le produit commandé (obligatoire)." },
          dci: { type: "string", description: "create_shipment : DCI." },
          dosage: { type: "string", description: "create_shipment : dosage." },
          supplier: { type: "string", description: "create_shipment : fournisseur." },
          country: { type: "string", description: "create_shipment : pays d'origine." },
          quantity: { type: "string", description: "Quantité commandée / reçue." },
          amount: { type: "string", description: "create_shipment : valeur de la commande." },
          currency: { type: "string", description: "create_shipment : devise (défaut EUR)." },
          status: { type: "string", description: "Statut : commandé, production, expédié, arrivé au terminal, dédouanement, livré, bloqué." },
          date: { type: "string", description: "create_shipment : date de commande (AAAA-MM-JJ)." },
          departureDate: { type: "string", description: "Départ (estimé à la création ; réel au suivi) AAAA-MM-JJ." },
          arrivalDate: { type: "string", description: "Arrivée (estimée à la création ; réelle au suivi) AAAA-MM-JJ." },
          customsDate: { type: "string", description: "update_shipment_status : date de dédouanement." },
          deliveryDate: { type: "string", description: "update_shipment_status : date de livraison à la PCH." },
          carrier: { type: "string", description: "create_shipment : transporteur." },
          incoterm: { type: "string", description: "create_shipment : incoterm (CIF, FOB…)." },
        },
        required: ["op"],
      },
    },
  },
};
