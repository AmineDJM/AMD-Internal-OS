import { userCan, hasGlobalView } from "@/lib/rbac";
import type { OpMeta } from "./types";

/**
 * CATALOGUE DES OPS — Le chemin générique (rattrapage de toute action ouverte), puis le Drive (écritures)
 * et les Tâches côté « moi ».
 *
 * Morceau de `OPS_CATALOG` (`../catalog.ts`), recomposé dans l'ordre d'origine : l'ordre des ops
 * fait partie du contrat (goldens, prompt de l'IA). Métadonnées pures, sans Prisma ni actions.
 */
export const OPS_SOCLE: OpMeta[] = [
  /**
   * LE CHEMIN GÉNÉRIQUE — la seule op qui ne nomme pas son geste, et pourquoi elle existe.
   *
   * Les 520 autres ops déclarent chacune UN geste à la main. C'est ce que le dirigeant a
   * refusé : « je veux pas la capacité de retirer classe thérapeutique, je veux la capacité de
   * tout faire ». Celle-ci atteint les 550 actions ouvertes de l'ERP sans qu'aucune ait été
   * décrite ici — le contrat se DÉRIVE de la source (`actions/contrat.ts`).
   *
   * Elle ne REMPLACE pas les ops déclarées : elles portent des alias en français, une
   * résolution de cible et des cartes taillées pour leur geste, et restent le bon chemin quand
   * elles existent. Celle-ci est le RATTRAPAGE, pour tout ce que personne n'a écrit.
   *
   * `covers: []` est honnête : elle ne rend NATIVE aucune action de l'inventaire de parité.
   * Y lister les 550 ferait passer le cliquet de parité pour une couverture nominative, alors
   * qu'il compte des gestes DÉCRITS à un humain — et un catalogue qui se déclare complet cesse
   * d'être relu.
   */
  {
    tool: "capability_operation", op: "run", module: "Toutes",
    uiLabel: "Exécuter une action de l'ERP par son contrat",
    aliases: [],
    risk: "SENSITIVE",
    summary:
      "Appelle N'IMPORTE QUELLE action serveur ouverte de l'ERP — la même que le bouton de l'écran, "
      + "avec ses propres contrôles de droits. Carte de confirmation obligatoire. Les gestes qui touchent "
      + "aux comptes, aux droits ou aux garde-fous sont refusés par conception, Super Admin compris. "
      + "Les champs de RÉFÉRENCE acceptent un NOM ou une référence lisible (« Nivolex », "
      + "« REG-2026-041 ») quand l'objet visé a une portée de lecture déclarée : la carte montre "
      + "alors la ligne retenue, et une désignation ambiguë est refusée avec ses candidats.",
    // La porte est celle de l'ACTION, pas celle-ci : ce pré-filtre laisse passer, et chaque
    // action revérifie. Le refuser ici sur un module fermerait le rattrapage à ceux-là mêmes
    // qui en ont besoin — l'action, elle, sait exactement ce qu'elle exige.
    gate: () => true,
    gateNote: "chaque action revérifie ses propres droits à l'exécution",
    covers: [],
  },
  // ───────────────────────────── DRIVE (écritures) ─────────────────────────────
  {
    tool: "drive_operation", op: "create_folder", module: "Drive",
    uiLabel: "Nouveau dossier",
    aliases: ["crée un dossier dans le drive", "nouveau dossier drive"],
    risk: "NORMAL",
    summary: "Crée un dossier (à la racine personnelle, dans un dossier parent ou une catégorie). Réversible (corbeille Drive).",
    gate: (u) => userCan(u, "DRIVE", "CREATE") || userCan(u, "DRIVE", "VIEW"),
    gateNote: "éditeur du dossier parent, ou droit Créer à la racine",
    covers: ["drive-actions:createFolder"],
  },
  {
    tool: "drive_operation", op: "rename", module: "Drive",
    uiLabel: "Renommer",
    aliases: ["renomme le fichier", "renomme le dossier drive"],
    risk: "NORMAL",
    summary: "Renomme un fichier ou dossier du Drive (accès éditeur requis). Réversible en renommant à nouveau.",
    gate: (u) => userCan(u, "DRIVE", "VIEW"),
    covers: ["drive-actions:renameNode"],
  },
  {
    tool: "drive_operation", op: "move", module: "Drive",
    uiLabel: "Déplacer",
    aliases: ["déplace le fichier", "range ce fichier dans", "mets ce document dans le dossier"],
    risk: "NORMAL",
    summary: "Déplace un élément (et son sous-arbre) vers un autre dossier — la catégorie de destination s'applique à tout le sous-arbre.",
    gate: (u) => userCan(u, "DRIVE", "VIEW"),
    covers: ["drive-actions:moveNode", "drive-actions:moveNodes"],
  },
  {
    tool: "drive_operation", op: "share", module: "Drive",
    uiLabel: "Partager",
    aliases: ["partage le dossier avec", "donne accès au fichier", "partage ce document"],
    risk: "NORMAL",
    summary: "Partage un élément avec des collègues (lecture ou modification) — chacun est notifié.",
    gate: (u) => userCan(u, "DRIVE", "VIEW"),
    covers: ["drive-actions:shareNode", "drive-actions:shareNodeWithMany", "drive-actions:shareNodesWithMany"],
  },
  {
    tool: "drive_operation", op: "unshare", module: "Drive",
    uiLabel: "Retirer le partage",
    aliases: ["retire le partage", "coupe l'accès au dossier de"],
    risk: "NORMAL",
    summary: "Retire l'accès d'une personne à un élément partagé.",
    gate: (u) => userCan(u, "DRIVE", "VIEW"),
    covers: ["drive-actions:unshareNode"],
  },
  {
    tool: "drive_operation", op: "trash", module: "Drive",
    uiLabel: "Mettre à la corbeille",
    aliases: ["mets à la corbeille", "corbeille ce fichier"],
    risk: "NORMAL",
    summary: "Met un élément (et son contenu) à la corbeille Drive — RESTAURABLE.",
    gate: (u) => userCan(u, "DRIVE", "VIEW"),
    covers: ["drive-actions:trashNode", "drive-actions:trashNodes"],
  },
  {
    tool: "drive_operation", op: "restore", module: "Drive",
    uiLabel: "Restaurer (corbeille Drive)",
    aliases: ["restaure de la corbeille drive", "sors ce fichier de la corbeille"],
    risk: "NORMAL",
    summary: "Restaure un élément de la corbeille Drive (avec son sous-arbre) ; si son parent a disparu, il revient à la racine.",
    gate: (u) => userCan(u, "DRIVE", "VIEW"),
    covers: ["drive-actions:restoreNode"],
  },
  {
    tool: "drive_operation", op: "delete", module: "Drive",
    uiLabel: "Supprimer définitivement (Drive)",
    aliases: ["supprime définitivement du drive", "efface le fichier pour de bon"],
    risk: "CRITICAL",
    summary: "Retire un élément du Drive (hors corbeille du Drive) : il passe dans la corbeille du Super Admin, restaurable avec ses versions et partages.",
    gate: (u) => userCan(u, "DRIVE", "VIEW"),
    covers: ["drive-actions:deleteNode"],
  },
  {
    tool: "drive_operation", op: "create_office", module: "Drive / Bureautique",
    uiLabel: "Nouveau document (Word/Excel/PowerPoint)",
    aliases: ["crée un document word", "nouveau document bureautique", "crée une feuille excel"],
    risk: "NORMAL",
    summary: "Crée un document bureautique vierge (docx/xlsx/pptx) dans le Drive, éditable dans l'app.",
    gate: (u) => userCan(u, "DRIVE", "CREATE") || userCan(u, "DRIVE", "VIEW"),
    covers: ["drive-actions:createOfficeNode"],
  },
  {
    tool: "drive_operation", op: "to_pdf", module: "Drive / Bureautique",
    uiLabel: "Convertir en PDF",
    aliases: ["convertis en pdf", "fais un pdf de ce document"],
    risk: "NORMAL",
    summary: "Produit un PDF à côté du document bureautique (l'original reste intact).",
    gate: (u) => userCan(u, "DRIVE", "CREATE"),
    covers: ["drive-actions:convertNodeToPdf"],
  },
  {
    tool: "drive_operation", op: "copy", module: "Drive",
    uiLabel: "Copier vers un dossier",
    aliases: ["copie ce fichier dans", "duplique le document vers"],
    risk: "NORMAL",
    summary: "COPIE un élément dans un autre dossier (l'original reste en place) — l'ACL de la destination s'applique à la copie.",
    gate: (u) => userCan(u, "DRIVE", "VIEW"),
    covers: ["drive-actions:copyNodes"],
  },
  {
    tool: "drive_operation", op: "comment", module: "Drive",
    uiLabel: "Commenter un élément",
    aliases: ["commente ce fichier", "laisse un commentaire sur le document"],
    risk: "NORMAL",
    summary: "Poste un commentaire sur un fichier ou dossier du Drive (visible de qui y a accès).",
    gate: (u) => userCan(u, "DRIVE", "VIEW"),
    covers: ["drive-comment-actions:postDriveComment"],
  },
  {
    tool: "drive_operation", op: "delete_comment", module: "Drive",
    uiLabel: "Supprimer un commentaire",
    aliases: ["supprime le commentaire sur", "efface mon commentaire"],
    risk: "NORMAL",
    summary: "Supprime un commentaire d'un élément du Drive (son auteur, ou un gestionnaire).",
    gate: (u) => userCan(u, "DRIVE", "VIEW"),
    covers: ["drive-comment-actions:deleteDriveComment"],
  },
  {
    tool: "drive_operation", op: "create_space", module: "Drive → Catégories",
    uiLabel: "Nouvelle catégorie (espace)",
    aliases: ["crée une catégorie drive", "nouvel espace drive"],
    risk: "NORMAL",
    summary: "Crée une catégorie du Drive (onglet) — les accès se règlent ensuite.",
    gate: (u) => hasGlobalView(u) || userCan(u, "DRIVE", "CREATE"),
    covers: ["drive-space-actions:createDriveSpace"],
  },
  {
    tool: "drive_operation", op: "update_space", module: "Drive → Catégories",
    uiLabel: "Modifier la catégorie (nom, accès)",
    aliases: ["renomme la catégorie drive", "donne la lecture de la catégorie à", "retire l'accès à la catégorie de"],
    risk: "SENSITIVE",
    summary: "Modifie une catégorie : nom, et ajout/retrait CIBLÉ d'une personne en lecture — TOUT le reste (rôles, gestionnaires, icône) est relu et rejoué à l'identique.",
    gate: (u) => hasGlobalView(u) || userCan(u, "DRIVE", "UPDATE"),
    gateNote: "gestionnaires de la catégorie (revérifié par l'action)",
    covers: ["drive-space-actions:updateDriveSpace"],
  },
  {
    tool: "drive_operation", op: "archive_space", module: "Drive → Catégories",
    uiLabel: "Archiver / désarchiver la catégorie",
    aliases: ["archive la catégorie drive", "désarchive l'espace drive"],
    risk: "NORMAL",
    summary: "Masque une catégorie des onglets (ou la réaffiche) — rien n'est supprimé.",
    gate: (u) => hasGlobalView(u) || userCan(u, "DRIVE", "UPDATE"),
    covers: ["drive-space-actions:archiveDriveSpace"],
  },
  {
    tool: "drive_operation", op: "delete_space", module: "Drive → Catégories",
    uiLabel: "Supprimer la catégorie",
    aliases: ["supprime la catégorie drive", "efface l'espace drive"],
    risk: "CRITICAL",
    summary: "Supprime une catégorie (onglet + réglages d'accès) — refusé si des fichiers y sont encore rangés.",
    gate: (u) => hasGlobalView(u) || userCan(u, "DRIVE", "DELETE") || userCan(u, "DRIVE", "UPDATE"),
    covers: ["drive-space-actions:deleteDriveSpace"],
  },
  {
    tool: "drive_operation", op: "rename_attachment", module: "Pièces jointes",
    uiLabel: "Renommer une pièce jointe d'entité",
    aliases: ["renomme la pièce jointe", "renomme le fichier joint à la demande"],
    risk: "NORMAL",
    summary: "Renomme une pièce jointe portée par une fiche (demande, dossier, événement…) — résolue par son nom de fichier, entité affichée.",
    gate: (u) => hasGlobalView(u) || userCan(u, "DOCUMENTS", "UPDATE") || userCan(u, "DRIVE", "VIEW"),
    covers: ["document-actions:renameDocument"],
  },
  {
    tool: "drive_operation", op: "delete_attachment", module: "Pièces jointes",
    uiLabel: "Supprimer une pièce jointe d'entité",
    aliases: ["supprime la pièce jointe", "efface le fichier joint à la fiche"],
    risk: "CRITICAL",
    summary: "Supprime DÉFINITIVEMENT une pièce jointe d'une fiche — aucun retour possible.",
    gate: (u) => hasGlobalView(u) || userCan(u, "DOCUMENTS", "DELETE") || userCan(u, "DRIVE", "VIEW"),
    covers: ["document-actions:deleteDocument"],
  },
  {
    tool: "drive_operation", op: "update_letterhead", module: "Bureautique → En-têtes",
    uiLabel: "Modifier un papier en-tête",
    aliases: ["renomme le papier en-tête", "désactive l'en-tête"],
    risk: "NORMAL",
    summary: "Renomme ou active/désactive un papier en-tête (réservé à l'assistante de direction / Super Admin — revérifié).",
    gate: () => true,
    gateNote: "assistante de direction / Super Admin (revérifié par l'action)",
    covers: ["letterhead-actions:updateLetterhead"],
  },
  {
    tool: "drive_operation", op: "delete_letterhead", module: "Bureautique → En-têtes",
    uiLabel: "Supprimer un papier en-tête",
    aliases: ["supprime le papier en-tête", "efface le modèle d'en-tête"],
    risk: "CRITICAL",
    summary: "Supprime un papier en-tête et son binaire — les documents DÉJÀ créés dessus ne bougent pas.",
    gate: () => true,
    gateNote: "assistante de direction / Super Admin (revérifié par l'action)",
    covers: ["letterhead-actions:deleteLetterhead"],
  },

  // ─────────────────────── TÂCHES — côté « moi » (répondre/faire) ───────────────────────
  {
    tool: "task_operation", op: "accept", module: "Espace de travail",
    uiLabel: "Accepter la demande de tâche",
    aliases: ["accepte la tâche", "j'accepte la demande de tâche"],
    risk: "NORMAL",
    summary: "Accepte une demande de tâche qui vous est adressée — accepter, c'est commencer (le demandeur est notifié).",
    gate: (u) => userCan(u, "WORKSPACE", "UPDATE") || userCan(u, "WORKSPACE", "VIEW"),
    covers: ["task-actions:respondTaskRequest"],
  },
  {
    tool: "task_operation", op: "refuse", module: "Espace de travail",
    uiLabel: "Refuser la demande de tâche",
    aliases: ["refuse la tâche", "décline la demande de tâche"],
    risk: "NORMAL",
    summary: "Refuse une demande de tâche (motif facultatif) — le demandeur est notifié avec le motif.",
    gate: (u) => userCan(u, "WORKSPACE", "UPDATE") || userCan(u, "WORKSPACE", "VIEW"),
    covers: [],
  },
  {
    tool: "task_operation", op: "delete_task", module: "Espace de travail",
    uiLabel: "Supprimer la tâche",
    aliases: ["supprime la tâche", "efface ma tâche", "retire la tâche de ma liste"],
    risk: "SENSITIVE",
    summary: "Supprime DÉFINITIVEMENT une tâche que VOUS avez créée (pièces et fil compris) — une tâche reçue se refuse, elle ne se supprime pas. Le Super Admin peut supprimer toute tâche.",
    gate: (u) => userCan(u, "WORKSPACE", "VIEW"),
    covers: ["task-actions:deleteTask"],
  },
  {
    tool: "task_operation", op: "submit_work", module: "Espace de travail",
    uiLabel: "Valider mon travail",
    aliases: ["valide mon travail sur la tâche", "marque la tâche comme faite avec compte rendu", "j'ai terminé la tâche"],
    risk: "NORMAL",
    summary: "Marque la tâche FAITE avec un compte rendu (toujours modifiable ensuite) — le demandeur est notifié.",
    gate: (u) => userCan(u, "WORKSPACE", "UPDATE") || userCan(u, "WORKSPACE", "VIEW"),
    covers: ["task-actions:submitTaskWork"],
  },
  {
    tool: "task_operation", op: "reopen", module: "Espace de travail",
    uiLabel: "Rouvrir la tâche",
    aliases: ["rouvre la tâche", "la tâche n'est pas finie"],
    risk: "NORMAL",
    summary: "Rouvre une tâche marquée faite (retour En cours).",
    gate: (u) => userCan(u, "WORKSPACE", "UPDATE") || userCan(u, "WORKSPACE", "VIEW"),
    covers: ["task-actions:reopenTaskWork"],
  },
  {
    tool: "task_operation", op: "request_document", module: "Espace de travail → Pièces",
    uiLabel: "Demander une pièce à quelqu'un",
    aliases: ["demande la pièce à", "réclame le devis signé à", "demande le document à"],
    risk: "NORMAL",
    summary: "Demande une pièce nommée à une personne SUR un événement / congrès / sponsoring (échéance possible) — elle la transmet, vous tranchez.",
    gate: () => true,
    covers: ["document-request-actions:requestDocument"],
  },
  {
    tool: "task_operation", op: "submit_document_request", module: "Espace de travail → Pièces",
    uiLabel: "Marquer la pièce transmise",
    aliases: ["marque la pièce transmise", "j'ai envoyé la pièce demandée"],
    risk: "NORMAL",
    summary: "Marque comme TRANSMISE une pièce qui vous a été demandée — le demandeur tranchera (acceptée / refusée).",
    gate: () => true,
    covers: ["document-request-actions:submitDocumentRequest"],
  },
  {
    tool: "task_operation", op: "decide_document_request", module: "Espace de travail → Pièces",
    uiLabel: "Accepter / refuser la pièce transmise",
    aliases: ["accepte la pièce transmise", "refuse la pièce reçue"],
    risk: "NORMAL",
    summary: "Tranche une pièce qui vous a été transmise : acceptée (close) ou refusée (à reprendre).",
    gate: () => true,
    covers: ["document-request-actions:decideDocumentRequest"],
  },
  {
    tool: "task_operation", op: "cancel_document_request", module: "Espace de travail → Pièces",
    uiLabel: "Annuler la demande de pièce",
    aliases: ["annule la demande de pièce", "retire la demande de document"],
    risk: "NORMAL",
    summary: "Annule une demande de pièce que vous aviez envoyée.",
    gate: () => true,
    covers: ["document-request-actions:cancelDocumentRequest"],
  },
  {
    tool: "task_operation", op: "comment", module: "Espace de travail",
    uiLabel: "Commenter la tâche",
    aliases: ["commente la tâche", "ajoute un message sur la tâche"],
    risk: "NORMAL",
    summary: "Ajoute un message au fil d'échange de la tâche (visible des personnes de la tâche).",
    gate: (u) => userCan(u, "WORKSPACE", "VIEW"),
    covers: ["task-actions:addTaskComment"],
  },
];
