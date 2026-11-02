import crypto from "node:crypto";

/**
 * LA CLÉ DU COFFRE — `COFFRE_KEY`, dédiée, jamais celle du Drive.
 *
 * Le Drive se replie sur une clé dérivée de `NEXTAUTH_SECRET` quand `DRIVE_ENCRYPTION_KEY` manque :
 * acceptable pour des fichiers, pas pour des RIB et des salaires. Le coffre n'a donc AUCUN repli en
 * production : sans `COFFRE_KEY`, il refuse de chiffrer comme de lire, avec un message qui dit quoi
 * faire. Il refuse aussi une `COFFRE_KEY` identique à `DRIVE_ENCRYPTION_KEY` : une fuite de l'une ne
 * doit pas ouvrir l'autre.
 *
 * Format : 32 octets, en hexadécimal (64 caractères) ou en base64. Générer avec
 * `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` et la poser sur Render,
 * jamais dans le code ni dans le dépôt.
 *
 * Développement et tests (`NODE_ENV` ≠ `production`) : sans `COFFRE_KEY`, une clé FIXE de
 * développement est utilisée — publique puisqu'écrite ici, donc sans valeur de secret. Ce qui est
 * chiffré avec elle ne se lit pas en production (identifiant de clé différent : refus explicite).
 * Un avertissement est écrit une fois en développement ; les tests restent silencieux.
 *
 * Deux sous-clés sont DÉRIVÉES (HKDF-SHA256) de la clé maîtresse : l'une chiffre (AES-256-GCM),
 * l'autre calcule l'empreinte de recherche (HMAC-SHA256). Connaître une empreinte ne donne rien
 * sur la clé de chiffrement, et inversement.
 *
 * La clé est lue À L'USAGE, jamais au chargement du module : `next build` tourne en production
 * sans les secrets d'exécution, et ne doit pas tomber pour autant.
 */

export class ErreurCleCoffre extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ErreurCleCoffre";
  }
}

export interface ClesCoffre {
  /** Sous-clé AES-256-GCM. */
  readonly chiffrement: Buffer;
  /** Sous-clé HMAC-SHA256 de l'empreinte de recherche. */
  readonly empreinte: Buffer;
  /** Identifiant public de la clé maîtresse (8 caractères hexadécimaux), écrit dans chaque chiffré. */
  readonly id: string;
  /** `true` quand c'est la clé de développement, jamais acceptable en production. */
  readonly developpement: boolean;
}

const SEL = Buffer.from("amd-internal-os/coffre", "utf8");
const CLE_DEVELOPPEMENT = crypto.createHash("sha256").update("amd-internal-os/coffre/cle-de-developpement-NON-SECRETE").digest();

function decoder(brute: string, nom: string): Buffer {
  const v = brute.trim();
  const buf = /^[0-9a-fA-F]{64}$/.test(v) ? Buffer.from(v, "hex") : Buffer.from(v, "base64");
  if (buf.length !== 32) {
    throw new ErreurCleCoffre(`${nom} invalide : 32 octets attendus, en hexadécimal (64 caractères) ou en base64.`);
  }
  return buf;
}

function deriver(maitresse: Buffer, usage: string): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", maitresse, SEL, `coffre/${usage}/v1`, 32));
}

/** Construit les sous-clés à partir d'une clé maîtresse de 32 octets. Exporté pour les tests et la rotation. */
export function clesDepuisMaitresse(maitresse: Buffer, developpement = false): ClesCoffre {
  if (maitresse.length !== 32) throw new ErreurCleCoffre("Clé maîtresse du coffre : 32 octets attendus.");
  return {
    chiffrement: deriver(maitresse, "chiffrement"),
    empreinte: deriver(maitresse, "empreinte"),
    id: deriver(maitresse, "identifiant").subarray(0, 4).toString("hex"),
    developpement,
  };
}

let avertissementEcrit = false;

/**
 * Lit les clés depuis l'environnement. Lève `ErreurCleCoffre` en production si `COFFRE_KEY` manque,
 * si elle est mal formée (dans tous les environnements), ou si elle est celle du Drive.
 */
export function chargerCles(env: NodeJS.ProcessEnv = process.env): ClesCoffre {
  const brute = env.COFFRE_KEY;
  const production = env.NODE_ENV === "production";
  if (!brute || brute.trim() === "") {
    if (production) {
      throw new ErreurCleCoffre(
        "Coffre fermé : la variable COFFRE_KEY manque. Générer 32 octets aléatoires (hexadécimal) et la poser dans l'environnement du serveur. Aucune donnée sensible n'est chiffrée ni lue sans elle.",
      );
    }
    if (env.NODE_ENV !== "test" && !avertissementEcrit) {
      avertissementEcrit = true;
      console.warn("[coffre] COFFRE_KEY absente : clé de DÉVELOPPEMENT utilisée (non secrète, refusée en production).");
    }
    return clesDepuisMaitresse(CLE_DEVELOPPEMENT, true);
  }
  const maitresse = decoder(brute, "COFFRE_KEY");
  const drive = env.DRIVE_ENCRYPTION_KEY;
  if (drive) {
    let cleDrive: Buffer | null = null;
    try { cleDrive = decoder(drive, "DRIVE_ENCRYPTION_KEY"); } catch { cleDrive = null; }
    if (cleDrive && crypto.timingSafeEqual(cleDrive, maitresse)) {
      throw new ErreurCleCoffre("COFFRE_KEY refusée : elle est identique à DRIVE_ENCRYPTION_KEY. Le coffre exige sa propre clé.");
    }
  }
  return clesDepuisMaitresse(maitresse, false);
}
