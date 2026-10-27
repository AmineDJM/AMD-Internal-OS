import { blocageParLeBC, type PorteBC } from "@/lib/bons-de-commande/regle";

/**
 * TOUT PAIEMENT DE LA PLATEFORME PASSE PAR LES FINANCES — ET PAR LE CENTRE DE PAIEMENT.
 *
 * La règle est simple à énoncer et facile à trahir : dès qu'une somme sort de la société ou y
 * entre, une écriture doit apparaître au module Finances. Sans cela, la trésorerie et le budget
 * décrivent une entreprise qui n'existe pas — et personne ne s'en aperçoit, puisque l'écran qui
 * mentirait est justement celui qu'on consulte pour vérifier.
 *
 * LES CHEMINS DE PAIEMENT, ET CE QU'ILS FONT (registre ci-dessous, testé) :
 *
 *   • ORDRE DE DÉPENSE payé → écriture. Déjà en place.
 *   • DEMANDE DE PAIEMENT réglée → écriture. Déjà en place.
 *   • PAIE → un virement par entité et par mois, de la somme DÉCLARÉE par les RH, envoyé au
 *     centre ; l'écriture se pose au règlement de son ordre (§118.176). Le « transfert au budget »
 *     qui écrivait un décaissement par salarié, hors centre, n'existe plus.
 *   • ENCAISSEMENT / DÉCAISSEMENT direct → c'est le module lui-même.
 *   • FACTURE réglée → écriture. C'EST CE QUI MANQUAIT : marquer une facture réglée posait une
 *     date, et rien d'autre.
 *   • CAISSE D'AVANCE remise → un ordre en attente du centre ; l'écriture se pose au versement,
 *     au moment où l'argent quitte la banque (§118.176).
 *   • DÉPENSE SUR CAISSE D'AVANCE → **pas** d'écriture : l'argent a déjà quitté la société quand
 *     la caisse a été remise. En inscrire une seconde compterait le même dinar deux fois — c'est
 *     l'erreur classique, et elle gonfle les dépenses du mois sans que rien ne le signale.
 *
 * Module PUR — testé, sans base de données.
 */

/** Sens de l'argent, tel que le module Finances l'enregistre. */
export type MoneyDirection = "IN" | "OUT";

/**
 * Le décaissement passe-t-il par le CENTRE DE PAIEMENT avant de partir ?
 *
 *   • `AUTORISE` — oui : un ordre de dépense naît « en attente du centre » et `canDisburse`
 *     refuse de le payer sans son autorisation.
 *   • `ENREGISTRE` — le geste n'est pas une décision de payer : il ENREGISTRE un mouvement déjà
 *     fait (frais bancaires, relevé importé, facture réglée avant son enregistrement). Il n'y a
 *     rien à autoriser — mais payer un fournisseur par ce chemin serait un contournement.
 *   • `HORS_CENTRE` — le décaissement est décidé DANS l'ERP sans passer par le centre. C'est une
 *     exception à la règle de la Direction (« tous passent par le centre de paiements ») : elle
 *     est écrite ici pour qu'on sache qu'elle existe, jamais tue — et elle porte la DÉCISION qui
 *     l'assume (`decision`), sans quoi ce n'est pas une exception, c'est un trou.
 */
export type CentrePath = "AUTORISE" | "ENREGISTRE" | "HORS_CENTRE";

/** Un chemin par lequel de l'argent bouge dans la plateforme. */
export interface PaymentPath {
  key: string;
  label: string;
  /** Le module d'où part le geste. */
  module: string;
  /** Une écriture Finances est-elle créée ? */
  settles: boolean;
  /** Pourquoi — surtout quand la réponse est « non ». */
  why: string;
  /** Le centre de paiement voit-il passer ce décaissement AVANT qu'il parte ? */
  centre: CentrePath;
  /** Pourquoi — exigé dès que la réponse n'est pas `AUTORISE`. */
  centreWhy: string;
  /**
   * LA DÉCISION qui assume un chemin `HORS_CENTRE` — qui, quand, et ce qui a été tranché. Exigée
   * sur chaque exception : un décaissement hors centre SANS décision écrite n'est pas une
   * exception, c'est un trou que personne n'a vu (§118.156). Absente partout ailleurs.
   */
  decision?: string;
}

/**
 * LE REGISTRE DES CHEMINS DE PAIEMENT — la liste qu'on relit quand on ajoute un geste d'argent.
 *
 * Il n'est pas décoratif : le test associé vérifie qu'aucun chemin ne reste sans justification,
 * et qu'un chemin qui ne solde pas dit POURQUOI. Ajouter un bouton « payer » quelque part sans
 * l'inscrire ici, c'est rouvrir le trou qu'on vient de fermer.
 */
