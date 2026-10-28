/**
 * Fabrique de documents — L'APERÇU : ce que la pièce serait, sans rien attribuer ni écrire
 * (`previsualiserDocument`).
 */
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import { canEditCompanyId } from "@/lib/company";
import { docxToPdf } from "@/lib/payslip/to-pdf";
import { convertConfigured } from "@/lib/office-convert";
import { construireDocumentCommercial } from "@/lib/artifact/factory/build";
import { formaterNumero, NATURE_LEGALE, TYPES_DOCUMENT, verifierSpecCommerciale, departDe, prochaineSequence, type SpecDocumentCommercial, type TotauxCommerciaux } from "@/lib/artifact/factory/commercial";
import { prevoirReference } from "@/lib/references/registre-serveur";
import { montantsDesAvoirsActifs } from "@/lib/lecteurs/avoirs-actifs";
import { refusPlafondAvoir, resteACrediter } from "@/lib/lecteurs/avoir";
import { controlerRibDePiece } from "@/modules/coffre/api";
import { echec, type EchecFabrique, manquesDIdentite, profilDocumentaire } from "./profil";
import { coordonneesParDefaut, type DemandeDocument, specDepuisDemande } from "./demande";
import { peutEcrire } from "./numerotation";
import { factureDeLAvoir, jugerPieceAmont, phraseDroitDEmettre, prefixeDe, registreDeLaPiece } from "./emission";

// ─────────────────────────── L'aperçu ───────────────────────────

export interface ApercuDocument {
  ok: true;
  societe: { id: string; nom: string };
  /** Le numéro que la PROCHAINE émission recevra si personne n'émet entre-temps — prévu, pas réservé. */
  numeroProchain: string;
  motif: string | null;
  /** La pièce prend son numéro au REGISTRE COMMUN NNN/DG/AAAA : il peut être CHOISI à l'émission (`DemandeDocument.numeroChoisi`). */
  surRegistre: boolean;
  papierEnTete: { id: string; nom: string } | null;
  identiteIncomplete: string[];
  /** La spécification telle qu'elle sera composée, numéro prévu compris. */
  spec: SpecDocumentCommercial;
  totaux: TotauxCommerciaux | null;
  bloquants: string[];
  avertissements: string[];
  peutEmettre: boolean;
  /** Vrai quand le PDF sera imprimé par l'éditeur Office ; faux = rendu du serveur. */
  pdfParEditeur: boolean;
  /**
   * L'APERÇU AVANT IMPRESSION (Direction, 10/2026) — le PDF de la pièce telle qu'elle sera composée, numéro PRÉVU compris,
   * rendu par le serveur à blanc : aucun numéro consommé, aucune ligne écrite, aucun fichier au Drive. Présent seulement
   * quand on le demande (`avecPdf`) : l'aperçu des totaux suit la frappe, le rendu d'une page non.
   */
  pdf?: { octets: Buffer; pages: number } | null;
  /** Pourquoi le rendu n'a pas pu être produit, quand il était demandé. */
  pdfErreur?: string;
  /** Ce que la société émettrice imprime par défaut (siège, téléphone, e-mail) — ce que l'écran pré-remplit. */
  coordonneesSociete: { adresse: string | null; telephone: string | null; email: string | null };
}

/**
 * L'APERÇU d'une pièce : la MÊME composition que l'émission — vérification, calcul, mise en page,
 * relecture — jouée à blanc, sans consommer de numéro ni écrire une ligne. C'est ce que l'écran
 * des Finances montre pendant la saisie : totaux, somme en lettres, numéro prévu, papier, et ce
 * qui bloquerait. Deux compositions (une pour l'aperçu, une pour l'émission) finiraient par
 * diverger sur un arrondi (§118.5) ; il n'y en a qu'une.
 */
