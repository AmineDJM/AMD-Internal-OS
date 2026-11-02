import type { LigneCommerciale } from "@/lib/artifact/factory/commercial";
import { correctionsDuBrouillon, lignesEffectives, type BrouillonBc, type CorrectionsBc } from "@/lib/bons-de-commande/brouillon";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE BC D'UN POSTE SE MODIFIE DANS L'APPLICATION, ET CHAQUE MODIFICATION SE GARDE (Direction, 11/2026).
 *
 * « Le BC est généré pour le devis validé ; la personne qui a ajouté le devis le modifie UNIQUEMENT dans la plateforme —
 * toute modification est enregistrée, et le Super Admin voit ce qui a changé — puis elle le valide ; validé, il part à la
 * page Bons de commande, où le responsable le télécharge en PDF, le signe et le dépose. La version signée entre dans
 * Legal. » Ce module dit QUI édite et valide, et CE QUI A CHANGÉ entre deux enregistrements — champ par champ, avant →
 * après, dans les mots de l'écran.
 *
 * Module PUR (aucun import lourd) : lu par l'écran comme par les actions (§118.83).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Ce qu'une version du brouillon enregistre : le geste et les changements. */
export type GesteBrouillon = "CREE" | "MODIFIE" | "RETIRE" | "VALIDE";

export const LIBELLE_GESTE_BROUILLON: Record<GesteBrouillon, string> = {
  CREE: "Brouillon créé à la validation du devis",
  MODIFIE: "Brouillon modifié",
  RETIRE: "Brouillon retiré",
  VALIDE: "Bon de commande validé — envoyé à la signature",
};

export interface ChangementBrouillon {
  champ: string;
  avant: string;
  apres: string;
}

/**
 * QUI MODIFIE ET VALIDE LE BC D'UN DEVIS DE POSTE : la personne qui a AJOUTÉ ce devis au poste, ou le Super Admin.
 * Le valideur du devis ne réécrit pas le BC qu'il a fait naître ; le demandeur non plus, s'il n'a pas déposé le devis.
 */
export function peutModifierLeBcDuPoste(p: { userId: string; role: string; secondaryRole?: string | null; deposeParId: string | null | undefined }): boolean {
  return p.role === "SUPER_ADMIN" || p.secondaryRole === "SUPER_ADMIN" || (p.deposeParId != null && p.deposeParId === p.userId);
}

export const REFUS_MODIFICATION_BC_POSTE =
  "Seule la personne qui a ajouté ce devis au poste (ou le Super Admin) modifie et valide son bon de commande.";

/** La notification du BC à vérifier, adressée à la personne qui a ajouté le devis. */
export function notificationBcAVerifier(p: { devis: string; fournisseur: string | null; poste: string; ref: string }): { title: string; body: string } {
  const qui = p.fournisseur ? ` (${p.fournisseur})` : "";
  return {
    title: "Bon de commande à vérifier",
    body: `${p.ref} — poste « ${p.poste} » : le devis ${p.devis}${qui} est validé et son bon de commande est généré. Vérifiez-le, modifiez-le au besoin dans la plateforme, puis validez-le : il partira à la signature.`,
  };
}

const LIBELLE_CHAMP: Record<keyof CorrectionsBc, string> = {
  tiers: "Fournisseur",
  date: "Date du bon de commande",
  tvaDefaut: "TVA par défaut",
  remiseGlobale: "Remise globale",
  modePaiement: "Mode de paiement",
  conditionsPaiement: "Conditions de paiement",
  objet: "Objet",
  referenceAmont: "Référence du devis",
  referenceAmontDate: "Date du devis",
  contact: "Contact",
  taxes: "Taxes additionnelles",
  livraison: "Livraison",
  notes: "Notes",
  coordonneesEmetteur: "Coordonnées de l'émetteur",
  letterheadId: "Papier en-tête",
  signataire: "Signataire",
  mentions: "Mentions",
  numero: "Numéro",
};

const vide = "—";

