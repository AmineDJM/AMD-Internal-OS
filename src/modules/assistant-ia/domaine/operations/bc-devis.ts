import { plier } from "@/lib/utils";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE BON DE COMMANDE DEPUIS UN DEVIS — ce que la carte DIT (lot B1, décision 0049). Pur.
 *
 * Mesuré le 02/11 (« catastrophique », la Direction) : la carte répétait « ce nom provient du
 * document… » trois fois, « Contrôle des totaux » quatre fois plus une redite, annonçait « Au-dessus
 * du seuil de 0 DZD », rattachait du matériel promotionnel à l'enveloppe « Regulatory » (la plus
 * récente, quelle qu'elle soit), et ne créait pas le PDF demandé. Ici, chaque chose se dit UNE fois :
 * la provenance, l'écart éventuel (une phrase, les lignes douteuses nommées), les taxes recalculées
 * contre celles du papier, et l'enveloppe proposée selon la NATURE de ce qu'on commande.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type NatureCommande = "PROMO_MATERIAL" | "EVENTS" | "GENERAL";

const MOTS_PROMO = /\b(promo\w*|publicit\w*|marketing|communication|impression|imprim\w*|flyers?|depliants?|brochures?|affiches?|banners?|roll[- ]?up|kakemonos?|stickers?|goodies|objets? (promotionnels?|publicitaires?)|stylos?|mugs?|casquettes?|polos?|cles? usb|calendriers?|fiches? posologiques?|visuels?|conception|charte graphique|signaletique|enseignes?|totems?|vitrophanie|presentoirs?|plv)\b/g;
const MOTS_EVENEMENT = /\b(congres|stand|evenement\w*|seminaires?|symposium|salon|restauration|pause[- ]cafe|cocktail|hotesses?|traiteur|hebergement|navette|badges?)\b/g;

/** Ce qu'on commande, lu sur les désignations et l'objet : le matériel promotionnel, un événement, ou autre chose. */
export function natureDeLaCommande(textes: readonly (string | null | undefined)[]): NatureCommande {
  const t = plier(textes.filter(Boolean).join(" \n "));
  const promo = t.match(MOTS_PROMO)?.length ?? 0;
  const evt = t.match(MOTS_EVENEMENT)?.length ?? 0;
  if (promo === 0 && evt === 0) return "GENERAL";
  return evt > promo ? "EVENTS" : "PROMO_MATERIAL";
}

export const LIBELLE_NATURE: Record<NatureCommande, string> = {
  PROMO_MATERIAL: "matériel promotionnel",
  EVENTS: "événement",
  GENERAL: "achat général",
};

export interface EnveloppeCandidate {
  id: string;
  name: string;
  modules: readonly string[];
  domaine: string;
  isActive: boolean;
  periodStart: string;
  periodEnd: string;
}

/**
 * L'ENVELOPPE PROPOSÉE : celle que la personne a nommée, sinon celle qui couvre la NATURE (module
 * PROMO_MATERIAL, EVENTS…), du pôle Marketing pour du promotionnel ou un événement — jamais une
 * enveloppe Regulatory pour du matériel promotionnel —, active et en cours. `null` : aucune ne convient,
 * on ne propose rien plutôt qu'une enveloppe au hasard.
 */
