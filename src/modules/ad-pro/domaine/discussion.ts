/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA SECTION DISCUSSION D'UNE DEMANDE Ad & Pro — module PUR, zéro import.
 *
 * ── LA DEMANDE ──────────────────────────────────────────────────────────────────────────
 *
 * « Toutes ces demandes peuvent se faire sur les postes mais aussi dans une section discussion
 * en bas de toutes les demandes Ad&Pro : sponsoring, événements, prises en charge, matériel
 * promotionnel, etc. C'est une section discussion. »
 *
 * ── CE QUE LA MESURE A TROUVÉ, ET POURQUOI IL N'Y A PAS DE NOUVEAU MÉCANISME ─────────────
 *
 * Le fil existe, il est CANONIQUE, et il tourne déjà : le modèle `Comment`
 * (`entityType` + `entityId` + `body` + auteur + édition) et le composant `CommentThread`
 * (édition, suppression, modération) sont montés sur CINQ écrans du dépôt — dont
 * `/promo-material/[id]`, c'est-à-dire l'une des sept natures du pôle Ad & Pro.
 *
 * Les SIX autres n'en avaient pas. C'est §118.71 dans sa forme la plus littérale : une porte
 * gardée à côté de six portes fermées, et c'est la même chose qui manque. Écrire un second
 * modèle de fil pour Ad & Pro aurait fait DEUX vérités sur ce qu'est un échange attaché à un
 * dossier, et c'est celle du pôle qui aurait pris du retard au premier correctif (§118.5) —
 * le symptôme serait une modération qui marche sur le matériel promotionnel et pas ailleurs.
 *
 * ── CE QUE CE MODULE DÉCIDE, ET CE QU'IL NE DÉCIDE PAS ──────────────────────────────────
 *
 * Il ne décide RIEN des droits : la porte est `canAccessEntity`, qui répond par ENREGISTREMENT
 * et non par module — une demande Ad & Pro est souvent confidentielle à son cercle, et un droit
 * de module ouvrirait le fil de la demande d'un autre service (§118.109). Ce module dit
 * seulement, pour une nature, SUR QUELLE ENTITÉ le fil s'attache et par quel chemin l'écran y
 * revient, une fois, pour les sept.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/**
 * LE VOCABULAIRE DE LA SECTION — écrit une fois, lu par les sept écrans.
 *
 * Sept titres écrits à la main auraient divergé au premier ajustement, et une section qui
 * s'appelle autrement d'un écran à l'autre se lit comme une autre section.
 */
export const DISCUSSION_TITRE = "Discussion" as const;

export const DISCUSSION_AIDE =
  "Tout l'échange du dossier : questions, précisions, références. C'est aussi d'ici qu'on demande "
  + "un devis, un bon de commande ou une facture — la demande garde alors le lien avec ce qui l'a motivée.";

/** Ce qu'une section vide dit — jamais un bloc muet (§118.30). */
export const DISCUSSION_VIDE =
  "Aucun échange pour l'instant. Écrivez ici plutôt qu'en messagerie : trois semaines plus tard, "
  + "personne ne retrouve pourquoi le dossier a pris dix jours.";

/*
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CE QUE CE MODULE NE PORTE PAS, ET POURQUOI C'EST DÉLIBÉRÉ.
 *
 * Un prédicat « qui peut modérer le fil d'une demande Ad & Pro ? » a été écrit ici, puis RETIRÉ
 * après mesure : `canModerateEntity` répond déjà à cette question pour toute entité de l'ERP, par
 * ENREGISTREMENT, et c'est lui que les actions canoniques de modération emploient. En garder un
 * second aurait fait afficher un bouton que l'action refuse — le symptôme exact de §118.5, et
 * celui que ce même fichier reproche à un second modèle de fil.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
