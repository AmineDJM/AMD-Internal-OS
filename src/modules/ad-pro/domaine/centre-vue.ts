import { AD_PRO_KINDS } from "./unified";
import { estFormeBC, type FormeBC, type FormePorte, type LigneCentre } from "./centre";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CE QUE L'ÉCRAN DU CENTRE AD & PRO MONTRE D'UNE LIGNE — maquette validée le 24/11/2026.
 *
 * La file « À décider » (une ligne : objet, montant, société, nature, demandeur, depuis quand, budget
 * restant, pièces, alerte courte) et la fiche de décision à droite. Ce module ne lit rien : il reçoit la
 * ligne (`LigneCentre`) et son contexte (`ContexteLigneCentre`, chargé en lot côté serveur) et dit ce qui
 * s'affiche. Les décisions restent celles des actions serveur existantes — l'écran ne fait que les nommer.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Une pièce ouvrable depuis la fiche (aperçu sans quitter le centre). */
export interface PieceCentre {
  nom: string;
  /** Le `Document` à ouvrir ; `null` = pièce enregistrée sans fichier. */
  documentId: string | null;
  nature: "DEVIS" | "BC" | "FACTURE" | "PIECE";
}

/** Une étape déjà franchie en amont (« Déjà validé »). */
interface EtapeCentre {
  etape: string;
  detail: string | null;
}

/** Un poste de la demande (le total que le DG valide en est la somme). */
export interface PosteCentre {
  libelle: string;
  voie: "AGENCE" | "DIRECT" | null;
  /** Le devis retenu (prestataire, ou « 2 écartés »). */
  devis: string | null;
  montant: number | null;
  refuse: boolean;
}

/** Un devis reçu pour le poste d'un bon de commande. */
interface DevisCentre {
  prestataire: string;
  montant: number | null;
  /** `false` = écarté par qui a choisi ; `null` = aucun choix lisible (un seul devis, ou rien de tranché). */
  retenu: boolean | null;
  documentId: string | null;
}

/** Un message du fil de la demande (ou du poste). */
interface MessageCentre {
  auteur: string | null;
  le: string;
  texte: string;
}

/** Le contexte d'une ligne — tout ce qui n'est pas sur `LigneCentre`, lu en lot par le serveur. */
export interface ContexteLigneCentre {
  societeId: string | null;
  societe: string | null;
  /** L'opération d'un bon de commande (« Congrès de cardiologie — SPO-2026-047 ») ; `null` pour une demande. */
  operation: string | null;
  /** Le poste d'un bon de commande. */
  poste: string | null;
  /** Quand la demande a été créée (ISO). */
  creeLe: string | null;
  /** La ligne budgétaire imputée et son disponible (enveloppe − payé − engagé) ; `null` = rien d'imputé. */
  budget: { ligne: string; disponible: number; autres: number } | null;
  pieces: PieceCentre[];
  chaine: EtapeCentre[];
  postes: PosteCentre[];
  devis: DevisCentre[];
  /** Le montant ACCORDÉ au(x) poste(s) d'un bon de commande. */
  accorde: number | null;
  /** Ce qui a déjà été payé sur l'opération (ordres réglés). */
  dejaPaye: number;
  fil: MessageCentre[];
  /** Où écrire une question au demandeur (fil de la demande ou du poste) ; `null` = pas de fil. */
  filCible: { entityType: string; entityId: string } | null;
}

export const CONTEXTE_VIDE: ContexteLigneCentre = {
  societeId: null, societe: null, operation: null, poste: null, creeLe: null, budget: null,
  pieces: [], chaine: [], postes: [], devis: [], accorde: null, dejaPaye: 0, fil: [], filCible: null,
};

/** La clé d'une ligne — la même partout (file, contexte, décisions locales). */
export const cleLigne = (r: Pick<LigneCentre, "entityType" | "entityId">): string => `${r.entityType}:${r.entityId}`;

const JOUR = 86_400_000;

/** Jours entiers d'attente. */
export function joursDAttente(depuis: string, maintenant: Date): number {
  return Math.max(0, Math.floor((maintenant.getTime() - new Date(depuis).getTime()) / JOUR));
}

/** Une ligne qui dort depuis une semaine bloque quelqu'un : elle se lit en rouge. */
export const DORMANTE_JOURS = 7;

/** « aujourd'hui », « depuis 4 j ». */
export function phraseAttente(jours: number): string {
  return jours === 0 ? "aujourd'hui" : `depuis ${jours} j`;
}

/** La nature lisible d'une ligne : « Bon de commande », ou la nature Ad & Pro de la demande. */
export function natureDeLaLigne(r: Pick<LigneCentre, "forme" | "kind">): string {
  if (estFormeBC(r.forme)) return "Bon de commande";
  if (r.forme === "TOTAL_DG") return "Total de la demande";
  return AD_PRO_KINDS.find((k) => k.kind === r.kind)?.label ?? "Demande";
}