export const PAYMENT_PATHS: PaymentPath[] = [
  {
    key: "expense-order", label: "Ordre de dépense payé", module: "Finances",
    settles: true, why: "Écriture au paiement, liée à l'ordre (`settleExpenseOrder`).",
    centre: "AUTORISE",
    centreWhy: "Tout ordre naît « en attente du centre » (`initialCentralStatus`) et `settleExpenseOrder` refuse de payer sans son autorisation (`canDisburse`).",
  },
  {
    key: "payment-request", label: "Demande de paiement réglée", module: "Finances",
    settles: true, why: "Écriture au règlement, liée à la demande.",
    centre: "AUTORISE",
    centreWhy: "Le dossier crée son ordre de dépense dès la soumission ; le bon à payer des Finances exige l'autorisation du centre.",
  },
  {
    key: "invoice-settlement", label: "Facture envoyée au règlement", module: "Legal — document de nature facture",
    settles: true, why: "L'ordre de dépense né de la facture écrit au paiement ; la facture ne se solde plus à la main.",
    centre: "AUTORISE",
    centreWhy: "La facture devient un ordre de dépense par la porte commune, en attente du centre ; celle qui découle d'un bon de commande non validé ne part pas (§118.148).",
  },
  {
    key: "payroll", label: "Paie virée par entité", module: "RH → centre de paiement → Finances",
    settles: true,
    why: "Une seule écriture par virement, de la somme DÉCLARÉE par les RH, posée au règlement de son ordre (`settleExpenseOrder`). Le « transfert au budget », qui écrivait un décaissement par salarié, n'existe plus : il compterait la paie une seconde fois.",
    centre: "AUTORISE",
    centreWhy: "« Un bouton pour toute la paie, avec la somme des salaires à virer, un bouton par entité » (la Direction, 01/10/2026) : l'envoi crée un ordre en attente du centre (`envoyerPaieAuCentre`), et les salariés ne sont prévenus du versement qu'au règlement.",
  },
  {
    key: "finance-direct", label: "Encaissement / décaissement direct", module: "Finances",
    settles: true, why: "C'est le module lui-même : l'écriture EST le geste.",
    centre: "ENREGISTRE",
    centreWhy: "Une écriture du livre ENREGISTRE un mouvement déjà fait (frais bancaires, relevé importé, régularisation). Payer un fournisseur passe par un ordre de dépense, donc par le centre.",
  },
  {
    key: "invoice", label: "Facture marquée réglée", module: "Legal — document de nature facture",
    settles: true,
    why: "Écriture au sens de la facture (reçue = sortie, émise = entrée), retirée si l'on dé-marque — SEULEMENT si la facture n'est pas partie au circuit de règlement, qui écrit déjà.",
    centre: "ENREGISTRE",
    centreWhy: "Marquer réglée ENREGISTRE un règlement fait avant l'enregistrement de la facture. La PAYER passe par « Envoyer au règlement », donc par le centre — et une facture partie au circuit ne se marque plus réglée à la main (`canMarkPaidDirectly`).",
  },
  {
    key: "petty-cash-allotment", label: "Caisse d'avance remise", module: "Moyens généraux → centre de paiement → Finances",
    settles: true,
    why: "L'écriture se pose au VERSEMENT de la remise, au règlement de son ordre : c'est là que l'argent quitte la banque. Elle n'est pas classée au budget — chaque achat fait sur la caisse l'est, ticket par ticket.",
    centre: "AUTORISE",
    centreWhy: "« La caisse donnée mensuellement aux moyens généraux doit passer par le centre de paiement et attendre la validation » (la Direction, 01/10/2026) : la remise naît avec son ordre, en attente du centre, et la détentrice ne confirme sa réception qu'une fois l'ordre réglé.",
  },
  {
    key: "petty-cash-top-up", label: "Rallonge de caisse d'avance accordée", module: "Moyens généraux → centre de paiement → Finances",
    settles: true, why: "Accordée, la rallonge devient une remise : son écriture se pose au VERSEMENT, au règlement de son ordre — comme la remise mensuelle, par le même écrivain (`general-means/remettre.ts` pour la rédaction de l'ordre).",
    centre: "AUTORISE",
    centreWhy: "« La rallonge de caisse doit passer dans le centre de paiement » (la Direction, 04/10/2026) : l'accord crée un ordre en attente du centre, et la détentrice ne confirme sa réception qu'une fois l'ordre réglé.",
  },
  {
    key: "petty-cash-expense", label: "Achat payé sur la caisse d'avance", module: "Moyens généraux",
    settles: false,
    why: "L'argent a DÉJÀ quitté la société lors de la remise de la caisse. Une seconde écriture compterait le même dinar deux fois.",
    centre: "ENREGISTRE",
    centreWhy: "L'argent est déjà sorti à la remise : l'achat sur caisse ne décaisse rien de plus.",
  },
];

