import { EntityType, type MailDirection } from "@prisma/client";
import type { MailFields } from "./write";

/**
 * LES RÈGLES PURES DU REGISTRE DES COURRIERS — sans base, sans session. D'où les tests.
 *
 * Elles portent les deux décisions qui ont coûté des données quand elles vivaient implicitement
 * dans le noyau d'écriture :
 *
 *  - UNE CORRECTION FUSIONNE. Un champ ABSENT d'une mise à jour (`undefined`) est INCHANGÉ ; seul
 *    un champ PRÉSENT — fût-il vide, c'est alors un effacement voulu — modifie le pli. Le noyau
 *    écrivait `f.sender ?? null` : corriger un titre depuis Adam, ou une date depuis l'écran,
 *    effaçait l'expéditeur, le porteur et les trois dates sans que personne l'ait demandé.
 *  - UN DOSSIER DE CLASSEMENT D'UNE ENTITÉ NE RANGE QUE LES PLIS DE CETTE ENTITÉ. Sans quoi le pli
 *    de la société B, rangé dans un dossier de A, disparaît dans un dossier que B ne voit pas.
 */

/** Ce qu'une correction ÉCRIT dans les colonnes suivies au journal — une clé absente n'est pas touchée. */
export interface CorrectionSuivie {
  title?: string;
  direction?: MailDirection;
  reference?: string | null;
  sender?: string | null;
  recipient?: string | null;
  sentAt?: Date | null;
  receivedAt?: Date | null;
  acknowledgedAt?: Date | null;
  carrier?: string | null;
  notes?: string | null;
}

/** Une chaîne vide est un champ vide : on l'écrit `null`, comme le formulaire le fait déjà. */
const texte = (v: string | null | undefined): string | null => (v == null || v.trim() === "" ? null : v.trim());

/**
 * CE QU'UNE CORRECTION ÉCRIT dans les colonnes suivies — et RIEN d'autre.
 *
 * La clé n'apparaît dans le résultat que si la correction en parle : le journal (`diffMailEntry`)
 * ne compare alors que ce qui a été demandé, et l'écriture ne touche pas au reste.
 * Le SENS ne s'efface pas (la colonne est obligatoire) : `null` vaut « inchangé ».
 */
export function correctionSuivie(f: Partial<MailFields>): CorrectionSuivie {
  const out: CorrectionSuivie = {};
  if (f.title !== undefined) out.title = (f.title ?? "").trim();
  if (f.direction) out.direction = f.direction;
  for (const k of ["reference", "sender", "recipient", "carrier", "notes"] as const) {
    if (f[k] !== undefined) out[k] = texte(f[k]);
  }
  for (const k of ["sentAt", "receivedAt", "acknowledgedAt"] as const) {
    if (f[k] !== undefined) out[k] = f[k] ?? null;
  }
  return out;
}

/**
 * UN DOSSIER ACCEPTE-T-IL CE PLI ? Un dossier commun au groupe (sans entité) accepte tout ; un
 * pli sans entité n'est le secret de personne et va partout ; sinon, les deux entités coïncident.
 */
export function dossierAccepteLePli(dossierCompanyId: string | null | undefined, pliCompanyId: string | null | undefined): boolean {
  if (!dossierCompanyId || !pliCompanyId) return true;
  return dossierCompanyId === pliCompanyId;
}

const TYPES_D_ENTITE = new Set<string>(Object.values(EntityType));

/**
 * L'OBJET D'ORIGINE d'un pli vient d'un champ caché : une valeur hors de l'énumération faisait
 * lever Prisma (« Invalid value for argument `sourceType` ») — une page d'erreur au lieu d'une phrase.
 */
export function origineInvalide(sourceType: string | null | undefined, sourceId: string | null | undefined): string | null {
  if (!sourceType) return null;
  if (!TYPES_D_ENTITE.has(sourceType)) return "L'objet d'origine de ce courrier n'est pas reconnu — rouvrez le formulaire depuis la fiche d'origine.";
  if (!sourceId) return "L'objet d'origine de ce courrier n'est pas précisé — rouvrez le formulaire depuis la fiche d'origine.";
  return null;
}