export function choisirEnveloppe(
  enveloppes: readonly EnveloppeCandidate[],
  nature: NatureCommande,
  voulue: string | null,
  aujourdhui: Date,
): { enveloppe: EnveloppeCandidate; raison: string } | null {
  if (voulue && voulue.trim()) {
    const v = plier(voulue.trim());
    const e = enveloppes.find((x) => plier(x.name) === v) ?? enveloppes.find((x) => plier(x.name).includes(v));
    return e ? { enveloppe: e, raison: "choisie par vous" } : null;
  }
  const iso = aujourdhui.toISOString();
  const marketing = nature === "PROMO_MATERIAL" || nature === "EVENTS";
  const modulesVoulus = nature === "PROMO_MATERIAL" ? ["PROMO_MATERIAL"] : nature === "EVENTS" ? ["EVENTS", "CONGRESS_NATIONAL", "CONGRESS_INTERNATIONAL", "SPONSORING"] : [];
  const nomVoulu = nature === "PROMO_MATERIAL" ? /(promo|marketing|communication|publicit)/ : nature === "EVENTS" ? /(evenement|event|congres|marketing)/ : /(general|fonctionnement|achats?|moyens generaux)/;
  let meilleure: { e: EnveloppeCandidate; score: number } | null = null;
  for (const e of enveloppes) {
    const dom = (e.domaine ?? "GENERAL").toUpperCase();
    // Le pôle exclu : du promotionnel ne s'impute ni au Regulatory ni aux Opérations.
    if (marketing && (dom === "REGULATORY" || dom === "OPERATIONS")) continue;
    if (!marketing && dom === "REGULATORY") continue;
    let score = 0;
    if (e.modules.some((m) => modulesVoulus.includes(m))) score += 4;
    if (marketing && dom === "MARKETING") score += 3;
    if (nomVoulu.test(plier(e.name))) score += 2;
    if (e.isActive) score += 1;
    if (e.periodStart <= iso && iso <= e.periodEnd) score += 1;
    if (score < (marketing ? 3 : 2)) continue; // une enveloppe qui ne couvre ni la nature ni le pôle ne se propose pas
    if (!meilleure || score > meilleure.score) meilleure = { e, score };
  }
  return meilleure ? { enveloppe: meilleure.e, raison: `couvre le ${LIBELLE_NATURE[nature]}` } : null;
}

/** La provenance, dite UNE fois. */
export function phraseProvenance(methode: "positions" | "modele" | "vision" | null | undefined): string {
  const d = methode === "positions" ? "lus sur le tableau du PDF" : methode === "vision" ? "lus sur l'image des pages" : "lus sur le devis";
  return `Lignes et montants ${d}, à vérifier contre le papier.`;
}

const c2 = (n: number) => Math.round(n * 100) / 100;

/**
 * LES TAXES, RECALCULÉES DEPUIS LES LIGNES ET COMPARÉES UNE FOIS au papier. Une phrase quand elles
 * diffèrent (au dinar près), rien quand elles concordent ou que le papier n'imprime rien.
 */
export function phraseTaxes(
  calc: { tva: number; taxe: number; ttc: number },
  imprime: { tva: number | null; taxe: number | null; ttc: number | null } | null | undefined,
  fmt: (n: number) => string,
): string | null {
  if (!imprime) return null;
  const ecarts: string[] = [];
  const cmp = (lib: string, c: number, i: number | null) => { if (i !== null && Math.abs(c2(c) - i) > 1) ecarts.push(`${lib} ${fmt(c2(c))} recalculée, ${fmt(i)} imprimée`); };
  cmp("TVA", calc.tva, imprime.tva);
  cmp("taxe", calc.taxe, imprime.taxe);
  cmp("TTC", calc.ttc, imprime.ttc);
  return ecarts.length ? `Taxes : ${ecarts.join(" ; ")} — le BC porte le recalcul.` : null;
}

/** Une ligne du détail (panneau) : « 2. Conception ADV — 1 × 145 000 DZD = 145 000 DZD ». */
export function ligneDeDetail(l: { rang: number; designation: string; quantite: number | null; prixUnitaire: number | null }, fmt: (n: number) => string): string {
  const total = l.quantite !== null && l.prixUnitaire !== null ? fmt(c2(l.quantite * l.prixUnitaire)) : "?";
  return `${l.rang}. ${l.designation} — ${l.quantite ?? "?"} × ${l.prixUnitaire !== null ? fmt(l.prixUnitaire) : "?"} = ${total}`;
}