/** Le chemin correspondant à une clé — `undefined` si la clé est inconnue. */
export function paymentPath(key: string): PaymentPath | undefined {
  return PAYMENT_PATHS.find((p) => p.key === key);
}

/** Les chemins qui NE créent pas d'écriture — chacun doit porter sa raison. */
export function nonSettlingPaths(): PaymentPath[] {
  return PAYMENT_PATHS.filter((p) => !p.settles);
}

/**
 * LES EXCEPTIONS À « TOUS LES PAIEMENTS PAR LE CENTRE » — ASSUMÉES par la Direction.
 *
 * Le 28/09/2026 elle avait gardé trois exceptions (paie, remise et rallonge de caisse d'avance) ;
 * le 01/10/2026 elle a fait passer la paie et la remise mensuelle par le centre, et le 04/10/2026 la
 * rallonge. Il n'en reste aucune. Les lister n'était pas les autoriser ; c'est la DÉCISION écrite sur
 * chacune qui les autorise, et un chemin qui changerait de camp sans décision ferait tomber le banc.
 */
export function horsCentre(): PaymentPath[] {
  return PAYMENT_PATHS.filter((p) => p.centre === "HORS_CENTRE");
}

/**
 * Le sens de l'écriture d'une facture.
 *
 * `OUT` : facture REÇUE, la société paie. `IN` : facture ÉMISE, elle encaisse. On ne DEVINE
 * jamais à partir des noms du payeur ou du destinataire : ce sont des chaînes libres, et une
 * écriture posée à l'envers est pire qu'une écriture absente — elle se voit moins.
 */
export function invoiceDirection(raw: string | null | undefined): MoneyDirection {
  return raw === "IN" ? "IN" : "OUT";
}

/** Le libellé de l'écriture d'une facture — reconnaissable dans le journal des Finances. */
export function invoiceSettlementLabel(invoice: { reference?: string | null; title: string }): string {
  const ref = invoice.reference?.trim();
  return ref ? `Facture ${ref} — ${invoice.title}` : `Facture — ${invoice.title}`;
}

/**
 * Faut-il créer, retirer, ou ne rien faire ?
 *
 * `paidDate` posée et aucune écriture → CREATE. `paidDate` retirée et une écriture existe →
 * REMOVE (on ne laisse pas traîner l'écriture d'un règlement annulé). Le reste → NOOP, y compris
 * une facture déjà réglée qu'on ré-enregistre : re-créer l'écriture la doublerait.
 *
 * ── LE CIRCUIT A LA PRIORITÉ, ET C'EST ARITHMÉTIQUE ─────────────────────────────────────────
 *
 * Une facture a DEUX chemins vers l'argent : l'envoi au règlement (`expenseOrderId` → centre de
 * paiement → ordre payé, qui écrit son écriture) et la saisie directe d'une date de paiement
 * (la facture déjà réglée qu'on enregistre après coup). Les laisser tourner tous les deux sur la
 * même pièce inscrirait le même décaissement DEUX FOIS : le total du mois gonflerait sans que
 * rien ne le signale, et c'est exactement le défaut qu'on vient de fermer ailleurs.
 *
 * Dès qu'une facture est partie au circuit, la saisie directe se tait. Elle ne « échoue » pas :
 * elle n'a plus rien à faire — l'écriture viendra du paiement de l'ordre.
 */
export function settlementAction(input: {
  paidDate: Date | null;
  transactionId: string | null;
  /** L'ordre de dépense né de cette facture. Non nul = le circuit possède le règlement. */
  expenseOrderId?: string | null;
}): "CREATE" | "REMOVE" | "NOOP" {
  // Le retrait reste possible même sous circuit : une écriture directe posée AVANT l'envoi doit
  // pouvoir être défaite, sinon elle resterait au livre sans plus rien pour la corriger.
  if (input.expenseOrderId && !input.transactionId) return "NOOP";
  if (input.paidDate && !input.transactionId) return "CREATE";
  if (!input.paidDate && input.transactionId) return "REMOVE";
  return "NOOP";
}

export type SettlementCheck = { ok: true } | { ok: false; error: string };

