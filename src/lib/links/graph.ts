/**
 * LE GRAPHE DES LIENS — « relié à… », mais selon le FLUX de l'affaire.
 *
 * ── CE QUE CE MODULE DÉCIDE ─────────────────────────────────────────────────────────────────
 *
 * Une affaire suit un chemin : un appel d'offres est publié, un CONTRAT (ou un avenant) en
 * naît, un ou plusieurs BONS DE COMMANDE exécutent ce contrat, une ou plusieurs FACTURES
 * couvrent ces bons ; une ASSURANCE se rattache au contrat qu'elle couvre ; et un COURRIER
 * peut parler de n'importe lequel de ces objets — souvent de plusieurs à la fois (une mise en
 * demeure de recouvrement porte trois factures et deux bons).
 *
 * ── POURQUOI DES PAIRES AUTORISÉES, ET NON « TOUT AVEC TOUT » ───────────────────────────────
 *
 * Laisser relier une facture directement à un appel d'offres semble arrangeant, et c'est le
 * piège : le jour où l'on cherche « quelle facture pour quel bon », la moitié des factures
 * pendent au marché sans passer par un bon, et la question n'a plus de réponse. Le lien direct
 * fait gagner trois secondes à la saisie et détruit la traçabilité qu'on construisait.
 *
 * Le refus NOMME donc le chemin (« une facture se relie à son bon de commande ; le marché s'en
 * déduit ») : un refus qui explique enseigne le flux, un refus muet fait chercher un contournement.
 *
 * ── LA PAIRE EST CANONIQUE, LE LIEN EST UNIQUE ──────────────────────────────────────────────
 *
 * « Relier A à B » et « relier B à A » sont le MÊME fait. On range donc toujours la paire dans
 * le même ordre (le rang du flux, puis l'identifiant) avant d'écrire : une seule ligne en base,
 * lisible des deux côtés, et l'unicité empêche le doublon sans aucun code de déduplication.
 *
 * Module PUR : ni base, ni import lourd. Testé.
 */

/**
 * Les natures qui participent au graphe. Le rang est celui du FLUX de l'affaire.
 *
 * ── POURQUOI « FACTURE » RESTE UNE NATURE À PART ────────────────────────────────────────────
 *
 * Une facture est désormais un `LegalDocument` de nature `INVOICE` : les deux natures désignent
 * la même table. Les fondre en une seule effacerait pourtant du savoir métier — c'est ICI, et
 * nulle part ailleurs, qu'est écrit qu'une facture se relie à SON BON DE COMMANDE et non au
 * contrat (le contrat s'en déduit par le bon), et que le refus l'explique.
 *
 * Le prix de ce choix est une règle à tenir : une pièce n'apparaît QUE sous sa nature. Les
 * listes de candidats l'appliquent (`queries/link-candidates`), et la résolution du libellé la
 * REFUSE côté serveur (`links/store`) — sans quoi la même pièce serait reliable deux fois, et le
 * même couple s'enregistrerait sous deux paires canoniques différentes.
 */
export const LINK_TYPES = [
  "PCH_TENDER",
  "LEGAL_DOCUMENT",
  "PCH_ORDER",
  "INVOICE",
  "REGULATORY_PRODUCT",
  "MAIL_ENTRY",
] as const;
export type LinkType = (typeof LINK_TYPES)[number];

export const LINK_TYPE_LABELS: Record<LinkType, string> = {
  PCH_TENDER: "Appel d'offres",
  LEGAL_DOCUMENT: "Document légal",
  PCH_ORDER: "Bon de commande",
  INVOICE: "Facture",
  REGULATORY_PRODUCT: "Dossier Regulatory",
  MAIL_ENTRY: "Courrier",
};

export function isLinkType(v: string): v is LinkType {
  return (LINK_TYPES as readonly string[]).includes(v);
}

/** Rang dans le flux — sert à ranger une paire toujours dans le même sens. */
export function linkRank(t: LinkType): number {
  return LINK_TYPES.indexOf(t);
}

