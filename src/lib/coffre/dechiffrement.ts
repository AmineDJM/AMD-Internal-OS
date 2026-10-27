import crypto from "node:crypto";
import { aad, ErreurDechiffrement, VERSION } from "./chiffrement";
import type { ClesCoffre } from "./cle";
import type { NatureCoffre } from "./natures";

/**
 * LE DÉCHIFFREMENT DU COFFRE — seul module qui rend une valeur en clair. Importé par le service de
 * lecture (`service.ts`, `lecture.ts`), jamais par le chemin d'écriture (`copies.ts`) : ce qui peut
 * écrire au coffre ne peut pas, du même geste, le lire (`frontiere.test.ts`).
 */

export function dechiffrer(cles: ClesCoffre, nature: NatureCoffre, donneeId: string, chiffre: string): string {
  const [version, id, charge, ...reste] = chiffre.split(".");
  if (version !== VERSION || !id || !charge || reste.length) throw new ErreurDechiffrement("Chiffré du coffre mal formé.");
  if (id !== cles.id) throw new ErreurDechiffrement("Donnée chiffrée avec une autre clé du coffre : illisible avec la clé actuelle.");
  const brut = Buffer.from(charge, "base64url");
  if (brut.length < 12 + 16) throw new ErreurDechiffrement("Chiffré du coffre tronqué.");
  const decipher = crypto.createDecipheriv("aes-256-gcm", cles.chiffrement, brut.subarray(0, 12));
  decipher.setAAD(aad(nature, donneeId));
  decipher.setAuthTag(brut.subarray(12, 28));
  try {
    return Buffer.concat([decipher.update(brut.subarray(28)), decipher.final()]).toString("utf8");
  } catch {
    throw new ErreurDechiffrement("Chiffré du coffre altéré, ou relu sous une autre nature ou une autre donnée.");
  }
}

export function recomposer(c: { valeurChiffree: Uint8Array; iv: Uint8Array; tag: Uint8Array; cleVersion: number; cleId: string | null }): string {
  if (c.cleVersion !== 1) throw new ErreurDechiffrement(`Format de chiffré inconnu (version ${c.cleVersion}).`);
  if (!c.cleId) throw new ErreurDechiffrement("Donnée du coffre sans identifiant de clé : illisible.");
  return `${VERSION}.${c.cleId}.${Buffer.concat([Buffer.from(c.iv), Buffer.from(c.tag), Buffer.from(c.valeurChiffree)]).toString("base64url")}`;
}
