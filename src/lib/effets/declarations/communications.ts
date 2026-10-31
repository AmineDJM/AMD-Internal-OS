import type { DeclarationAnnulation } from "../declarations";

/**
 * K10b — COMMUNICATIONS, EFFETS SORTANTS ET SUPPRESSIONS (décision 0038). Chaque ligne a son test d'exécution puis
 * d'annulation contre la base (`src/lib/actions/reversibilite/communications.test.ts`).
 */
const J = (raison: string): DeclarationAnnulation => ({ annulation: "retour", mecanisme: "journal", raison });
const F = (annulation: DeclarationAnnulation["annulation"], raison: string): DeclarationAnnulation => ({ annulation, mecanisme: "fenetre", raison });
const C = (raison: string): DeclarationAnnulation => ({ annulation: "compensation", mecanisme: "journal", raison });
const SANS = (raison: string): DeclarationAnnulation => ({ annulation: "retour", mecanisme: "sans-effet", raison });

/** LE CARNET DE COURRIERS — des écritures en base seulement (le fichier « courrier » n'envoie rien) : le journal J7. */
const COURRIER = J("geste réversible (journal des effets) : le pli, la pièce, le partenaire ou le dossier créé est retiré, une valeur modifiée remise — sauf ce qu'un autre a changé depuis, dit et jamais écrasé ; l'annulation se rétablit");
/** Une écriture interne, sans rien qui sorte : le journal J7, dans les deux sens. */
const INTERNE = J("geste réversible (journal des effets) : ce qui a été créé est retiré, ce qui a été modifié retrouve sa valeur d'avant, ce qui a été retiré est recréé à l'identique (même identifiant) — sauf ce qu'un autre a changé depuis, dit et jamais écrasé ; l'annulation se rétablit");
/** Un COURRIEL : la fenêtre d'annulation, puis le rectificatif. */
const COURRIEL = F("compensation", "fenêtre d'annulation : le courriel attend le délai réglé par le Super Admin (2 min par défaut) — annulé dedans, RIEN n'est parti ; parti, il n'est pas effacé chez son destinataire : un rectificatif lui part (annulable à son tour), et l'écran le dit");
/** Une PUBLICATION au site Adventum : la file attend la fenêtre ; partie, la version d'avant est renvoyée. */
const SITE = F("compensation", "fenêtre d'annulation : l'envoi au site attend le délai réglé (la file ne le prend pas avant) — annulé dedans, le site n'a rien reçu et le contenu retrouve sa version d'avant ; parti, la version d'avant est renvoyée au site (ou la page retirée) — elle a pu être lue");
/** Une DÉCISION de circuit : elle se défait en entier ou pas du tout. */
const DECISION = C("geste réversible, tout ou rien : la décision est rouverte (statuts d'avant rendus), ce qu'elle a fait naître (ordre de dépense, imputation, poste) est retiré — ou passé à ANNULÉ s'il a vécu depuis ; si un dépendant ne se défait plus (un ordre déjà payé), RIEN n'est annulé et la liste dit pourquoi ; les notifications non lues sont retirées, les lues reçoivent un rectificatif");
/** Une PIÈCE NUMÉROTÉE : jamais effacée, annulée. */
const PIECE = C("compensation : la pièce émise (facture, devis, bon de commande, avoir) n'est jamais effacée — elle passe à ANNULÉE, son numéro reste consommé (la série n'a ni trou ni doublon), ses fichiers restent dans le Drive comme trace ; rétablir lui rend son statut");
/** Un GESTE DANS LA BOÎTE MICROSOFT, défait par son inverse. */
const BOITE = J("geste inverse dans la boîte Microsoft, exécuté à l'annulation : le message retrouve son état (lu / non lu), son dossier d'origine, le brouillon son contenu d'avant (ou part à la corbeille de la boîte) ; rétablir rejoue le geste");