/** Les avertissements, sans redite : une phrase contenue dans une autre disparaît. */
export function sansRedite(phrases: readonly (string | null | undefined | false)[]): string[] {
  const k = (s: string) => plier(s).replace(/[^a-z0-9]+/g, " ").trim();
  const garde: string[] = [];
  for (const p of phrases) {
    if (!p || !p.trim()) continue;
    const kp = k(p);
    if (garde.some((g) => k(g).includes(kp))) continue;
    for (let i = garde.length - 1; i >= 0; i--) if (kp.includes(k(garde[i]))) garde.splice(i, 1);
    garde.push(p.trim());
  }
  return garde;
}

// ─────────────────────────────── Le cycle du BC composé depuis un devis ───────────────────────────────

/**
 * LE CYCLE DU BC DEPUIS UN DEVIS — des états lus sur la pièce, des transitions dont les PRÉCONDITIONS sont tenues
 * par le code, jamais par la consigne du modèle :
 *
 *   (devis lu) ──CREER──▶ BROUILLON (numéroté, PDF au Drive, en pré-validation, sans demande)
 *   BROUILLON ──ENVOYER_EN_VALIDATION (validateur exigé)──▶ EN_VALIDATION ──▶ VALIDE ──▶ SIGNE (circuit des BC)
 *   tout état sauf ANNULE ──ANNULER (K10b : statut ANNULÉ, numéro consommé, fichiers gardés)──▶ ANNULE
 *
 * CREER n'exige PAS de validateur ; il exige une lecture qui n'est pas ILLISIBLE, des lignes chiffrées et un
 * fournisseur qui n'est pas une société du groupe. ENVOYER_EN_VALIDATION exige un validateur et un brouillon.
 */
export type EtatBCDevis = "BROUILLON" | "EN_VALIDATION" | "VALIDE" | "SIGNE" | "ANNULE";
export type TransitionBC = "CREER" | "ENVOYER_EN_VALIDATION" | "ANNULER";

export function etatBCDevis(p: {
  annule: boolean;
  signe: boolean;
  /** Une demande de validation retient le BC (`bcPrevalidationRequestId`) — et son statut. */
  demande: { statut: string } | null;
}): EtatBCDevis {
  if (p.annule) return "ANNULE";
  if (p.signe) return "SIGNE";
  if (!p.demande) return "BROUILLON";
  return p.demande.statut === "APPROVED" ? "VALIDE" : p.demande.statut === "REJECTED" || p.demande.statut === "CANCELLED" ? "BROUILLON" : "EN_VALIDATION";
}

/** `null` : la transition est permise ; sinon la phrase du refus. */
export function refusTransitionBC(
  t: TransitionBC,
  etat: EtatBCDevis | null,
  ctx: { validateurId?: string | null; lecture?: "FIABLE" | "A_VERIFIER" | "ILLISIBLE" | null; lignesChiffrees?: boolean; fournisseurDuGroupe?: boolean } = {},
): string | null {
  switch (t) {
    case "CREER":
      if (etat !== null) return "Ce bon de commande existe déjà.";
      if (ctx.lecture === "ILLISIBLE" || ctx.lignesChiffrees === false) return "Aucune ligne chiffrée n'a été lue sur le devis : le bon de commande ne peut pas être composé.";
      if (ctx.fournisseurDuGroupe) return "Le fournisseur lu est une société du groupe (le client du devis) : le fournisseur est l'émetteur du devis.";
      return null; // AUCUN validateur exigé pour créer le brouillon.
    case "ENVOYER_EN_VALIDATION":
      if (etat !== "BROUILLON") return etat === "ANNULE" ? "Ce bon de commande est annulé." : etat === "SIGNE" ? "Ce bon de commande est déjà signé." : "Ce bon de commande est déjà en validation.";
      if (!ctx.validateurId) return "qui doit valider ce bon de commande (le validateur principal)";
      return null;
    case "ANNULER":
      return etat === "ANNULE" ? "Ce bon de commande est déjà annulé." : etat === null ? "Ce bon de commande n'existe pas." : null;
  }
}
