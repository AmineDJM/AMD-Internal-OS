import crypto from "node:crypto";
import type { ClesCoffre } from "./cle";
import type { NatureCoffre } from "../domaine/natures";

/**
 * CHIFFREMENT DU COFFRE — AES-256-GCM, IV aléatoire de 12 octets par valeur.
 *
 * Ce module CHIFFRE et ne déchiffre pas : le déchiffrement vit seul dans `dechiffrement.ts`, que le
 * chemin d'écriture (double écriture appelée par des actions que l'assistant peut atteindre) n'importe
 * jamais — `frontiere.test.ts` le prouve.
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

export const VERSION = "c1";

export function aad(nature: NatureCoffre, donneeId: string): Buffer {
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

/**
 * EMPREINTE DE RECHERCHE — HMAC-SHA256 (sous-clé dédiée) de la nature et de la valeur NORMALISÉE.
 * Stable : la même valeur donne toujours la même empreinte sous la même clé, ce qui permet de
 * retrouver « à qui est ce RIB ? » sans rien déchiffrer. La nature y entre : un NIN et un RIB qui
 * partageraient des chiffres ne se confondent pas.
 */
export function empreinte(cles: ClesCoffre, nature: NatureCoffre, normalisee: string): string {
  return crypto.createHmac("sha256", cles.empreinte).update(`${nature}\u0000${normalisee}`, "utf8").digest("hex");
}

/**
 * LE CHIFFRÉ EN COLONNES — la table `DonneeSensible` range séparément le corps, l'IV, l'étiquette GCM,
 * la version du format et l'identifiant de clé. `decomposer` (ici) et `recomposer` (`dechiffrement.ts`)
 * passent d'une forme à l'autre sans rien déchiffrer : `recomposer(decomposer(c)) === c`.
 */
export interface ColonnesChiffre {
  valeurChiffree: Buffer;
  iv: Buffer;
  tag: Buffer;
  cleVersion: number;
  cleId: string;
}

export function decomposer(chiffre: string): ColonnesChiffre {
  const [version, id, charge, ...reste] = chiffre.split(".");
  if (version !== VERSION || !id || !charge || reste.length) throw new ErreurDechiffrement("Chiffré du coffre mal formé.");
  const brut = Buffer.from(charge, "base64url");
  if (brut.length < 12 + 16) throw new ErreurDechiffrement("Chiffré du coffre tronqué.");
  return { iv: brut.subarray(0, 12), tag: brut.subarray(12, 28), valeurChiffree: brut.subarray(28), cleVersion: 1, cleId: id };
}