export const DECLARATIONS_COMMUNICATIONS: Readonly<Record<string, DeclarationAnnulation>> = {
  "mail-register-actions:createMailEntry": COURRIER,
  "mail-register-actions:editMailEntry": COURRIER,
  "mail-register-actions:setMailDate": COURRIER,
  "mail-register-actions:attachDriveNodeToMail": COURRIER,
  "mail-piece-actions:addMailPiece": COURRIER,
  "mail-piece-actions:updateMailPiece": COURRIER,
  "mail-partner-actions:createMailPartner": COURRIER,
  "mail-partner-actions:updateMailPartner": COURRIER,
  "mail-folder-actions:createMailFolder": COURRIER,
  "mail-folder-actions:updateMailFolder": COURRIER,
  "mail-folder-actions:moveMailEntries": COURRIER,

  "candidatures-site-actions:classerCandidatureSite": INTERNE,
  "candidatures-site-actions:remettreCandidatureATrier": INTERNE,
  "candidatures-site-actions:rattacherCandidatureSite": J("geste réversible : le candidat créé au recrutement (et sa pièce CV) est retiré, la candidature du site revient « à trier » — si personne n'a avancé le candidat depuis (sinon : dit, rien d'écrasé)"),
  "custom-field-actions:modifierChampPersonnalise": INTERNE,
  "custom-field-actions:saveCustomValues": INTERNE,
  "dossier-actions:linkEmailToDossier": INTERNE,
  "kpi-actions:reglerAffectationKpi": INTERNE,
  "kpi-actions:reglerFrequenceRevue": INTERNE,
  "fabrique-actions:reglerNumerotationPieces": J("geste réversible : le motif et le premier numéro d'avant sont rendus au profil — le compteur, lui, ne recule jamais (un numéro déjà attribué reste attribué)"),
  "segmentation-actions:publierRegles": J("geste réversible : la version publiée est retirée, la précédente redevient la règle en vigueur"),
  "recrutement-diffusion-actions:enregistrerTexteCanal": INTERNE,
  "recrutement-diffusion-actions:preparerPostLinkedIn": INTERNE,
  "recrutement-diffusion-actions:marquerCanalPublie": J("geste réversible : le canal retrouve son état d'avant dans l'ERP — la personne avait publié elle-même sur LinkedIn ou ailleurs : ce post-là se retire là où il a été publié (l'ERP ne l'a jamais envoyé)"),
  "recrutement-diffusion-actions:retirerCanal": INTERNE,
  "recrutement-diffusion-actions:envoyerOffreEmploitic": J("geste réversible : l'état du canal Emploitic est rendu ; l'envoi lui-même n'est pas branché (l'API attend sa documentation) — branché, il passera par la fenêtre d'annulation (`differerEffetSortant`)"),
  "recrutement-diffusion-actions:publierOffreSiteDuRecrutement": SITE,
  "site-web-actions:enregistrerArticle": SITE,
  "site-web-actions:relancerEnvoiSite": SITE,
  "site-web-actions:rapprocherSiteMaintenant": J("geste réversible : le rapprochement et ce qu'il a remis en file sont défaits ; ce qu'il a renvoyé au site attend la fenêtre d'annulation"),
  "site-web-actions:verifierConnexionSite": J("geste réversible : la vérification ne fait que lire le site ; ce qu'elle écrit dans l'ERP (état de la liaison, blocage levé) retrouve sa valeur d'avant"),
  "site-web-actions:genererCleSite": J("geste réversible : la clé en attente est retirée — elle ne sera jamais acceptée, même collée dans le site ; la clé en vigueur ne bouge pas"),
  "site-web-actions:abandonnerCleSite": J("geste réversible : la clé en attente abandonnée est rétablie, telle quelle"),

  "mail-actions:connectMailbox": J("geste réversible : la boîte connectée est retirée (ou retrouve ses réglages d'avant, mot de passe chiffré compris)"),
  "mail-actions:disconnectMailbox": J("geste réversible : la boîte est reconnectée à l'identique (mêmes réglages, même identifiant) — si son mot de passe d'application n'a pas été révoqué chez Infomaniak"),
  "mail-actions:sendMailAction": COURRIEL,
  "smart-mail-actions:sendMail": COURRIEL,
  "microsoft-mail-actions:sendMessage": COURRIEL,
  "microsoft-mail-actions:setMessageRead": BOITE,
  "microsoft-mail-actions:moveMessage": BOITE,
  "microsoft-mail-actions:saveDraft": BOITE,
  "microsoft-mail-actions:linkMessageToEntity": INTERNE,
  "microsoft-mail-actions:saveAttachmentToDrive": J("geste réversible : le fichier entré au Drive (et son lien de provenance) est retiré tant que personne ne l'a ouvert ni rangé ailleurs ; le message, lui, n'a pas bougé dans la boîte"),
  "microsoft-mail-actions:disconnectMicrosoftMail": J("geste réversible : la connexion Microsoft (jetons chiffrés), ses dossiers et ses liens de provenance sont recréés à l'identique — si Microsoft n'a pas révoqué le consentement entre-temps, sinon il faut se reconnecter"),

  "directive-actions:publishDirective": F("compensation", "fenêtre d'annulation : les poussées attendent le délai réglé ; annulée, la directive repasse à l'état d'avant, les notifications non lues sont retirées, les poussées ne partent pas — une notification déjà lue reçoit un rectificatif (« n'en tenez plus compte »)"),
  "directive-actions:resendDirective": F("compensation", "fenêtre d'annulation : le rappel (notifications, poussées) est retiré s'il n'a pas été lu, le compteur d'envois rendu ; lu, un rectificatif le suit"),

  "admin-request-actions:decideApproval": DECISION,
  "admin-request-actions:finishRequest": C("geste réversible, tout ou rien : la demande est rouverte, l'imputation au budget retirée (remise en budget), l'archive du Drive retirée ; un dépendant qui a vécu depuis bloque l'annulation, la liste le dit"),
  "care-actions:decideCareQuote": DECISION,
  "medical-info-actions:validateDeclarationByDirection": DECISION,
  "medical-info-actions:requestSlipPayment": C("geste réversible, tout ou rien : la demande de paiement et l'ordre de dépense nés du bordereau sont retirés (ou passés à ANNULÉ), le bordereau revient à son état d'avant ; un ordre déjà payé bloque l'annulation — « paiement à récupérer » se fait alors par le circuit de remboursement, la liste le dit"),

  "fabrique-actions:emettrePieceCommerciale": PIECE,
  "fabrique-actions:emettreAvoir": C("compensation : l'avoir émis n'est jamais effacé — il passe à ANNULÉ (il ne compte plus dans le net de la facture), son numéro reste consommé, son document reste au Drive ; rétablir lui rend son statut"),

  "site-web-redaction-actions:redigerArticleAvecIA": SANS("rien n'est écrit : le texte proposé par l'IA n'est enregistré qu'à l'« Enregistrer » de l'article, lui-même réversible"),
  "site-web-redaction-actions:redigerOffreAvecIA": SANS("rien n'est écrit : le texte proposé par l'IA n'est enregistré qu'à l'enregistrement de l'offre, lui-même réversible"),
  "smart-mail-actions:smartMailStatus": SANS("lecture : l'état de la configuration du courrier, rien n'est écrit"),
  "supplier-portal-actions:supplierLogin": { annulation: "compensation", mecanisme: "compensation-metier", raison: "l'inverse d'une connexion au portail est la déconnexion (« Se déconnecter ») ; la tentative et la date de dernière connexion restent au journal de sécurité — une trace ne s'efface pas" },
  "supplier-portal-actions:supplierLogout": { annulation: "compensation", mecanisme: "compensation-metier", raison: "l'inverse d'une déconnexion est la reconnexion du fournisseur, avec ses identifiants ; rien d'autre n'a été écrit" },
};