/**
 * LES PAIRES AUTORISÉES — le flux, écrit une fois.
 *
 * Chaque entrée porte la raison du lien : elle s'affiche au moment de relier, pour que la
 * personne sache ce qu'elle est en train d'affirmer.
 */
export const LINK_PAIRS: { a: LinkType; b: LinkType; why: string }[] = [
  { a: "PCH_TENDER", b: "LEGAL_DOCUMENT", why: "Le contrat (ou l'avenant) né de ce marché." },
  { a: "LEGAL_DOCUMENT", b: "LEGAL_DOCUMENT", why: "Deux pièces qui se tiennent : une assurance et le contrat qu'elle couvre, un avenant et son contrat." },
  { a: "LEGAL_DOCUMENT", b: "PCH_ORDER", why: "Le bon de commande qui exécute ce contrat." },
  { a: "PCH_ORDER", b: "INVOICE", why: "La facture qui couvre ce bon — une facture peut en couvrir plusieurs." },
  // LE COURRIER PARLE DE TOUT. C'est la seule nature sans contrainte de flux : un pli n'est
  // pas une étape de l'affaire, c'est ce qu'on s'écrit à son sujet.
  { a: "PCH_TENDER", b: "MAIL_ENTRY", why: "Le pli échangé au sujet de ce marché." },
  { a: "LEGAL_DOCUMENT", b: "MAIL_ENTRY", why: "Le pli échangé au sujet de cette pièce." },
  { a: "PCH_ORDER", b: "MAIL_ENTRY", why: "Le pli échangé au sujet de ce bon." },
  { a: "INVOICE", b: "MAIL_ENTRY", why: "Le pli échangé au sujet de cette facture (relance, mise en demeure)." },
  { a: "REGULATORY_PRODUCT", b: "MAIL_ENTRY", why: "Le pli échangé au sujet de ce dossier." },
];

/**
 * LES CHEMINS QU'ON REFUSE, avec la route à prendre à la place. Un refus qui explique enseigne
 * le flux ; un refus muet fait saisir la donnée ailleurs, hors de l'ERP.
 */
const DETOURS: { a: LinkType; b: LinkType; say: string }[] = [
  {
    a: "PCH_TENDER", b: "INVOICE",
    say: "Une facture se relie à son BON DE COMMANDE, pas au marché : le marché s'en déduit. Sans ce passage, « quelle facture pour quel bon ? » n'a plus de réponse.",
  },
  {
    a: "PCH_TENDER", b: "PCH_ORDER",
    say: "Un bon de commande appartient DÉJÀ à son marché (il y est créé) — ce lien ferait doublon avec le rattachement d'origine.",
  },
  {
    a: "LEGAL_DOCUMENT", b: "INVOICE",
    say: "Une facture se relie à son BON DE COMMANDE ; le contrat s'en déduit par le bon.",
  },
];

/** Cette paire est-elle autorisée ? (l'ordre des deux natures n'a pas d'importance) */
export function pairAllowed(a: LinkType, b: LinkType): boolean {
  return LINK_PAIRS.some((p) => (p.a === a && p.b === b) || (p.a === b && p.b === a));
}

/** La raison affichée d'une paire autorisée. */
export function pairReason(a: LinkType, b: LinkType): string | null {
  return LINK_PAIRS.find((p) => (p.a === a && p.b === b) || (p.a === b && p.b === a))?.why ?? null;
}

/** Les natures auxquelles on peut relier CETTE nature, dans l'ordre du flux. */
export function targetsFor(from: LinkType): LinkType[] {
  return LINK_TYPES.filter((t) => pairAllowed(from, t));
}

/**
 * LA PAIRE, RANGÉE. Le même couple d'objets produit toujours le même enregistrement, quel que
 * soit le côté depuis lequel on a cliqué — c'est ce qui rend l'unicité suffisante.
 */