export async function previsualiserDocument(
  user: CurrentUser, demande: DemandeDocument,
  /**
   * `delegation` : l'aperçu d'un dossier qui autorise l'émission (comme `OptionsEmission.delegation`) — le demandeur d'un poste
   * relit SON bon de commande sans droit d'écriture Legal. `numeroAffiche` : ce que la pièce imprime à la place du numéro
   * prévu (« À attribuer à la validation ») — le numéro n'est attribué qu'à l'émission ; le prévu reste dit dans `numeroProchain`.
   */
  opts: { avecPdf?: boolean; delegation?: string | null; numeroAffiche?: string | null } = {},
): Promise<ApercuDocument | EchecFabrique> {
  const type = demande.type;
  if (!TYPES_DOCUMENT.includes(type)) return echec("MISSING_INPUT", `Type de document inconnu : « ${String(type)} » (${TYPES_DOCUMENT.join(", ")}).`);
  if (!opts.delegation && !peutEcrire(user, "CREATE", type)) {
    return echec("MISSING_PERMISSION", phraseDroitDEmettre(type));
  }
  if (opts.delegation && !(demande.societe ?? "").trim()) {
    return echec("MISSING_INPUT", "Cet aperçu est autorisé par un dossier qui ne nomme aucune société : rattachez le dossier à la société qui commande, puis relancez.");
  }
  const p = await profilDocumentaire(user, demande.societe, { papierEnTeteId: demande.letterheadId ?? null, type });
  if (!p.ok) return p;
  const { profil, habillage } = p;
  if (!opts.delegation && !(await canEditCompanyId(user.id, profil.societe.id))) return echec("MISSING_PERMISSION", `Vous voyez ${profil.societe.nom} sans pouvoir l'engager : la pièce ne peut pas être émise en son nom.`);
  // L'aperçu d'un avoir lit sa facture comme l'émission : sinon il montrerait un client que l'émission remplacera.
  let facture: { numero: string; ttc: number; avoirs: number[] } | null = null;
  if (type === "AVOIR") {
    const lu = await factureDeLAvoir(user, demande.chainFromId, profil.societe.id);
    if (!lu.ok) return lu;
    facture = { numero: lu.numero, ttc: lu.ttc, avoirs: await montantsDesAvoirsActifs(lu.id) };
    demande = {
      ...demande, tiers: lu.tiers, referenceAmont: lu.numero, referenceAmontDate: lu.date, numeroClient: lu.numeroClient, chainFromId: lu.id,
      tvaDefaut: demande.tvaDefaut ?? lu.calcul.tvaDefaut, remiseGlobale: demande.remiseGlobale ?? lu.calcul.remiseGlobale, taxes: demande.taxes ?? lu.calcul.taxes,
    };
  }
  // LE COFFRE (refonte V2-E) : le RIB du tiers (fiche de l'annuaire ou recopié du devis) passe la politique au goulot.
  const tiersRib = await controlerRibDePiece(user, demande.tiers?.rib, `${demande.type} pour ${demande.tiers?.nom ?? "?"} — RIB du tiers`);
  const base = specDepuisDemande(demande.tiers ? { ...demande, tiers: { ...demande.tiers, rib: tiersRib } } : demande, profil);
  const annee = Number(base.date.slice(0, 4));
  const kind = NATURE_LEGALE[type];
  const prefixe = prefixeDe(type, profil);
  const motif = profil.reglages.numerotation[type] ?? null;
  const anneeSure = Number.isFinite(annee) ? annee : new Date().getUTCFullYear();
  // Au registre commun NNN/DG/AAAA, le prévu se lit au compteur COMMUN de la société (et saute les numéros déjà choisis).
  const registre = registreDeLaPiece(type, profil, anneeSure);
  const seq = registre ? null : await prisma.documentSequence.findUnique({ where: { companyId_kind_year: { companyId: profil.societe.id, kind, year: anneeSure } }, select: { last: true } });
  const numeroProchain = registre
    ? await prevoirReference(profil.societe.id, anneeSure, registre)
    : formaterNumero(prefixe, anneeSure, prochaineSequence(seq?.last ?? 0, departDe(profil.reglages.numerotationDepart, type, anneeSure)), motif);
  const spec: SpecDocumentCommercial = { ...base, numero: opts.numeroAffiche?.trim() || numeroProchain };
  const commun = { ok: true as const, societe: { id: profil.societe.id, nom: profil.societe.nom }, numeroProchain, motif, surRegistre: registre !== null, papierEnTete: profil.papierEnTete, identiteIncomplete: profil.identiteIncomplete, spec, pdfParEditeur: convertConfigured(), coordonneesSociete: coordonneesParDefaut(profil) };
  // LA PIÈCE AMONT SE JUGE DÈS L'APERÇU (lot D1c — F1) : l'écran ne propose pas d'émettre ce que l'émission refusera.
  const amontId = (demande.chainFromId ?? "").trim() || null;
  const refusAmont = amontId && type !== "AVOIR" ? await jugerPieceAmont(user, type, amontId, profil.societe.id) : null;
  const motifAmont = refusAmont ? [refusAmont.motif] : [];
  const regles = verifierSpecCommerciale(spec);
  if (regles.bloquants.length > 0) return { ...commun, totaux: null, bloquants: [...regles.bloquants, ...motifAmont], avertissements: [...regles.avertissements, ...manquesDIdentite(profil)], peutEmettre: false };
  const essai = await construireDocumentCommercial(spec, habillage);
  const plafond = facture && essai.totaux ? refusPlafondAvoir(facture.numero, essai.totaux.totalTtc, resteACrediter(facture.ttc, facture.avoirs)) : null;
  const bloquants = [...essai.verification.bloquants, ...(plafond ? [plafond] : []), ...motifAmont];
  // L'APERÇU AVANT IMPRESSION : le MÊME fichier que l'émission composerait, rendu en PDF par le serveur — jamais écrit.
  const rendu = opts.avecPdf && essai.verification.ok ? await docxToPdf(essai.octets) : null;
  return {
    ...commun, totaux: essai.totaux, bloquants, avertissements: [...essai.verification.avertissements, ...manquesDIdentite(profil)], peutEmettre: essai.verification.ok && !plafond && !refusAmont,
    ...(opts.avecPdf ? (rendu && rendu.ok ? { pdf: { octets: rendu.pdf, pages: rendu.pages } } : { pdf: null, pdfErreur: rendu && !rendu.ok ? rendu.error : "Le rendu n'est pas possible tant que la pièce est refusée." }) : {}),
  };
}
