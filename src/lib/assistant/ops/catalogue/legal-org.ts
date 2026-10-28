import { userCan } from "./dependances";
import { isSA, type OpMeta } from "./types";

/**
 * CATALOGUE DES OPS — Legal et administration structurelle (organisation).
 *
 * Morceau de `OPS_CATALOG` (`../catalog.ts`), recomposé dans l'ordre d'origine : l'ordre des ops
 * fait partie du contrat (goldens, prompt de l'IA). Métadonnées pures, sans Prisma ni actions.
 */
export const OPS_LEGAL_ORG: OpMeta[] = [
  // ───────────────────────────── LEGAL ─────────────────────────────
  {
    tool: "legal_operation", op: "renew", module: "Legal",
    uiLabel: "Renouveler le document légal",
    aliases: ["renouvelle le contrat", "renouvellement du document légal"],
    risk: "NORMAL",
    summary: "Crée le document SUIVANT de la chaîne (nouvelles dates) — l'ancien est marqué renouvelé, l'historique reste lisible.",
    gate: (u) => userCan(u, "LEGAL", "UPDATE"),
    covers: ["legal-actions:renewLegalDocument"],
  },
  {
    tool: "legal_operation", op: "cancel", module: "Legal",
    uiLabel: "Annuler le document légal",
    aliases: ["annule le contrat", "résilie le document légal"],
    risk: "SENSITIVE",
    summary: "Annule un document légal (motif conservé) — il sort des rappels d'échéance, rien n'est effacé.",
    gate: (u) => userCan(u, "LEGAL", "UPDATE"),
    covers: ["legal-actions:cancelLegalDocument"],
  },
  {
    tool: "legal_operation", op: "set_readers", module: "Legal",
    uiLabel: "Lecteurs du document légal",
    aliases: ["lecteurs du document légal", "donne accès au contrat à", "qui peut lire le contrat"],
    risk: "NORMAL",
    summary: "REMPLACE la liste des lecteurs d'un document légal (le déposant garde toujours l'accès) — nul autre ne voit.",
    gate: (u) => userCan(u, "LEGAL", "UPDATE"),
    gateNote: "le déposant du document",
    covers: ["legal-actions:setLegalReaders"],
  },
  {
    tool: "legal_operation", op: "send_invoice_settlement", module: "Legal",
    uiLabel: "Envoyer la facture au règlement",
    aliases: ["envoie la facture au règlement", "facture légale au règlement"],
    risk: "SENSITIVE",
    summary: "Crée l'ORDRE DE DÉPENSE d'une facture légale (montant requis) — il part dans le circuit Finances/Centre de paiement, rien n'est décaissé ici.",
    gate: (u) => userCan(u, "LEGAL", "UPDATE") || userCan(u, "FINANCES", "CREATE"),
    covers: ["legal-actions:sendLegalInvoiceToSettlement"],
  },
  {
    tool: "legal_operation", op: "submit_purchase_order", module: "Legal",
    uiLabel: "Adresser le bon de commande au centre de validation",
    aliases: [
      "soumets le bon de commande au centre", "fais valider le BC", "envoie le bon de commande en validation",
      "adresse le BC au centre de validation",
    ],
    risk: "NORMAL",
    summary: "Adresse un BON DE COMMANDE du registre Legal à SON centre de validation — celui d'Ad & Pro "
      + "s'il vient d'une demande Ad & Pro, le centre de validations sinon (décision de la Direction, "
      + "09/2026). Rattrape un BC enregistré avant la règle ou dont l'envoi a échoué ; un BC déjà au "
      + "centre (en attente ou validé) n'est jamais adressé deux fois. Rien n'est validé ici : c'est le "
      + "centre qui décide.",
    gate: (u) => userCan(u, "LEGAL", "UPDATE") || userCan(u, "FINANCES", "UPDATE"),
    gateNote: "droit d'écriture sur les bons de commande (Legal, ou Finances depuis la chaîne d'achat)",
    covers: ["legal-actions:adresserBCAuCentre"],
  },
  {
    tool: "legal_operation", op: "attach_drive", module: "Legal",
    uiLabel: "Déclarer un fichier Drive en Legal",
    aliases: ["déclare ce fichier en legal", "rattache le contrat du drive à legal"],
    risk: "NORMAL",
    summary: "Déclare un fichier du Drive comme document légal (SANS copie : Legal pointe dessus) — un fichier déjà déclaré n'est jamais doublonné.",
    gate: (u) => userCan(u, "LEGAL", "CREATE"),
    covers: ["legal-actions:attachDriveNodeToLegal"],
  },
  {
    tool: "legal_operation", op: "link_record", module: "Legal",
    uiLabel: "Brancher la pièce sur une fiche",
    aliases: [
      "rattache le contrat à la demande", "branche cette convention sur le sponsoring",
      "lie la facture à la prise en charge", "rattache le bon de commande à l'événement",
    ],
    risk: "NORMAL",
    summary: "BRANCHE un document Legal DÉJÀ enregistré sur une fiche Ad & Pro (sponsoring, congrès, "
      + "événement, demande « autre », consulting) — sans le recréer et sans copie : c'est la MÊME pièce, "
      + "avec ses fichiers joints. La fiche se donne par sa référence ou son intitulé (champ « target ») ; "
      + "un document déjà rattaché ailleurs est REFUSÉ en nommant la fiche qui le porte.",
    gate: (u) => userCan(u, "LEGAL", "VIEW"),
    covers: ["ad-pro-rattacher-legal:rattacherLegalAFiche"],
  },
  {
    tool: "legal_operation", op: "comment_ad_pro", module: "Ad & Pro",
    uiLabel: "Écrire dans la discussion de la demande",
    aliases: [
      "écris dans la discussion du sponsoring", "commente la demande Ad&Pro",
      "pose un mot sur le fil de la prise en charge", "note sur le fil de l'événement",
    ],
    risk: "NORMAL",
    summary: "Écrit un message HORODATÉ dans la section Discussion d'une demande Ad & Pro — les SEPT "
      + "natures du pôle (sponsoring, congrès international ou national, événement, matériel promotionnel, "
      + "consulting, autre demande). La demande se donne par sa référence ou son intitulé (champ « target »). "
      + "C'est le fil que tous ses acteurs lisent, et d'où partent les demandes de devis, de bon de commande "
      + "et de facture. La porte est celle de l'ENREGISTREMENT : une demande qu'on ne peut pas lire est refusée.",
    gate: () => true,
    gateNote: "accès à la DEMANDE elle-même (revérifié par l'action, par enregistrement)",
    covers: ["ad-pro-discussion-actions:addAdProComment"],
  },
  {
    tool: "legal_operation", op: "unlink_record", module: "Legal",
    uiLabel: "Détacher la pièce de sa fiche",
    aliases: ["détache ce contrat de la demande", "retire la facture de la prise en charge"],
    risk: "NORMAL",
    summary: "DÉTACHE un document Legal de la fiche qui le porte — la pièce n'est ni supprimée ni modifiée, "
      + "elle cesse d'apparaître sur la fiche et redevient rattachable ailleurs. C'est le geste que le refus "
      + "de « link_record » nomme quand la pièce est déjà prise.",
    gate: (u) => userCan(u, "LEGAL", "VIEW"),
    covers: ["ad-pro-rattacher-legal:detacherLegalDeFiche"],
  },
  {
    tool: "legal_operation", op: "delete_document", module: "Legal",
    uiLabel: "Supprimer le document légal",
    aliases: ["supprime le document légal", "efface la fiche legal"],
    risk: "CRITICAL",
    summary: "Supprime DÉFINITIVEMENT la fiche Legal — un fichier Drive référencé reste intact.",
    gate: (u) => userCan(u, "LEGAL", "DELETE"),
    covers: ["legal-actions:deleteLegalDocument"],
  },
  {
    tool: "legal_operation", op: "create_folder", module: "Legal → Dossiers",
    uiLabel: "Nouveau dossier Legal",
    aliases: ["crée un dossier legal", "nouveau dossier de documents légaux"],
    risk: "NORMAL",
    summary: "Crée un dossier de classement Legal (sous-dossier possible).",
    gate: (u) => userCan(u, "LEGAL", "CREATE"),
    covers: ["legal-folder-actions:createLegalFolder"],
  },
  {
    tool: "legal_operation", op: "rename_folder", module: "Legal → Dossiers",
    uiLabel: "Renommer le dossier Legal",
    aliases: ["renomme le dossier legal"],
    risk: "NORMAL",
    summary: "Renomme un dossier de classement Legal.",
    gate: (u) => userCan(u, "LEGAL", "UPDATE"),
    covers: ["legal-folder-actions:updateLegalFolder"],
  },
  {
    tool: "legal_operation", op: "delete_folder", module: "Legal → Dossiers",
    uiLabel: "Supprimer le dossier Legal",
    aliases: ["supprime le dossier legal"],
    risk: "NORMAL",
    summary: "Supprime un dossier Legal — les documents repassent « non classés », aucun n'est supprimé.",
    gate: (u) => userCan(u, "LEGAL", "DELETE") || userCan(u, "LEGAL", "UPDATE"),
    covers: ["legal-folder-actions:deleteLegalFolder"],
  },
  {
    tool: "legal_operation", op: "move_documents", module: "Legal → Dossiers",
    uiLabel: "Classer des documents dans un dossier",
    aliases: ["classe le contrat dans le dossier legal", "range les documents légaux dans"],
    risk: "NORMAL",
    summary: "Classe un ou plusieurs documents légaux dans un dossier (« aucun » = déclasser).",
    gate: (u) => userCan(u, "LEGAL", "UPDATE"),
    covers: ["legal-folder-actions:moveLegalDocuments"],
  },

  // ─────────────────────── ADMINISTRATION STRUCTURELLE (org) ───────────────────────
  {
    tool: "org_operation", op: "create_account_invite", module: "Administration",
    uiLabel: "Créer un compte (lien d'invitation)",
    aliases: [
      "crée un compte pour", "crée un utilisateur", "nouveau compte", "ajoute un utilisateur",
      "donne un accès à", "invite", "crée-lui un accès",
    ],
    risk: "SENSITIVE",
    summary:
      "Crée le compte et un LIEN d'invitation à usage unique (72 h) : la personne définit ELLE-MÊME son mot de passe. " +
      "Aucun mot de passe ne transite jamais par la conversation.",
    gate: isSA,
    gateNote: "création de comptes",
    covers: ["admin-actions:createUser"],
  },
  {
    tool: "org_operation", op: "create_company", module: "Administration → Entités",
    uiLabel: "Nouvelle entité",
    aliases: ["crée une entité", "nouvelle société du groupe", "ajoute l'entité"],
    risk: "SENSITIVE",
    summary: "Crée une entité du groupe (le cloisonnement par entité s'y applique aussitôt).",
    gate: isSA,
    gateNote: "administration des entités",
    covers: ["company-actions:createCompany"],
  },
  {
    tool: "org_operation", op: "toggle_company", module: "Administration → Entités",
    uiLabel: "Activer / désactiver l'entité",
    aliases: ["désactive l'entité", "réactive la société"],
    risk: "SENSITIVE",
    summary: "Active ou désactive une entité — désactivée, elle sort des menus de rattachement (rien n'est effacé).",
    gate: isSA,
    covers: ["company-actions:toggleCompany"],
  },
  {
    tool: "org_operation", op: "create_department", module: "Administration → Départements",
    uiLabel: "Nouveau département",
    aliases: ["crée un département", "nouveau sous-département"],
    risk: "NORMAL",
    summary: "Crée un département (ou sous-département : l'entité suit celle du parent) dans l'organigramme.",
    gate: (u) => userCan(u, "EMPLOYEES", "UPDATE"),
    covers: ["department-actions:createDepartment"],
  },
  {
    tool: "org_operation", op: "assign_department", module: "Administration → Départements",
    uiLabel: "Rattacher l'employé à un département",
    aliases: ["rattache l'employé au département", "change le département de"],
    risk: "NORMAL",
    summary: "Rattache un employé à un département (ou l'en détache) — l'organigramme et les circuits N+1 suivent.",
    gate: (u) => userCan(u, "EMPLOYEES", "UPDATE"),
    covers: ["department-actions:assignEmployeeDepartment"],
  },
  {
    tool: "org_operation", op: "assign_manager", module: "Administration → Départements",
    uiLabel: "Désigner le N+1 de l'employé",
    aliases: ["désigne le manager de", "change le n+1 de", "rattache l'employé à son responsable"],
    risk: "NORMAL",
    summary: "Désigne (ou retire) le responsable hiérarchique direct d'un employé — les circuits de validation N+1 suivent.",
    gate: (u) => userCan(u, "EMPLOYEES", "UPDATE"),
    covers: ["department-actions:assignEmployeeManager"],
  },
  {
    tool: "org_operation", op: "create_supplier", module: "Administration → Fournisseurs",
    uiLabel: "Nouveau fournisseur (portail)",
    aliases: ["crée un fournisseur", "nouveau partenaire fournisseur"],
    risk: "SENSITIVE",
    summary: "Crée un fournisseur du portail externe (pays, e-mail de contact) — ses accès se gèrent ensuite fiche par fiche.",
    gate: isSA,
    covers: ["supplier-actions:createSupplier"],
  },
  {
    tool: "org_operation", op: "toggle_supplier", module: "Administration → Fournisseurs",
    uiLabel: "Activer / désactiver le fournisseur",
    aliases: ["désactive le fournisseur", "coupe l'accès du fournisseur"],
    risk: "SENSITIVE",
    summary: "Active ou désactive un fournisseur du portail — désactivé, son portail ne répond plus (réversible).",
    gate: isSA,
    covers: ["supplier-actions:toggleSupplier"],
  },
  {
    tool: "org_operation", op: "create_contact", module: "Moyens généraux → Annuaire d'entreprise",
    uiLabel: "Nouveau contact d'entreprise",
    aliases: ["ajoute un contact d'entreprise", "nouveau contact agence", "enregistre le contact de l'imprimeur"],
    risk: "NORMAL",
    summary: "Ajoute un contact à l'annuaire d'entreprise (agence, livreur, imprimeur… : nature, personne, téléphone, e-mail).",
    gate: (u) => userCan(u, "GENERAL_MEANS", "CREATE"),
    covers: ["company-contact-actions:createCompanyContact"],
  },
  {
    tool: "org_operation", op: "set_module_access", module: "Administration → Accès",
    uiLabel: "Régler l'accès d'une personne à un module",
    aliases: ["donne à x le droit de créer dans", "bloque le module finances pour", "retire le droit de supprimer à", "remets l'accès par défaut du module"],
    risk: "SENSITIVE",
    summary: "Règle la case (personne, module) de la matrice d'accès : défaut du rôle, bloqué, ou droits personnalisés (donner/retirer CREATE, UPDATE, DELETE, VALIDATE, EXPORT, UPLOAD ; portée tout/assigné) — TOUS les autres réglages de la personne sont rejoués à l'identique.",
    gate: (u) => isSA(u),
    gateNote: "Super Admin seul",
    covers: ["access-actions:saveAccessMatrix", "access-actions:saveModuleAccess"],
  },
  {
    tool: "org_operation", op: "update_user_profile", module: "Administration → Comptes",
    uiLabel: "Profil d'un compte (nom, e-mail, fonction, région)",
    aliases: ["change l'e-mail de connexion de", "renomme le compte de", "change la fonction de"],
    risk: "SENSITIVE",
    summary: "Modifie le profil d'un compte : nom, e-mail DE CONNEXION (unicité vérifiée), fonction, région — FUSION (le reste est rejoué). Le rôle passe par set_account_role, l'activation par set_account_active.",
    gate: (u) => isSA(u),
    gateNote: "Super Admin seul",
    covers: ["access-actions:updateUserProfile"],
  },
  {
    tool: "org_operation", op: "revoke_sessions", module: "Administration → Comptes",
    uiLabel: "Déconnecter de partout",
    aliases: ["déconnecte x de partout", "révoque toutes les sessions de", "force la reconnexion de"],
    risk: "SENSITIVE",
    summary: "Révoque TOUTES les sessions ouvertes d'un compte (reconnexion exigée sur chaque appareil) — le compte reste actif.",
    gate: (u) => isSA(u),
    gateNote: "Super Admin seul",
    covers: ["access-actions:revokeAllSessions"],
  },
  {
    tool: "org_operation", op: "request_user_onboarding", module: "Administration → Comptes",
    uiLabel: "Relancer le setup guidé",
    aliases: ["relance l'onboarding de", "refais passer le setup guidé à"],
    risk: "NORMAL",
    summary: "(Re)déclenche le parcours de configuration guidé d'un compte — à sa prochaine navigation, la personne y est redirigée.",
    gate: (u) => isSA(u),
    gateNote: "Super Admin seul",
    covers: ["access-actions:requestOnboarding"],
  },
];
