/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * TOUT BON DE COMMANDE PASSE PAR UN CENTRE DE VALIDATION — la règle, pure.
 *
 * ── CE QUE LA DIRECTION A DÉCIDÉ (09/2026) ──────────────────────────────────────────────────
 *
 * « Concernant les BC, ils doivent tous passer soit par le centre de validation Ad&Pro si la
 * demande est depuis Ad&Pro, soit par le centre de validation normal, si elle provient de
 * quelque part d'autre. »
 *
 * ── CE QUE LA MESURE A TROUVÉ AVANT CETTE RÈGLE ─────────────────────────────────────────────
 *
 * Aucun bon de commande ne passait par aucun centre. Recensé chemin par chemin : un BC existait
 * sous QUATRE formes sans lien entre elles — une pièce du registre Legal (`LegalDocument` de
 * nature `PURCHASE_ORDER`, née `ACTIVE`, sans aucun état d'approbation), le visa d'un poste
 * Ad & Pro (`AdProItem.orderStage`, donné par « la Direction »), les états BC_* du matériel
 * promotionnel (validés par les FINANCES), et le chantier « bon de commande » du circuit court,
 * qu'un simple clic sans pièce refermait. `legal-chain.ts` lisait même des validateurs sur
 * `LEGAL_DOCUMENT` que personne ne créait : un lecteur sans écrivain.
 *
 * ── LA RÈGLE, EN TROIS QUESTIONS ────────────────────────────────────────────────────────────
 *
 *   1. QUEL CENTRE ? — `centreDeLOrigine` : le centre Ad & Pro dès que le chemin d'origine du BC
 *      passe par une nature Ad & Pro ou un poste ; le centre de validations sinon.
 *   2. OÙ EN EST SA PORTE ? — `PorteBC` : en attente, validée, refusée, ou à revoir. `null` = le
 *      BC n'a pas de porte, ce qui ne peut arriver qu'à un BC ANTÉRIEUR à cette règle.
 *   3. QUE FAIRE QUAND LE BC CHANGE ? — `gesteAiguillage` : poser, transférer, rouvrir,
 *      actualiser, ou ne rien faire — jamais re-juger une décision déjà prise.
 *
 * ── CE QUE LA PORTE BLOQUE ───────────────────────────────────────────────────────────────────
 *
 * Un BC qui attend son centre n'engage pas encore la société : la facture qui en DÉCOULE ne part
 * pas au règlement (`blocageParLeBC`), et la phrase qui annonce le BC le DIT (`reserveBC`) — un
 * document qui s'ouvre, s'imprime et a l'air fini, sans dire qu'il n'est pas validé, se lit
 * comme un engagement (§118.32).
 *
 * Et ce qu'elle NE bloque PAS : un BC sans porte, c'est-à-dire historique. Le bloquer gèlerait
 * rétroactivement tout le registre au déploiement — une garde qui refuse ce qu'elle ne sait pas
 * lire est désactivée dans la semaine (§118.16).
 *
 * ── CE QUE LA DIRECTION A PRÉCISÉ ENSUITE (09/2026, §118.149) ────────────────────────────────
 *
 * « Tout BC supérieur à un montant configuré dans les centres de validations Ad&Pro devra passer
 * par la validation d'un des centres. » Et les BC vont ensuite aux FINANCES, qui les SIGNENT —
 * « si un BC se retrouve là-bas, c'est qu'il doit être signé ». D'où deux questions de plus :
 *
 *   4. FAUT-IL UN CENTRE ? — `validationRequiseBC` : strictement au-dessus du seuil, ou montant
 *      inconnu (on ne franchit pas une porte de contrôle sur un trou, §118.132).
 *   5. OÙ EN EST LE BC, DE BOUT EN BOUT ? — `etapeBC` : à valider, à revoir, refusé, à signer,
 *      signé — une seule fonction pour la file des Finances, l'action de signature, la fiche et
 *      la phrase d'émission, sinon quatre lectures de « prêt à signer » divergeraient (§118.5).
 *
 * Module PUR, au SOCLE — sa seule importation est une constante du socle : le chemin du module
 * « Bons de commande » tel qu'une phrase le nomme (§118.176). Quatre couches en ont besoin sans
 * avoir le droit de se parler : les actions de Legal, la fabrique documentaire (le pont), le
 * règlement des factures (domaine `finance`) et le centre Ad & Pro (domaine `adpro`).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { MENU_BONS_DE_COMMANDE } from "@/lib/chemins/bons-de-commande";
import { PHRASE_PREVALIDATION } from "./prevalidation";

/** Les deux centres entre lesquels un BC s'aiguille. */
export type CentreBC = "AD_PRO" | "VALIDATION";

/** L'état de la porte d'un BC. */
export type EtatPorteBC = "EN_ATTENTE" | "VALIDE" | "REFUSE" | "A_REVOIR";

/**
 * LA PORTE D'UN BC TELLE QU'ON LA LIT.
 *
 * `source` dit OÙ vit la décision, et la distinction n'est pas un détail : le BC d'un poste Ad &
 * Pro est demandé AVANT que sa pièce existe — c'est la DEMANDE que le centre vise (montant
 * accordé, prestataire, imputation). La pièce qui arrive ensuite en est la matérialisation ; lui
 * poser une seconde porte ferait valider DEUX FOIS le même engagement, et deux vérités sur « ce
 * BC est-il validé ? » divergent toujours (§118.5).
 */
export interface PorteBC {
  centre: CentreBC;
  etat: EtatPorteBC;
  source: "DOCUMENT" | "POSTE";
  /** Le motif du centre (refus, demande de modification). */
  note?: string | null;
}

export const LIBELLE_CENTRE_BC: Record<CentreBC, string> = {
  AD_PRO: "centre de validation Ad & Pro",
  VALIDATION: "centre de validations",
};

export const LIBELLE_ETAT_BC: Record<EtatPorteBC, string> = {
  EN_ATTENTE: "En attente de validation",
  VALIDE: "Validé",
  REFUSE: "Refusé",
  A_REVOIR: "À revoir",
};

/** Le chemin vers l'écran du centre — pour les liens des refus et des notifications. */
export const CHEMIN_CENTRE_BC: Record<CentreBC, string> = {
  AD_PRO: "/centre-ad-pro",
  VALIDATION: "/centre-de-validations",
};

/**
 * QUEL CENTRE ? — la réponse est dans le CHEMIN D'ORIGINE du BC.
 *
 * Le chemin est la suite des types d'entité qu'on traverse en remontant d'où le BC vient : sa
 * source directe, la demande de pièce qui l'a fait naître, l'ordre ou le dossier qu'elle visait.
 * Il suffit qu'UN maillon soit Ad & Pro pour que la demande vienne d'Ad & Pro — un BC réclamé
 * sur le poste d'un sponsoring EST un BC du sponsoring, même s'il a transité par le secrétariat.
 *
 * Les types Ad & Pro arrivent en PARAMÈTRE : ce module est au socle et ne lit pas le registre
 * des natures (domaine `adpro`). L'appelant le dérive du registre canonique — une liste écrite ici
 * à la main serait fausse à la première nature ajoutée, en silence (§118.73).
 */
export function centreDeLOrigine(chemin: readonly string[], typesAdPro: ReadonlySet<string>): CentreBC {
  return chemin.some((t) => typesAdPro.has(t)) ? "AD_PRO" : "VALIDATION";
}

/** L'état d'une demande de validation (centre de validations) — `null` si elle a été retirée. */
export function etatDepuisValidation(status: string): EtatPorteBC | null {
  switch (status) {
    case "PENDING": return "EN_ATTENTE";
    case "APPROVED": return "VALIDE";
    case "REJECTED": return "REFUSE";
    case "CHANGES_REQUESTED": return "A_REVOIR";
    default: return null; // CANCELLED : la porte a été retirée, elle ne dit plus rien
  }
}

/**
 * L'état d'un visa du centre Ad & Pro. Un état inconnu ATTEND — le sens sûr. Un visa RENVOYÉ pour
 * correction (audit 360°, R07) est « à revoir », exactement comme au centre de validations : la
 * modification du BC le renvoie au centre (`gesteAiguillage`, cas A_REVOIR).
 */
export function etatDepuisVisa(status: string): EtatPorteBC {
  if (status === "APPROVED") return "VALIDE";
  if (status === "REFUSED") return "REFUSE";
  if (status === "CHANGES_REQUESTED") return "A_REVOIR";
  return "EN_ATTENTE";
}

/**
 * L'état porté par le VISA D'UN POSTE Ad & Pro — `null` quand aucun BC n'a été demandé.
 *
 * `DIRECTION_OK` garde son nom de colonne historique ; depuis cette règle, c'est le centre Ad &
 * Pro qui le pose. `ISSUED` suit un visa : l'ordre de dépense n'est émis qu'après.
 */
export function etatDepuisPoste(orderStage: string): EtatPorteBC | null {
  switch (orderStage) {
    case "REQUESTED": return "EN_ATTENTE";
    case "DIRECTION_OK":
    case "ISSUED": return "VALIDE";
    case "REFUSED": return "REFUSE";
    default: return null;
  }
}

/**
 * LA FACTURE QUI DÉCOULE DE CE BC PEUT-ELLE PARTIR AU RÈGLEMENT ? — `null` = oui.
 *
 * Le refus NOMME le BC, le centre et ce qui lève le blocage (§118.30). Un BC sans porte ne
 * bloque rien : c'est un BC d'avant la règle.
 */
export function blocageParLeBC(porte: PorteBC | null, reference: string | null): string | null {
  if (!porte || porte.etat === "VALIDE") return null;
  const bc = reference?.trim() ? `Le bon de commande ${reference.trim()}` : "Le bon de commande dont découle cette facture";
  const centre = LIBELLE_CENTRE_BC[porte.centre];
  switch (porte.etat) {
    case "EN_ATTENTE":
      return `${bc} attend encore la validation du ${centre} : la facture partira au règlement une fois le bon de commande validé.`;
    case "A_REVOIR":
      return `${bc} est à revoir à la demande du ${centre}${porte.note ? ` (« ${porte.note} »)` : ""} : corrigez-le — sa modification le renvoie au centre — avant d'envoyer la facture.`;
    case "REFUSE":
      return `${bc} a été refusé par le ${centre}${porte.note ? ` (« ${porte.note} »)` : ""} : une facture qui en découle ne part pas au règlement.`;
  }
}

/**
 * CE QUE LA PHRASE QUI ANNONCE UN BC DOIT DIRE (§118.32).
 *
 * « Bon de commande BC-2026-012 émis » sur un BC que personne n'a validé ferait envoyer la pièce
 * au fournisseur — elle s'ouvre, s'imprime, porte un numéro. La réserve entre dans la phrase, et
 * se tait quand le BC est validé : une réserve permanente cesse d'être lue.
 */
export function reserveBC(porte: PorteBC | null): string | null {
  if (!porte || porte.etat === "VALIDE") return null;
  const centre = LIBELLE_CENTRE_BC[porte.centre];
  switch (porte.etat) {
    case "EN_ATTENTE":
      return `Ce bon de commande attend la validation du ${centre} : ne l'envoyez pas au fournisseur avant.`;
    case "A_REVOIR":
      return `Le ${centre} demande de revoir ce bon de commande : il n'engage pas la société en l'état.`;
    case "REFUSE":
      return `Ce bon de commande a été refusé par le ${centre} : il n'engage pas la société.`;
  }
}

/**
 * CE QUE DIT UN AIGUILLAGE QUI N'A PAS POSÉ DE PORTE — et un seul endroit pour le dire.
 *
 * Deux causes, deux phrases : personne ne siège au centre (un Super Admin doit exister), ou
 * l'écriture de la porte a échoué (on la rattrape d'un clic, depuis la fiche). La fabrique et les
 * actions Legal portaient chacune LEUR rédaction de la première, et aucune ne connaissait la
 * seconde : un BC sans porte sortait avec une phrase qui ne disait rien (§118.5, §118.148).
 * `null` quand une porte a bien été posée — c'est alors `reserveBC` qui parle.
 */
export function reserveSansPorte(a: { sansSiege?: boolean; enEchec?: boolean; enPrevalidation?: boolean }): string | null {
  // Retenu par sa pré-validation : il n'a pas de porte PARCE QUE le demandeur recueille d'abord des avis.
  if (a.enPrevalidation) return PHRASE_PREVALIDATION;
  if (a.sansSiege) {
    return "Aucun siège au centre de validations : ce bon de commande n'a pas pu y être adressé — il n'est PAS validé. Un Super Admin doit exister pour le valider.";
  }
  if (a.enEchec) {
    return "Ce bon de commande n'a pas pu être adressé à son centre de validation (erreur technique) : il n'est PAS validé. Rattrapez-le par « Adresser au centre », sur sa fiche Legal.";
  }
  return null;
}

/**
 * CE BC DOIT-IL PASSER PAR UN CENTRE ? — le seuil réglé depuis le centre de validation Ad & Pro.
 *
 * STRICTEMENT au-dessus du seuil → oui. Aucun seuil fixé (0) → oui : c'est le comportement d'avant
 * la règle, et le seul sûr tant que la Direction n'a pas choisi le montant. Montant inconnu, nul
 * ou illisible → oui : un BC dont on ignore le montant n'est pas « petit », et franchir une porte
 * de contrôle sur une absence de donnée serait décider à la place du centre (§118.132).
 */
export function validationRequiseBC(montant: number | null | undefined, seuil: number | null | undefined): boolean {
  if (!(typeof seuil === "number" && Number.isFinite(seuil) && seuil > 0)) return true;
  if (!(typeof montant === "number" && Number.isFinite(montant) && montant > 0)) return true;
  return montant > seuil;
}

/** Le motif écrit quand un BC passe sous le seuil : il dit POURQUOI aucun centre ne le voit. */
export function motifSousLeSeuil(seuil: number): string {
  return `Sous le seuil de validation des bons de commande (${seuil.toLocaleString("fr-FR")} DZD) : aucun centre n'a à le valider, il passe directement à la signature des Finances.`;
}

/** Ce que l'aiguillage doit faire, décidé sans rien lire. */
export type GesteAiguillage =
  | { geste: "POSER" }
  | { geste: "TRANSFERER" }
  | { geste: "ROUVRIR"; motif: string }
  | { geste: "ACTUALISER" }
  /** La validation qui attendait n'a plus d'objet : le BC est passé sous le seuil. */
  | { geste: "RETIRER"; motif: string }
  | { geste: "RIEN" };

/**
 * QUE FAIRE DE LA PORTE D'UN BC QU'ON VIENT DE CRÉER OU DE TOUCHER ?
 *
 *   • aucune porte → la POSER, dans le centre de son origine ;
 *   • porte du POSTE → RIEN : c'est la demande du poste que le centre vise, la pièce n'en est
 *     que la matérialisation (voir `PorteBC.source`) ;
 *   • en attente dans l'AUTRE centre (le BC vient d'être rattaché à une fiche Ad & Pro, ou
 *     détaché) → la TRANSFÉRER — elle n'a encore été vue par personne ;
 *   • en attente dans le bon centre, montant changé → ACTUALISER le montant affiché au centre ;
 *   • VALIDÉE et montant RELEVÉ → ROUVRIR : l'empreinte réelle d'un engagement ne dépasse jamais
 *     l'empreinte validée (§118.16). Baisser le montant ne rouvre rien — c'est un geste qui
 *     RÉDUIT. Un montant d'abord INCONNU qu'on renseigne ne rouvre rien non plus : le centre a
 *     validé la PIÈCE, qui portait son montant, et la saisie ne fait que le recopier ;
 *   • À REVOIR et modifiée → ROUVRIR : c'est la resoumission que le centre a demandée ;
 *   • REFUSÉE → RIEN : un refus ne se contourne pas en retouchant la pièce, et une décision
 *     déjà prise ne se re-juge pas parce que le BC a changé de fiche.
 *
 * ET LE SEUIL (§118.149) : sous le seuil, aucune porte n'est POSÉE, et une porte qui ATTEND
 * encore est RETIRÉE — elle n'a plus d'objet. Mais ce qu'un centre a DÉCIDÉ ne s'efface pas :
 * un refus reste un refus même si la pièce passe sous le seuil (sinon baisser le montant serait
 * la façon de contourner un refus), et une validation reste acquise. Sans `seuil`, tout BC exige
 * un centre — le comportement de la règle précédente.
 */
export function gesteAiguillage(input: {
  actuelle: PorteBC | null;
  centreVoulu: CentreBC;
  montantAvant?: number | null;
  montantApres?: number | null;
  /** Le BC a-t-il été modifié par la personne (et non simplement relu) ? */
  modifie?: boolean;
  /** Le seuil des bons de commande en vigueur — absent : tout BC exige un centre. */
  seuil?: number | null;
}): GesteAiguillage {
  const { actuelle, centreVoulu } = input;
  const avant = input.montantAvant ?? null;
  const apres = input.montantApres ?? null;
  const requise = validationRequiseBC(apres, input.seuil ?? null);
  const sousLeSeuil = () => motifSousLeSeuil(input.seuil ?? 0);

  if (!actuelle) return requise ? { geste: "POSER" } : { geste: "RIEN" };
  if (actuelle.source === "POSTE") return { geste: "RIEN" };

  const montantChange = avant !== apres;

  switch (actuelle.etat) {
    case "EN_ATTENTE":
      if (!requise) return { geste: "RETIRER", motif: sousLeSeuil() };
      if (actuelle.centre !== centreVoulu) return { geste: "TRANSFERER" };
      return montantChange && input.modifie ? { geste: "ACTUALISER" } : { geste: "RIEN" };
    case "VALIDE":
      // Relevé mais toujours sous le seuil : aucun centre n'a à le revoir.
      if (!requise) return { geste: "RIEN" };
      if (avant != null && apres != null && apres > avant) {
        return {
          geste: "ROUVRIR",
          motif: `Montant relevé de ${avant.toLocaleString("fr-FR")} à ${apres.toLocaleString("fr-FR")} DZD après validation.`,
        };
      }
      return { geste: "RIEN" };
    case "A_REVOIR":
      if (!input.modifie) return { geste: "RIEN" };
      // Corrigé SOUS le seuil : la correction a rendu la validation sans objet.
      return requise
        ? { geste: "ROUVRIR", motif: "Bon de commande corrigé à la demande du centre." }
        : { geste: "RETIRER", motif: sousLeSeuil() };
    case "REFUSE":
      return { geste: "RIEN" };
  }
}

// ───────────────────────── L'étape d'un BC, de bout en bout ─────────────────────────

/** Où en est un bon de commande — de l'entrée dans le circuit à la signature des Finances. */
export type EtapeBC =
  /** BC d'avant la règle, jamais retouché : on ne le présume ni à valider ni à signer. */
  | "HORS_CIRCUIT"
  /** Il dépasse le seuil et n'est passé par aucun centre (aiguillage raté, ou pièce ancienne). */
  | "SANS_PORTE"
  | "A_VALIDER"
  | "A_REVOIR"
  | "REFUSE"
  /** Validé par son centre, ou sous le seuil : c'est aux Finances de le signer. */
  | "A_SIGNER"
  /**
   * RENVOYÉ À SON ÉMETTEUR par un signataire, avec ce qu'il faut corriger (audit 360°, R09) : il
   * quitte la file des signataires, et y revient dès que la pièce est modifiée.
   */
  | "A_CORRIGER"
  | "SIGNE";

export const LIBELLE_ETAPE_BC: Record<EtapeBC, string> = {
  HORS_CIRCUIT: "Antérieur au circuit",
  SANS_PORTE: "À adresser au centre",
  A_VALIDER: "En attente de validation",
  A_REVOIR: "À revoir",
  REFUSE: "Refusé",
  A_SIGNER: "À signer par les Finances",
  A_CORRIGER: "Renvoyé à l'émetteur",
  SIGNE: "Signé",
};

/**
 * L'ÉTAPE D'UN BC — une seule lecture pour la file des Finances, l'action de signature, la fiche
 * et la phrase d'émission.
 *
 * La SIGNATURE l'emporte : un BC signé n'est plus « à valider » pour personne. Une porte en
 * attente, à revoir ou refusée dit l'étape. Une porte VALIDÉE rend le BC « à signer » s'il est
 * dans le circuit — un BC ancien validé il y a un an sur un poste n'est pas à signer aujourd'hui.
 * Sans porte : hors circuit s'il n'y est jamais entré, sinon à signer sous le seuil, et « à
 * adresser » au-dessus (le centre ne l'a jamais vu).
 */
export function etapeBC(a: {
  porte: PorteBC | null;
  validationRequise: boolean;
  signe: boolean;
  dansLeCircuit: boolean;
  /**
   * Un signataire l'a RENVOYÉ à son émetteur (audit 360°, R09). Champ OBLIGATOIRE : un défaut à faux
   * ferait réapparaître dans la file des signataires, en silence, chez le prochain appelant qui
   * l'oublierait, un BC qu'ils viennent de renvoyer (§118.127b).
   */
  renvoye: boolean;
}): EtapeBC {
  if (a.signe) return "SIGNE";
  // Ce qui serait « à signer » mais a été renvoyé attend son émetteur, pas les signataires. Le renvoi
  // ne masque jamais une porte qui attend : c'est le centre, alors, qui a la main.
  const aSigner: EtapeBC = a.renvoye ? "A_CORRIGER" : "A_SIGNER";
  if (a.porte) {
    switch (a.porte.etat) {
      case "EN_ATTENTE": return "A_VALIDER";
      case "A_REVOIR": return "A_REVOIR";
      case "REFUSE": return "REFUSE";
      case "VALIDE": return a.dansLeCircuit ? aSigner : "HORS_CIRCUIT";
    }
  }
  if (!a.dansLeCircuit) return "HORS_CIRCUIT";
  return a.validationRequise ? "SANS_PORTE" : aSigner;
}

/**
 * CE QUE LA PHRASE D'UN BC DOIT DIRE, SELON SON ÉTAPE (§118.32). Se tait sur un BC signé, et sur
 * un BC d'avant le circuit — une réserve permanente cesse d'être lue.
 *
 * Un BC « à signer » SANS porte n'a vu aucun centre parce qu'il est sous le seuil : la phrase le
 * DIT, avec le montant du seuil — sinon la personne se demanderait pourquoi son BC a sauté la
 * validation qu'elle attendait, et le soupçonnerait d'avoir contourné la règle.
 */
export function reserveEtapeBC(etape: EtapeBC, porte: PorteBC | null, seuil?: number | null): string | null {
  switch (etape) {
    case "A_VALIDER":
    case "A_REVOIR":
    case "REFUSE":
      return reserveBC(porte);
    case "SANS_PORTE":
      return "Ce bon de commande dépasse le seuil de validation et n'est passé par aucun centre : il n'est PAS validé. « Adresser au centre », sur sa fiche Legal.";
    case "A_SIGNER": {
      const signature = `Il attend la signature des Finances (${MENU_BONS_DE_COMMANDE}) : ne l'envoyez pas au fournisseur avant.`;
      if (!porte && typeof seuil === "number" && seuil > 0) {
        return `Sous le seuil de validation des bons de commande (${seuil.toLocaleString("fr-FR")} DZD) : aucun centre n'a à le valider. ${signature}`;
      }
      return porte?.etat === "VALIDE"
        ? `Validé par le ${LIBELLE_CENTRE_BC[porte.centre]}. ${signature}`
        : `Ce bon de commande attend la signature des Finances (${MENU_BONS_DE_COMMANDE}) : ne l'envoyez pas au fournisseur avant.`;
    }
    case "A_CORRIGER":
      return "Un signataire a renvoyé ce bon de commande pour correction (le motif est sur sa fiche) : modifiez-le — sa modification le rend à la signature. Ne l'envoyez pas au fournisseur avant.";
    case "SIGNE":
    case "HORS_CIRCUIT":
      return null;
  }
}

/** La phrase d'une signature retirée — un seul endroit, lue par toutes les portes d'écriture. */
export const PHRASE_SIGNATURE_RETIREE =
  "Le bon de commande a changé après la signature des Finances : la signature est retirée, il retourne à leur signature.";

/**
 * LA RÉSERVE D'UN BC QU'ON VIENT D'ÉCRIRE — à partir de ce que l'aiguillage a rendu, pour toutes
 * les portes d'écriture (fabrique, demandes de pièce, rattachements).
 *
 * Quatre portes composaient chacune leur réserve (`reserveSansPorte(a) ?? reserveBC(a.porte)`) ;
 * aucune ne connaissait l'étape « à signer », et un BC sous le seuil — sans porte — serait sorti
 * SANS réserve, c'est-à-dire avec l'air d'un BC fini qu'on peut envoyer (§118.5, §118.32). Sans
 * étape (un appelant d'avant la règle), on retombe sur la porte seule.
 */
export function reserveDeLAiguillage(a: {
  porte: PorteBC | null;
  etape?: EtapeBC | null;
  seuil?: number | null;
  sansSiege?: boolean;
  enEchec?: boolean;
  enPrevalidation?: boolean;
  signatureRetiree?: boolean;
}): string | null {
  const sansPorte = reserveSansPorte(a);
  if (sansPorte) return sansPorte;
  const reserve = a.etape ? reserveEtapeBC(a.etape, a.porte, a.seuil) : reserveBC(a.porte);
  return [a.signatureRetiree ? PHRASE_SIGNATURE_RETIREE : null, reserve].filter(Boolean).join(" ") || null;
}

/**
 * POURQUOI CE BC NE SE SIGNE PAS ENCORE — `null` quand il se signe. Le refus nomme l'étape ET
 * le geste qui la lève (§118.30) : « non autorisé » tout court ferait chercher un droit qui n'est
 * pas en cause.
 */
export function motifNonSignable(etape: EtapeBC, porte: PorteBC | null): string | null {
  const centre = porte ? LIBELLE_CENTRE_BC[porte.centre] : "centre de validation";
  switch (etape) {
    case "A_SIGNER": return null;
    case "SIGNE": return "Ce bon de commande est déjà signé.";
    case "A_VALIDER": return `Ce bon de commande attend encore la validation du ${centre} : il se signe une fois validé.`;
    case "A_REVOIR": return `Le ${centre} a demandé de revoir ce bon de commande : il se signe une fois corrigé et validé.`;
    case "REFUSE": return `Ce bon de commande a été refusé par le ${centre} : il ne se signe pas.`;
    case "A_CORRIGER": return "Ce bon de commande a été renvoyé à son émetteur pour correction : il se signe une fois modifié.";
    case "SANS_PORTE":
      return "Ce bon de commande dépasse le seuil de validation et n'est passé par aucun centre : « Adresser au centre », sur sa fiche Legal, puis il se signe une fois validé.";
    case "HORS_CIRCUIT":
      return "Ce bon de commande est antérieur au circuit de validation et de signature : faites-le entrer dans le circuit depuis sa fiche Legal.";
  }
}

/**
 * LE CHANTIER « BON DE COMMANDE » D'UN DOSSIER PEUT-IL SE CLORE ?
 *
 * Il se refermait d'un clic, sans pièce : le circuit court du matériel promotionnel déclarait « BC
 * fait » sans qu'aucun BC n'existe nulle part, et donc sans qu'aucun centre l'ait vu. Il faut
 * maintenant deux faits : AU MOINS UN bon de commande enregistré depuis le dossier, et TOUS
 * validés par leur centre. Un seul BC encore en attente — ou refusé — suffit à tenir le chantier
 * ouvert : clore sur « deux sur trois » serait déclarer fait ce qui ne l'est pas.
 *
 * Un BC SANS porte (enregistré avant la règle) ne passe pas non plus : il n'a été vu par aucun
 * centre. Le refus nomme le geste qui le lui soumet — « Adresser au centre », sur sa fiche Legal.
 *
 * DEPUIS LE SEUIL ET LA SIGNATURE (§118.149) : quand l'appelant connaît l'ÉTAPE de chaque BC
 * (`etapeBC`), c'est elle qui décide, et le chantier ne se clôt qu'une fois TOUS les BC SIGNÉS
 * par les Finances — un BC validé mais pas signé ne part pas chez le fournisseur, donc le chantier
 * n'est pas fait. Un BC sous le seuil n'a pas de porte à attendre : il attend la signature. Sans
 * étape (un appelant d'avant la règle), la porte seule décide, comme avant.
 */
export function chantierBCClos(bcs: readonly {
  reference: string | null;
  porte: PorteBC | null;
  etape?: EtapeBC;
}[]):
  { ok: true } | { ok: false; raison: string } {
  if (bcs.length === 0) {
    return {
      ok: false,
      raison: "Aucun bon de commande n'est enregistré sur ce dossier. Enregistrez-le depuis « Pièces liées » "
        + "(Engagement › Bon de commande) : il passera au centre de validation, et le chantier se clôt une fois le BC validé.",
    };
  }
  const nom = (r: string | null) => (r?.trim() ? r.trim() : "sans numéro");
  // Hors du circuit : aucune porte et pas d'étape qui dise qu'il n'en faut pas, ou une étape qui
  // dit qu'il n'y est jamais entré (« à adresser », « antérieur au circuit »).
  const horsCircuit = bcs.filter((b) => (b.etape ? b.etape === "SANS_PORTE" || b.etape === "HORS_CIRCUIT" : !b.porte));
  if (horsCircuit.length > 0) {
    return {
      ok: false,
      raison: `${horsCircuit.length === 1 ? "Le bon de commande" : "Les bons de commande"} ${horsCircuit.map((b) => nom(b.reference)).join(", ")} `
        + `n'${horsCircuit.length === 1 ? "a" : "ont"} été vu${horsCircuit.length === 1 ? "" : "s"} par aucun centre : ouvrez sa fiche Legal et « Adressez-le au centre ».`,
    };
  }
  const enAttente = bcs.filter((b) => (b.etape
    ? b.etape === "A_VALIDER" || b.etape === "A_REVOIR" || b.etape === "REFUSE"
    : Boolean(b.porte && b.porte.etat !== "VALIDE")));
  if (enAttente.length > 0) {
    const detail = enAttente.map((b) => `${nom(b.reference)} (${b.porte ? LIBELLE_ETAT_BC[b.porte.etat].toLowerCase() : LIBELLE_ETAPE_BC[b.etape!].toLowerCase()})`).join(", ");
    return { ok: false, raison: `Bon(s) de commande pas encore validé(s) par leur centre : ${detail}. Le chantier se clôt une fois tous validés.` };
  }
  const nonSignes = bcs.filter((b) => b.etape === "A_SIGNER" || b.etape === "A_CORRIGER");
  if (nonSignes.length > 0) {
    // Un BC RENVOYÉ à son émetteur n'est pas signé non plus — et le dire, c'est nommer qui a la main.
    const detail = nonSignes.map((b) => `${nom(b.reference)}${b.etape === "A_CORRIGER" ? " (renvoyé à l'émetteur pour correction)" : ""}`).join(", ");
    return {
      ok: false,
      raison: `Bon(s) de commande pas encore signé(s) par les Finances : ${detail}. `
        + `Le chantier se clôt une fois tous signés (${MENU_BONS_DE_COMMANDE}).`,
    };
  }
  return { ok: true };
}
