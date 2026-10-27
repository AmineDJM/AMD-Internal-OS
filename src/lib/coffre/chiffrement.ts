import crypto from "node:crypto";
import type { ClesCoffre } from "./cle";
import type { NatureCoffre } from "./natures";

/**
 * CHIFFREMENT DU COFFRE — AES-256-GCM, IV aléatoire de 12 octets par valeur.
 *
 * Format du chiffré (texte, stockable dans une colonne `TEXT`) :
 *   `c1.<id de clé>.<base64url(iv ‖ tag ‖ chiffré)>`
 * L'identifiant de clé permet de dire « chiffré avec une autre clé » plutôt qu'une erreur opaque,
 * et préparera la rotation.
 *
 * Données associées (AAD) : `nature` et identifiant de la donnée. Un chiffré recopié sur une autre
 * ligne ou relu sous une autre nature échoue à l'authentification — on ne peut pas faire lire le
 * RIB d'un fournisseur comme le salaire d'un collaborateur. Le TITULAIRE n'y entre pas exprès : une
 * fusion de fiches Personne ne doit pas rendre les données illisibles.
 */

export class ErreurDechiffrement extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ErreurDechiffrement";
  }
}

const VERSION = "c1";

function aad(nature: NatureCoffre, donneeId: string): Buffer {
  return Buffer.from(`${VERSION}\u0000${nature}\u0000${donneeId}`, "utf8");
}

export function chiffrer(cles: ClesCoffre, nature: NatureCoffre, donneeId: string, clair: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", cles.chiffrement, iv);
  cipher.setAAD(aad(nature, donneeId));
  const corps = Buffer.concat([cipher.update(clair, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}.${cles.id}.${Buffer.concat([iv, tag, corps]).toString("base64url")}`;
}

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

/**
 * EMPREINTE DE RECHERCHE — HMAC-SHA256 (sous-clé dédiée) de la nature et de la valeur NORMALISÉE.
 * Stable : la même valeur donne toujours la même empreinte sous la même clé, ce qui permet de
 * retrouver « à qui est ce RIB ? » sans rien déchiffrer. La nature y entre : un NIN et un RIB qui
 * partageraient des chiffres ne se confondent pas.
 */
export function empreinte(cles: ClesCoffre, nature: NatureCoffre, normalisee: string): string {
  return crypto.createHmac("sha256", cles.empreinte).update(`${nature}\u0000${normalisee}`, "utf8").digest("hex");
}
