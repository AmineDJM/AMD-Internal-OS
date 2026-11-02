/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE PORT DES CAPACITÉS — ce par quoi Adam atteint N'IMPORTE QUELLE action de l'ERP.
 *
 * ── POURQUOI CE FICHIER EXISTE, ET C'EST LE CLIQUET QUI L'A DIT ──────────────────────────
 *
 * La première version branchait l'op générique directement sur `@/lib/actions/*`.
 * `boundary.test.ts` a compté 433 franchissements pour un plafond de 428 et refusé — le même
 * refus qui avait déjà eu raison sur le catalogue de colonnes Regulatory (§118.72). Relever le
 * plafond aurait été une ligne ; ç'aurait aussi été admettre qu'Adam connaît le dossier
 * `actions/` de l'ERP, alors que TOUT le contrat de plateforme existe pour l'en empêcher.
 *
 * Le remède est celui que le message d'échec nomme : passer par le contrat de plateforme. Ce
 * module est ce contrat pour les capacités — la SEULE porte, et elle est étroite.
 *
 * ── CE QU'IL N'AJOUTE PAS ────────────────────────────────────────────────────────────────
 *
 * Aucune logique. Il RÉEXPORTE, et c'est voulu : y glisser une vérification de droits en ferait
 * une seconde vérité qui prendrait du retard sur l'action (§118.5), et c'est la version en
 * retard qui serait la faille. Les contrôles vivent là où ils doivent vivre — le refus
 * d'auto-escalade dans `generique.ts`, les droits dans l'action elle-même.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type { ContratAction, ChampAction, TypeChamp } from "@/lib/actions/contrat";
export { direContrat } from "@/lib/actions/contrat";
export { CONTRATS_ACTIONS, CONTRAT_PAR_ID } from "@/lib/actions/contrat.genere";
export {
  chercherCapacites, interdictionGenerique, validerEntree,
  type CapaciteTrouvee, type EntreeRefusee,
} from "@/lib/actions/generique";
export { executerAction, type ResultatGenerique } from "@/lib/actions/executer";
// LA RELECTURE APRÈS ÉCRITURE — « c'est fait » n'est pas une preuve (§104.16). Elle relit
// par le MÊME chemin que l'écran (`porteeEntite`), donc sous les droits de la personne.
export { relireApresEcriture, type Relecture } from "@/lib/cibles/relire";
export { direEmpreinteEcriture, empreinteEcriture, type EmpreinteEcriture } from "@/lib/cibles/modeles-touches";
// LA DÉSIGNATION AVANT L'ÉCRITURE — « Nivolex » là où l'action attend un `cuid`. Même porte :
// la recherche passe par `porteeEntite`, donc une personne ne peut pas désigner ce qu'elle ne
// voit pas, et un refus ne nomme jamais une ligne hors de son périmètre.
export {
  resoudreEntrees, champsDesignables,
  type EntreesResolues, type Substitution, type NonResolu,
} from "@/lib/cibles/resoudre-entrees";
// LA DÉSIGNATION LIBRE — « la convention Sanofi », « SP-2026-014 » — pour les ops qui ne
// passent pas par un contrat d'action et doivent désigner elles-mêmes une fiche. Même porte,
// même portée : `resoudreCible` compose `porteeEntite`, donc une fiche hors périmètre
// n'apparaît pas même comme candidate.
export { resoudreCible, direRefus, type Cible, type Resolution } from "@/lib/cibles/resoudre";
// LA PORTÉE DE LECTURE DES PIÈCES LEGAL (§118.148) — celle de l'écran, pas une copie. Une op qui
// DÉSIGNE une pièce par son titre la cherche sous cette portée : sinon elle confirmerait
// l'existence d'un document restreint — et son titre — à quelqu'un qui n'en est pas lecteur. Le
// cliquet de frontière a compté 430 pour 428 quand l'op l'importait du socle en direct.
export { legalReaderWhere } from "@/lib/lecteurs/legal";
// BRANCHER / DÉTACHER UNE PIÈCE LEGAL EXISTANTE sur une fiche Ad & Pro. Ces deux actions
// exigent DEUX droits (lire la pièce, modifier la fiche) et les vérifient elles-mêmes ; le
// port ne fait que les rendre atteignables sans qu'Adam connaisse `actions/` (§118.111).
export {
  rattacherLegalAFiche, detacherLegalDeFiche,
} from "@/modules/ad-pro/actions-rattacher-legal";
// LA FEUILLE DES ANNUAIRES (§118.133) — colorer des cellules, et reconnaître les colonnes des
// deux feuilles (praticiens, établissements). L'action revérifie les droits LIGNE PAR LIGNE ;
// les deux gardes de colonnes sont des listes pures. Le port les rend atteignables sans qu'Adam
// connaisse `actions/` ni `medical/` — le cliquet a compté 432 pour 428 quand l'op les importait
// en direct, et le remède est celui que son message nomme.
/**
 * LE CENTRE DE VALIDATION AD & PRO — le siège, la liste, la décision.
 *
 * `siegeAuCentreAdPro` est le prédicat qui dit QUI siège (Direction Générale, Super Admin) et
 * `REFUS_CENTRE_AD_PRO` la phrase que l'écran, l'action et l'op disent à l'identique : trois
 * formulations du même interdit donneraient trois compréhensions de ce qui s'est passé.
 *
 * Il passe par ICI et non en import direct depuis `@/lib/ad-pro/` : ce serait un franchissement
 * de frontière de plus, et le plafond est à marge ZÉRO (§118.114, §118.127f, §118.136). La liste
 * du centre est le MÊME lecteur que l'écran (§118.5) — une op qui chercherait les visas de son
 * côté finirait par ne pas voir les mêmes lignes.
 */