/** Un nombre à la française, avec une espace ORDINAIRE entre les milliers : l'historique se lit et se copie tel quel. */
const nombreFr = (n: number): string => n.toLocaleString("fr-FR").replace(/[  ]/g, " ");

/** Une valeur du composeur, dite en clair et courte : jamais un objet brut à l'écran. */
function dire(v: unknown): string {
  if (v === null || v === undefined || v === "") return vide;
  if (typeof v === "number") return Number.isFinite(v) ? nombreFr(v) : vide;
  if (typeof v === "string") return v.length > 160 ? `${v.slice(0, 157)}…` : v;
  if (Array.isArray(v)) return v.length === 0 ? vide : v.map(dire).join(" ; ");
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.nom === "string") return dire(o.nom) + (typeof o.qualite === "string" && o.qualite ? ` (${o.qualite})` : "");
    if (typeof o.libelle === "string") return `${o.libelle}${typeof o.taux === "number" ? ` ${Math.round(o.taux * 10000) / 100} %` : ""}`;
    const parts = Object.entries(o).filter(([, x]) => x !== null && x !== undefined && x !== "").map(([k, x]) => `${k} : ${dire(x)}`);
    return parts.length ? parts.join(", ") : vide;
  }
  return String(v);
}

/** Une ligne de BC dite en une phrase : « Chambre single — 54 nuitée × 14 500 ». */
function direLigne(l: LigneCommerciale | undefined): string {
  if (!l) return vide;
  if (l.section) return `Section : ${l.designation}`;
  const qte = Number.isFinite(l.quantite) ? nombreFr(l.quantite) : "?";
  const pu = Number.isFinite(l.prixUnitaire) ? nombreFr(l.prixUnitaire) : "?";
  return `${l.designation} — ${qte}${l.unite ? ` ${l.unite}` : ""} × ${pu}${l.remise ? ` (remise ${Math.round(l.remise * 10000) / 100} %)` : ""}`;
}

const memeChose = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * CE QUI A CHANGÉ entre deux états du brouillon — les lignes que le BC imprimera, puis chaque correction de la bande
 * (fournisseur, dates, paiement, TVA, livraison…). `avant` absent : le premier état, comparé à ce que le devis donne.
 */
export function changementsDuBrouillon(
  avant: BrouillonBc | null, apres: BrouillonBc, lignesDuDevis: readonly LigneCommerciale[],
): ChangementBrouillon[] {
  const out: ChangementBrouillon[] = [];
  const la = avant ? lignesEffectives(avant, lignesDuDevis) : [...lignesDuDevis];
  const lb = lignesEffectives(apres, lignesDuDevis);
  for (let i = 0; i < Math.max(la.length, lb.length); i++) {
    if (!memeChose(la[i], lb[i])) out.push({ champ: `Ligne ${i + 1}`, avant: direLigne(la[i]), apres: direLigne(lb[i]) });
  }
  const ca = avant ? correctionsDuBrouillon(avant) : {};
  const cb = correctionsDuBrouillon(apres);
  for (const cle of Object.keys(LIBELLE_CHAMP) as (keyof CorrectionsBc)[]) {
    if (!memeChose(ca[cle], cb[cle])) out.push({ champ: LIBELLE_CHAMP[cle], avant: dire(ca[cle]), apres: dire(cb[cle]) });
  }
  if ((avant?.numeroChoisi ?? null) !== (apres.numeroChoisi ?? null)) {
    out.push({ champ: "Numéro choisi", avant: dire(avant?.numeroChoisi), apres: dire(apres.numeroChoisi) });
  }
  return out;
}

/** Relit les changements gardés en base (JSON) — ce qui n'a pas la forme attendue est écarté. */
export function changementsLus(json: unknown): ChangementBrouillon[] {
  if (!Array.isArray(json)) return [];
  return json.flatMap((x) => {
    if (!x || typeof x !== "object") return [];
    const o = x as Record<string, unknown>;
    return typeof o.champ === "string" && typeof o.avant === "string" && typeof o.apres === "string"
      ? [{ champ: o.champ, avant: o.avant, apres: o.apres }] : [];
  });
}