/**
 * UNE FACTURE QUE LA SOCIÉTÉ A ÉMISE se règle par son CLIENT (§118.195) : le centre de paiement n'autorise que des
 * DÉPENSES, et lui envoyer une facture de vente ouvrirait un ordre de décaissement pour de l'argent qui doit entrer.
 * La phrase est lue par l'action ET par la fiche, qui ne propose donc pas le bouton (§118.83).
 */
export const REFUS_FACTURE_EMISE_AU_REGLEMENT =
  "Cette facture a été émise par la société : c'est son client qui la règle. Renseignez sa date de règlement quand le paiement arrive — le centre de paiement n'autorise que des dépenses.";

/**
 * LA FACTURE D'UN POSTE Ad & Pro SE PAIE PAR SON POSTE (audit du 27/10/2026, ADPRO-01).
 *
 * Déposée sur un poste (`deposerFacturePoste`), elle est aussi une pièce du registre Legal — et « Envoyer au
 * règlement » y ouvrait un SECOND chemin vers le centre de paiement : sans la porte du DG sur le total, sans le
 * plafond du montant accordé, sans le budget du poste, et sans poser `expenseOrderId` sur le poste — qui pouvait
 * donc demander son propre paiement ensuite, pour la même facture. La phrase est lue par l'action ET par la fiche.
 */
export function refusFactureDePoste(libellePoste: string): string {
  return `Cette facture appartient au poste « ${libellePoste} » d'une demande Ad & Pro : son paiement se demande depuis le poste `
    + "(« Demander le paiement »), qui applique la validation du Directeur Général, le montant accordé et le budget du poste.";
}

/**
 * PEUT-ON ENVOYER CETTE FACTURE AU RÈGLEMENT ?
 *
 * Le refus NOMME ce qui bloque : « envoi impossible » fait rouvrir la fiche trois fois avant de
 * comprendre que la facture est déjà partie. Et il ferme le double comptage par l'autre bout —
 * une facture déjà réglée en direct n'a plus rien à envoyer au centre de paiement.
 */
export function canSendToSettlement(input: {
  kind: string;
  amount: number | null;
  paidDate: Date | null;
  expenseOrderId: string | null;
  /**
   * LE BON DE COMMANDE DONT LA FACTURE DÉCOULE (`chainFromId`), et sa porte (§118.148).
   *
   * Une facture qui suit un BC que son centre n'a pas validé ne part pas au paiement : payer
   * l'exécution d'une commande que la société n'a pas engagée, c'est le contournement exact que
   * la porte existe pour fermer. `null` (pas de BC amont, ou BC d'avant la règle) ne bloque rien.
   */
  bc?: { porte: PorteBC | null; reference: string | null } | null;
  /**
   * L'ORDRE DÉJÀ LIÉ, quand il y en a un (§118.185, audit 360° I8). Une facture que le centre de
   * paiement a REFUSÉE, ou dont l'ordre a été ANNULÉ, restait « déjà partie au règlement » pour
   * toujours : ni payable, ni renvoyable. Un ordre refusé ou annulé ne paiera jamais — la facture
   * peut repartir, et le nouvel envoi remplace l'ancien lien. Sans ce fait (`undefined`), la règle
   * reste celle d'avant : un lien bloque.
   */
  ordreLie?: { status: string; centralStatus: string } | null;
  /** LE SENS DE LA FACTURE (`direction`) : « IN » = émise par la société. Absent : facture reçue, comme avant. */
  direction?: string | null;
  /** LE POSTE Ad & Pro dont c'est la facture (pièce FACTURE du poste), s'il y en a un : il paie par sa propre porte. */
  posteAdPro?: { label: string } | null;
}): SettlementCheck {
  if (input.kind !== "INVOICE") {
    return { ok: false, error: "Seul un document de nature « facture » s'envoie au règlement." };
  }
  if (input.direction === "IN") return { ok: false, error: REFUS_FACTURE_EMISE_AU_REGLEMENT };
  if (input.posteAdPro) return { ok: false, error: refusFactureDePoste(input.posteAdPro.label) };
  if (input.expenseOrderId && !ordreClos(input.ordreLie)) return { ok: false, error: "Cette facture est déjà partie au règlement." };
  if (input.paidDate) {
    return {
      ok: false,
      error: "Cette facture porte déjà une date de règlement : l'envoyer au paiement décaisserait une seconde fois. Effacez la date si le règlement n'a pas eu lieu.",
    };
  }
  if (!input.amount || input.amount <= 0) return { ok: false, error: "Renseignez d'abord le montant de la facture." };
  const bloque = input.bc ? blocageParLeBC(input.bc.porte, input.bc.reference) : null;
  if (bloque) return { ok: false, error: bloque };
  return { ok: true };
}

