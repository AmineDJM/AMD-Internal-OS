"use server";

/**
 * LE BOUTON DES FINANCES — composer une FACTURE ou un BON DE COMMANDE (ou un devis) au format de
 * la société, sur son papier en-tête, en Word et en PDF, depuis l'écran du registre.
 *
 * ── CE QUE CE FICHIER N'EST PAS ────────────────────────────────────────────────────────────
 *
 * Ce n'est pas un second générateur de pièces. La fabrique (`platform/in-process/artifact/
 * factory.ts`) existait pour Adam : numéro atomique, identité légale, papier en-tête, montants
 * calculés par le code, pièce inscrite au registre Legal, fichiers dans le Drive. Ces actions ne
 * font que TRADUIRE un formulaire en demande de fabrique (§118.5 : deux chemins d'émission
 * finiraient par diverger sur un arrondi ou un numéro), et l'APERÇU est la même composition
 * jouée à blanc. La porte est celle de la fabrique — `legalWriteAllowed`, la même que l'écran et
 * qu'Adam : les Finances émettent factures et bons de commande, Legal émet tout.
 *
 * ── POURQUOI DES LISTES DE CHAMPS ET PAS UN JSON ────────────────────────────────────────────
 *
 * Les lignes arrivent en LISTES parallèles (`ligneDesignation[]`, `ligneQuantite[]`…) : c'est ce
 * que le contrat d'action sait DÉCRIRE (§118.73 — `getAll("…")` est une liste nommée), donc ce
 * que la carte de confirmation d'Adam et le chemin générique savent lire. Un JSON opaque dans un
 * champ « spec » serait décrit comme un texte, et personne ne saurait quoi y mettre.
 */

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { fdStr, type ActionResult } from "@/lib/actions/types";
import { MODES_PAIEMENT, TYPES_DOCUMENT, type ModePaiement, type TypeDocumentCommercial } from "@/lib/artifact/factory/commercial";
import {
  apercuPourEcran, definirProfilDocumentaire, emettreDocumentDrive, previsualiserDocument, previsualiserRevision, reviserDocumentDrive,
  type ApercuDocument, type ApercuPiece, type DemandeDocument, type EchecFabrique, type MethodePdf, type ModificationsDocument,
} from "@/platform/in-process/artifact/factory";
import type { CoordonneesEmetteur } from "@/lib/artifact/factory/commercial";
import { factureACrediter } from "@/lib/legal/aval";
import { montantsDesAvoirsActifs } from "@/lib/lecteurs/avoirs-actifs";
import { netDeLaFacture } from "@/lib/lecteurs/avoir";
import { accesAuxPiecesLegalDetaille } from "@/lib/entity-access";
import { lienFichierEmis } from "@/lib/legal/fichiers-emis";
import { saisieEffective } from "@/lib/references/registre";
import { delegationDuBcDeLaDemande } from "@/lib/secretariat/delegation-bc";