/** La nature sur la ligne de la file : « BC · Sponsoring » pour un bon de commande, la nature sinon. */
export function natureDeLaLigneCourte(r: Pick<LigneCentre, "forme" | "kind">): string {
  if (!estFormeBC(r.forme)) return natureDeLaLigne(r);
  const n = natureDeLaDemande(r);
  return n ? `BC · ${n}` : "Bon de commande";
}

/** La nature de la DEMANDE d'origine (pour un BC : celle de l'opération qui l'a fait naître). */
export function natureDeLaDemande(r: Pick<LigneCentre, "kind">): string | null {
  return AD_PRO_KINDS.find((k) => k.kind === r.kind)?.label ?? null;
}

export type ChoixCentre = "VALIDER" | "RENVOYER" | "REFUSER";

/** Les gestes qu'une forme offre ICI — chacun porté par l'action serveur qui le décide déjà. */
interface GestesForme {
  /** `null` = la décision se prend devant le dossier (étape de circuit, ancien parcours). */
  ok: string | null;
  renvoyer: string | null;
  refuser: string | null;
  /** Écrire une question au demandeur dans le fil, sans décider. */
  precision: boolean;
  motifs: readonly string[];
  /** Ce que lit le demandeur — dit au-dessus des motifs. */
  titreMotif: string;
}

const MOTIFS_DEMANDE = ["Hors budget de l'exercice", "Postes à réduire", "Opération non prioritaire", "Doublon avec une autre opération"] as const;
const MOTIFS_BC = ["Écart avec le devis retenu", "Lignes à corriger", "Choix du prestataire à justifier", "Pièce illisible ou incomplète"] as const;

/**
 * LES GESTES PAR FORME — les libellés de la maquette, ramenés à ce que l'action serveur fait vraiment.
 *
 * Le total d'une demande ne se REFUSE pas : `statuerTotalDg` le valide ou le RENVOIE EN RÉVISION. Le BC d'un poste
 * se vise ou se refuse (`approveAdProItemOrder`) ; un BC du registre Legal et une demande à visa ont les trois issues
 * (`deciderVisaCentreAdPro`). Les autres formes se décident sur leur dossier, par l'action de leur circuit.
 */
export function gestesDeLaForme(forme: FormePorte | FormeBC): GestesForme {
  switch (forme) {
    case "TOTAL_DG":
      return { ok: "Valider le total", renvoyer: "Renvoyer en révision", refuser: null, precision: true, motifs: MOTIFS_DEMANDE, titreMotif: "Ce qu'il faut revoir — transmis au demandeur et à la Direction Marketing" };
    case "VISA_CENTRE":
      return { ok: "Autoriser le dépassement", renvoyer: "Renvoyer", refuser: "Refuser", precision: true, motifs: MOTIFS_DEMANDE, titreMotif: "Motif — c'est ce que lira le demandeur" };
    case "BC_LEGAL":
      return { ok: "Viser le BC", renvoyer: "Renvoyer", refuser: "Refuser", precision: false, motifs: MOTIFS_BC, titreMotif: "Motif — l'émetteur corrige le BC" };
    case "BC_POSTE":
      return { ok: "Viser le BC", renvoyer: null, refuser: "Refuser", precision: false, motifs: MOTIFS_BC, titreMotif: "Motif du refus — le demandeur corrige sa demande de BC" };
    default:
      return { ok: null, renvoyer: null, refuser: null, precision: false, motifs: [], titreMotif: "" };
  }
}

/** Ce que la ligne devient, à l'écran, juste après la décision (avant que la file ne se recharge). */
export function etatApresDecision(forme: FormePorte | FormeBC, choix: ChoixCentre | "PRECISION"): string {
  if (choix === "PRECISION") return "Précision demandée";
  if (choix === "VALIDER") return estFormeBC(forme) ? "Visé" : forme === "VISA_CENTRE" ? "Autorisé" : "Validé";
  if (choix === "RENVOYER") return "Renvoyé";
  return "Refusé";
}

/** La phrase de statut affichée sur la fiche une fois la décision enregistrée. */
export function phraseApresDecision(forme: FormePorte | FormeBC, choix: ChoixCentre | "PRECISION", motif: string | null): string {
  const m = motif ? ` — « ${motif} »` : "";
  if (choix === "PRECISION") return `Question envoyée dans le fil de la demande${m}. Elle reste ici jusqu'à votre décision.`;
  if (choix === "VALIDER") {
    if (forme === "TOTAL_DG") return "Total validé — les bons de commande de la demande peuvent partir.";
    if (forme === "VISA_CENTRE") return "Dépassement autorisé — la demande poursuit son circuit.";
    return "BC visé — il part à la signature des Finances.";
  }
  if (choix === "RENVOYER") return `Renvoyé pour correction${m}.`;
  return `Refusé${m}.`;
}

export interface AlerteCentre {
  titre: string;
  detail: string;
}

const dzd = (n: number): string => `${Math.round(n).toLocaleString("fr-FR")} DZD`;

/**
 * LES ALERTES D'UNE LIGNE — en rouge sur la fiche, le titre seul sur la file. Elles ne décident de rien :
 * elles disent ce qu'on regarderait de toute façon avant de viser.
 */