/**
 * LA CLÉ D'ENVOI D'UNE FACTURE — une seule, lue par les deux portes qui l'envoient au règlement (la
 * fiche Legal et le dossier du matériel promotionnel) : deux clés pour la même pièce laisseraient
 * deux clics simultanés, un sur chaque écran, ouvrir deux ordres (§118.185).
 */
export function cleEnvoiAuReglement(invoiceId: string | null): string {
  return `reglement-facture:${invoiceId ?? ""}`;
}

/** Un ordre qui ne paiera jamais : annulé, ou refusé par le centre de paiement. */
export function ordreClos(ordre: { status: string; centralStatus: string } | null | undefined): boolean {
  if (!ordre) return false;
  return ordre.status === "CANCELLED" || ordre.centralStatus === "REFUSED";
}

/**
 * PEUT-ON POSER À LA MAIN LA DATE DE RÈGLEMENT ?
 *
 * Non, si la facture est partie au circuit : son paiement la soldera, et la marquer réglée
 * d'avance écrirait la date d'un virement qui n'a pas encore eu lieu. L'écran dirait « réglée »
 * sur un dossier que les Finances tiennent encore ouvert — et personne ne rouvre ce qui a l'air
 * fini. EFFACER la date reste toujours possible : défaire une erreur ne doit jamais se bloquer.
 */
export function canMarkPaidDirectly(input: {
  paidDate: Date | null;
  expenseOrderId: string | null;
}): SettlementCheck {
  if (input.paidDate && input.expenseOrderId) {
    return {
      ok: false,
      error: "Cette facture est partie au règlement : son paiement la soldera. Suivez-la depuis le centre de paiement.",
    };
  }
  return { ok: true };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * QUI DATE LE RÈGLEMENT D'UNE FACTURE (audit Assistante de direction, 10/2026).
 *
 * Le défaut : la date de règlement d'une facture se posait par qui ÉCRIT la pièce — Legal compris. Sur
 * une facture sans ordre, la poser la déclarait « réglée » et inscrivait le mouvement au livre
 * (`syncInvoiceSettlement`) : la facture sortait du circuit du centre de paiement sans que les Finances
 * l'aient vue, et le bouton « Envoyer au règlement » se taisait ensuite (`canSendToSettlement`).
 *
 * La règle : la date (la poser, la changer, l'effacer — c'est l'écriture du livre qui bouge) appartient
 * à qui RÈGLE aux Finances, le droit même que le paiement d'un ordre exige (`settleExpenseOrder` :
 * Finances, modifier). Les autres voient la date, ne la changent pas : l'action refuse, et l'écran
 * masque le champ — la même fonction pour les deux, pas deux copies (§118.5).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export function peutDaterLeReglement(droits: { financesModifier: boolean }): boolean {
  return droits.financesModifier;
}

/** La phrase du refus — lue par les actions ; l'écran, lui, ne propose pas le champ. */
export const REFUS_DATE_REGLEMENT_HORS_FINANCES =
  "La date de règlement d'une facture se pose par les Finances, qui règlent : envoyez la facture au règlement (centre de paiement) ou demandez-leur d'enregistrer un paiement déjà fait.";

/** Deux dates de règlement désignent-elles le même jour ? (un formulaire renvoie la date sans l'heure) */
function memeJour(a: Date | null, b: Date | null): boolean {
  if (!a || !b) return a === b;
  return a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10);
}

/**
 * LA DATE DE RÈGLEMENT À ÉCRIRE — celle d'avant si le champ n'a pas été envoyé (l'écran ne le montre pas
 * à qui ne règle pas : son absence ne doit pas EFFACER la date posée par les Finances), la demandée si la
 * personne règle, et un refus si quelqu'un d'autre tente de la changer. Renvoyer la même date est permis
 * (un formulaire qui la recharge telle quelle ne change rien).
 */
export function dateDeReglementAEcrire(input: {
  avant: Date | null;
  demandee: Date | null;
  /** Le champ figure-t-il dans ce qui est envoyé ? */
  champEnvoye: boolean;
  financesModifier: boolean;
}): { ok: true; paidDate: Date | null } | { ok: false; error: string } {
  if (!input.champEnvoye) return { ok: true, paidDate: input.avant };
  if (peutDaterLeReglement(input)) return { ok: true, paidDate: input.demandee };
  if (memeJour(input.avant, input.demandee)) return { ok: true, paidDate: input.avant };
  return { ok: false, error: REFUS_DATE_REGLEMENT_HORS_FINANCES };
}