/** « 2 500 000,00 » (espaces, insécables, virgule) → 2500000 ; vide ou illisible → null. */
function nombre(v: string | null | undefined): number | null {
  const s = (v ?? "").replace(/[\s  ]/g, "").replace(",", ".");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Un pourcentage saisi (« 19 », « 2,5 ») → une fraction (0,19) ; vide → null. */
const fraction = (v: string | null | undefined): number | null => {
  const n = nombre(v);
  return n === null ? null : n / 100;
};

const texte = (formData: FormData, cle: string): string | null => {
  const v = fdStr(formData, cle);
  return v && v.trim() ? v.trim() : null;
};

/**
 * LES LIGNES : des listes parallèles, une entrée par ligne saisie, dans l'ordre de l'écran — une seule
 * lecture pour la composition et pour la révision d'une pièce émise (§118.194) : deux lecteurs de la même
 * saisie finiraient par arrondir ou couper différemment.
 */
function lireLignes(formData: FormData): DemandeDocument["lignes"] {
  const designations = formData.getAll("ligneDesignation").map(String);
  const details = formData.getAll("ligneDetails").map(String);
  const quantites = formData.getAll("ligneQuantite").map(String);
  const prix = formData.getAll("lignePrix").map(String);
  const remises = formData.getAll("ligneRemise").map(String);
  const tvas = formData.getAll("ligneTva").map(String);
  const sections = formData.getAll("ligneSection").map(String);
  // L'UNITÉ (« u », « boîte ») : le composeur la saisit ; un formulaire qui ne l'envoie pas ne l'efface pas.
  const unites = formData.has("ligneUnite") ? formData.getAll("ligneUnite").map(String) : null;
  const lignes: DemandeDocument["lignes"] = designations.map((designation, i) => {
    const section = sections[i] === "1" || sections[i] === "true";
    return {
      designation: designation.trim(),
      section,
      details: (details[i] ?? "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean),
      // Une ligne chiffrée dont la quantité ou le prix est illisible arrive à NaN : la fabrique la
      // REFUSE en nommant la ligne, au lieu qu'un zéro silencieux fasse une pièce fausse.
      quantite: section ? 0 : (nombre(quantites[i]) ?? Number.NaN),
      prixUnitaire: section ? 0 : (nombre(prix[i]) ?? Number.NaN),
      remise: fraction(remises[i]),
      tva: fraction(tvas[i]),
      ...(unites ? { unite: section ? null : (unites[i] ?? "").trim() || null } : {}),
    };
  });
  return lignes;
}

/** Ce que la personne CHOISIT pour sa pièce au-delà de la saisie courante : coordonnées imprimées, signataire, mentions. */
interface ChoixDeLaPiece {
  coordonnees: CoordonneesEmetteur | null | undefined;
  signataire: { nom: string; qualite: string | null } | null | undefined;
  mentions: string[] | undefined;
}

/**
 * LES CHOIX DE LA PIÈCE — dont LES COORDONNÉES DE L'ÉMETTEUR choisies pour la pièce (Direction, 10/2026 — « l'e-mail dépend de la société, il doit
 * pouvoir se modifier »). `emetteurPersonnalise=1` : les trois champs gouvernent, un champ vide n'imprime rien.
 * `emetteurPersonnalise=0` : retour à la carte de la société (`null`). Clé absente : rien n'est dit (`undefined`) — une
 * révision garde alors le choix fait à l'émission.
 */
function lireChoixDeLaPiece(formData: FormData): ChoixDeLaPiece {
  const drapeau = fdStr(formData, "emetteurPersonnalise");
  const coordonnees: ChoixDeLaPiece["coordonnees"] = drapeau === null
    ? undefined
    : drapeau !== "1"
      ? null
      : { adresse: texte(formData, "emetteurAdresse"), telephone: texte(formData, "emetteurTelephone"), email: texte(formData, "emetteurEmail") };
  // LE SIGNATAIRE : `signatairePersonnalise=1` le fixe (nom vide = aucun) ; absent, celui de la marque (émission) ou de la pièce (révision).
  const drapeauSignataire = fdStr(formData, "signatairePersonnalise");
  const signataire: ChoixDeLaPiece["signataire"] = drapeauSignataire === "1"
    ? (texte(formData, "signataireNom") ? { nom: texte(formData, "signataireNom") ?? "", qualite: texte(formData, "signataireQualite") } : null)
    : undefined;
  // LES MENTIONS de la pièce : une par ligne ; présentes et vides, il n'y en a plus.
  const mentions: ChoixDeLaPiece["mentions"] = formData.has("mentions")
    ? (fdStr(formData, "mentions") ?? "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean)
    : undefined;
  return { coordonnees, signataire, mentions };
}

/**
 * La DEMANDE de fabrique, lue depuis le formulaire — une seule lecture, pour l'aperçu et l'émission.
 * Les lignes arrivent DÉJÀ lues : l'appelant appelle `lireLignes` lui-même, parce que la dérivation des
 * contrats ne suit qu'un niveau de délégation (§118.87c) — lues ici, à deux niveaux, elles disparaissaient
 * de ce que l'action déclare recevoir. Et il les lit dans une instruction À PART : un appel imbriqué
 * (`lireDemande(formData, lireLignes(formData))`) n'est pas reconnu comme une délégation — mesuré, ce
 * sont alors TOUS les autres champs de la demande qui disparaissaient du contrat. Les coordonnées de l'émetteur
 * (`lireChoixDeLaPiece`) arrivent de même, lues par l'appelant : ce sont des champs du formulaire comme les autres.
 */
function lireDemande(
  formData: FormData, lignes: DemandeDocument["lignes"], choix: ChoixDeLaPiece,
): { ok: true; demande: DemandeDocument } | { ok: false; error: string } {
  const type = (fdStr(formData, "type") ?? "") as TypeDocumentCommercial;
  if (!TYPES_DOCUMENT.includes(type)) return { ok: false, error: "Nature de pièce inconnue : facture, bon de commande ou devis." };
  const mode = fdStr(formData, "modePaiement");
  const modePaiement = mode && (MODES_PAIEMENT as readonly string[]).includes(mode) ? (mode as ModePaiement) : null;

  const libellesTaxes = formData.getAll("taxeLibelle").map(String);
  const tauxTaxes = formData.getAll("taxeTaux").map(String);
  const taxes = libellesTaxes
    .map((libelle, i) => ({ libelle: libelle.trim(), taux: fraction(tauxTaxes[i]) ?? Number.NaN }))
    .filter((t) => t.libelle || Number.isFinite(t.taux));

  const contactNom = texte(formData, "contactNom");
  const contactTelephone = texte(formData, "contactTelephone");
  const livraisonAdresse = texte(formData, "livraisonAdresse");
  const livraisonDelai = texte(formData, "livraisonDelai");
  const livraisonDate = texte(formData, "livraisonDate");
  const validite = nombre(fdStr(formData, "validiteJours"));

  return {
    ok: true,
    demande: {
      type,
      societe: texte(formData, "societe"),
      tiers: {
        nom: texte(formData, "tiersNom") ?? "",
        adresse: texte(formData, "tiersAdresse"),
        telephone: texte(formData, "tiersTelephone"),
        email: texte(formData, "tiersEmail"),
        rc: texte(formData, "tiersRc"),
        nif: texte(formData, "tiersNif"),
        ai: texte(formData, "tiersAi"),
        nis: texte(formData, "tiersNis"),
      },
      numeroClient: texte(formData, "numeroClient"),
      lignes,
      date: texte(formData, "date"),
      echeance: type === "FACTURE" ? texte(formData, "echeance") : null,
      validiteJours: type === "DEVIS" && validite !== null && Number.isInteger(validite) ? validite : null,
      tvaDefaut: fraction(fdStr(formData, "tvaDefaut")),
      remiseGlobale: fraction(fdStr(formData, "remiseGlobale")),
      modePaiement,
      conditionsPaiement: texte(formData, "conditionsPaiement"),
      objet: texte(formData, "objet"),
      referenceAmont: texte(formData, "referenceAmont"),
      referenceAmontDate: texte(formData, "referenceAmontDate"),
      contact: contactNom || contactTelephone ? { nom: contactNom, telephone: contactTelephone } : null,
      // Les coordonnées de l'émetteur que CETTE pièce imprime — absentes, celles de la société émettrice.
      coordonneesEmetteur: choix.coordonnees === undefined ? null : choix.coordonnees,
      ...(choix.signataire !== undefined ? { signataire: choix.signataire } : {}),
      mentions: choix.mentions ?? null,
      taxes: taxes.length ? taxes : null,
      livraison: livraisonAdresse || livraisonDelai || livraisonDate ? { adresse: livraisonAdresse, delai: livraisonDelai, ...(livraisonDate ? { date: livraisonDate } : {}) } : null,
      notes: texte(formData, "notes"),
      letterheadId: texte(formData, "letterheadId"),
      chainFromId: texte(formData, "chainFromId"),
      forcerDoublon: fdStr(formData, "forcerDoublon") === "1",
      // Composé depuis « Demandes de validations » : le BC naît en pré-validation, aucun centre ne le voit encore.
      prevalidation: fdStr(formData, "prevalidation") === "1",
      // LA RÉFÉRENCE CHOISIE (registre commun NNN/DG/AAAA) : le champ est prérempli avec le numéro prévu ; laissé tel quel, rien
      // n'est figé (le prochain libre est attribué) ; modifié, la fabrique le vérifie sous verrou.
      numeroChoisi: saisieEffective(fdStr(formData, "numeroChoisi"), fdStr(formData, "numeroSuggere")),
      // Les pièces composées depuis l'écran se rangent par nature : « Factures émises », etc.
      dossier: type === "FACTURE" ? "Factures émises" : type === "BON_DE_COMMANDE" ? "Bons de commande émis" : "Devis émis",
    },
  };
}

/** Ce que l'écran du composeur reçoit de l'aperçu — défini avec la fabrique (`apercuPourEcran`), une seule forme pour deux actions. */
export type { ApercuPiece } from "@/platform/in-process/artifact/factory";

/**
 * LA DÉLÉGATION D'UNE RÉVISION — le BC d'une demande au secrétariat se révise depuis la demande, par son demandeur ou qui la
 * gère, sans droit Legal (Direction, 14/10/2026 ; `secretariat/delegation-bc.ts`). Ailleurs : `{}`, les droits Legal s'appliquent.
 */
async function emissionDeLaPiece(user: Awaited<ReturnType<typeof requireUser>>, legalDocumentId: string): Promise<{ delegation?: string }> {
  const delegation = await delegationDuBcDeLaDemande(user, legalDocumentId);
  return delegation ? { delegation } : {};
}

/**
 * L'APERÇU — la même composition que l'émission, à blanc : totaux, somme en lettres, numéro
 * prévu, papier en-tête, et ce qui bloquerait. Rien n'est écrit, aucun numéro n'est consommé.
 */
export async function previsualiserPieceCommerciale(_prev: ApercuPiece | { ok: false; error: string } | undefined, formData: FormData): Promise<ApercuPiece | { ok: false; error: string }> {
  const user = await requireUser();
  const lignes = lireLignes(formData);
  // LA RÉVISION D'UNE PIÈCE ÉMISE (« Modifier de A à Z » depuis sa fiche) : la même composition que `reviserPieceCommerciale`,
  // à blanc — nature, société et numéro sont ceux de la pièce, pas ceux du formulaire.
  const revisionDe = fdStr(formData, "revisionDe");
  const choix = lireChoixDeLaPiece(formData);
  const lignesRevisees = formData.has("ligneDesignation") ? lignes : undefined;
  const modifications = lireModifications(formData, lignesRevisees, choix);
  const lu = lireDemande(formData, lignes, choix);
  const r: ApercuDocument | EchecFabrique = revisionDe
    ? await previsualiserRevision(user, { legalDocumentId: revisionDe, modifications }, await emissionDeLaPiece(user, revisionDe))
    : lu.ok ? await previsualiserDocument(user, lu.demande) : { ok: false, echec: "MISSING_INPUT", motif: lu.error };
  if (!r.ok) return { ok: false, error: r.motif };
  return apercuPourEcran(r, Boolean(revisionDe));
}

export type ApercuImpression = { ok: true; pdfBase64: string; pages: number; numeroProchain: string } | { ok: false; error: string };

/**
 * L'APERÇU AVANT IMPRESSION (Direction, 10/2026) — la pièce telle qu'elle sera imprimée, en PDF, AVANT de l'émettre :
 * la même composition que l'émission, rendue par le serveur à blanc. Elle porte le numéro PRÉVU (celui que la prochaine
 * émission recevra si personne n'émet entre-temps) ; rien n'est écrit, aucun numéro n'est consommé, aucun fichier ne
 * va au Drive. Refusée tant que la pièce l'est (règles, identité de l'émetteur) : on ne montre pas ce qu'on ne livrerait pas.
 */
export async function apercuAvantImpressionPiece(_prev: ApercuImpression | undefined, formData: FormData): Promise<ApercuImpression> {
  const user = await requireUser();
  const lignes = lireLignes(formData);
  // Une RÉVISION s'imprime sous SON numéro, par la même composition que la révision (voir `previsualiserPieceCommerciale`).
  const revisionDe = fdStr(formData, "revisionDe");
  const choix = lireChoixDeLaPiece(formData);
  const lignesRevisees = formData.has("ligneDesignation") ? lignes : undefined;
  const modifications = lireModifications(formData, lignesRevisees, choix);
  const lu = lireDemande(formData, lignes, choix);
  const r: ApercuDocument | EchecFabrique = revisionDe
    ? await previsualiserRevision(user, { legalDocumentId: revisionDe, modifications, avecPdf: true }, await emissionDeLaPiece(user, revisionDe))
    : lu.ok ? await previsualiserDocument(user, lu.demande, { avecPdf: true }) : { ok: false, echec: "MISSING_INPUT", motif: lu.error };
  if (!r.ok) return { ok: false, error: r.motif };
  if (r.bloquants.length > 0) return { ok: false, error: `L'aperçu n'est pas possible : ${r.bloquants.slice(0, 3).join(" ; ")}` };
  if (!r.pdf) return { ok: false, error: r.pdfErreur ?? "Le rendu de l'aperçu n'a pas pu être produit." };
  return { ok: true, pdfBase64: r.pdf.octets.toString("base64"), pages: r.pdf.pages, numeroProchain: r.numeroProchain };
}

export interface ResultatEmission extends ActionResult {
  reference?: string;
  legalDocumentId?: string;
  /**
   * OÙ VOIR LA PIÈCE (§118.209) — sa fiche `/legal/<id>?emis=1`, quand elle s'ouvre à la personne : l'écran y mène
   * tout de suite, et la fiche montre la pièce et son PDF. `null` : la fiche lui est fermée (une pièce n'est
   * pas toujours lisible par qui l'a émise) — le PDF, lui, s'ouvre sous la porte de la pièce (`lienPdf`).
   */
  lien?: string | null;
  lienPdf?: string;
  docxNodeId?: string;
  docxNom?: string;
  pdfNodeId?: string | null;
  pdfNom?: string | null;
  pdfMethode?: MethodePdf | null;
  totalTtc?: number;
  dejaEmis?: boolean;
  surPapierEnTete?: boolean;
  avertissements?: string[];
}

/**
 * ÉMET la pièce : numéro du compteur de la société (au motif de son profil), Word sur le papier
 * en-tête, PDF (éditeur Office ou rendu du serveur), pièce au registre Legal — par la fabrique,
 * sous les droits de la personne.
 */
export async function emettrePieceCommerciale(_prev: ResultatEmission | undefined, formData: FormData): Promise<ResultatEmission> {
  const user = await requireUser();
  const lignes = lireLignes(formData);
  const choix = lireChoixDeLaPiece(formData);
  const lu = lireDemande(formData, lignes, choix);
  if (!lu.ok) return { ok: false, error: lu.error };
  const r = await emettreDocumentDrive(user, lu.demande);
  if (!r.ok) return { ok: false, error: r.motif + (r.bloquants?.length ? ` — ${r.bloquants.slice(0, 3).join(" ; ")}` : "") };
  revalidatePath("/legal");
  revalidatePath(`/legal/${r.legalDocumentId}`);
  revalidatePath("/finances");
  const libelle = r.type === "FACTURE" ? "Facture" : r.type === "DEVIS" ? "Devis" : "Bon de commande";
  // La fiche s'ouvre-t-elle à la personne ? La MÊME porte que la fiche : y mener quelqu'un qui n'y entre pas serait un
  // geste offert puis retiré (§118.83).
  const acces = await accesAuxPiecesLegalDetaille(user, [r.legalDocumentId], ["VIEW"]);
  const ficheOuverte = (acces.droits.get("VIEW")?.has(r.legalDocumentId) ?? false) && !acces.horsFiche.has(r.legalDocumentId);
  return {
    ok: true, id: r.legalDocumentId, reference: r.reference, legalDocumentId: r.legalDocumentId,
    lien: ficheOuverte ? `/legal/${r.legalDocumentId}?emis=1` : null, lienPdf: lienFichierEmis(r.legalDocumentId, "pdf"),
    docxNodeId: r.docx.nodeId, docxNom: r.docx.nom, pdfNodeId: r.pdf?.nodeId ?? null, pdfNom: r.pdf?.nom ?? null, pdfMethode: r.pdf?.methode ?? null,
    totalTtc: r.totaux.totalTtc, dejaEmis: r.dejaEmis, surPapierEnTete: r.surPapierEnTete, avertissements: r.avertissements,
    message: (r.dejaEmis
      ? `${libelle} ${r.reference} existait déjà pour ${r.tiers} : rendu tel quel, rien de nouveau n'a été émis.`
      : `${libelle} ${r.reference} émis${r.type === "FACTURE" ? "e" : ""} au nom de ${r.societe.nom} pour ${r.tiers}.`)
      // Un BC émis attend son centre de validation (§118.148) : l'écran le dit, dans la même phrase.
      + (r.reserveBonDeCommande ? ` ${r.reserveBonDeCommande}` : ""),
  };
}

/**
 * CE QUE LE FORMULAIRE DE RÉVISION PORTE — et RIEN d'autre (§118.152) : une clé absente garde la valeur de la pièce, une clé
 * présente et vide l'efface. Le composeur en mode révision envoie tout (« modifiable de A à Z ») ; l'ancien formulaire
 * réduit (poste Ad & Pro) n'envoie que ses champs, et le reste de la pièce ne bouge pas. Les lignes arrivent DÉJÀ lues, par
 * l'appelant, dans une instruction à part (voir `lireDemande`, §118.87c).
 */
function lireModifications(
  formData: FormData, lignes: DemandeDocument["lignes"] | undefined, choix: ChoixDeLaPiece,
): ModificationsDocument {
  const m: ModificationsDocument = {};
  if (lignes) m.lignes = lignes;
  if (formData.has("tiersNom")) {
    m.tiers = {
      nom: texte(formData, "tiersNom") ?? "",
      ...(formData.has("tiersAdresse") ? { adresse: texte(formData, "tiersAdresse") } : {}),
      ...(formData.has("tiersTelephone") ? { telephone: texte(formData, "tiersTelephone") } : {}),
      ...(formData.has("tiersEmail") ? { email: texte(formData, "tiersEmail") } : {}),
      ...(formData.has("tiersRc") ? { rc: texte(formData, "tiersRc") } : {}),
      ...(formData.has("tiersNif") ? { nif: texte(formData, "tiersNif") } : {}),
      ...(formData.has("tiersAi") ? { ai: texte(formData, "tiersAi") } : {}),
      ...(formData.has("tiersNis") ? { nis: texte(formData, "tiersNis") } : {}),
    };
  }
  if (formData.has("date")) m.date = texte(formData, "date");
  if (formData.has("echeance")) m.echeance = texte(formData, "echeance");
  if (formData.has("objet")) m.objet = texte(formData, "objet");
  if (formData.has("notes")) m.notes = texte(formData, "notes");
  if (formData.has("referenceAmont")) m.referenceAmont = texte(formData, "referenceAmont");
  if (formData.has("referenceAmontDate")) m.referenceAmontDate = texte(formData, "referenceAmontDate");
  if (formData.has("numeroClient")) m.numeroClient = texte(formData, "numeroClient");
  if (formData.has("conditionsPaiement")) m.conditionsPaiement = texte(formData, "conditionsPaiement");
  if (formData.has("modePaiement")) {
    const mode = fdStr(formData, "modePaiement");
    m.modePaiement = mode && (MODES_PAIEMENT as readonly string[]).includes(mode) ? (mode as ModePaiement) : null;
  }
  if (formData.has("tvaDefaut")) m.tvaDefaut = fraction(fdStr(formData, "tvaDefaut"));
  if (formData.has("remiseGlobale")) m.remiseGlobale = fraction(fdStr(formData, "remiseGlobale"));
  if (formData.has("taxeLibelle")) {
    const libelles = formData.getAll("taxeLibelle").map(String);
    const taux = formData.getAll("taxeTaux").map(String);
    const taxes = libelles
      .map((libelle, i) => ({ libelle: libelle.trim(), taux: fraction(taux[i]) ?? Number.NaN }))
      .filter((t) => t.libelle || Number.isFinite(t.taux));
    m.taxes = taxes.length ? taxes : null;
  }
  if (formData.has("validiteJours")) {
    const v = nombre(fdStr(formData, "validiteJours"));
    m.validiteJours = v !== null && Number.isInteger(v) ? v : null;
  }
  if (formData.has("livraisonAdresse") || formData.has("livraisonDelai") || formData.has("livraisonDate")) {
    m.livraison = {
      ...(formData.has("livraisonAdresse") ? { adresse: texte(formData, "livraisonAdresse") } : {}),
      ...(formData.has("livraisonDelai") ? { delai: texte(formData, "livraisonDelai") } : {}),
      ...(formData.has("livraisonDate") ? { date: texte(formData, "livraisonDate") } : {}),
    };
  }
  if (formData.has("contactNom") || formData.has("contactTelephone")) {
    m.contact = {
      ...(formData.has("contactNom") ? { nom: texte(formData, "contactNom") } : {}),
      ...(formData.has("contactTelephone") ? { telephone: texte(formData, "contactTelephone") } : {}),
    };
  }
  // Le papier en-tête : présent et vide = celui du profil de la société ; absent = celui de l'émission.
  if (formData.has("letterheadId")) m.letterheadId = texte(formData, "letterheadId");
  if (choix.coordonnees !== undefined) m.coordonneesEmetteur = choix.coordonnees;
  if (choix.signataire !== undefined) m.signataire = choix.signataire;
  if (choix.mentions !== undefined) m.mentions = choix.mentions;
  return m;
}

export interface ResultatRevision extends ActionResult {
  reference?: string;
  version?: number;
}

/**
 * RÉVISER UNE PIÈCE ÉMISE depuis sa fiche (§118.194 — audit 360°, R15) — un devis ou un bon de commande :
 * même numéro, nouvelle version du Word et du PDF, historique au registre, et la fiche suit le fichier
 * (montant, partie, échéance). La fabrique savait réviser ; seul le dossier promotionnel l'appelait, et la
 * fiche Legal n'offrait que le formulaire générique — qui changeait le montant sans toucher au fichier.
 *
 * Ce que le formulaire ne porte pas ne s'écrit pas (§118.152) ; la version que l'écran a montrée est exigée
 * (`versionVue`), et le motif l'est après tout ce qui refuserait la révision — c'est la fabrique qui tient
 * l'ordre, pour tous ses appelants. Une facture émise ne se révise pas : la fabrique le refuse et dit quoi faire.
 */
export async function reviserPieceCommerciale(_prev: ResultatRevision | undefined, formData: FormData): Promise<ResultatRevision> {
  const user = await requireUser();
  const legalDocumentId = fdStr(formData, "legalDocumentId");
  if (!legalDocumentId) return { ok: false, error: "Pièce introuvable." };
  const vue = nombre(fdStr(formData, "versionVue"));
  const lignes = lireLignes(formData);
  const choix = lireChoixDeLaPiece(formData);
  const lignesRevisees = formData.has("ligneDesignation") ? lignes : undefined;
  const modifications = lireModifications(formData, lignesRevisees, choix);
  if (Object.keys(modifications).length === 0) return { ok: false, error: "Rien à réviser : la révision porte sur le tiers, les lignes, la date, les références, le paiement, la TVA, les taxes, la livraison, le contact, les notes, le papier en-tête ou les coordonnées de l'émetteur." };
  const r = await reviserDocumentDrive(user, {
    legalDocumentId, modifications, motif: texte(formData, "motif"),
    versionVue: vue !== null && Number.isInteger(vue) ? vue : null, exigerMotif: true,
  }, await emissionDeLaPiece(user, legalDocumentId));
  if (!r.ok) return { ok: false, error: r.motif + (r.bloquants?.length ? ` — ${r.bloquants.slice(0, 3).join(" ; ")}` : "") };
  revalidatePath("/legal");
  revalidatePath(`/legal/${legalDocumentId}`);
  revalidatePath("/demandes");
  const libelle = r.type === "DEVIS" ? "Devis" : "Bon de commande";
  return {
    ok: true, id: legalDocumentId, reference: r.reference, version: r.version,
    message: `${libelle} ${r.reference} révisé : version ${r.version}, ${formaterTtc(r.totaux.totalTtc)} TTC — le Word, le PDF et la fiche disent la même chose.`
      + (r.reserveBonDeCommande ? ` ${r.reserveBonDeCommande}` : ""),
  };
}

export interface ResultatAvoir extends ActionResult {
  reference?: string;
}

/**
 * ÉMETTRE UN AVOIR sur une facture émise (§118.195 — audit 360°, R15) : la seule correction d'une facture, qui ne se
 * réécrit pas. L'écran envoie les lignes à créditer et le motif ; le client, le numéro et la date d'origine, la TVA,
 * la remise et les taxes viennent de la FACTURE, et c'est la fabrique qui les reprend — rien de cela n'est lu ici.
 * La fabrique refuse ce qui dépasse le reste à créditer, revérifié sous verrou ; le motif est exigé après l'état.
 */
export async function emettreAvoir(_prev: ResultatAvoir | undefined, formData: FormData): Promise<ResultatAvoir> {
  const user = await requireUser();
  const factureId = fdStr(formData, "factureId");
  if (!factureId) return { ok: false, error: "Facture introuvable." };
  // La société de la facture, pour le profil documentaire ; une pièce qui n'est pas une facture émise est refusée
  // par la FABRIQUE, avec sa phrase — une seconde rédaction ici finirait par dire autre chose (§118.5).
  const facture = await factureACrediter(factureId);
  const lignes = lireLignes(formData);
  const r = await emettreDocumentDrive(user, {
    type: "AVOIR", societe: facture?.companyId ?? null, chainFromId: factureId,
    // Le client vient de la facture, sur le lien — la fabrique le remplace : rien n'est pris de l'écran.
    tiers: { nom: "" },
    lignes, objet: texte(formData, "motif"),
  });
  if (!r.ok) return { ok: false, error: r.motif + (r.bloquants?.length ? ` — ${r.bloquants.slice(0, 3).join(" ; ")}` : "") };
  revalidatePath("/legal");
  revalidatePath(`/legal/${factureId}`);
  if (r.dejaEmis) {
    return { ok: true, id: r.legalDocumentId, reference: r.reference, message: `Un avoir identique existait déjà (${r.reference}) : aucun nouvel avoir n'a été émis.` };
  }
  if (!facture) return { ok: true, id: r.legalDocumentId, reference: r.reference, message: `Avoir ${r.reference} émis : ${formaterTtc(r.totaux.totalTtc)} TTC crédités.` };
  const net = netDeLaFacture(facture.ttc, await montantsDesAvoirsActifs(factureId));
  return {
    ok: true, id: r.legalDocumentId, reference: r.reference,
    message: `Avoir ${r.reference} émis : ${formaterTtc(r.totaux.totalTtc)} TTC crédités sur la facture ${facture.numero} — net de la facture : ${formaterTtc(net)}.`
      // UN AVOIR SUR UNE FACTURE RÉGLÉE est un remboursement : l'écriture du règlement a eu lieu, elle ne se réécrit
      // pas — et la phrase dit où se demande ce qui est dû au client, au lieu de laisser croire que c'est fait.
      + (facture.regleeLe ? " La facture est déjà réglée : ce montant est dû au client — son remboursement se demande depuis « Demandes de validations » (« Demande de paiement »)." : ""),
  };
}

/** « 1 234 567,89 DZD » — la phrase du résultat ; les totaux viennent de la fabrique, jamais du navigateur. */
function formaterTtc(n: number): string {
  return `${n.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} DZD`;
}

/**
 * RÈGLE la numérotation d'une nature de pièce pour une société — le motif (« {n:3}/FS/{aa} ») et/ou le PREMIER
 * NUMÉRO de l'année (« commencer à 032/DG/2026 »). Ceux qui tiennent la papeterie seulement, comme le reste du profil.
 *
 * Ce que le formulaire ne porte pas ne s'écrit pas (§118.152c) : sans clé `motif`, le motif reste ; sans clé `depart`,
 * le départ reste. Le départ est un PLANCHER du compteur, jamais un recul : le message dit le prochain numéro réel.
 */
export async function reglerNumerotationPieces(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const type = (fdStr(formData, "type") ?? "") as TypeDocumentCommercial;
  if (!TYPES_DOCUMENT.includes(type)) return { ok: false, error: "Nature de pièce inconnue." };
  const motifSaisi = formData.has("motif");
  const departSaisi = formData.has("depart");
  if (!motifSaisi && !departSaisi) return { ok: false, error: "Rien à régler : renseignez le motif et/ou le premier numéro de l'année." };
  let depart: { annee: number; numero: number | null } | undefined;
  if (departSaisi) {
    const brut = (fdStr(formData, "depart") ?? "").trim();
    const annee = Number(fdStr(formData, "annee") ?? new Date().getUTCFullYear());
    if (brut === "") depart = { annee, numero: null };
    else {
      const numero = Number(brut);
      if (!/^\d+$/.test(brut)) return { ok: false, error: `Le premier numéro est un entier (« ${brut} » ne se lit pas) : 32 pour commencer à 032.` };
      depart = { annee, numero };
    }
  }
  const r = await definirProfilDocumentaire(user, {
    societe: texte(formData, "societe"),
    ...(motifSaisi ? { numerotation: { [type]: texte(formData, "motif") } } : {}),
    ...(depart ? { numerotationDepart: { [type]: depart } } : {}),
  });
  if (!r.ok) return { ok: false, error: r.motif };
  revalidatePath("/legal");
  const applique = r.profil.reglages.numerotation[type];
  const parts: string[] = [];
  if (motifSaisi) parts.push(applique ? `Motif enregistré : ${applique}.` : "Motif effacé : retour à la numérotation par défaut.");
  if (depart) {
    parts.push(depart.numero === null
      ? `Départ ${depart.annee} retiré : la série reprend son compteur.`
      : `Premier numéro de ${depart.annee} : ${depart.numero}. Le compteur ne recule jamais — s'il est déjà plus loin, la série continue.`);
  }
  return { ok: true, message: parts.join(" ") };
}
