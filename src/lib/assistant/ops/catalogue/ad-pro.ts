import { userCan, hasGlobalView } from "./dependances";
import { siegeAuCentreAdPro } from "@/platform/in-process/capacites";
import type { OpMeta } from "./types";

/**
 * CATALOGUE DES OPS — Ad & Pro : circuits sponsoring et congrès / événements, postes de dépense, demandes
 * « autres », correction de fiche, visa et seuils du centre de validation.
 *
 * Morceau de `OPS_CATALOG` (`../catalog.ts`), recomposé dans l'ordre d'origine : l'ordre des ops
 * fait partie du contrat (goldens, prompt de l'IA). Métadonnées pures, sans Prisma ni actions.
 */
export const OPS_AD_PRO: OpMeta[] = [
  // ───────────────────────────── AD & PRO — circuit sponsoring ─────────────────────────────
  // Les anciennes décisions HORS circuit (préliminaire, analyse, décision définitive) ont disparu
  // (§118.151) : le circuit d'un sponsoring se conduit par `advance_workflow`, qui passe par le
  // moteur, et sa fin se prononce ici — la validation finale qui fige les postes.
  {
    tool: "adpro_operation", op: "close_sponsoring", module: "Sponsoring",
    uiLabel: "Valider et clôturer le sponsoring",
    aliases: ["clôture le sponsoring", "valide et clôture le sponsoring", "validation finale du sponsoring", "cloture la demande de sponsoring"],
    risk: "CRITICAL",
    summary: "VALIDATION FINALE d'un sponsoring dont la tenue est pré-validée : vérifie que chaque poste est décidé et que chaque poste accordé a son budget et son montant (sinon dit TOUT ce qui manque), puis FIGE les postes et écrit leur somme comme montant accordé.",
    gate: (u) => hasGlobalView(u) || userCan(u, "SPONSORING", "VALIDATE"),
    gateNote: "celui qui a pré-validé la tenue — Direction Marketing, ou la Direction quand la demande vient d'elle — jamais le demandeur (revérifié par l'action)",
    covers: ["sponsoring-actions:cloturerSponsoring"],
  },
  {
    tool: "adpro_operation", op: "reopen_sponsoring", module: "Sponsoring",
    uiLabel: "Rouvrir un sponsoring clôturé",
    aliases: ["rouvre le sponsoring", "réouvre la clôture du sponsoring", "annule la clôture du sponsoring"],
    risk: "SENSITIVE",
    summary: "Rouvre un sponsoring clôturé (motif obligatoire) : il repasse en tenue pré-validée, son montant accordé est retiré, ses postes se modifient à nouveau jusqu'à la prochaine clôture.",
    gate: (u) => hasGlobalView(u) || userCan(u, "SPONSORING", "VALIDATE"),
    gateNote: "la même autorité que la clôture (revérifiée par l'action)",
    covers: ["sponsoring-actions:rouvrirSponsoring"],
  },
  {
    tool: "adpro_operation", op: "appeal_sponsoring", module: "Sponsoring",
    uiLabel: "Faire appel (demandeur)",
    aliases: ["fais appel sur le sponsoring", "conteste la décision du sponsoring"],
    risk: "SENSITIVE",
    summary: "Fait APPEL après la décision — un refus, ou un montant accordé sous l'ancien circuit (motif obligatoire) — et rouvre le circuit de validation de la demande.",
    gate: () => true,
    gateNote: "le demandeur de la demande (revérifié par l'action)",
    covers: ["sponsoring-actions:sponsoringAppeal"],
  },
  {
    tool: "adpro_operation", op: "involve_third_party", module: "Ad & Pro",
    uiLabel: "Impliquer une tierce personne",
    aliases: ["implique l'assistante sur le sponsoring", "fais valider par une tierce personne"],
    risk: "NORMAL",
    summary: "Implique une tierce personne (ex. assistante de direction) dans le circuit d'un sponsoring / congrès / événement SANS lui ouvrir le module : demande de validation dans SON espace, sans budget.",
    gate: () => true,
    gateNote: "un acteur du dossier (revérifié par l'action)",
    covers: ["sponsoring-actions:requestThirdPartyInput", "congress-request-actions:requestThirdPartyInput"],
  },

  // ───────────────────────────── AD & PRO — circuit congrès / événements ─────────────────────────────
  // Les anciennes décisions HORS circuit (préliminaire, analyse, décision définitive, budget accordé
  // global) ont disparu (Direction, 27/10) : le circuit d'un congrès / événement se conduit par
  // `advance_workflow`, comme à l'écran.
  {
    tool: "adpro_operation", op: "cancel_congress_request", module: "Congrès",
    uiLabel: "Retirer la demande",
    aliases: ["annule la demande de congrès", "annule la prise en charge", "retire la demande de congrès", "retire la prise en charge"],
    risk: "SENSITIVE",
    summary: "Retire une demande de congrès / événement NON encore validée : elle est SUPPRIMÉE avec ses postes, ses pièces et ses ordres non réglés, et reste récupérable depuis la corbeille par le Super Admin (le demandeur, un validateur du module, ou la Direction).",
    gate: () => true,
    gateNote: "demandeur ou validateur (revérifié par l'action)",
    covers: ["congress-request-actions:cancelCongressRequest"],
  },
  {
    tool: "adpro_operation", op: "add_congress_beneficiary", module: "Congrès → Personnes",
    uiLabel: "Ajouter une personne prise en charge",
    aliases: ["ajoute le docteur à la prise en charge du congrès", "prends en charge cette personne au congrès"],
    risk: "NORMAL",
    summary: "Propose un professionnel pour la prise en charge d'un congrès : praticien de l'annuaire (résolu par nom) ou nom libre, avec sa qualité.",
    gate: () => true,
    gateNote: "accès au congrès (revérifié par l'action)",
    covers: ["congress-beneficiary-actions:addCongressBeneficiary"],
  },
  {
    tool: "adpro_operation", op: "remove_congress_beneficiary", module: "Congrès → Personnes",
    uiLabel: "Retirer une personne prise en charge",
    aliases: ["retire la personne de la prise en charge du congrès"],
    risk: "NORMAL",
    summary: "Retire une personne de la liste des prises en charge d'un congrès.",
    gate: () => true,
    gateNote: "accès au congrès (revérifié par l'action)",
    covers: ["congress-beneficiary-actions:removeCongressBeneficiary"],
  },
  {
    tool: "adpro_operation", op: "request_beneficiary_ids", module: "Congrès → Personnes",
    uiLabel: "Demander les pièces des professionnels",
    aliases: ["demande les pièces d'identité des personnes prises en charge"],
    risk: "NORMAL",
    summary: "Demande les pièces de chaque professionnel proposé (national : passeport ; international : passeport, visa, informations de voyage) et prévient le DEMANDEUR.",
    gate: () => true,
    gateNote: "accès au congrès (revérifié par l'action)",
    covers: ["congress-beneficiary-actions:requestBeneficiaryIds"],
  },

  // ───────────────────────────── AD & PRO — postes de dépense ─────────────────────────────
  {
    tool: "adpro_operation", op: "add_item", module: "Ad & Pro → Postes",
    uiLabel: "Ajouter un poste de dépense",
    aliases: ["ajoute un poste à l'opération", "ajoute le traiteur au sponsoring", "nouveau poste de dépense"],
    risk: "NORMAL",
    summary: "Ajoute un POSTE à une opération (sponsoring / congrès / événement) : libellé, estimation, prestataire, et budget INCLUS ou RALLONGE — un poste ajouté après la décision est marqué.",
    gate: () => true,
    gateNote: "accès à l'opération (revérifié par l'action)",
    covers: ["ad-pro-item-actions:addAdProItem"],
  },
  {
    tool: "adpro_operation", op: "update_item", module: "Ad & Pro → Postes",
    uiLabel: "Modifier un poste",
    aliases: ["modifie le poste de dépense", "affecte le montant du poste"],
    risk: "SENSITIVE",
    summary: "Modifie un poste — SEULS les champs donnés bougent (l'action est champ-par-champ) ; le montant AFFECTÉ est un geste de la Direction, refusé si un ordre est déjà émis.",
    gate: () => true,
    gateNote: "éditeurs de l'opération ; le montant affecté exige la Direction (revérifié)",
    covers: ["ad-pro-item-actions:updateAdProItem"],
  },
  {
    tool: "adpro_operation", op: "delete_item", module: "Ad & Pro → Postes",
    uiLabel: "Retirer un poste",
    aliases: ["supprime le poste de dépense"],
    risk: "CRITICAL",
    summary: "Retire un poste — si son ordre de dépense est émis, seule la DIRECTION peut le faire et l'ordre est ANNULÉ (trace comptable conservée) ; un matériel promo rattaché est conservé.",
    gate: () => true,
    gateNote: "éditeurs ; un poste émis exige la Direction (revérifié par l'action)",
    covers: ["ad-pro-item-actions:deleteAdProItem"],
  },
  {
    tool: "adpro_operation", op: "submit_item", module: "Ad & Pro → Postes",
    uiLabel: "Soumettre le poste à la Direction",
    aliases: ["soumets le poste à validation", "envoie le poste à la direction"],
    risk: "NORMAL",
    summary: "Soumet UN poste à la Direction (accorder / refuser / budget à revoir) — un poste « à revoir » se resoumet autant de fois qu'il faut, chaque tour reste dans l'historique.",
    gate: () => true,
    gateNote: "accès à l'opération (revérifié par l'action)",
    covers: ["ad-pro-item-actions:submitAdProItem"],
  },
  {
    tool: "adpro_operation", op: "set_item_budget", module: "Ad & Pro → Postes",
    uiLabel: "Imputer le poste à un budget",
    aliases: ["impute le poste au budget", "choisis la catégorie budgétaire du poste"],
    risk: "SENSITIVE",
    summary: "Impute un poste ACCORDÉ à une (sous-)catégorie budgétaire (résolue par nom, « aucune » retire) — le budget choisi suit la dépense jusqu'aux Finances. Direction.",
    gate: (u) => hasGlobalView(u) || userCan(u, "SPONSORING", "VALIDATE") || userCan(u, "CONGRESS_NATIONAL", "VALIDATE") || userCan(u, "CONGRESS_INTERNATIONAL", "VALIDATE") || userCan(u, "EVENTS", "VALIDATE"),
    covers: ["ad-pro-item-actions:setAdProItemBudget"],
  },
  {
    tool: "adpro_operation", op: "request_item_quote", module: "Ad & Pro → Postes",
    uiLabel: "Demander une pièce au secrétariat (devis / facture)",
    aliases: [
      "demande un devis pour le poste", "ouvre une demande de devis au secrétariat",
      "réclame la facture du poste", "demande la facture au secrétariat",
    ],
    risk: "NORMAL",
    summary: "Ouvre une DEMANDE ADMINISTRATIVE (Bureau du secrétariat) pour un poste — DEVIS ou FACTURE, avec le message qui porte le contenu et les références. Refuse si une demande de la même nature est déjà ouverte, et la facture exige que le bon de commande ait été demandé.",
    gate: () => true,
    gateNote: "accès à l'opération (revérifié par l'action)",
    covers: ["ad-pro-item-actions:demanderPieceSecretariat"],
  },
  {
    tool: "adpro_operation", op: "request_item_order", module: "Ad & Pro → Postes",
    uiLabel: "Demander l'émission du BC",
    aliases: ["demande l'émission du bon de commande du poste"],
    risk: "SENSITIVE",
    summary: "Demande le bon de commande d'un poste accordé à l'ASSISTANTE DE DIRECTION, qui le dépose ; il revient sur le poste (au-dessus du seuil des bons de commande, le centre de validation Ad & Pro le vise en parallèle), puis les Finances le signent — exige montant affecté ET budget ; sans assistante unique, elle doit être choisie à l'écran. Un sponsoring direct n'a pas de BC.",
    gate: () => true,
    gateNote: "accès à l'opération (revérifié par l'action)",
    covers: ["ad-pro-item-actions:requestAdProItemOrder"],
  },
  {
    tool: "adpro_operation", op: "approve_item_order", module: "Ad & Pro → Postes",
    uiLabel: "Valider le BC (centre Ad & Pro)",
    aliases: ["vise le bon de commande du poste", "valide le bon de commande du poste", "refuse l'émission du bc du poste"],
    risk: "CRITICAL",
    summary: "VALIDATION du bon de commande d'un poste par le CENTRE DE VALIDATION AD & PRO (Direction Générale, Super Admin), ou refus MOTIVÉ — la signature des Finances suit le BC déposé par l'assistante. Tout BC né d'Ad & Pro au-dessus du seuil des bons de commande passe par ce centre (décision de la Direction, 09/2026).",
    gate: (u) => siegeAuCentreAdPro(u),
    covers: ["ad-pro-item-actions:approveAdProItemOrder"],
  },
  {
    tool: "adpro_operation", op: "link_item_promo_material", module: "Ad & Pro → Postes",
    uiLabel: "Rattacher un matériel promotionnel",
    aliases: ["rattache le matériel promo au poste", "détache le matériel du poste"],
    risk: "NORMAL",
    summary: "Rattache un matériel promotionnel EXISTANT à un poste (« aucun » détache) — on rattache, on ne recopie pas : le matériel garde son propre circuit.",
    gate: () => true,
    gateNote: "accès à l'opération (revérifié par l'action)",
    covers: ["ad-pro-item-actions:linkPromoMaterial"],
  },

  // ───────────────────────────── AD & PRO — demandes « autres » & correction de fiche ─────────────────────────────
  {
    tool: "adpro_operation", op: "create_other_request", module: "Ad & Pro → Autres",
    uiLabel: "Nouvelle demande « autre »",
    aliases: ["crée une demande ad pro autre", "demande hors catégorie ad pro"],
    risk: "NORMAL",
    summary: "Crée une demande Ad & Pro « autre » (objet + description OBLIGATOIRES — c'est sur elle que la décision se prend) — elle suit le circuit Ad & Pro (N+1, Directeur des opérations, prévalidation de la Direction Marketing).",
    gate: (u) => userCan(u, "AD_PRO_OTHER", "CREATE"),
    covers: ["ad-pro-other-actions:createAdProOtherRequest"],
  },
  {
    tool: "adpro_operation", op: "decide_other_request", module: "Ad & Pro → Autres",
    uiLabel: "Trancher la demande « autre »",
    aliases: ["valide la demande autre", "refuse la demande autre"],
    risk: "SENSITIVE",
    summary: "Donne l'avis de l'étape courante du circuit d'une demande « autre » (valider ou refuser — le moteur juge qui agit) — motif tracé.",
    gate: (u) => userCan(u, "AD_PRO_OTHER", "VALIDATE") || hasGlobalView(u),
    covers: ["ad-pro-other-actions:decideAdProOtherRequest"],
  },
  /**
   * LE VISA DU CENTRE DE VALIDATION AD & PRO — et pourquoi ce geste-là est OFFERT ici.
   *
   * §118.15 réserve à un clic dans une vraie session les gestes qui sont des ATTESTATIONS :
   * accorder une autorisation, fournir une pièce. Autoriser un dépassement de seuil en est
   * une — l'audit portera le nom d'une personne. La question n'est donc pas si cette op est
   * commode, c'est si le chemin qui l'emprunte fait bien signer un humain.
   *
   * Trois faits MESURÉS le disent, et c'est pourquoi l'op existe :
   *
   *  1. Le registre des capacités de MISSION est une liste FERMÉE de 62 entrées et ne contient
   *     AUCUNE capacité `*_operation` : une mission ne peut pas atteindre une op, donc il n'y a
   *     pas de chemin où le moteur exécuterait ce visa sans carte. C'est exactement ce que
   *     `policy/guard.ts` protège pour `mission_control`, et ce visa n'y entre pas par ailleurs
   *     — y ajouter un motif pour une capacité qui n'existe pas dans ce registre serait du code
   *     mort (§118.14), et élargir ses motifs, qui servent les capacités de mission, serait
   *     l'erreur que §118.74 nomme.
   *  2. En conversation, toute op passe par la carte de confirmation, et §118.126 a tranché :
   *     « une carte qui exige un clic EST une action confirmée ». La carte porte le montant ET
   *     le seuil côte à côte — la personne voit précisément ce que le contrôle existe pour lui
   *     faire regarder.
   *  3. Le siège est REVÉRIFIÉ par l'action de l'écran (`siegeAuCentreAdPro`), que l'exécuteur
   *     appelle telle quelle : la conversation n'est pas une porte dérobée (§118.7), et y
   *     réécrire la vérification en ferait une seconde vérité en retard (§118.74).
   *
   * Et le geste INVERSE serait plus coûteux que le défaut : REFUSER un dépassement est un geste
   * qui RÉDUIT, que §118.15 déclare sans danger et disponible dans la conversation. Exclure
   * l'action entière l'aurait emporté avec l'autorisation, pour un « je ne peux pas » que rien
   * n'oblige (§118.27). Les deux directions sont donc offertes, comme `decide_other_request` —
   * la décision Ad & Pro voisine, SENSITIVE elle aussi, offerte ainsi depuis toujours.
   *
   * La cible se résout sur la LISTE DU CENTRE elle-même (`demandesAuCentreAdPro`) et non par une
   * seconde requête : une op qui chercherait les visas de son côté finirait par ne pas voir les
   * mêmes que l'écran (§118.5), et le symptôme serait une carte proposée sur une ligne que le
   * centre ne montre plus.
   */
  {
    tool: "adpro_operation", op: "decide_gate_visa", module: "Centre de validation Ad & Pro",
    uiLabel: "Trancher le dépassement de seuil",
    aliases: [
      "autorise le dépassement de seuil", "refuse le dépassement de seuil",
      "valide le visa du centre ad pro", "refuse le visa ad pro",
    ],
    risk: "SENSITIVE",
    summary: "AUTORISE ou REFUSE le franchissement du seuil Ad & Pro pour une demande qui l'attend au "
      + "centre de validation (Direction Générale ou Super Admin, revérifié par l'action). La demande se "
      + "donne par sa référence ou son intitulé (champ « reference ») ; la décision par « decision » "
      + "(autoriser / refuser) ; un REFUS exige son motif (champ « note »). Un visa déjà tranché est "
      + "REFUSÉ en nommant sa décision : on ne rejoue pas une attestation.",
    gate: (u) => siegeAuCentreAdPro(u),
    gateNote: "siège au centre de validation Ad & Pro (Direction Générale ou Super Admin)",
    covers: ["ad-pro-centre-actions:deciderVisaCentreAdPro"],
  },
  /**
   * LES DEUX SEUILS DU CENTRE (§118.149) — réglés depuis le centre de validation Ad & Pro, par
   * ses SIÈGES. Ils étaient déclarés « couverts » par `update_platform_setting`, qui ne les
   * connaissait PAS : sa liste de réglages modifiables n'en contenait aucun, donc la carte aurait
   * répondu « réglage inconnu » — une parité annoncée sans chemin réel (§118.14). Et même
   * branché, il aurait écrit la colonne à côté de l'action : sans son siège (Super Admin seul)
   * ni, pour les BC, le réaiguillage de ce qui est en vol. Les ops appellent l'action de l'écran.
   */
  {
    tool: "adpro_operation", op: "set_bc_threshold", module: "Centre de validation Ad & Pro",
    uiLabel: "Régler le seuil des bons de commande",
    aliases: [
      "règle le seuil des bons de commande", "change le seuil de validation des bc",
      "au-dessus de combien un bc passe par le centre",
    ],
    risk: "SENSITIVE",
    summary: "Règle le SEUIL DES BONS DE COMMANDE (champ « amount », en DZD ; 0 = tout BC passe par un centre). "
      + "Au-dessus : un centre de validation (Ad & Pro si le BC en vient, le centre de validations sinon), puis "
      + "la signature des Finances ; en deçà : directement à la signature des Finances. Les BC en cours qui "
      + "changent de côté sont réaiguillés, et la réponse dit combien.",
    gate: (u) => siegeAuCentreAdPro(u),
    gateNote: "siège au centre de validation Ad & Pro (Direction Générale ou Super Admin)",
    covers: ["settings-actions:setBcValidationThreshold"],
  },
  {
    tool: "adpro_operation", op: "set_request_threshold", module: "Centre de validation Ad & Pro",
    uiLabel: "Régler le seuil des demandes Ad & Pro",
    aliases: [
      "règle le seuil du centre ad pro", "change le seuil de validation du directeur général",
      "au-dessus de combien une demande ad pro passe par le centre",
    ],
    risk: "SENSITIVE",
    summary: "Règle le SEUIL DES DEMANDES Ad & Pro (champ « amount », en DZD ; 0 = plus aucune validation du "
      + "Directeur Général) : une demande dont le budget total le dépasse passe par le centre de validation Ad & Pro. "
      + "Distinct du seuil des bons de commande.",
    gate: (u) => siegeAuCentreAdPro(u),
    gateNote: "siège au centre de validation Ad & Pro (Direction Générale ou Super Admin)",
    covers: ["settings-actions:setAdProDgThreshold"],
  },
  {
    tool: "adpro_operation", op: "close_other_request", module: "Ad & Pro → Autres",
    uiLabel: "Clore / annuler la demande « autre »",
    aliases: ["clôture la demande autre", "annule la demande autre"],
    risk: "NORMAL",
    summary: "Marque TERMINÉE une demande validée et exécutée, ou l'ANNULE — le demandeur, un validateur ou la Direction.",
    gate: () => true,
    gateNote: "demandeur ou validateur (revérifié par l'action)",
    covers: ["ad-pro-other-actions:closeAdProOtherRequest"],
  },
  {
    tool: "adpro_operation", op: "correct_request", module: "Ad & Pro",
    uiLabel: "Corriger la fiche d'une demande",
    aliases: ["corrige la ville du sponsoring", "corrige la fiche de la demande ad pro"],
    risk: "SENSITIVE",
    summary: "Corrige la FICHE d'une demande Ad & Pro par LISTE BLANCHE (ville, spécialité, produits, description, montant demandé, dates) — les DÉCISIONS ne passent jamais par ici ; après décision, seule la Direction corrige.",
    gate: () => true,
    gateNote: "demandeur avant décision ; Direction après (revérifié par l'action)",
    covers: ["ad-pro-edit-actions:updateAdProRequest"],
  },
];
