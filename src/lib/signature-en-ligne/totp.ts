import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * LE CODE À USAGE UNIQUE D'UNE SIGNATURE EN LIGNE (Direction, 15/11/2026) — TOTP, RFC 6238 (HMAC-SHA1, 6 chiffres, pas
 * de 30 s), lu par toute application d'authentification (Google Authenticator, Microsoft Authenticator, 2FAS…).
 * Serveur seulement (`node:crypto`). Aucune dépendance : la norme tient en quelques lignes, et ses vecteurs de test
 * officiels sont rejoués par `totp.test.ts`.
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const PAS_SECONDES = 30;
export const CHIFFRES = 6;

export function base32(octets: Buffer): string {
  let bits = 0, valeur = 0, sortie = "";
  for (const o of octets) {
    valeur = (valeur << 8) | o;
    bits += 8;
    while (bits >= 5) {
      sortie += ALPHABET[(valeur >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) sortie += ALPHABET[(valeur << (5 - bits)) & 31];
  return sortie;
}

export function depuisBase32(texte: string): Buffer {
  const propre = texte.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0, valeur = 0;
  const octets: number[] = [];
  for (const c of propre) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) throw new Error("Secret illisible.");
    valeur = (valeur << 5) | i;
    bits += 5;
    if (bits >= 8) {
      octets.push((valeur >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(octets);
}

/** Un secret neuf : 20 octets aléatoires (160 bits, la taille de HMAC-SHA1), en base32. */
export const genererSecret = (): string => base32(randomBytes(20));

/** Le pas de temps d'un instant (millisecondes). */
export const pasDe = (instantMs: number): number => Math.floor(instantMs / 1000 / PAS_SECONDES);

/** Le code d'un pas — clé brute, `chiffres` chiffres (RFC 4226 §5.3, troncature dynamique). */
export function codeDuPas(cle: Buffer, pas: number, chiffres = CHIFFRES): string {
  const compteur = Buffer.alloc(8);
  compteur.writeBigUInt64BE(BigInt(pas));
  const h = createHmac("sha1", cle).update(compteur).digest();
  const decalage = h[h.length - 1] & 0x0f;
  const binaire = ((h[decalage] & 0x7f) << 24) | (h[decalage + 1] << 16) | (h[decalage + 2] << 8) | h[decalage + 3];
  return String(binaire % 10 ** chiffres).padStart(chiffres, "0");
}

/**
 * VÉRIFIER UN CODE SAISI — accepté sur le pas courant ou son voisin (une minute et demie de tolérance d'horloge), et
 * seulement sur un pas PLUS RÉCENT que le dernier servi (`dernierPas`) : un code vu par-dessus l'épaule ne sert pas deux
 * fois. Rend le pas accepté, à enregistrer, ou `null`.
 */
export function verifierCode(secret: string, saisi: string, instantMs: number, dernierPas: number): number | null {
  const code = saisi.replace(/\s/g, "");
  if (!/^\d{6}$/.test(code)) return null;
  const cle = depuisBase32(secret);
  const courant = pasDe(instantMs);
  for (const pas of [courant, courant - 1, courant + 1]) {
    if (pas <= dernierPas) continue;
    const attendu = Buffer.from(codeDuPas(cle, pas));
    if (timingSafeEqual(attendu, Buffer.from(code))) return pas;
  }
  return null;
}

/** L'adresse `otpauth://` que l'application lit dans le QR code. */
export function adresseOtpauth(secret: string, compte: string, emetteur = "AMD Internal OS"): string {
  const libelle = encodeURIComponent(`${emetteur}:${compte}`);
  return `otpauth://totp/${libelle}?secret=${secret}&issuer=${encodeURIComponent(emetteur)}&algorithm=SHA1&digits=${CHIFFRES}&period=${PAS_SECONDES}`;
}
