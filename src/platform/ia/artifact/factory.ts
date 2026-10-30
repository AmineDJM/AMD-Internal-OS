/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA FABRIQUE DE DOCUMENTS, VUE D'ADAM — « fais-moi un devis Adventum pour la Pharmacie
 * Centrale », « émets les 25 bons de commande de la liste », « prépare le dossier du comité en
 * Excel, PowerPoint et Word ».
 *
 * ── UNE PIÈCE ÉMISE EST UNE PIÈCE DU REGISTRE LEGAL (§17) ───────────────────────────────
 *
 * Un devis, un bon de commande, une facture : la chaîne d'achat que Legal tient déjà (natures
 * QUOTE → PURCHASE_ORDER → INVOICE, `chainFromId`, règlement d'une facture). La fabrique n'y
 * ajoute pas un second registre : elle CRÉE la pièce là, avec son numéro, son montant, son
 * fichier dans le Drive, et range la spécification complète dans `custom.fabrique` — c'est ce
 * qui permet de la RÉVISER (un devis v2) et de reconnaître un doublon.
 *
 * ── LE NUMÉRO EST ATTRIBUÉ APRÈS TOUT CE QUI PEUT ÉCHOUER, ET AVEC LA PIÈCE ─────────────
 *
 * La composition est jouée à blanc (numéro « PROVISOIRE ») : règles, mise en page, relecture,
 * contrôle. Si quelque chose bloque, aucun numéro n'est consommé. Puis, dans UNE transaction :
 * le compteur avance et la pièce naît au registre (`etat: EN_COURS`). Le fichier s'écrit
 * ensuite ; si l'écriture échoue, la pièce numérotée reste visible au registre sans fichier, et
 * la même demande la RETROUVE par son empreinte et la termine au lieu de numéroter à nouveau.
 * Une numérotation de factures continue par construction, pas par discipline.
 *
 * ── MÊMES DROITS QUE L'ÉCRAN (§7) ───────────────────────────────────────────────────────
 *
 * `legalWriteAllowed` — la porte d'écriture du registre, celle du formulaire Legal et des
 * actions du vocabulaire « facture ». La société est celle de la personne (`canEditCompanyId`),
 * jamais une société qu'elle ne fait que voir. Le papier en-tête est celui de la bibliothèque
 * de cette société ; le profil documentaire, tenu par ceux qui tiennent la papeterie.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Découpé par responsabilité — voir le dossier `factory/`, dans l'ordre du circuit : `profil.ts`
 * (la société et son profil documentaire), `demande.ts` (la demande d'émission, sa composition, le
 * PDF), `numerotation.ts` (le numéro attribué, choisi ou modifié), `emission.ts` (le droit d'émettre,
 * la pièce amont, `emettreDocumentDrive`), `apercu.ts` (`previsualiserDocument`), `revision.ts`
 * (`reviserDocumentDrive` et ses aperçus), `dossier.ts` (le dossier à trois formats).
 */

export { resoudreSociete, manquesDIdentite, profilDocumentaire, definirProfilDocumentaire, type EchecFabrique, type ReglagesDocumentaires, type ProfilDocumentaire, type Habillage, type ModificationsProfil } from "./factory/profil";
export { coordonneesParDefaut, specDepuisDemandePourTest, type DemandeDocument, type MethodePdf, type DocumentEmis } from "./factory/demande";
export { estRevisionDeNumeroSeul, verifierNumeroDeLaPiece } from "./factory/numerotation";
export { emettreDocumentDrive, type OptionsEmission } from "./factory/emission";
export { previsualiserDocument, type ApercuDocument } from "./factory/apercu";
export { reviserDocumentDrive, apercuPourEcran, previsualiserRevision, type ModificationsDocument, type ApercuPiece } from "./factory/revision";
export { construireDossierDrive, type DossierEmis } from "./factory/dossier";
