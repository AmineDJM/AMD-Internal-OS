/**
 * JOINDRE UNE PIÈCE, ET RELIER UNE FACTURE, SUR UN DOSSIER Ad&Pro — la même règle partout.
 *
 * ── LE DÉFAUT QU'ON CORRIGE ─────────────────────────────────────────────────────────────────
 *
 * « On veut pouvoir associer une facture, un engagement à l'événement, mais je n'arrive pas à
 * joindre de pièce jointe. » Deux causes, et elles sont distinctes :
 *
 * 1. **LE DROIT D'ENVOI ÉTAIT ÉPELÉ DIFFÉREMMENT SUR CHAQUE ÉCRAN**, et chaque orthographe
 *    oubliait quelqu'un :
 *
 *        sponsoring       : `UPLOAD` ou le demandeur
 *        congrès (×2)     : `UPLOAD` ou le demandeur
 *        événements       : `UPLOAD` ou celui qui pilote
 *        matériel promo   : `UPLOAD` ou marketing/assistante/finances/info médicale
 *
 *    Résultat : une personne qui INSTRUIT le dossier — la Direction qui l'a validé, le chef de
 *    produit qui l'a analysé, l'assistante qui le suit — ne voyait aucun bouton d'envoi dès que
 *    le droit `UPLOAD` du module ne lui avait pas été coché. Elle envoyait donc la facture par
 *    mail, et le dossier restait vide.
 *
 * 2. **LE BLOC « ENGAGEMENTS, FACTURES ET COURRIERS LIÉS » N'EXISTAIT QUE SUR LE SPONSORING.**
 *    Le mécanisme, lui, connaissait déjà les congrès, les événements et le matériel promotionnel
 *    (`links/source-link.ts`) : il ne manquait que le bloc sur quatre écrans sur cinq.
 *
 * ── LA RÈGLE ────────────────────────────────────────────────────────────────────────────────
 *
 * **Qui peut décider d'un dossier peut y joindre sa facture.** Joindre une pièce n'est pas un
 * pouvoir : c'est le geste qui rend le dossier lisible. Le refuser à qui l'instruit ne protège
 * rien — cela sort la pièce de l'ERP.
 *
 * Cinq portes, et chacune a sa raison :
 *   1. le droit `UPLOAD` du module — la porte explicite, inchangée ;
 *   2. le DEMANDEUR — c'est son dossier ;
 *   3. qui peut le MODIFIER ou le VALIDER — il en répond ;
 *   4. le DIRECTION MARKETING désigné sur le dossier — il l'a analysé ;
 *   5. la VUE GLOBALE (Direction, Super Admin) — elle voit tout et arbitre.
 *
 * ── CE QUE CETTE RÈGLE NE FAIT PAS ──────────────────────────────────────────────────────────
 *
 * Elle n'ouvre RIEN à qui n'a pas déjà le module : elle se compose avec la porte d'entrée de
 * l'écran, elle ne la remplace pas. Et elle ne dit rien de la SUPPRESSION — retirer une pièce
 * d'un dossier reste un geste à part, avec ses propres droits.
 *
 * Module PUR : ni base, ni session. Testé.
 */

export interface AdProViewer {
  id: string;
  /** Le droit `UPLOAD` sur le module de ce dossier. */
  canUploadModule: boolean;
  /** Le droit `UPDATE` sur ce module. */
  canUpdateModule: boolean;
  /** Le droit `VALIDATE` sur ce module. */
  canValidateModule: boolean;
  /** Vue globale — Direction, Super Admin. */
  hasGlobalView: boolean;
}

export interface AdProRecord {
  requesterId?: string | null;
  /** Le référent Direction Marketing désigné sur le dossier — il l'a analysé, il peut le documenter. */
  productManagerId?: string | null;
  /** L'assistante de direction en charge, quand le dossier en désigne une. */
  assistantId?: string | null;
}

/**
 * PEUT-ON JOINDRE UNE PIÈCE À CE DOSSIER ?
 *
 * On ne nomme aucun RÔLE ici : une liste de rôles tient jusqu'à la première nomination qu'on
 * oublie d'y ajouter. On lit ce que la personne peut FAIRE du dossier, et la réponse suit.
 */
export function canAttachToAdPro(viewer: AdProViewer, record: AdProRecord): boolean {
  if (viewer.hasGlobalView) return true;
  if (viewer.canUploadModule) return true;
  if (viewer.canUpdateModule || viewer.canValidateModule) return true;
  return isOwnBusiness(viewer.id, record);
}

/** La personne est-elle partie prenante NOMMÉE de ce dossier ? */
export function isOwnBusiness(userId: string, record: AdProRecord): boolean {
  return [record.requesterId, record.productManagerId, record.assistantId]
    .some((id) => Boolean(id) && id === userId);
}

/**
 * PEUT-ON RATTACHER UNE FACTURE OU UN ENGAGEMENT À CE DOSSIER ?
 *
 * La même règle : créer une facture DÉJÀ rattachée est le seul moment où l'on sait de quoi elle
 * vient, et le seul où le rattachement ne coûte rien. La refuser à qui instruit le dossier
 * garantit qu'on la créera ailleurs, sans lien — et que six semaines plus tard personne ne saura
 * plus à quel événement elle correspond.
 */
export function canLinkOnAdPro(viewer: AdProViewer, record: AdProRecord): boolean {
  return canAttachToAdPro(viewer, record);
}

/**
 * CE QU'ON DIT À QUI NE PEUT PAS JOINDRE — ou `null` quand il le peut.
 *
 * Un bloc « Documents » sans bouton et sans explication fait chercher la panne : on recharge, on
 * change de navigateur, on finit par envoyer la pièce par mail. Nommer la porte manquante coûte
 * une phrase et fait gagner un aller-retour.
 */
export function attachHint(viewer: AdProViewer, record: AdProRecord): string | null {
  if (canAttachToAdPro(viewer, record)) return null;
  return "Vous pouvez consulter les pièces de ce dossier, mais pas en ajouter : demandez le droit d'envoi sur ce module à un administrateur, ou faites-la déposer par le demandeur.";
}