export { siegeAuCentreAdPro, REFUS_CENTRE_AD_PRO, type LigneCentre, type FormePorte } from "@/modules/ad-pro/partage";
export { demandesAuCentreAdPro } from "@/modules/ad-pro/api";
export { deciderVisaCentreAdPro } from "@/modules/ad-pro/actions-centre";
// LES DEUX SEUILS DU CENTRE (§118.149) — celui des demandes et celui des bons de commande. Leurs
// ops appellent l'action de l'ÉCRAN : même siège, même borne, et surtout le même RÉAIGUILLAGE des
// BC en vol — écrire la colonne à côté en ferait une seconde écriture qui l'oublierait (§118.5).
export { setAdProDgThreshold, setBcValidationThreshold } from "@/lib/actions/settings-actions";
// Les valeurs PAR DÉFAUT des réglages : une carte qui montre « avant → après » sur une plateforme
// neuve (sans ligne de réglages) les lit ici plutôt que de les recopier (§118.5).
export { DEFAULT_APP_SETTINGS } from "@/lib/settings";
// LE COFFRE (refonte V2-E) — le chemin d'ÉCRITURE seulement (copie chiffrée d'une colonne écrite) et le
// masque : Adam écrit une fiche sans en lire les données sensibles, et ne peut pas importer ce qui déchiffre.
export { doubleEcrireCoffre } from "@/modules/coffre/api";
export { masquerSensibles } from "@/modules/coffre/partage";

export { colorerCellulesAnnuaire } from "@/lib/actions/annuaire-couleurs-actions";
export { isAnnuaireField } from "@/lib/medical/directory-grid";
export { isEtablissementField } from "@/lib/medical/etablissements-grid";

// LE RÔLE QUI TRANCHE une demande Ad & Pro — lu par l'op qui désigne un référent de gamme.
// L'op lisait `rbac` et `workflow/origin` en direct : 430 franchissements pour un plafond de
// 428. Le prédicat vit au SOCLE (`personnes/referents-gamme`), le pont le porte (§118.114).
export { porteLeRoleQuiTranche } from "@/lib/personnes/referents-gamme";

// LA SECTION DISCUSSION d'une demande Ad & Pro — l'écrivain unique des sept natures. L'op le
// lisait en direct : 429 franchissements pour un plafond de 428, et le plafond ne se relève pas.
export { addAdProComment } from "@/modules/ad-pro/actions-discussion";
// Les DEUX natures de pièce qu'on fait établir par le secrétariat (devis, facture) : le
// vocabulaire est PUR et vit au socle, mais Adam n'a pas le droit d'importer `@/lib/ad-pro/`
// en direct — il passe par cette porte, comme pour le centre de validation ci-dessus.
export {
  PIECE_SECRETARIAT, NATURES_PIECE_SECRETARIAT, peutDemanderPiece, titrePiece,
  type NaturePieceSecretariat,
} from "@/modules/ad-pro/partage";

// LE PÔLE D'UN CONTRAT DE CONSULTING (§118.150) — Ad & Pro ou Ressources humaines. La règle est
// PURE et vit au socle (`lecteurs/consulting`) ; l'op qui transfère un contrat en lit le libellé
// et le pôle opposé, et Adam n'a pas le droit d'importer le socle métier en direct : il passe par
// cette porte, comme pour le centre de validation ci-dessus. La DÉSIGNATION du contrat, elle,
// passe par `resoudreCible` — la portée du registre borne les lignes aux pôles lisibles.
export { LIBELLE_POLE, poleDe, poleOppose, type PoleConsulting } from "@/lib/lecteurs/consulting";

// LA CLÔTURE D'UN SPONSORING (§118.151) — le BILAN, lu par l'op d'Adam avant de montrer sa carte :
// une carte qui propose une clôture que l'action refusera est un geste offert puis retiré
// (§118.83). La règle est PURE et vit dans `ad-pro/` ; Adam n'a pas le droit de l'importer en
// direct, il passe par cette porte, comme pour les pièces du secrétariat ci-dessus.
export { bilanCloture, type BilanCloture } from "@/modules/ad-pro/partage";
// LES POSTES TELS QUE LA CLÔTURE LES JUGE (§118.167) — nature et matériel réservé compris. L'op
// d'Adam les lisait avec sa propre requête ; trois lectures écrites à la main auraient oublié le
// matériel chez l'une des trois, et la carte aurait proposé une clôture que l'action refuse.
export { postesPourCloture } from "@/modules/ad-pro/api";

// CE QU'UNE SUPPRESSION EMPORTERAIT (§118.162) — l'aperçu du lot : ce qui part avec l'élément, et
// ce qui l'interdit (règlement, signature, dépôt aux autorités, courrier inscrit). L'op d'Adam qui
// supprime un événement le lit AVANT de montrer sa carte, comme la fenêtre de l'écran : deux
// rédactions de « ce qui part avec » finiraient par dire deux choses (§118.5).
export { apercuSuppression, type ApercuSuppression } from "@/lib/admin-delete-registry";

// QUI PEUT SUPPRIMER UN RAPPORT TERRAIN (§118.212) — la règle de l'action, lue par l'op d'Adam
// AVANT de montrer sa carte : une carte qui propose une suppression que l'action refusera est un
// geste offert puis retiré (§118.83). Adam n'a pas le droit d'importer les lecteurs de l'ERP en
// direct : il passe par cette porte.
export { peutSupprimerUnRapportTerrain } from "@/lib/queries/field-reports";
