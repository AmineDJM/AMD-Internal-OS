import { type DomainToolSpec, zipOps, opsSummary, opEnum } from "./assemblage";
import { MISSION_OPS_IMPL, MEDINFO_OPS_IMPL } from "../impl-wave2b";
import { ADPRO_OPS_IMPL, BD_OPS_IMPL } from "../impl-commercial";
import { BD4_OPS_IMPL } from "../impl-wave4b";
import { EVENT_OPS_IMPL, ADPRO5_OPS_IMPL, CONSULTING_OPS_IMPL } from "../impl-wave5";
import { CARE_OPS_IMPL, PROMO_OPS_IMPL } from "../impl-wave5b";
import { PROMO2_OPS_IMPL } from "../impl-promo-circuit2";
import { BD6_OPS_IMPL, DOSSIER_OPS_IMPL, DIRECTIVE_OPS_IMPL, SUPPORT_OPS_IMPL } from "../impl-wave6";
import { FILE_MEDINFO_OPS_IMPL } from "../impl-wave8-files";

/**
 * OUTILS DE DOMAINE — Ad & Pro, events, consulting, prises en charge, matériel promotionnel, information médicale,
 * business development, dossiers, directives, support.
 *
 * Morceau de `DOMAIN_TOOLS` (`../index.ts`), recomposé dans l'ordre d'origine : l'ordre des outils
 * fait partie du prompt de l'IA. Chaque entrée zippe le catalogue avec ses implémentations.
 */
