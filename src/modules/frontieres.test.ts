import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cibleInterne, dependances } from "@/platform/imports";
import { demenagements } from "@/platform/demenagements";
import { CARTE, SOCLE_METIER } from "./carte";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES FRONTIÈRES DES MODULES (`src/modules/<module>/`) — rapport d'audit 08, structure cible.
 * Le guide pas à pas : `docs/architecture/MODULES.md`.
 *
 *   api.ts        la porte SERVEUR : commandes, requêtes, types publics ;
 *   api-*.ts      une porte serveur SPÉCIALISÉE quand une partie du module ne doit pas être
 *                 atteinte par tous (le coffre : `api.ts` n'écrit que, `api-lecture.ts` déchiffre) ;
 *   partage.ts    la porte PURE, importable partout (navigateur, autres `domaine/`) ;
 *   actions.ts    les actions serveur (`"use server"`), déclarées dans `src/lib/actions/parc.ts` —
 *                 `actions-<cas>.ts` quand le module en a plusieurs fichiers (chacun garde sa clé) ;
 *   domaine/      règles PURES : ni Prisma, ni Next, ni Node, ni React, ni `infra/`, ni `ecrans/` ;
 *   infra/        la base et les fichiers, réexportés par les portes ;
 *   ecrans/       composants React du module, importés par les pages de `src/app/` seulement.
 *
 * Les règles, toutes à ZÉRO (un module migré naît propre, il n'a pas de dette « à résorber ») :
 *   1. hors du module, on n'importe qu'une porte — ou un `ecrans/*` depuis `src/app/` ;
 *   2. `domaine/` est pur (un import de TYPE seul de `@prisma/client` est permis : il s'efface) ;
 *      et `partage.ts` ne réexporte que `domaine/` ;
 *   3. un module n'en lit un autre que s'il figure dans `carte.ts`, qui reste sans cycle ;
 *      un `domaine/` ne lit un autre module que par sa porte pure ;
 *   4. le socle (L0 de `platform/domains.ts`) n'importe aucun module ;
 *   5. personne n'importe un ancien chemin : l'adresse de réexpédition (`tsconfig.json`,
 *      `platform/demenagements.ts`) ne sert qu'au code qui arrive d'une autre branche.
 *
 * Et une dette HÉRITÉE, mesurée par module : les imports d'un module vers l'ancien `src/lib/`
 * hors socle. Elle ne peut que baisser — la liste est exacte, une entrée neuve fait échouer.
 *
 * ESLint (`no-restricted-imports`, `.eslintrc.json`) dit les règles 1, 2 et 5 dans l'éditeur ; ce
 * test les TIENT, imports relatifs compris (`platform/imports.ts`).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Les imports d'un module vers `src/lib/` hors socle, connus et nommés. Ne peut que rétrécir. */
const DETTE_HERITEE: Record<string, string[]> = {
  "ad-pro": [
    // Les bons de commande (règle, aiguillage, brouillon, copie signée, saisie du composeur) : cible = `@/modules/bons-de-commande/api`.
    "src/modules/ad-pro/actions-centre.ts → src/lib/bons-de-commande/aiguillage",
    "src/modules/ad-pro/actions-centre.ts → src/lib/bons-de-commande/etat",
    "src/modules/ad-pro/actions-postes-decision.ts → src/lib/bons-de-commande/aiguillage",
    "src/modules/ad-pro/actions-postes-lignes.ts → src/lib/bons-de-commande/aiguillage",
    "src/modules/ad-pro/actions-postes-lignes.ts → src/lib/bons-de-commande/brouillon",
    "src/modules/ad-pro/actions-postes-lignes.ts → src/lib/bons-de-commande/regle",
    "src/modules/ad-pro/actions-postes-lignes.ts → src/lib/bons-de-commande/saisie-composeur",
    "src/modules/ad-pro/actions-postes-paiement.ts → src/lib/bons-de-commande/aiguillage",
    "src/modules/ad-pro/actions-postes-paiement.ts → src/lib/bons-de-commande/copie-signee",
    "src/modules/ad-pro/actions-postes-paiement.ts → src/lib/bons-de-commande/saisie-composeur",
    "src/modules/ad-pro/actions-postes.ts → src/lib/bons-de-commande/aiguillage",
    "src/modules/ad-pro/actions-postes.ts → src/lib/bons-de-commande/etat",
    "src/modules/ad-pro/actions-postes.ts → src/lib/bons-de-commande/regle",
    "src/modules/ad-pro/actions-rattacher-legal.ts → src/lib/bons-de-commande/aiguillage",
    "src/modules/ad-pro/actions-rattacher-legal.ts → src/lib/bons-de-commande/regle",
    "src/modules/ad-pro/domaine/bc-poste.ts → src/lib/bons-de-commande/regle",
    "src/modules/ad-pro/domaine/devis-poste.ts → src/lib/bons-de-commande/regle",
    "src/modules/ad-pro/domaine/poste-etapes.ts → src/lib/bons-de-commande/regle",
    "src/modules/ad-pro/ecrans/apercu-bc-poste.tsx → src/lib/bons-de-commande/brouillon",
    "src/modules/ad-pro/ecrans/devis-bc-poste.tsx → src/lib/bons-de-commande/brouillon",
    "src/modules/ad-pro/ecrans/facture-paiement-bc.tsx → src/lib/bons-de-commande/copie-signee",
    "src/modules/ad-pro/ecrans/postes/elements.tsx → src/lib/bons-de-commande/regle",
    "src/modules/ad-pro/infra/bc-devis.ts → src/lib/bons-de-commande/brouillon",
    "src/modules/ad-pro/infra/facture-poste-lecture.ts → src/lib/bons-de-commande/copie-signee",
    "src/modules/ad-pro/infra/marche-bc.ts → src/lib/bons-de-commande/regle",
    "src/modules/ad-pro/infra/pieces-poste.ts → src/lib/bons-de-commande/copie-signee",
    "src/modules/ad-pro/infra/pieces-poste.ts → src/lib/bons-de-commande/etat",
    "src/modules/ad-pro/infra/pieces-poste.ts → src/lib/bons-de-commande/regle",
    "src/modules/ad-pro/infra/postes/commun.ts → src/lib/bons-de-commande/saisie-composeur",
    "src/modules/ad-pro/infra/requetes/devis-poste.ts → src/lib/bons-de-commande/brouillon",
    "src/modules/ad-pro/infra/requetes/devis-poste.ts → src/lib/bons-de-commande/etat",
    "src/modules/ad-pro/infra/requetes/devis-poste.ts → src/lib/bons-de-commande/regle",
    "src/modules/ad-pro/infra/requetes/postes.ts → src/lib/bons-de-commande/brouillon",
    // Le moteur de circuit (étapes, parcours, origine, statut d'une « autre » demande) : cible = la porte du circuit de validation.
    "src/modules/ad-pro/actions-autres.ts → src/lib/workflow/autre-statut",
    "src/modules/ad-pro/actions-autres.ts → src/lib/workflow/engine",
    "src/modules/ad-pro/actions-autres.ts → src/lib/workflow/origin",
    "src/modules/ad-pro/actions-congres.ts → src/lib/workflow/engine",
    "src/modules/ad-pro/actions-congres.ts → src/lib/workflow/origin",
    "src/modules/ad-pro/actions-edition.ts → src/lib/workflow/engine",
    "src/modules/ad-pro/actions-evenements.ts → src/lib/workflow/engine",
    "src/modules/ad-pro/actions-evenements.ts → src/lib/workflow/origin",
    "src/modules/ad-pro/actions-postes.ts → src/lib/workflow/engine",
    "src/modules/ad-pro/actions-sponsoring.ts → src/lib/workflow/engine",
    "src/modules/ad-pro/actions-sponsoring.ts → src/lib/workflow/origin",
    "src/modules/ad-pro/actions-transfert.ts → src/lib/workflow/engine",
    "src/modules/ad-pro/actions-transfert.ts → src/lib/workflow/origin",
    "src/modules/ad-pro/infra/postes/commun.ts → src/lib/workflow/engine",
    "src/modules/ad-pro/infra/requetes/centre.ts → src/lib/workflow/parcours",
    // Le stock promotionnel et le dossier de matériel promotionnel : cible = `@/modules/promo/api` (prochain lot du pôle).
    "src/modules/ad-pro/actions-postes-decision.ts → src/lib/promo/reservations",
    "src/modules/ad-pro/actions-postes-decision.ts → src/lib/promo/stock-ecriture",
    "src/modules/ad-pro/actions-postes-lignes.ts → src/lib/promo/reservations",
    "src/modules/ad-pro/actions-postes-materiel.ts → src/lib/promo/catalogue",
    "src/modules/ad-pro/actions-postes-materiel.ts → src/lib/promo/reservations",
    "src/modules/ad-pro/actions-postes-materiel.ts → src/lib/promo/stock",
    "src/modules/ad-pro/actions-postes-materiel.ts → src/lib/promo/stock-ecriture",
    "src/modules/ad-pro/actions-postes-materiel.ts → src/lib/queries/promo-stock",
    "src/modules/ad-pro/actions-postes-paiement.ts → src/lib/promo/reservations",
    "src/modules/ad-pro/actions-postes.ts → src/lib/promo/reservations",
    "src/modules/ad-pro/domaine/cloture-sponsoring.ts → src/lib/promo/reservations",
    "src/modules/ad-pro/domaine/create-fields.ts → src/lib/promo-material/achats",
    "src/modules/ad-pro/domaine/devis-poste.ts → src/lib/promo-material/devis",
    "src/modules/ad-pro/domaine/edition.ts → src/lib/promo-material/statut",
    "src/modules/ad-pro/domaine/suppression.ts → src/lib/promo-material/validateurs",
    "src/modules/ad-pro/ecrans/demande-materiel-form.tsx → src/lib/promo-material/actions-fournisseur",
    "src/modules/ad-pro/ecrans/demande-materiel-form.tsx → src/lib/promo-material/lignes-demande",
    "src/modules/ad-pro/ecrans/demande-materiel-form.tsx → src/lib/promo/catalogue",
    "src/modules/ad-pro/ecrans/demande-materiel-form.tsx → src/lib/queries/promo-achats",
    "src/modules/ad-pro/ecrans/materiel-stock.tsx → src/lib/promo/catalogue",
    "src/modules/ad-pro/ecrans/materiel-stock.tsx → src/lib/promo/reservations",
    "src/modules/ad-pro/ecrans/postes/elements.tsx → src/lib/promo/reservations",
    "src/modules/ad-pro/ecrans/postes/formulaires.tsx → src/lib/promo/reservations",
    "src/modules/ad-pro/ecrans/postes/poste-carte.tsx → src/lib/promo/reservations",
    "src/modules/ad-pro/infra/bc-devis.ts → src/lib/promo-material/devis",
    "src/modules/ad-pro/infra/postes/commun.ts → src/lib/promo/catalogue",
    "src/modules/ad-pro/infra/postes/commun.ts → src/lib/promo/stock",
    "src/modules/ad-pro/infra/requetes/demandes.ts → src/lib/promo-material/statut",
    "src/modules/ad-pro/infra/requetes/demandes.ts → src/lib/queries/promo-achats",
    "src/modules/ad-pro/infra/requetes/postes.ts → src/lib/promo-material/statut",
    "src/modules/ad-pro/infra/requetes/postes.ts → src/lib/promo/catalogue",
    "src/modules/ad-pro/infra/requetes/postes.ts → src/lib/promo/reservations",
    "src/modules/ad-pro/infra/requetes/postes.ts → src/lib/promo/stock",
    "src/modules/ad-pro/infra/requetes/postes.ts → src/lib/queries/promo-stock",
    "src/modules/ad-pro/infra/requetes/prise-en-charge.ts → src/lib/promo-material/statut",
    "src/modules/ad-pro/infra/requetes/suppression.ts → src/lib/queries/promo-circuit",
    // L'argent — ordres de dépense, règlement, factures connues, budget marketing et intégration 2026 : cible =
    // `@/modules/finances/api` (lot Finances en cours ; ces fichiers deviendront ses portes).
    "src/modules/ad-pro/actions-congres.ts → src/lib/expense-orders",
    "src/modules/ad-pro/actions-congres.ts → src/lib/payments/revision-ordre",
    "src/modules/ad-pro/actions-postes-decision.ts → src/lib/payments/annulation",
    "src/modules/ad-pro/actions-postes-paiement.ts → src/lib/expense-orders",
    "src/modules/ad-pro/actions-postes-paiement.ts → src/lib/factures/blocage-vue",
    "src/modules/ad-pro/actions-postes-paiement.ts → src/lib/factures/connues",
    "src/modules/ad-pro/actions-postes.ts → src/lib/payments/annulation",
    "src/modules/ad-pro/actions-prise-en-charge.ts → src/lib/expense-orders",
    "src/modules/ad-pro/ecrans/bloc-historique.tsx → src/lib/budget-marketing/integration-2026",
    "src/modules/ad-pro/ecrans/bloc-historique.tsx → src/lib/budget-marketing/integration-serveur",
    "src/modules/ad-pro/ecrans/bloc-historique.tsx → src/lib/budget-marketing/rapprochement-serveur",
    "src/modules/ad-pro/ecrans/facture-paiement-bc.tsx → src/lib/factures/blocage-vue",
    "src/modules/ad-pro/ecrans/facture-paiement-bc.tsx → src/lib/finance/relance-paiement",
    "src/modules/ad-pro/ecrans/pieces-historique.tsx → src/lib/budget-marketing/integration-vue",
    "src/modules/ad-pro/infra/requetes/postes.ts → src/lib/queries/budget",
    // L'intérim des décideurs : cible = `@/modules/rh/api` (lot RH en cours).
    "src/modules/ad-pro/infra/prise-en-charge/devis-acces.ts → src/lib/hr/stand-in-resolve",
    // Les droits par enregistrement (lecture et porte d'écriture), les liens d'entité, la visibilité des listes, les intervenants : transverses au registre.
    "src/modules/ad-pro/actions-autres.ts → src/lib/entity-access",
    "src/modules/ad-pro/actions-congres-beneficiaires.ts → src/lib/vue-lecture",
    "src/modules/ad-pro/actions-congres.ts → src/lib/third-party",
    "src/modules/ad-pro/actions-conseil.ts → src/lib/entity-access",
    "src/modules/ad-pro/actions-discussion.ts → src/lib/entity-access",
    "src/modules/ad-pro/actions-discussion.ts → src/lib/entity-href",
    "src/modules/ad-pro/actions-edition.ts → src/lib/entity-access",
    "src/modules/ad-pro/actions-edition.ts → src/lib/lecteurs/consulting",
    "src/modules/ad-pro/actions-evenements.ts → src/lib/entity-access",
    "src/modules/ad-pro/actions-evenements.ts → src/lib/queries/porte-ecriture",
    "src/modules/ad-pro/actions-medecins.ts → src/lib/entity-access",
    "src/modules/ad-pro/actions-medecins.ts → src/lib/vue-lecture",
    "src/modules/ad-pro/actions-pieces.ts → src/lib/entity-href",
    "src/modules/ad-pro/actions-pieces.ts → src/lib/queries/pieces-demande-droits",
    "src/modules/ad-pro/actions-prise-en-charge-logistique.ts → src/lib/entity-access",
    "src/modules/ad-pro/actions-prise-en-charge.ts → src/lib/entity-access",
    "src/modules/ad-pro/actions-rattacher-legal.ts → src/lib/entity-access",
    "src/modules/ad-pro/actions-sponsoring.ts → src/lib/third-party",
    "src/modules/ad-pro/ecrans/discussion-card.tsx → src/lib/entity-access",
    "src/modules/ad-pro/ecrans/discussion-card.tsx → src/lib/entity-href",
    "src/modules/ad-pro/ecrans/involvement-conversations.tsx → src/lib/queries/involvement",
    "src/modules/ad-pro/ecrans/medecins-concernes.tsx → src/lib/entity-access",
    "src/modules/ad-pro/ecrans/prise-en-charge/page-billets-emis.tsx → src/lib/entity-access",
    "src/modules/ad-pro/ecrans/prise-en-charge/page-devis.tsx → src/lib/entity-access",
    "src/modules/ad-pro/infra/pieces-liees.ts → src/lib/lecteurs/legal",
    "src/modules/ad-pro/infra/pieces-poste.ts → src/lib/lecteurs/fichiers-emis",
    "src/modules/ad-pro/infra/postes/commun.ts → src/lib/entity-access",
    "src/modules/ad-pro/infra/prise-en-charge/devis-acces.ts → src/lib/entity-access",
    "src/modules/ad-pro/infra/requetes/centre.ts → src/lib/entity-access",
    "src/modules/ad-pro/infra/requetes/congres.ts → src/lib/acces/compose",
    "src/modules/ad-pro/infra/requetes/congres.ts → src/lib/queries/visibilite-listes",
    "src/modules/ad-pro/infra/requetes/evenements.ts → src/lib/queries/visibilite-listes",
    "src/modules/ad-pro/infra/requetes/suppression.ts → src/lib/entity-access",
    // Les pièces, le Drive, Legal et la numérotation (registre, papeterie, lecture des pièces, lettre de demande de devis).
    "src/modules/ad-pro/actions-autres.ts → src/lib/attach-files",
    "src/modules/ad-pro/actions-autres.ts → src/lib/refs",
    "src/modules/ad-pro/actions-congres.ts → src/lib/attach-files",
    "src/modules/ad-pro/actions-conseil.ts → src/lib/conseil-pieces-ia",
    "src/modules/ad-pro/actions-conseil.ts → src/lib/storage",
    "src/modules/ad-pro/actions-discussion.ts → src/lib/attach-files",
    "src/modules/ad-pro/actions-discussion.ts → src/lib/fil-pieces",
    "src/modules/ad-pro/actions-pieces.ts → src/lib/storage",
    "src/modules/ad-pro/actions-postes-decision.ts → src/lib/demande-devis-depot",
    "src/modules/ad-pro/actions-postes-decision.ts → src/lib/references/registre",
    "src/modules/ad-pro/actions-postes-decision.ts → src/lib/references/registre-serveur",
    "src/modules/ad-pro/actions-postes-lignes.ts → src/lib/pieces-lues/devis-poste-lecture",
    "src/modules/ad-pro/actions-postes-lignes.ts → src/lib/queries/letterheads",
    "src/modules/ad-pro/actions-postes-lignes.ts → src/lib/references/registre",
    "src/modules/ad-pro/actions-postes-lignes.ts → src/lib/refs",
    "src/modules/ad-pro/actions-postes-lignes.ts → src/lib/storage",
    "src/modules/ad-pro/actions-postes-paiement.ts → src/lib/attach-files",
    "src/modules/ad-pro/actions-postes-paiement.ts → src/lib/documents",
    "src/modules/ad-pro/actions-postes-paiement.ts → src/lib/pieces-lues/devis-poste-lecture",
    "src/modules/ad-pro/actions-postes-paiement.ts → src/lib/refs",
    "src/modules/ad-pro/actions-postes-voyageurs.ts → src/lib/attach-files",
    "src/modules/ad-pro/actions-postes-voyageurs.ts → src/lib/documents",
    "src/modules/ad-pro/actions-postes.ts → src/lib/demande-devis-depot",
    "src/modules/ad-pro/actions-postes.ts → src/lib/dossiers-core",
    "src/modules/ad-pro/actions-postes.ts → src/lib/refs",
    "src/modules/ad-pro/actions-prise-en-charge-logistique.ts → src/lib/documents",
    "src/modules/ad-pro/actions-prise-en-charge.ts → src/lib/documents",
    "src/modules/ad-pro/actions-prise-en-charge.ts → src/lib/storage",
    "src/modules/ad-pro/actions-sponsoring.ts → src/lib/attach-files",
    "src/modules/ad-pro/actions-sponsoring.ts → src/lib/refs",
    "src/modules/ad-pro/actions-transfert.ts → src/lib/refs",
    "src/modules/ad-pro/ecrans/devis-bc-poste.tsx → src/lib/legal/fichiers-emis",
    "src/modules/ad-pro/ecrans/discussion-card.tsx → src/lib/fil-pieces",
    "src/modules/ad-pro/ecrans/item-ask-panel.tsx → src/lib/legal/from-piece",
    "src/modules/ad-pro/ecrans/pieces-legal-demande.tsx → src/lib/legal/fichiers-emis",
    "src/modules/ad-pro/ecrans/pieces-legal-demande.tsx → src/lib/queries/pieces-legal-demande",
    "src/modules/ad-pro/infra/bc-devis.ts → src/lib/artifact/factory/commercial",
    "src/modules/ad-pro/infra/bc-devis.ts → src/lib/legal/piece-emise",
    "src/modules/ad-pro/infra/bc-devis.ts → src/lib/pieces-lues/emetteur",
    "src/modules/ad-pro/infra/bc-devis.ts → src/lib/pieces-lues/lecture-fichier",
    "src/modules/ad-pro/infra/bc-devis.ts → src/lib/refs",
    "src/modules/ad-pro/infra/facture-poste-lecture.ts → src/lib/pieces-lues/service",
    "src/modules/ad-pro/infra/fiches-poste.ts → src/lib/attach-files",
    "src/modules/ad-pro/infra/fiches-poste.ts → src/lib/documents",
    "src/modules/ad-pro/infra/fiches-poste.ts → src/lib/storage",
    "src/modules/ad-pro/infra/pieces-poste.ts → src/lib/refs",
    "src/modules/ad-pro/infra/postes/commun.ts → src/lib/dossiers-core",
    "src/modules/ad-pro/infra/prise-en-charge/actions-commun.ts → src/lib/dossiers-core",
    "src/modules/ad-pro/infra/prise-en-charge/pieces-db.ts → src/lib/attach-files",
    "src/modules/ad-pro/infra/prise-en-charge/pieces-db.ts → src/lib/documents",
    "src/modules/ad-pro/infra/prise-en-charge/pieces-db.ts → src/lib/storage",
    "src/modules/ad-pro/infra/requetes/devis-poste.ts → src/lib/artifact/factory/commercial",
    "src/modules/ad-pro/infra/requetes/devis-poste.ts → src/lib/pieces-lues/emetteur",
    "src/modules/ad-pro/infra/requetes/devis-poste.ts → src/lib/pieces-lues/montants",
    "src/modules/ad-pro/infra/requetes/postes.ts → src/lib/legal/piece-emise",
    // Les sociétés et les annuaires (praticiens, référents de gamme, wilayas), le calendrier.
    "src/modules/ad-pro/actions-autres.ts → src/lib/company",
    "src/modules/ad-pro/actions-congres.ts → src/lib/company",
    "src/modules/ad-pro/actions-congres.ts → src/lib/geo/algeria",
    "src/modules/ad-pro/actions-congres.ts → src/lib/medical-info",
    "src/modules/ad-pro/actions-evenements.ts → src/lib/company",
    "src/modules/ad-pro/actions-postes-lignes.ts → src/lib/company",
    "src/modules/ad-pro/actions-postes-lignes.ts → src/lib/queries/company-contacts",
    "src/modules/ad-pro/actions-postes-paiement.ts → src/lib/company",
    "src/modules/ad-pro/actions-postes.ts → src/lib/company",
    "src/modules/ad-pro/actions-prise-en-charge.ts → src/lib/medical/profil-rapide",
    "src/modules/ad-pro/actions-sponsoring.ts → src/lib/company",
    "src/modules/ad-pro/actions-sponsoring.ts → src/lib/geo/algeria",
    "src/modules/ad-pro/actions-sponsoring.ts → src/lib/personnes/referents-gamme",
    "src/modules/ad-pro/domaine/create-fields.ts → src/lib/geo/algeria",
    "src/modules/ad-pro/domaine/postes-luna.ts → src/lib/geo/algeria",
    "src/modules/ad-pro/infra/business-unit-auto.ts → src/lib/personnes/roles-vente",
    "src/modules/ad-pro/infra/calendrier.ts → src/lib/calendar",
    "src/modules/ad-pro/infra/calendrier.ts → src/lib/calendar-tz",
    "src/modules/ad-pro/infra/calendrier.ts → src/lib/company",
    "src/modules/ad-pro/infra/pieces-liees.ts → src/lib/company",
    "src/modules/ad-pro/infra/pieces-poste.ts → src/lib/company",
    "src/modules/ad-pro/infra/referent-de-la-gamme.ts → src/lib/personnes/referents-gamme",
    "src/modules/ad-pro/infra/requetes/demandes.ts → src/lib/company",
    // Les notifications, la réservation des fiches (logistique), le secrétariat, le texte non fiable remis au modèle.
    "src/modules/ad-pro/actions-centre.ts → src/lib/notify",
    "src/modules/ad-pro/actions-congres.ts → src/lib/notify",
    "src/modules/ad-pro/actions-edition.ts → src/lib/notify",
    "src/modules/ad-pro/actions-postes-decision.ts → src/lib/notify",
    "src/modules/ad-pro/actions-postes-lignes.ts → src/lib/notify",
    "src/modules/ad-pro/actions-postes-materiel.ts → src/lib/notify",
    "src/modules/ad-pro/actions-postes-voyageurs.ts → src/lib/reservation-fiche/serveur",
    "src/modules/ad-pro/actions-postes.ts → src/lib/notify",
    "src/modules/ad-pro/actions-postes.ts → src/lib/secretariat/annulation",
    "src/modules/ad-pro/actions-prise-en-charge-logistique.ts → src/lib/notify",
    "src/modules/ad-pro/actions-prise-en-charge-logistique.ts → src/lib/reservation-fiche/serveur",
    "src/modules/ad-pro/actions-prise-en-charge.ts → src/lib/notify",
    "src/modules/ad-pro/actions-transfert.ts → src/lib/notify",
    "src/modules/ad-pro/ecrans/hebergements-bloc.tsx → src/lib/reservation-fiche/etat",
    "src/modules/ad-pro/ecrans/items-panel.tsx → src/lib/reservation-fiche/etat",
    "src/modules/ad-pro/ecrans/prise-en-charge/care-panel.tsx → src/lib/reservation-fiche/etat",
    "src/modules/ad-pro/ecrans/prise-en-charge/fiche-voyageur.tsx → src/lib/reservation-fiche/etat",
    "src/modules/ad-pro/ecrans/voyageurs-bloc.tsx → src/lib/reservation-fiche/etat",
    "src/modules/ad-pro/infra/porte-dg.ts → src/lib/notify",
    "src/modules/ad-pro/infra/postes-luna-ia.ts → src/lib/comms/untrusted",
    "src/modules/ad-pro/infra/postes/commun.ts → src/lib/notify",
    "src/modules/ad-pro/infra/postes/commun.ts → src/lib/secretariat/annulation",
    "src/modules/ad-pro/infra/requetes/postes.ts → src/lib/queries/reservations-fiches",
    "src/modules/ad-pro/infra/requetes/prise-en-charge.ts → src/lib/queries/reservations-fiches",
    "src/modules/ad-pro/infra/requetes/prise-en-charge.ts → src/lib/reservation-fiche/etat",
    // La corbeille (retrait réversible, aperçu de suppression).
    "src/modules/ad-pro/actions-evenements.ts → src/lib/suppression/coeur",
    "src/modules/ad-pro/actions-pieces.ts → src/lib/admin-delete-registry",
    "src/modules/ad-pro/actions-pieces.ts → src/lib/suppression/coeur",
    "src/modules/ad-pro/actions-postes.ts → src/lib/admin-delete-registry",
    "src/modules/ad-pro/actions-postes.ts → src/lib/suppression/coeur",
    "src/modules/ad-pro/infra/requetes/suppression.ts → src/lib/admin-delete-registry",
    // Le modèle (conseil des pièces, postes proposés par Luna) et ses réglages.
    "src/modules/ad-pro/infra/postes-luna-ia.ts → src/lib/ai",
    "src/modules/ad-pro/infra/postes-luna-ia.ts → src/lib/ai-settings",
    "src/modules/ad-pro/infra/postes-luna-ia.ts → src/lib/models/contract",
    "src/modules/ad-pro/infra/postes-luna-ia.ts → src/lib/models/gateway",
    // Le seuil de la porte du DG (`seuils/`) : au socle des domaines, à verser au socle des modules.
    "src/modules/ad-pro/actions-centre.ts → src/lib/seuils/ad-pro",
    "src/modules/ad-pro/domaine/poste-etapes.ts → src/lib/seuils/porte-dg-total",
    "src/modules/ad-pro/ecrans/items-panel.tsx → src/lib/seuils/porte-dg-total",
    "src/modules/ad-pro/ecrans/porte-dg-carte.tsx → src/lib/seuils/porte-dg-total",
    "src/modules/ad-pro/infra/porte-dg.ts → src/lib/seuils/porte-dg-total",
    "src/modules/ad-pro/infra/requetes/postes.ts → src/lib/seuils/porte-dg-total",
    "src/modules/ad-pro/infra/visa.ts → src/lib/seuils/ad-pro",
  ],
  consommation: [
    // `normalizeHeader` (repli d'en-tête de tableur) vit dans l'import de l'annuaire médical.
    "src/modules/consommation/domaine/affinite.ts → src/lib/medical/directory-sheet",
    "src/modules/consommation/domaine/lecture.ts → src/lib/medical/directory-sheet",
    // Le référentiel produits : cible = `@/modules/produits/api`.
    "src/modules/consommation/domaine/resolution.ts → src/lib/products/identity",
  ],
  coffre: [
    // Qui a droit aux salaires : la règle de confidentialité RH, lue pour bâtir le lecteur.
    "src/modules/coffre/infra/lecteur.ts → src/lib/hr/confidentialite",
  ],
  referentiels: [
    // Les normalisations NIF / RC / e-mail vivent chez la qualité des données et la lecture des pièces.
    "src/modules/referentiels/domaine/coordonnees.ts → src/lib/quality/model",
    "src/modules/referentiels/domaine/normalisation.ts → src/lib/pieces-lues/fournisseur",
    "src/modules/referentiels/domaine/normalisation.ts → src/lib/quality/model",
    // Les FICHES 360° lisent la visibilité de chaque métier : ce sont des lectures transverses, à sortir
    // vers un modèle de lecture (proposition §5.5) quand les métiers auront leur `api.ts`.
    "src/modules/referentiels/infra/organisations/fiche.ts → src/lib/company",
    "src/modules/referentiels/infra/organisations/fiche.ts → src/lib/queries/visibilite-listes",
    "src/modules/referentiels/infra/personnes/fiche.ts → src/lib/company",
    "src/modules/referentiels/infra/personnes/fiche.ts → src/lib/entity-access",
    "src/modules/referentiels/infra/personnes/fiche.ts → src/lib/entity-href",
    "src/modules/referentiels/infra/personnes/fiche.ts → src/lib/queries/vue-360",
    // La reprise des pièces relance la file d'enrichissement (moteur E) : cible = `@/modules/pieces/api`.
    "src/modules/referentiels/infra/reprises/rattrapage-pieces.ts → src/lib/enrichissement/file",
    "src/modules/referentiels/infra/reprises/rattrapage-pieces.ts → src/lib/enrichissement/signalement",
  ],
  rh: [
    // La paie et les avances partent au CENTRE DE PAIEMENT (Finances) comme une demande : `createExpenseOrder` et le budget.
    // Cible = `@/modules/finances/api` quand le module Finances sera migré (autre session) — jamais une copie ici.
    "src/modules/rh/actions-paie.ts → src/lib/expense-orders",
    "src/modules/rh/actions-paie.ts → src/lib/queries/budget",
    "src/modules/rh/actions-paie.ts → src/lib/refs",
    "src/modules/rh/actions.ts → src/lib/expense-orders",
    // Les droits délégués d'un absent restent au SOCLE DES DROITS : `rbac.ts` les lit (domains.ts, ARCH-01).
    // Cible = `src/lib/rbac/` quand `rbac.ts` sera découpé — alors ces lignes tombent d'elles-mêmes.
    "src/modules/rh/actions-interim.ts → src/lib/hr/stand-in",
    "src/modules/rh/actions-interim.ts → src/lib/hr/stand-in-resolve",
    "src/modules/rh/infra/conge-escalade.ts → src/lib/hr/stand-in-resolve",
    "src/modules/rh/infra/leave-core.ts → src/lib/hr/stand-in-resolve",
    "src/modules/rh/infra/requetes/hr.ts → src/lib/hr/stand-in-resolve",
    // L'organisation (départements, entités, source unique de l'organigramme) : cible = un module `organisation`.
    "src/modules/rh/actions-documents.ts → src/lib/company",
    "src/modules/rh/actions-interim.ts → src/lib/company",
    "src/modules/rh/actions-paie.ts → src/lib/company",
    "src/modules/rh/actions.ts → src/lib/company",
    "src/modules/rh/actions.ts → src/lib/org/source-unique",
    "src/modules/rh/domaine/leave-workflow.ts → src/lib/approval-chain",
    "src/modules/rh/infra/conge-escalade.ts → src/lib/departments",
    "src/modules/rh/infra/leave-core.ts → src/lib/departments",
    "src/modules/rh/infra/requetes/hr-pulse.ts → src/lib/company",
    "src/modules/rh/infra/requetes/hr.ts → src/lib/approval-chain",
    "src/modules/rh/infra/requetes/hr.ts → src/lib/departments",
    // Les services transverses : notifications, Drive chiffré, stockage, agenda, archives, références, PDF.
    // Ce sont des plateformes, pas des métiers : cible = `src/platform/` (rapport 08, §3.4).
    "src/modules/rh/actions-conges-discussion.ts → src/lib/notify",
    "src/modules/rh/actions-documents.ts → src/lib/calendar",
    "src/modules/rh/actions-documents.ts → src/lib/calendar-tz",
    "src/modules/rh/actions-documents.ts → src/lib/drive-storage",
    "src/modules/rh/actions-documents.ts → src/lib/notify",
    "src/modules/rh/actions-documents.ts → src/lib/references/registre",
    "src/modules/rh/actions-documents.ts → src/lib/references/registre-serveur",
    "src/modules/rh/actions-documents.ts → src/lib/storage",
    "src/modules/rh/actions-interim.ts → src/lib/notify",
    "src/modules/rh/actions-paie.ts → src/lib/artifact/adapters/docx/adapter",
    "src/modules/rh/actions-paie.ts → src/lib/drive-storage",
    "src/modules/rh/actions-paie.ts → src/lib/payslip/to-pdf",
    "src/modules/rh/actions-paie.ts → src/lib/storage",
    "src/modules/rh/actions.ts → src/lib/notify",
    "src/modules/rh/domaine/absences.ts → src/lib/calendar-tz",
    "src/modules/rh/ecrans/hr-meeting-controls.tsx → src/lib/calendar-tz",
    "src/modules/rh/infra/archive-demande-rh.ts → src/lib/archive",
    "src/modules/rh/infra/archive-demande-rh.ts → src/lib/calendar-tz",
    "src/modules/rh/infra/archive-demande-rh.ts → src/lib/drive-storage",
    "src/modules/rh/infra/attestation-travail-depot.ts → src/lib/drive-storage",
    "src/modules/rh/infra/attestation-travail-depot.ts → src/lib/notify",
    "src/modules/rh/infra/attestation-travail-depot.ts → src/lib/payslip/to-pdf",
    "src/modules/rh/infra/attestation-travail-depot.ts → src/lib/references/registre",
    "src/modules/rh/infra/attestation-travail-depot.ts → src/lib/references/registre-serveur",
    "src/modules/rh/infra/conge-escalade.ts → src/lib/notify",
    "src/modules/rh/infra/hr-drive-mirror.ts → src/lib/drive-storage",
    "src/modules/rh/infra/leave-core.ts → src/lib/notify",
    "src/modules/rh/infra/leave-core.ts → src/lib/storage",
    "src/modules/rh/infra/ordre-mission-depot.ts → src/lib/drive-storage",
    "src/modules/rh/infra/ordre-mission-depot.ts → src/lib/notify",
    "src/modules/rh/infra/ordre-mission-depot.ts → src/lib/payslip/to-pdf",
    "src/modules/rh/infra/ordre-mission-depot.ts → src/lib/references/registre",
    "src/modules/rh/infra/ordre-mission-depot.ts → src/lib/references/registre-serveur",
    // La lecture des pièces par l'IA (contrat de travail, attestation) : cible = `@/modules/pieces/api`.
    "src/modules/rh/actions.ts → src/lib/ai",
    "src/modules/rh/actions.ts → src/lib/ia/cle-manquante",
    "src/modules/rh/actions.ts → src/lib/regulatory/intelligence/ocr/ocr-engine",
    "src/modules/rh/infra/attestation-travail-luna.ts → src/lib/ai-settings",
    "src/modules/rh/infra/attestation-travail-luna.ts → src/lib/comms/untrusted",
    "src/modules/rh/infra/attestation-travail-luna.ts → src/lib/openai-luna",
    "src/modules/rh/infra/attestation-travail-luna.ts → src/lib/pieces-lues/lecture-fichier",
    "src/modules/rh/infra/attestation-travail-luna.ts → src/lib/pieces-lues/moteur-luna",
    "src/modules/rh/infra/attestation-travail-luna.ts → src/lib/regulatory/intelligence/extract/texte-ou-ocr",
    // L'ordre de mission suit la mission d'équipe (Ad & Pro, autre session) : cible = `@/modules/adpro/api`.
    "src/modules/rh/actions-documents.ts → src/lib/missions-equipe/etat",
    "src/modules/rh/actions-documents.ts → src/lib/missions-equipe/serveur",
    "src/modules/rh/infra/ordre-mission-depot.ts → src/lib/missions-equipe/etat",
    "src/modules/rh/infra/ordre-mission-depot.ts → src/lib/missions-equipe/serveur",
    // Les gardes transverses : visibilité des listes, accès par fiche, garde des comptes, règles d'annulation.
    "src/modules/rh/actions-conges-discussion.ts → src/lib/entity-access",
    "src/modules/rh/actions-documents.ts → src/lib/annulations/regles",
    "src/modules/rh/actions-documents.ts → src/lib/queries/visibilite-listes",
    "src/modules/rh/infra/depart.ts → src/lib/admin/garde-comptes",
    "src/modules/rh/infra/requetes/hr.ts → src/lib/queries/visibilite-listes",
  ],
};

/** Le socle : ce qu'un module a le droit de lire sans que ce soit une dette. */
const SOCLE = [
  "src/lib/prisma", "src/lib/session", "src/lib/rbac", "src/lib/utils", "src/lib/labels", "src/lib/audit",
  "src/lib/settings", "src/lib/journal", "src/lib/annuaires/", "src/lib/chemins/", "src/components/ui/", "src/components/shared/",
  "src/platform/imports",
];
/** Les actions serveur de `src/lib/actions/` : un écran de module peut les appeler (Next les remplace par un appel distant). */
const ACTIONS = "src/lib/actions/";
/** Ce qu'un `domaine/` ne peut pas importer en VALEUR. */
const INTERDITS_DOMAINE = /^(@prisma\/client|next(\/|$)|react(\/|$)|react-dom|node:|fs$|path$|crypto$|xlsx$)/;
/** Les fichiers permis à la racine d'un module (hors tests et README). */
const PORTE = /^(api|api-[a-z-]+|partage|actions|actions-[a-z-]+)$/;
const DOSSIERS = new Set(["domaine", "infra", "ecrans"]);

const RACINE = process.cwd();
function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules") walk(p, out); }
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(path.relative(RACINE, p).split(path.sep).join("/"));
  }
  return out;
}

const moduleDe = (f: string): string | null => f.match(/^src\/modules\/([^/]+)\//)?.[1] ?? null;
/** `domaine`, `infra`, `ecrans`, ou le nom d'une porte (`api`, `partage`…) pour un fichier à la racine. */
const partieDe = (f: string): string => f.split("/")[3]?.replace(/\.tsx?$/, "") ?? "";

interface Arete { from: string; spec: string; to: string | null; typeSeul: boolean }
const aretes: Arete[] = walk("src").concat(walk("scripts")).flatMap((from) =>
  dependances(fs.readFileSync(from, "utf8")).map(({ spec, typeSeul }) => ({ from, spec, to: cibleInterne(spec, from), typeSeul })));

const modules = fs.existsSync("src/modules")
  ? fs.readdirSync("src/modules", { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : [];

/** Les arêtes module → module mesurées, `a → b`. */
const aretesModules = [...new Set(aretes.flatMap(({ from, to }) => {
  const a = moduleDe(from);
  const b = to ? moduleDe(`${to}/`) : null;
  return a && b && a !== b ? [`${a} → ${b}`] : [];
}))].sort();

describe("modules — la structure de chaque module", () => {
  it("chaque module a sa porte `api.ts` et son `README.md`", () => {
    for (const m of modules) {
      expect(fs.existsSync(`src/modules/${m}/api.ts`), `src/modules/${m}/api.ts`).toBe(true);
      expect(fs.existsSync(`src/modules/${m}/README.md`), `src/modules/${m}/README.md`).toBe(true);
    }
  });

  it("à la racine d'un module, seulement des portes ; dessous, seulement domaine/, infra/, ecrans/", () => {
    const intrus: string[] = [];
    for (const m of modules) {
      for (const e of fs.readdirSync(`src/modules/${m}`, { withFileTypes: true })) {
        if (e.isDirectory()) { if (!DOSSIERS.has(e.name)) intrus.push(`src/modules/${m}/${e.name}/`); continue; }
        if (e.name === "README.md" || /\.test\.tsx?$/.test(e.name)) continue;
        if (!PORTE.test(e.name.replace(/\.tsx?$/, ""))) intrus.push(`src/modules/${m}/${e.name}`);
      }
    }
    expect(intrus, "une porte s'appelle api.ts, api-<facette>.ts, partage.ts, actions.ts ou actions-<cas>.ts ; le reste va dans domaine/, infra/ ou ecrans/").toEqual([]);
  });

  it("chaque module figure dans la carte (`carte.ts`), et la carte ne nomme que des modules qui existent", () => {
    expect([...modules].sort()).toEqual(Object.keys(CARTE).sort());
  });

  it("un module ne reste pas à moitié déménagé dans `src/lib/`", () => {
    for (const m of modules) expect(fs.existsSync(`src/lib/${m}`), `src/lib/${m} existe encore`).toBe(false);
  });
});

describe("modules — les frontières tiennent", () => {
  it("1 · hors du module, on n'entre que par une porte (ou un écran, depuis une page)", () => {
    const fautes = aretes.filter(({ from, to }) => {
      const m = to && moduleDe(`${to}/`);
      if (!m || moduleDe(from) === m) return false;
      const partie = partieDe(`${to}.ts`);
      if (PORTE.test(partie)) return false;
      if (partie === "ecrans" && from.startsWith("src/app/")) return false;
      return true;
    });
    expect(fautes.map((a) => `${a.from} ⇒ ${a.spec}`), "import profond dans un module : passer par sa porte (api.ts, partage.ts…)").toEqual([]);
  });

  it("2 · `domaine/` est pur", () => {
    const fautes = aretes.filter(({ from, spec, to, typeSeul }) => {
      if (!moduleDe(from) || partieDe(from) !== "domaine") return false;
      if (INTERDITS_DOMAINE.test(spec)) return !(typeSeul && spec === "@prisma/client");
      if (to === "src/lib/prisma") return true;
      return !!to && moduleDe(`${to}/`) === moduleDe(from) && partieDe(`${to}.ts`) !== "domaine";
    });
    expect(fautes.map((a) => `${a.from} ⇒ ${a.spec}`)).toEqual([]);
  });

  it("2 · `partage.ts` ne réexporte que `domaine/` (la porte pure le reste)", () => {
    const fautes = aretes.filter(({ from, to }) => moduleDe(from) && partieDe(from) === "partage"
      && !(to && moduleDe(`${to}/`) === moduleDe(from) && partieDe(`${to}.ts`) === "domaine"));
    expect(fautes.map((a) => `${a.from} ⇒ ${a.spec}`)).toEqual([]);
  });

  it("3 · un `domaine/` ne lit un autre module que par sa porte pure", () => {
    const fautes = aretes.filter(({ from, to }) => {
      const m = to && moduleDe(`${to}/`);
      return !!m && moduleDe(from) !== null && m !== moduleDe(from) && partieDe(from) === "domaine" && partieDe(`${to}.ts`) !== "partage";
    });
    expect(fautes.map((a) => `${a.from} ⇒ ${a.spec}`)).toEqual([]);
  });

  it("3 · chaque lien entre modules est déclaré dans `carte.ts`", () => {
    const declarees = new Set(Object.entries(CARTE).flatMap(([a, bs]) => bs.map((b) => `${a} → ${b}`)));
    expect(aretesModules.filter((a) => !declarees.has(a)), "un lien entre modules s'ajoute d'abord à src/modules/carte.ts (et se justifie en revue)").toEqual([]);
  });

  it("3 · aucune permission morte dans la carte (un lien déclaré est un lien utilisé)", () => {
    const mesurees = new Set(aretesModules);
    const mortes = Object.entries(CARTE).flatMap(([a, bs]) => bs.map((b) => `${a} → ${b}`)).filter((x) => !mesurees.has(x));
    expect(mortes, "retirer de carte.ts le lien que plus personne n'utilise").toEqual([]);
  });

  it("3 · la carte est sans cycle", () => {
    const etat = new Map<string, "encours" | "fini">();
    const cycles: string[] = [];
    const visiter = (m: string, chemin: string[]) => {
      if (etat.get(m) === "fini") return;
      if (etat.get(m) === "encours") { cycles.push([...chemin, m].join(" → ")); return; }
      etat.set(m, "encours");
      for (const d of (CARTE as Record<string, readonly string[]>)[m] ?? []) visiter(d, [...chemin, m]);
      etat.set(m, "fini");
    };
    for (const m of Object.keys(CARTE)) visiter(m, []);
    expect(cycles).toEqual([]);
  });

  it("3 · le socle métier ne lit que le socle métier", () => {
    const socle = new Set<string>(SOCLE_METIER);
    const fautes = SOCLE_METIER.flatMap((m) => ((CARTE as Record<string, readonly string[]>)[m] ?? []).filter((d) => !socle.has(d)).map((d) => `${m} → ${d}`));
    expect(fautes).toEqual([]);
  });

  it("4 · le socle n'importe aucun module", () => {
    const fautes = aretes.filter(({ from, to }) => !moduleDe(from) && SOCLE.some((s) => from === `${s}.ts` || from.startsWith(s))
      && !!to && !!moduleDe(`${to}/`));
    expect(fautes.map((a) => `${a.from} ⇒ ${a.spec}`)).toEqual([]);
  });

  it("5 · personne n'importe un ancien chemin (l'adresse de réexpédition est pour les autres branches)", () => {
    const parAncien = new Map(demenagements().map((d) => [d.ancienChemin, d]));
    const fautes = aretes.filter(({ to }) => !!to && parAncien.has(to))
      .map(({ from, spec, to }) => `${from} ⇒ ${spec} — écrire : ${porteDe(parAncien.get(to!)!.nouveauChemin)}`);
    expect(fautes, "ce fichier a déménagé dans un module : importer la porte du module").toEqual([]);
  });

  it("5 · chaque adresse de réexpédition mène à un fichier qui existe", () => {
    const perdues = demenagements().filter((d) => ![".ts", ".tsx", "/index.ts"].some((e) => fs.existsSync(`${d.nouveauChemin}${e}`)));
    expect(perdues.map((d) => `${d.ancien} → ${d.nouveauChemin}`)).toEqual([]);
  });

  it("la dette héritée vers `src/lib/` ne grossit pas (et la liste reste exacte)", () => {
    for (const m of modules) {
      const mesuree = aretes
        .filter(({ from, to }) => moduleDe(from) === m && !!to && to.startsWith("src/lib/")
          && !to.startsWith(ACTIONS) && !SOCLE.some((s) => to === s || to.startsWith(s)))
        .map(({ from, to }) => `${from} → ${to}`);
      const connue = DETTE_HERITEE[m] ?? [];
      expect([...new Set(mesuree)].sort(), `dette héritée du module ${m} — une entrée neuve est un couplage ajouté ; une entrée disparue se RETIRE de DETTE_HERITEE`).toEqual([...connue].sort());
    }
  });
});

/** La porte par laquelle on atteint désormais un fichier déménagé (pour le message d'erreur). */
function porteDe(nouveau: string): string {
  const m = moduleDe(`${nouveau}/`);
  if (!m) return `@/${nouveau.replace(/^src\//, "")}`;
  const partie = partieDe(`${nouveau}.ts`);
  if (partie === "domaine") return `@/modules/${m}/partage (ou /api côté serveur)`;
  if (PORTE.test(partie)) return `@/modules/${m}/${partie}`;
  return `@/modules/${m}/api (ou la porte api-*.ts qui l'exporte)`;
}