export function canonicalPair(
  x: { type: LinkType; id: string },
  y: { type: LinkType; id: string },
): { fromType: LinkType; fromId: string; toType: LinkType; toId: string } {
  const parCote = linkRank(x.type) - linkRank(y.type);
  // Même nature (assurance ↔ contrat) : l'identifiant tranche, faute de rang qui les sépare.
  const premierEstX = parCote !== 0 ? parCote < 0 : x.id <= y.id;
  const [p, s] = premierEstX ? [x, y] : [y, x];
  return { fromType: p.type, fromId: p.id, toType: s.type, toId: s.id };
}

export type LinkCheck = { ok: true } | { ok: false; error: string };

/**
 * Ce qui empêche de relier ces deux objets. Renvoie le motif EXACT — « lien impossible »
 * n'apprend à personne quel chemin prendre.
 */
export function validateLink(
  x: { type: string; id: string },
  y: { type: string; id: string },
): LinkCheck {
  if (!isLinkType(x.type) || !isLinkType(y.type)) {
    return { ok: false, error: "Ce type d'objet ne participe pas aux liens d'affaire." };
  }
  if (x.type === y.type && x.id === y.id) {
    return { ok: false, error: "Un objet ne se relie pas à lui-même." };
  }
  if (pairAllowed(x.type, y.type)) return { ok: true };

  const detour = DETOURS.find(
    (d) => (d.a === x.type && d.b === y.type) || (d.a === y.type && d.b === x.type),
  );
  if (detour) return { ok: false, error: detour.say };
  return {
    ok: false,
    error: `On ne relie pas ${LINK_TYPE_LABELS[x.type].toLowerCase()} et ${LINK_TYPE_LABELS[y.type].toLowerCase()} : ces deux natures ne se suivent pas dans le flux d'une affaire.`,
  };
}

/**
 * OÙ MÈNE UN LIEN. Un lien qui ne s'ouvre pas est une chaîne de caractères : on veut cliquer et
 * arriver sur la fiche.
 *
 * Une seule nature n'a pas de fiche à elle : un BON DE COMMANDE se lit dans la fiche de SON
 * marché (d'où `orderTenderId`, que l'appelant résout). Une FACTURE, elle, en a une depuis
 * qu'elle est un document légal de nature « facture » : `/legal/<id>`. Renvoyer `null` plutôt
 * qu'une URL inventée : un lien mort érode la confiance dans tous les autres.
 */
export function linkHref(
  type: LinkType,
  id: string,
  ctx?: { orderTenderId?: string | null },
): string | null {
  switch (type) {
    case "PCH_TENDER": return `/pch/${id}`;
    case "LEGAL_DOCUMENT": return `/legal/${id}`;
    case "PCH_ORDER": return ctx?.orderTenderId ? `/pch/${ctx.orderTenderId}` : null;
    case "INVOICE": return `/legal/${id}`;
    case "REGULATORY_PRODUCT": return `/regulatory/${id}`;
    // Un courrier s'ouvre dans le panneau du registre (`lienCourrier`, `chemins/courriers.ts`).
    case "MAIL_ENTRY": return `/courriers?courrier=${encodeURIComponent(id)}`;
  }
}

/**
 * UNE VUE DE LIEN, telle que l'écran l'affiche : l'AUTRE bout, vu depuis l'objet courant.
 *
 * L'enregistrement est rangé canoniquement ; l'écran, lui, ne veut jamais savoir de quel côté
 * il se trouve — il veut « ce à quoi je suis relié ».
 */
export function otherSide(
  link: { fromType: string; fromId: string; toType: string; toId: string; fromLabel?: string | null; toLabel?: string | null },
  self: { type: string; id: string },
): { type: string; id: string; label: string | null } {
  const estDepart = link.fromType === self.type && link.fromId === self.id;
  return estDepart
    ? { type: link.toType, id: link.toId, label: link.toLabel ?? null }
    : { type: link.fromType, id: link.fromId, label: link.fromLabel ?? null };
}