export const OUTILS_COMMERCIAL_PILOTAGE: Record<string, DomainToolSpec> = {
  adpro_operation: {
    module: "SPONSORING",
    ops: zipOps("adpro_operation", { ...ADPRO_OPS_IMPL, ...MISSION_OPS_IMPL, ...ADPRO5_OPS_IMPL }),
    def: {
      name: "adpro_operation",
      description:
        "AD & PRO — LES CIRCUITS COMPLETS : sponsoring (préliminaire National Sales → analyse Direction Marketing → décision Direction → appel), congrès / événements (mêmes marches + budget accordé modifiable + personnes prises en charge), POSTES de dépense (ajout, soumission, décision, imputation budgétaire, BC visé puis émis), demandes « autres », correction de fiche par liste blanche, missions, matériel promo (étapes), par les actions canoniques. "
        + `Champ « op » : ${opsSummary("adpro_operation")}. `
        + "Le sponsoring se donne par SPO-… ou institution ; le congrès / événement par « target » (+ « kind » si ambigu) ; le poste par « label » dans son opération.",
      input_schema: {
        type: "object",
        properties: {
          op: { type: "string", enum: opEnum("adpro_operation"), description: "Le geste à faire." },
          label: { type: "string", description: "Postes / circuit promo : libellé du poste ou titre du dossier ; demandes « autres » : l'objet." },
          reference: { type: "string", description: "Référence exacte (SPO-…, AUT-…, dossier promo) — ou alias de « target »." },
          decision: { type: "string", description: "Décisions : approuver / accorder / valider, refuser, budget à revoir (decide_item)." },
          amount: { type: "string", description: "Montants DZD : budget proposé (analyse), budget accordé (décision finale), estimation (add_item), montant demandé (correct_request)." },
          grantedAmount: { type: "string", description: "update_item : montant AFFECTÉ par la Direction." },
          to: { type: "string", description: "transfer : module de destination (sponsoring / prise en charge nationale / internationale)." },
          note: { type: "string", description: "Motif / note (obligatoire pour les refus)." },
          target: { type: "string", description: "La cible : événement / congrès / sponsoring (nom ou référence)." },
          kind: { type: "string", description: "Type de la cible (événement | sponsoring | congrès international | congrès national) — tranche l'ambiguïté." },
          person: { type: "string", description: "La personne : référent Direction Marketing désigné, tierce personne, personne prise en charge, bénéficiaire d'une demande « autre »." },
          role: { type: "string", description: "Missions : accompagnant / délégué de référence ; personnes prises en charge : rôle libre." },
          message: { type: "string", description: "comment_mission : le message ; create_other_request : alias de notes." },
          mode: { type: "string", description: "add_item : « rallonge » si le poste est EN PLUS du budget accordé ; close_other_request : « annuler »." },
          category: { type: "string", description: "set_item_budget : la (sous-)catégorie budgétaire (nom ; « aucune » retire)." },
          material: { type: "string", description: "link_item_promo_material : le matériel promo (MP-… ou titre ; « aucun » détache)." },
          supplier: { type: "string", description: "add_item / update_item : le prestataire pressenti." },
          notes: { type: "string", description: "Notes / description (create_other_request : OBLIGATOIRE ; correct_request : description)." },
          city: { type: "string", description: "correct_request : ville." },
          specialty: { type: "string", description: "correct_request : spécialité." },
          products: { type: "string", description: "correct_request : produits." },
          startDate: { type: "string", description: "correct_request : date de début (AAAA-MM-JJ)." },
          endDate: { type: "string", description: "correct_request : date de fin (AAAA-MM-JJ)." },
        },
        required: ["op"],
      },
    },
  },
  event_operation: {
    module: "EVENTS",
    ops: zipOps("event_operation", EVENT_OPS_IMPL),
    def: {
      name: "event_operation",
      description:
        "EVENTS — la fiche d'un événement (modification en rejouant TOUT l'existant, suppression), sa soumission au circuit de prise en charge, et ses INSCRIPTIONS (ajout, statut présent/confirmé/annulé, retrait), par les actions canoniques. "
        + `Champ « op » : ${opsSummary("event_operation")}. `
        + "L'événement se donne par NOM (« target »), le participant par son nom (« person »).",
      input_schema: {
        type: "object",
        properties: {
          op: { type: "string", enum: opEnum("event_operation"), description: "Le geste à faire." },
          target: { type: "string", description: "L'événement visé (nom)." },
          newName: { type: "string", description: "update_event : nouveau nom." },
          eventType: { type: "string", description: "update_event : congrès, séminaire, table ronde, staff hospitalier, symposium, webinaire, formation, journée scientifique, autre." },
          scope: { type: "string", description: "update_event : national / international." },
          format: { type: "string", description: "update_event : présentiel / webinaire / hybride." },
          status: { type: "string", description: "Événement : brouillon, terminé, annulé (les états du circuit suivent la décision). Participant : inscrit, confirmé, refusé, présent, absent, annulé." },
          startDate: { type: "string", description: "update_event : date de début (AAAA-MM-JJ)." },
          endDate: { type: "string", description: "update_event : date de fin (AAAA-MM-JJ)." },
          location: { type: "string", description: "update_event : lieu." },
          city: { type: "string", description: "Ville." },
          country: { type: "string", description: "Pays." },
          specialty: { type: "string", description: "Spécialité (événement ou participant)." },
          institution: { type: "string", description: "add_registration : établissement du participant." },
          products: { type: "string", description: "update_event : produits présentés." },
          quantity: { type: "string", description: "update_event : capacité (places)." },
          amount: { type: "string", description: "update_event : budget estimé (DZD)." },
          person: { type: "string", description: "Participant (prénom + nom) — ou Direction Marketing pour submit_event_for_approval." },
          role: { type: "string", description: "add_registration : médecin, professeur, chef de service, pharmacien, autre." },
          email: { type: "string", description: "add_registration : e-mail." },
          phone: { type: "string", description: "add_registration : téléphone." },
          notes: { type: "string", description: "Description / commentaire." },
        },
        required: ["op", "target"],
      },
    },
  },
  consulting_operation: {
    module: "CONSULTING",
    ops: zipOps("consulting_operation", CONSULTING_OPS_IMPL),
    def: {
      name: "consulting_operation",
      description:
        "CONSULTING — le contrat entre deux parties : création (tâches attendues comprises), soumission au validateur désigné, validation (contrat ACTIF) ou refus, clôture / rupture, et les tâches attendues du prestataire (ajout, livrée, retrait), par les actions canoniques. "
        + `Champ « op » : ${opsSummary("consulting_operation")}. `
        + "Le contrat se donne par référence CONS-…, intitulé ou consultant.",
      input_schema: {
        type: "object",
        properties: {
          op: { type: "string", enum: opEnum("consulting_operation"), description: "Le geste à faire." },
          reference: { type: "string", description: "Le contrat visé (CONS-…, intitulé ou consultant)." },
          label: { type: "string", description: "create_contract : intitulé ; tâches : la tâche visée / à créer." },
          counterparty: { type: "string", description: "create_contract : le consultant ou cabinet (OBLIGATOIRE)." },
          person: { type: "string", description: "submit_contract : le validateur désigné (nom)." },
          decision: { type: "string", description: "decide_contract : valider ou refuser ; close_contract : « rompre » pour une rupture en cours de contrat." },
          amount: { type: "string", description: "create_contract : montant (DZD)." },
          startDate: { type: "string", description: "create_contract : début (AAAA-MM-JJ)." },
          endDate: { type: "string", description: "create_contract : fin (AAAA-MM-JJ)." },
          dueDate: { type: "string", description: "add_contract_task : échéance de la tâche (AAAA-MM-JJ)." },
          tasks: { type: "string", description: "create_contract : tâches attendues, séparées par des virgules." },
          paymentTerms: { type: "string", description: "create_contract : modalités de paiement." },
          note: { type: "string", description: "Décision / clôture : note ou motif." },
          notes: { type: "string", description: "create_contract : périmètre de la mission." },
        },
        required: ["op"],
      },
    },
  },
  care_operation: {
    module: "CONGRESS_NATIONAL",
    ops: zipOps("care_operation", CARE_OPS_IMPL),
    def: {
      name: "care_operation",
      description:
        "PRISES EN CHARGE d'un congrès (national ou international) — personnes (annuaire ou profil libre), avis du demandeur, DÉCISION PAR PERSONNE (Direction), besoins par personne (pièces / prestations et leurs états), devis qui couvrent N cases (garde anti double paiement), sollicitation des devis, envoi aux Finances bloqué tant qu'il manque quelque chose, rattachement d'une case au matériel promo — par les actions canoniques. "
        + `Champ « op » : ${opsSummary("care_operation")}. `
        + "Le congrès se donne par NOM (« target », « kind » national / international si ambigu), la personne par son nom (« person »), l'élément par son libellé (« label »).",
      input_schema: {
        type: "object",
        properties: {
          op: { type: "string", enum: opEnum("care_operation"), description: "Le geste à faire." },
          target: { type: "string", description: "Le congrès visé (nom)." },
          kind: { type: "string", description: "Congrès national / congrès international (si le nom seul est ambigu)." },
          person: { type: "string", description: "La personne prise en charge (praticien de l'annuaire ou nom libre)." },
          label: { type: "string", description: "L'élément visé (pièce / prestation) — create_care_quote : les libellés couverts (virgules)." },
          cells: { type: "string", description: "create_care_quote : synonyme de « label » (libellés couverts, virgules)." },
          decision: { type: "string", description: "Avis : favorable / défavorable / pas d'avis. Personne : accorder / écarter. Devis : accepter / refuser." },
          supplier: { type: "string", description: "Devis : le fournisseur." },
          amount: { type: "string", description: "create_care_quote : montant du devis (DZD)." },
          reference: { type: "string", description: "create_care_quote : référence du devis." },
          status: { type: "string", description: "set_care_cell_status : demandée / reçue / réglée / sans objet." },
          serviceKind: { type: "string", description: "add_care_cell : hôtel, transport, billet, restauration, inscription, matériel promotionnel, autre." },
          mode: { type: "string", description: "add_care_cell : « prestation » force une prestation (sinon : pièce à fournir)." },
          role: { type: "string", description: "add_care_person : fonction (« Professeur », « Chef de service »…)." },
          institution: { type: "string", description: "add_care_person : établissement." },
          material: { type: "string", description: "link_care_promo : le matériel promotionnel (MP-… ou titre ; « aucun » détache)." },
          note: { type: "string", description: "Note / justification." },
          notes: { type: "string", description: "add_care_cell : précisions sur l'élément." },
        },
        required: ["op", "target"],
      },
    },
  },
  promo_operation: {
    module: "PROMO_MATERIAL",
    ops: zipOps("promo_operation", { ...PROMO_OPS_IMPL, ...PROMO2_OPS_IMPL }),
    def: {
      name: "promo_operation",
      description:
        "MATÉRIEL PROMOTIONNEL — le CIRCUIT 2 (devis demandés au secrétariat et retranscrits ligne à ligne, lignes retenues par le demandeur, bons de commande GÉNÉRÉS par la plateforme, factures par BC, paiement au centre de paiement avec la demande de visa ou de déclaration), la bascule d'un dossier d'avant sur ce circuit, le CIRCUIT COURT d'avant (devis reçu sur pièce exigée, chantiers parallèles BC / paiement / visa), les marches du circuit long (devis déposés, agence retenue, BC aux Finances puis validé puis envoyé, bordereau de paiement, paiement, matériel réalisé, examen Direction, conformité + visa, BAT, livraison, facture, règlement-clôture), commentaires, annulation — par les actions canoniques. Le STOCK promotionnel n'est PAS ici : dotations, réceptions, pertes et inventaires attestent des faits physiques et se font à l'écran (Sales & Marketing › Stock promotionnel). "
        + `Champ « op » : ${opsSummary("promo_operation")}. `
        + "Le dossier se donne par référence MP-… ou titre (« reference »).",
      input_schema: {
        type: "object",
        properties: {
          op: { type: "string", enum: opEnum("promo_operation"), description: "Le geste à faire." },
          reference: { type: "string", description: "Le dossier visé (MP-… ou titre)." },
          label: { type: "string", description: "Synonyme de « reference »." },
          supplier: { type: "string", description: "choose_promo_agency : l'agence retenue. Circuit 2 : le FOURNISSEUR qui désigne un devis (et son BC) — choose_promo_lines : un ou plusieurs (virgules), chacun retient tout son devis." },
          name: { type: "string", description: "Synonyme de « supplier » (l'agence ou le fournisseur visé)." },
          amount: { type: "string", description: "Montant (DZD) — agence retenue, règlement final, facture déposée (deposit_promo_invoice)." },
                    person: { type: "string", description: "update_promo_bc : l'interlocuteur du BC." },
          date: { type: "string", description: "Facture déposée : date (AAAA-MM-JJ)." },
          mode: { type: "string", description: "choose_promo_lines : « valider » soumet le choix ; paiement / information médicale : « visa » (demande de visa publicitaire) ou « déclaration » (au ministère)." },
          track: { type: "string", description: "complete_promo_track : bon de commande / demande de paiement / visa publicitaire." },
          lines: { type: "string", description: "choose_promo_lines : les LIGNES retenues, séparées par « ; » — « Fournisseur : ligne » quand deux devis portent la même référence." },
          invoiceRef: { type: "string", description: "Circuit 2 : la référence de la facture (dépôt, paiement, information médicale)." },
          file: { type: "string", description: "deposit_promo_invoice : le fichier de la facture — nom d'un fichier de votre Drive (glissé dans la conversation ou déposé)." },
          address: { type: "string", description: "generate_promo_bcs / update_promo_bc : adresse de livraison." },
          delay: { type: "string", description: "generate_promo_bcs / update_promo_bc : délai de livraison." },
          phone: { type: "string", description: "update_promo_bc : téléphone de l'interlocuteur." },
          message: { type: "string", description: "comment_promo : le commentaire ; confirm_promo_conformity : référence de l'autorité." },
          note: { type: "string", description: "Commentaire d'étape / n° de BC / référence du visa ; circuit 2 : message au secrétariat, ce qui est à corriger, motif d'annulation ou de modification d'un BC." },
          notes: { type: "string", description: "BC du circuit 2 : notes imprimées sur le bon de commande." },
        },
        required: ["op"],
      },
    },
  },
  medical_info_operation: {
    module: "MEDICAL_INFO",
    ops: zipOps("medical_info_operation", { ...MEDINFO_OPS_IMPL, ...FILE_MEDINFO_OPS_IMPL }),
    def: {
      name: "medical_info_operation",
      description:
        "INFORMATION MÉDICALE — déclarations aux autorités de santé : demander/annuler une pièce, DEMANDER LE BON DE VERSEMENT (l'étape qui précède la déclaration : centre de paiement → Finances → remise au bureau du PRIM), consigner la référence de l'autorité, valider (pharmacien puis Direction), messages — par les actions canoniques. "
        + `Champ « op » : ${opsSummary("medical_info_operation")}. `
        + "La déclaration se donne par référence ou libellé.",
      input_schema: {
        type: "object",
        properties: {
          op: { type: "string", enum: opEnum("medical_info_operation"), description: "Le geste à faire." },
          file: { type: "string", description: "fulfill_doc_request : Le FICHIER : nom d'un fichier de votre Drive (glissé dans la conversation ou déposé) — résolu par nom, droits Drive revérifiés à l'exécution." },
          reference: { type: "string", description: "Référence ou libellé de la déclaration visée." },
          label: { type: "string", description: "Alias de reference." },
          piece: { type: "string", description: "La pièce demandée (libellé)." },
          person: { type: "string", description: "request_declaration_document : à qui demander (nom) ; request_bv : le bénéficiaire du versement." },
          authorityRef: { type: "string", description: "record_authority_declaration : la référence donnée par l'autorité." },
          message: { type: "string", description: "comment_declaration : le message." },
          note: { type: "string", description: "Note / commentaire (validation Direction) ; request_bv : ce que couvre le versement ; deliver_bv : note de remise ; skip_bv : le MOTIF, exigé." },
          notes: { type: "string", description: "record_authority_declaration : notes de l'autorité." },
          amount: { type: "string", description: "request_bv : le MONTANT du bon de versement (DZD)." },
          date: { type: "string", description: "request_bv : l'échéance DEMANDÉE (le centre de paiement arbitre ensuite)." },
        },
        required: ["op"],
      },
    },
  },
  bd_operation: {
    module: "BUSINESS_DEVELOPMENT",
    ops: zipOps("bd_operation", { ...BD_OPS_IMPL, ...BD4_OPS_IMPL, ...BD6_OPS_IMPL }),
    def: {
      name: "bd_operation",
      description:
        "BUSINESS DEVELOPMENT — pipeline d'opportunités (stades idée → validée / abandonnée), études de marché (lignes-molécules, acteurs, pré-remplissage, présentations IA), ET le TABLEAU STRATÉGIQUE projets → gammes → produits (fiches en FUSION, cellule par liste blanche via set_bd_cell, suppressions en cascade comptées, commentaires) — par les actions canoniques. "
        + `Champ « op » : ${opsSummary("bd_operation")}. `
        + "L'étude se donne par TITRE (« research »), la ligne par sa molécule (« row »), l'acteur par son nom (« player ») ; le projet du tableau par NOM (« target »), la gamme par « range », le produit par « product » (DCI ou marque).",
      input_schema: {
        type: "object",
        properties: {
          op: { type: "string", enum: opEnum("bd_operation"), description: "Le geste à faire." },
          name: { type: "string", description: "Pipeline : nom de l'opportunité (création ou cible)." },
          status: { type: "string", description: "update_status : le stade ; update_research : brouillon / finale." },
          dci: { type: "string", description: "create : DCI du produit." },
          therapeuticClass: { type: "string", description: "create / update_research_row : classe thérapeutique." },
          research: { type: "string", description: "Études : le TITRE de l'étude visée (ou à créer)." },
          row: { type: "string", description: "Études : la ligne visée (molécule / produit)." },
          player: { type: "string", description: "Études : l'acteur visé (laboratoire)." },
          molecules: { type: "string", description: "create_research : molécules initiales, séparées par des virgules." },
          people: { type: "string", description: "set_research_participants : noms, virgules (liste REMPLACÉE ; « aucun » vide)." },
          newName: { type: "string", description: "Nouveau titre / nom (étude, ligne, acteur, présentation)." },
          quantity: { type: "string", description: "update_research_row : volume marché (unités)." },
          amount: { type: "string", description: "update_research_row : valeur marché USD ; update_research_player : part de marché." },
          price: { type: "string", description: "update_research_row : prix moyen par boîte (USD)." },
          mode: { type: "string", description: "update_research_player / produit BD (sourcing) : importation, fabrication locale, à étudier." },
          presentation: { type: "string", description: "Présentations : le titre visé (ou à donner à la nouvelle)." },
          notes: { type: "string", description: "Notes / consigne IA (generate/regenerate_presentation : l'instruction) ; tableau : description du projet." },
          sources: { type: "string", description: "update_research : sources de l'étude." },
          target: { type: "string", description: "Tableau stratégique : le PROJET visé (nom)." },
          range: { type: "string", description: "Tableau : la gamme visée (nom)." },
          product: { type: "string", description: "Tableau : le produit visé (DCI ou nom de marque)." },
          field: { type: "string", description: "set_bd_cell : la cellule (Nom, Statut, DCI, Dosage, Taille de marché DZD, Prix unitaire, Concurrents, Investissement A1…)." },
          value: { type: "string", description: "set_bd_cell : la nouvelle valeur (vide pour effacer)." },
          kind: { type: "string", description: "set_bd_cell : projet ou produit." },
          dosage: { type: "string", description: "Produit BD : dosage." },
          form: { type: "string", description: "Produit BD : forme galénique." },
          label: { type: "string", description: "Produit BD : nom de marque." },
          note: { type: "string", description: "Commentaire (projet, gamme, produit)." },
          message: { type: "string", description: "comment_bd_project : le commentaire à poser." },
        },
        required: ["op"],
      },
    },
  },
  dossier_operation: {
    module: "DOSSIERS",
    ops: zipOps("dossier_operation", DOSSIER_OPS_IMPL),
    def: {
      name: "dossier_operation",
      description:
        "SUJETS DE PILOTAGE (anciennement « projets de suivi ») — statut (ouvert → terminé / archivé), équipe (responsable + participants REJOUÉS en FUSION, « aucun » vide), fil « Suivi & discussion » (messages, mentions de MEMBRES, modification / suppression par extrait), e-mail journalisé dans le fil (sujet existant ou créé à la volée), ouverture d'un sujet depuis une tâche — par les actions canoniques. "
        + `Champ « op » : ${opsSummary("dossier_operation")}. `
        + "Le projet se donne par référence ou intitulé (« target ») ; un message du fil par un extrait (« message », ou « dernier »).",
      input_schema: {
        type: "object",
        properties: {
          op: { type: "string", enum: opEnum("dossier_operation"), description: "Le geste à faire." },
          target: { type: "string", description: "Le projet visé (référence ou intitulé)." },
          status: { type: "string", description: "set_dossier_status : ouvert, en cours, en attente, terminé, archivé." },
          person: { type: "string", description: "assign_dossier : le responsable (nom ; « aucun » retire)." },
          people: { type: "string", description: "assign_dossier : participants (noms, virgules — liste REMPLACÉE, absents rejoués, « aucun » vide) ; post_dossier_message : mentions." },
          message: { type: "string", description: "Le message à poster — ou l'EXTRAIT qui désigne un message existant (edit/delete ; « dernier » accepté)." },
          note: { type: "string", description: "edit_dossier_message : le NOUVEAU texte." },
          name: { type: "string", description: "link_email_to_dossier : intitulé du projet à CRÉER (si « target » absent)." },
          label: { type: "string", description: "link_email_to_dossier : l'OBJET de l'e-mail ; create_dossier_from_task : le titre de la tâche." },
          date: { type: "string", description: "link_email_to_dossier : date de réception (AAAA-MM-JJ)." },
        },
        required: ["op"],
      },
    },
  },
  directive_operation: {
    module: "DIRECTIVES",
    ops: zipOps("directive_operation", DIRECTIVE_OPS_IMPL),
    def: {
      name: "directive_operation",
      description:
        "DIRECTIVES de la Direction — émission référencée DIR- vers UNE personne ou UN rôle (priorité, échéance), avancement (prise en compte horodatée, terminée, ARCHIVAGE réservé à la Direction), fil émetteur ↔ destinataire — par les actions canoniques. "
        + `Champ « op » : ${opsSummary("directive_operation")}. `
        + "La directive se donne par référence DIR-… ou titre (« target »).",
      input_schema: {
        type: "object",
        properties: {
          op: { type: "string", enum: opEnum("directive_operation"), description: "Le geste à faire." },
          target: { type: "string", description: "La directive visée (DIR-… ou titre)." },
          label: { type: "string", description: "create_directive : le titre." },
          message: { type: "string", description: "Le contenu de la directive, ou le message à poster sur le fil." },
          person: { type: "string", description: "create_directive : destinataire nommé (prime sur le rôle)." },
          role: { type: "string", description: "create_directive : rôle destinataire (« Délégués médicaux », « National Sales »…)." },
          status: { type: "string", description: "set_directive_status : ouverte, prise en compte, en cours, terminée, archivée." },
          priority: { type: "string", description: "create_directive : basse, moyenne, haute, critique." },
          date: { type: "string", description: "create_directive : échéance (AAAA-MM-JJ)." },
        },
        required: ["op"],
      },
    },
  },
  support_operation: {
    module: "SUPPORT",
    ops: zipOps("support_operation", SUPPORT_OPS_IMPL),
    def: {
      name: "support_operation",
      description:
        "SUPPORT interne — demandes SUP- (question, support promotionnel, brochure, document) vers UNE personne ou UN rôle, prise en charge par le destinataire, fil de réponse (la réponse d'un destinataire passe la demande « répondue »), statut avec clôture ouverte au demandeur — par les actions canoniques. "
        + `Champ « op » : ${opsSummary("support_operation")}. `
        + "La demande se donne par référence SUP-… ou objet (« target »).",
      input_schema: {
        type: "object",
        properties: {
          op: { type: "string", enum: opEnum("support_operation"), description: "Le geste à faire." },
          target: { type: "string", description: "La demande visée (SUP-… ou objet)." },
          label: { type: "string", description: "create_support_request : l'objet." },
          message: { type: "string", description: "Le message / la réponse." },
          person: { type: "string", description: "create_support_request : destinataire nommé (prime sur le rôle)." },
          role: { type: "string", description: "create_support_request : rôle destinataire." },
          kind: { type: "string", description: "create_support_request : question, support promotionnel, brochure, document, autre." },
          product: { type: "string", description: "create_support_request : produit concerné." },
          status: { type: "string", description: "set_support_status : ouverte, en cours, répondue, clôturée." },
        },
        required: ["op"],
      },
    },
  },
};
