/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « SEUL LE NUMÉRO CHANGE » — DÉCIDÉ AU SERVEUR, EN COMPARANT (Direction, 14/10/2026).
 *
 * « Changer UNIQUEMENT le numéro de référence d'un BC ne relance PAS son circuit. » Une révision dont la seule différence
 * avec la pièce enregistrée est le numéro garde l'état du BC : pas de réaiguillage, étapes de validation et signature des
 * Finances conservées. Le Word et le PDF sont régénérés au nouveau numéro (une version marquée « numéro seul »).
 *
 * La décision ne vient JAMAIS d'un drapeau du navigateur : le serveur compare ce qui est ENREGISTRÉ à ce qui est SOUMIS,
 * champ par champ, après normalisation (espaces, vide = absent, nombres au millionième, remise 0 = aucune remise). Les
 * champs DÉRIVÉS du profil de la société (émetteur, pied de page, couleur, papier) ne sont pas une saisie : ils ne sont pas
 * comparés — et la régénération « numéro seul » reprend la pièce enregistrée telle quelle, numéro excepté.
 *
 * PUR, SANS IMPORT : lu par la fabrique, par l'action de la fiche Legal (BC déposé) et par les tests.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Ce que la personne saisit d'une pièce commerciale — tout ce qui se compare (le numéro mis à part). */
export const CHAMPS_SAISIS_PIECE = [
  "tiers", "lignes", "date", "echeance", "validiteJours", "tvaDefaut", "remiseGlobale", "modePaiement", "conditionsPaiement",
  "objet", "referenceAmont", "referenceAmontDate", "numeroClient", "contact", "taxes", "livraison", "notes",
  "coordonneesEmetteur", "signataire", "mentionsPiece",
] as const;

/** Les clés dont la valeur 0 vaut « rien » (une remise nulle n'est pas une remise). */
const ZERO_VAUT_RIEN = new Set(["remise", "remiseGlobale"]);

/** La forme comparable d'une valeur : vide = `null`, textes nettoyés, nombres arrondis, objets triés sans clé vide. */
export function normaliserPourComparer(v: unknown, cle = ""): unknown {
  if (v === undefined || v === null) return null;
  if (typeof v === "string") { const s = v.trim().replace(/\s+/g, " "); return s === "" ? null : s; }
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return null;
    if (v === 0 && ZERO_VAUT_RIEN.has(cle)) return null;
    return Math.round(v * 1e6) / 1e6;
  }
  if (typeof v === "boolean") return v ? true : null;
  if (Array.isArray(v)) {
    const a = v.map((x) => normaliserPourComparer(x, cle));
    return a.length === 0 || a.every((x) => x === null) ? null : a;
  }
  if (typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const x = normaliserPourComparer((v as Record<string, unknown>)[k], k);
      if (x !== null) o[k] = x;
    }
    return Object.keys(o).length === 0 ? null : o;
  }
  return null;
}

/** Les clés dont la valeur diffère entre l'enregistré et le soumis (après normalisation). */
export function champsDifferents(avant: Record<string, unknown>, apres: Record<string, unknown>, cles: readonly string[]): string[] {
  return cles.filter((k) => JSON.stringify(normaliserPourComparer(avant[k], k)) !== JSON.stringify(normaliserPourComparer(apres[k], k)));
}

export interface VerdictNumeroSeul {
  /** Vrai : le numéro change, et rien d'autre. */
  seul: boolean;
  /** Ce qui change en plus du numéro (vide quand `seul`). */
  autres: string[];
}

/**
 * LA RÉVISION D'UNE PIÈCE ÉMISE NE CHANGE-T-ELLE QUE SON NUMÉRO ? — `avant` : la spécification enregistrée ; `apres` : la
 * spécification que la révision composerait (même numéro) ; `papierChange` : un autre papier en-tête a été choisi.
 */
export function changementDeNumeroSeul(
  avant: Record<string, unknown>, apres: Record<string, unknown>, o: { numeroChange: boolean; papierChange?: boolean },
): VerdictNumeroSeul {
  const autres = [...champsDifferents(avant, apres, CHAMPS_SAISIS_PIECE), ...(o.papierChange ? ["papier en-tête"] : [])];
  return { seul: o.numeroChange && autres.length === 0, autres };
}

/** La mention d'une version « numéro seul » (journal des versions, audit). */
export const MENTION_NUMERO_SEUL = "numéro seul — circuit et signatures conservés";

/** Ce que l'écran dit d'un changement de numéro seul sur un BC — et de sa copie signée, quand il y en a une. */
export function phraseNumeroSeul(o: { signe: boolean }): string {
  return "Seul le numéro change : le bon de commande garde son état (aucun nouveau passage au centre, étapes de validation conservées)"
    + (o.signe
      ? " et la signature des Finances est conservée. Le Word et le PDF sont régénérés au nouveau numéro ; la copie signée téléversée reste la pièce signée (elle porte l'ancien numéro, tracé au journal)."
      : ". Le Word et le PDF sont régénérés au nouveau numéro.");
}
