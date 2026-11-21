import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { chargerCles, ErreurCleCoffre } from "@/modules/coffre/api";
import { checkLockout, recordFailure, clearAttempts } from "@/lib/login-throttle";
import { genererSecret, verifierCode, adresseOtpauth } from "./totp";

/**
 * LE CONTRÔLE RENFORCÉ D'UNE SIGNATURE EN LIGNE (Direction, 15/11/2026) — serveur seulement.
 *
 * Deux preuves, au moment même de signer : le MOT DE PASSE du compte (ce que la personne sait — une session laissée
 * ouverte ne suffit pas) et un CODE À USAGE UNIQUE de son application d'authentification (ce qu'elle a). Les échecs
 * comptent comme ceux de la connexion : cinq de suite verrouillent la signature un quart d'heure.
 *
 * Le secret TOTP est chiffré AES-256-GCM sous une clé DÉRIVÉE de la clé du coffre (HKDF, usage « signature/totp ») :
 * la base seule ne le livre pas.
 */

export const REFUS_VUE_EXACTE = "Vous visualisez le compte d'une autre personne : une signature, un cachet ou un code de signature ne se prépare et ne s'appose que depuis son propre compte. "
  + "Le Super Admin peut signer en suppléance depuis le SIEN : quittez « Agir comme » — le BC portera son nom, sa signature et la mention « en suppléance ».";

/** Le coffre fermé (clé absente) : la signature en ligne le DIT, au lieu d'une erreur serveur muette. */
export const REFUS_COFFRE_FERME = "La signature en ligne est indisponible : le coffre du serveur est fermé (clé COFFRE_KEY absente). Prévenez l'administrateur ; en attendant, la copie signée reste possible.";

/** Exécute un geste qui lit la clé du coffre ; un coffre fermé rend `REFUS_COFFRE_FERME`, toute autre panne remonte. */
export async function sousLeCoffre<T>(geste: () => Promise<T>): Promise<T | { refusCoffre: string }> {
  try {
    return await geste();
  } catch (e) {
    if (e instanceof ErreurCleCoffre) return { refusCoffre: REFUS_COFFRE_FERME };
    throw e;
  }
}

const cleTotp = (): Buffer => Buffer.from(crypto.hkdfSync("sha256", chargerCles().chiffrement, Buffer.from("amd/signature"), "signature/totp/v1", 32));

export function chiffrerSecret(secret: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", cleTotp(), iv);
  const corps = Buffer.concat([c.update(secret, "utf8"), c.final()]);
  return `t1.${Buffer.concat([iv, c.getAuthTag(), corps]).toString("base64")}`;
}

export function dechiffrerSecret(chiffre: string): string {
  if (!chiffre.startsWith("t1.")) throw new Error("Secret au format inconnu.");
  const brut = Buffer.from(chiffre.slice(3), "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", cleTotp(), brut.subarray(0, 12));
  d.setAuthTag(brut.subarray(12, 28));
  return Buffer.concat([d.update(brut.subarray(28)), d.final()]).toString("utf8");
}

export interface EtatSecondFacteur { actif: boolean; enCours: boolean }

export async function etatSecondFacteur(userId: string): Promise<EtatSecondFacteur> {
  const f = await prisma.secondFacteur.findUnique({ where: { userId }, select: { activeLe: true } });
  return { actif: Boolean(f?.activeLe), enCours: Boolean(f && !f.activeLe) };
}

/** COMMENCER (ou recommencer) l'enrôlement : un secret neuf, pas encore actif tant qu'un premier code ne l'a pas prouvé. */
export async function commencerEnrolement(userId: string, compte: string): Promise<{ secret: string; adresse: string }> {
  const secret = genererSecret();
  const secretChiffre = chiffrerSecret(secret);
  await prisma.secondFacteur.upsert({
    where: { userId },
    create: { userId, secretChiffre },
    update: { secretChiffre, activeLe: null, dernierPas: 0 },
  });
  return { secret, adresse: adresseOtpauth(secret, compte) };
}

/** CONFIRMER l'enrôlement par un premier code lu dans l'application. */
export async function confirmerEnrolement(userId: string, code: string): Promise<string | null> {
  const f = await prisma.secondFacteur.findUnique({ where: { userId } });
  if (!f) return "Commencez par afficher le QR code, puis saisissez le code de l'application.";
  const pas = verifierCode(dechiffrerSecret(f.secretChiffre), code, Date.now(), f.dernierPas);
  if (pas === null) return "Ce code ne correspond pas : vérifiez l'heure de votre téléphone et saisissez le code affiché maintenant.";
  await prisma.secondFacteur.update({ where: { userId }, data: { activeLe: new Date(), dernierPas: pas } });
  return null;
}

const cleSignature = (userId: string) => `signature:${userId}`;

/**
 * LE CONTRÔLE AU MOMENT DE SIGNER — rend le refus à dire, ou `null`. Le code accepté est CONSOMMÉ par une écriture
 * conditionnelle (`dernierPas` < pas) : deux clics simultanés avec le même code n'en font passer qu'un.
 */
export async function controleRenforce(userId: string, motDePasse: string, code: string, ip: string | null): Promise<string | null> {
  const r = await sousLeCoffre(() => controle(userId, motDePasse, code, ip));
  return r && typeof r === "object" ? r.refusCoffre : r;
}

async function controle(userId: string, motDePasse: string, code: string, ip: string | null): Promise<string | null> {
  const cle = cleSignature(userId);
  const verrou = await checkLockout(cle);
  if (verrou.locked) return `Trop d'essais : la signature est verrouillée jusqu'à ${verrou.until?.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}.`;
  const [user, facteur] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { passwordHash: true } }),
    prisma.secondFacteur.findUnique({ where: { userId } }),
  ]);
  if (!facteur?.activeLe) return "Activez d'abord votre code de signature (Mon espace › Ma signature) : sans lui, rien ne se signe en ligne.";
  const bonMdp = Boolean(user?.passwordHash && motDePasse && (await bcrypt.compare(motDePasse, user.passwordHash)));
  const pas = bonMdp ? verifierCode(dechiffrerSecret(facteur.secretChiffre), code, Date.now(), facteur.dernierPas) : null;
  if (!bonMdp || pas === null) {
    await recordFailure(cle, ip);
    return bonMdp ? "Code de l'application incorrect ou déjà utilisé : saisissez le code affiché maintenant." : "Mot de passe incorrect.";
  }
  const pris = await prisma.secondFacteur.updateMany({ where: { userId, dernierPas: { lt: pas } }, data: { dernierPas: pas } });
  if (pris.count === 0) return "Ce code vient d'être utilisé : attendez le suivant (30 secondes).";
  await clearAttempts(cle);
  return null;
}