export function alertesDeLaLigne(r: Pick<LigneCentre, "montant" | "forme">, c: ContexteLigneCentre): AlerteCentre[] {
  const out: AlerteCentre[] = [];
  if (r.montant == null || !(r.montant > 0)) {
    out.push({ titre: "Montant non renseigné", detail: estFormeBC(r.forme) ? "ouvrez la pièce pour le lire avant de viser" : "la demande passe ici faute de montant" });
  }
  if (c.budget && c.budget.disponible < 0) {
    out.push({ titre: "Budget dépassé", detail: `la ligne ${c.budget.ligne} est à ${dzd(c.budget.disponible)}` });
  }
  if (estFormeBC(r.forme) && r.montant != null && c.accorde != null && r.montant - c.accorde >= 0.005) {
    out.push({ titre: "BC au-dessus de l'accordé", detail: `${dzd(r.montant)} contre ${dzd(c.accorde)} accordés (+${dzd(r.montant - c.accorde)})` });
  }
  const retenu = c.devis.find((d) => d.retenu === true);
  const moinsCher = retenu?.montant != null
    ? c.devis.filter((d) => d.retenu === false && d.montant != null && d.montant < retenu.montant!).sort((a, b) => a.montant! - b.montant!)[0]
    : undefined;
  if (retenu && moinsCher) {
    out.push({ titre: "Devis le moins cher écarté", detail: `${moinsCher.prestataire} à ${dzd(moinsCher.montant!)} (−${dzd(retenu.montant! - moinsCher.montant!)})` });
  }
  if (estFormeBC(r.forme) && c.pieces.length === 0) {
    out.push({ titre: "Aucune pièce", detail: "ni devis ni bon de commande joint" });
  }
  return out;
}

/** L'alerte de la file : les titres, en une ligne. */
export function alerteCourte(alertes: readonly AlerteCentre[]): string | null {
  return alertes.length ? alertes.map((a) => a.titre).join(" · ") : null;
}

/** « Devis retenu → Accordé → BC » d'un bon de commande, l'écart signalé. Vide pour une demande. */
export function montantsDuBC(r: Pick<LigneCentre, "montant" | "forme">, c: ContexteLigneCentre): { libelle: string; valeur: number; ecart: boolean }[] {
  if (!estFormeBC(r.forme)) return [];
  const out: { libelle: string; valeur: number; ecart: boolean }[] = [];
  const retenu = c.devis.find((d) => d.retenu === true) ?? (c.devis.length === 1 ? c.devis[0] : undefined);
  if (retenu?.montant != null) out.push({ libelle: "Devis retenu", valeur: retenu.montant, ecart: false });
  if (c.accorde != null) out.push({ libelle: "Accordé", valeur: c.accorde, ecart: retenu?.montant != null && Math.abs(c.accorde - retenu.montant) >= 0.005 });
  if (r.montant != null) out.push({ libelle: "BC", valeur: r.montant, ecart: c.accorde != null && Math.abs(r.montant - c.accorde) >= 0.005 });
  return out;
}

/** Une pastille de société : la clé (`null` = toutes), son nom, ce qui y attend. */
interface SocieteCentre {
  cle: string | null;
  nom: string;
  enAttente: number;
}

/**
 * LES PASTILLES DE SOCIÉTÉ — « Toutes », puis chaque société que la personne voit, dans l'ordre reçu. Une ligne sans
 * société ne se range sous aucune : elle n'apparaît que sous « Toutes ».
 */
export function societesDuCentre(
  societes: readonly { id: string; nom: string }[],
  lignes: readonly { societeId: string | null }[],
): SocieteCentre[] {
  const compte = new Map<string, number>();
  for (const l of lignes) if (l.societeId) compte.set(l.societeId, (compte.get(l.societeId) ?? 0) + 1);
  return [{ cle: null, nom: "Toutes", enAttente: lignes.length }, ...societes.map((s) => ({ cle: s.id, nom: s.nom, enAttente: compte.get(s.id) ?? 0 }))];
}

/** La phrase unique des seuils — dite une fois, dans la bulle ⓘ de la file. */
export function phraseSeuils(seuilDemandes: number, seuilBC: number): string {
  const d = seuilDemandes > 0 ? `les demandes dont le total dépasse ${dzd(seuilDemandes)}` : "aucune demande (seuil à 0)";
  const b = seuilBC > 0 ? `les bons de commande au-dessus de ${dzd(seuilBC)}` : "tous les bons de commande nés d'Ad & Pro";
  return `Passent ici ${d}, et ${b}.`;
}

/** L'issue d'une décision passée du centre, telle que « Déjà décidés » l'affiche. */
export type EtatDecide = "VALIDE" | "VISE" | "AUTORISE" | "RENVOYE" | "REFUSE";

/** Une décision récente du centre (menu ⋯ « Déjà décidés »). */
export interface DecisionCentre {
  cle: string;
  entityType: string;
  entityId: string;
  objet: string;
  montant: number | null;
  etat: EtatDecide;
  decideur: string | null;
  le: string | null;
  note: string | null;
  /** Un refus de visa sur une demande qui attend encore : un siège peut le réexaminer. */
  reexaminable: boolean;
  href: string;
}
