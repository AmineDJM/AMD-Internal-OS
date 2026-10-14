/**
 * L'INTÉGRATION AD & PRO 2026 — CE QUE LES ÉCRANS EN DISENT (module PUR, sans import lourd : lu par les écrans clients,
 * les requêtes et les tests).
 */
import { entityHref } from "../entity-href";

/** La page de la demande intégrée (`TYPE:id`). Une formation n'a pas de fiche à elle : sa fiche d'intégration la porte. */
export function lienDemandeIntegree(cle: string): string | null {
  const [type, id] = cle.split(":");
  if (!type || !id) return null;
  return lienDemande(type, id);
}

export function lienDemande(type: string, id: string): string | null {
  if (type === "TRAINING") return `/budget-marketing/integration/demande/TRAINING/${encodeURIComponent(id)}`;
  return entityHref(type, id);
}

/** Une pièce attendue, telle que la demande la garde (`AdProIntegrationDemande.piecesAttendues`). */
export interface PieceAttendueVue { cle: string; libelle: string }
/** Une pièce déjà dans la plateforme, rattachée (jamais redéposée). */
export interface PieceRattachee {
  cle: string; documentId: string | null; nom: string; le: string; parId: string | null; source: string;
  /** Le lien qui ouvre la pièce quand ce n'est pas un `Document` (fichier du Drive, pièce jointe de la messagerie). */
  href?: string | null;
  /** La source du Rapprochement (`DOC:` / `DRIVE:` / `MSG:`) qui l'a rattachée — pour l'annuler. */
  ref?: string | null;
}

const estObjet = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Relit la liste des pièces attendues d'un JSON, sans rien inventer. */
export function piecesAttenduesDe(json: unknown): PieceAttendueVue[] {
  if (!Array.isArray(json)) return [];
  return json.filter(estObjet).filter((p) => typeof p.cle === "string" && typeof p.libelle === "string").map((p) => ({ cle: p.cle as string, libelle: p.libelle as string }));
}
export function piecesRattacheesDe(json: unknown): PieceRattachee[] {
  if (!Array.isArray(json)) return [];
  return json.filter(estObjet).filter((p) => typeof p.cle === "string").map((p) => ({
    cle: p.cle as string,
    documentId: typeof p.documentId === "string" ? p.documentId : null,
    nom: typeof p.nom === "string" ? p.nom : "Pièce",
    le: typeof p.le === "string" ? p.le : "",
    parId: typeof p.parId === "string" ? p.parId : null,
    source: typeof p.source === "string" ? p.source : "",
    ...(typeof p.href === "string" ? { href: p.href } : {}),
    ...(typeof p.ref === "string" ? { ref: p.ref } : {}),
  }));
}

/** La clé d'étape d'une pièce déposée pour une pièce attendue (`Document.stepKey`). */
export const PREFIXE_PIECE = "integration:";
export const stepKeyDePiece = (cle: string) => `${PREFIXE_PIECE}${cle}`;
export const cleDuStepKey = (stepKey: string | null | undefined): string | null =>
  stepKey && stepKey.startsWith(PREFIXE_PIECE) ? stepKey.slice(PREFIXE_PIECE.length) : null;

export interface EtatPiece { cle: string; libelle: string; fournie: boolean; fichiers: { id: string; nom: string; rattachee: boolean; href?: string | null }[] }

/**
 * LES PIÈCES ATTENDUES ET MANQUANTES — obligatoires mais NON bloquantes : une pièce est fournie dès qu'un fichier est
 * déposé pour elle ou qu'une pièce de la plateforme lui est rattachée.
 */
export function etatDesPieces(
  attendues: readonly PieceAttendueVue[],
  deposees: readonly { id: string; nom: string; stepKey: string | null }[],
  rattachees: readonly PieceRattachee[],
): { pieces: EtatPiece[]; manquantes: PieceAttendueVue[] } {
  const pieces = attendues.map((a) => {
    const fichiers = [
      ...deposees.filter((d) => cleDuStepKey(d.stepKey) === a.cle).map((d) => ({ id: d.id, nom: d.nom, rattachee: false })),
      ...rattachees.filter((r) => r.cle === a.cle).map((r) => ({ id: r.documentId ?? r.ref ?? `${r.cle}:${r.le}`, nom: r.nom, rattachee: true, href: r.href ?? null })),
    ];
    return { cle: a.cle, libelle: a.libelle, fournie: fichiers.length > 0, fichiers };
  });
  return { pieces, manquantes: pieces.filter((p) => !p.fournie).map((p) => ({ cle: p.cle, libelle: p.libelle })) };
}

/** Comparer ce que Luna a lu sur une pièce à la ligne du fichier : montant (à 1 DZD) et fournisseur attendu. */
export function controleDeLaPiece(
  lu: { ttc: number | null; fournisseur: string | null },
  attendu: { montant: number; fournisseur?: string | null },
): { ok: boolean; ecarts: string[] } {
  const ecarts: string[] = [];
  if (lu.ttc != null && Math.abs(lu.ttc - attendu.montant) > 1) {
    ecarts.push(`montant lu ${lu.ttc.toLocaleString("fr-FR")} DZD, la ligne du fichier dit ${attendu.montant.toLocaleString("fr-FR")} DZD`);
  }
  const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (attendu.fournisseur && lu.fournisseur && !norm(lu.fournisseur).includes(norm(attendu.fournisseur)) && !norm(attendu.fournisseur).includes(norm(lu.fournisseur))) {
    ecarts.push(`fournisseur lu « ${lu.fournisseur} », attendu « ${attendu.fournisseur} »`);
  }
  return { ok: ecarts.length === 0, ecarts };
}
