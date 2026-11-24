import crypto from "crypto";

/**
 * LA CLÉ DES FICHIERS — `DRIVE_ENCRYPTION_KEY`, et le trousseau des anciennes (audit Drive du 24/11, A2).
 *
 * Avant : une clé mal formée (63 caractères collés tronqués) était ignorée EN SILENCE, et chaque service
 * retombait sur une clé dérivée de SON secret d'authentification. Le web, l'app Adventum IA et le worker
 * n'ayant pas les mêmes secrets, un fichier écrit par l'un était illisible par l'autre — et la
 * déduplication resservait ce blob illisible à qui redéposait le fichier pour « réparer ».
 *
 * Désormais :
 *   • une clé DÉFINIE mais invalide est une erreur, partout ;
 *   • en production, `DRIVE_ENCRYPTION_KEY` est obligatoire (aucun repli) ;
 *   • chaque clé a un IDENTIFIANT court (HMAC) écrit dans `FileBlob.keyId` : on sait avec quelle clé
 *     relire un blob, et l'on ne réemploie jamais un blob d'une autre clé ;
 *   • `DRIVE_ENCRYPTION_KEYS` porte les ANCIENNES clés (rotation, blobs écrits par un service mal
 *     configuré) : elles servent à lire, jamais à écrire.
 *
 * Format d'une clé : 32 octets, en hexadécimal (64 caractères) ou en base64 (44 caractères).
 * Hors production, sans `DRIVE_ENCRYPTION_KEY`, la clé reste dérivée du secret d'authentification
 * (comportement d'avant : les fichiers de développement et des bancs restent lisibles).
 *
 * Module pur (ni base, ni réseau) : il lit l'environnement qu'on lui passe.
 */

export class ErreurCleDrive extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ErreurCleDrive";
  }
}

export interface CleDrive {
  readonly cle: Buffer;
  /** Identifiant public de la clé (16 caractères hexadécimaux) : ne révèle rien de la clé. */
  readonly id: string;
}

export interface TrousseauDrive {
  /** La clé qui chiffre les écritures. */
  readonly active: CleDrive;
  /** Les anciennes clés, pour LIRE seulement. */
  readonly anciennes: readonly CleDrive[];
  /** `repli` : clé dérivée du secret d'authentification (hors production seulement). */
  readonly source: "DRIVE_ENCRYPTION_KEY" | "repli";
}

const GENERER = "node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"";

/** Identifiant d'une clé : HMAC tronqué, stable, non réversible. */
export function identifiantCle(cle: Buffer): string {
  return crypto.createHmac("sha256", cle).update("amd-internal-os/drive/identifiant-de-cle/v1").digest("hex").slice(0, 16);
}

function decoder(brute: string, nom: string): Buffer {
  const v = brute.trim();
  let buf: Buffer | null = null;
  if (/^[0-9a-fA-F]{64}$/.test(v)) buf = Buffer.from(v, "hex");
  else if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(v)) buf = Buffer.from(v, "base64");
  if (!buf || buf.length !== 32) {
    throw new ErreurCleDrive(
      `${nom} invalide (${v.length} caractères) : 32 octets attendus, en hexadécimal (64 caractères) ou en base64 (44 caractères). `
      + "Rien n'a été chiffré avec elle : corrigez la variable sur ce service (une clé collée tronquée est la cause habituelle).",
    );
  }
  return buf;
}

const cleDe = (cle: Buffer): CleDrive => ({ cle, id: identifiantCle(cle) });

/** Lit le trousseau. Lève `ErreurCleDrive` (message qui dit le remède) si la configuration est fausse. */
export function lireTrousseau(env: NodeJS.ProcessEnv = process.env): TrousseauDrive {
  const explicite = env.DRIVE_ENCRYPTION_KEY?.trim();
  let active: CleDrive;
  let source: TrousseauDrive["source"];
  if (explicite) {
    active = cleDe(decoder(explicite, "DRIVE_ENCRYPTION_KEY"));
    source = "DRIVE_ENCRYPTION_KEY";
  } else if (env.NODE_ENV === "production") {
    throw new ErreurCleDrive(
      "DRIVE_ENCRYPTION_KEY manquante : en production, les fichiers ne se chiffrent qu'avec une clé explicite, "
      + "LA MÊME sur chaque service (web, Adventum IA, worker). Posez-la dans Render › le service › Environment "
      + `(générer : ${GENERER}) — voir docs/readme/37-sauvegardes-restauration.md.`,
    );
  } else {
    // Hors production : la dérivation d'avant, pour que les fichiers de développement restent lisibles.
    const secret = env.NEXTAUTH_SECRET ?? env.AUTH_SECRET ?? "amd-internal-os";
    active = cleDe(crypto.createHash("sha256").update(secret).digest());
    source = "repli";
  }
  const anciennes: CleDrive[] = [];
  const brutes = (env.DRIVE_ENCRYPTION_KEYS ?? "").split(/[\s,;]+/).filter(Boolean);
  brutes.forEach((b, i) => {
    const c = cleDe(decoder(b, `DRIVE_ENCRYPTION_KEYS (clé n° ${i + 1})`));
    if (c.id !== active.id && !anciennes.some((a) => a.id === c.id)) anciennes.push(c);
  });
  return { active, anciennes, source };
}

let memo: { signature: string; trousseau: TrousseauDrive } | null = null;

/** Le trousseau de CE processus, relu quand l'environnement change (les bancs de test le font). */
export function trousseauCourant(): TrousseauDrive {
  const e = process.env;
  const signature = [e.NODE_ENV, e.DRIVE_ENCRYPTION_KEY, e.DRIVE_ENCRYPTION_KEYS, e.NEXTAUTH_SECRET, e.AUTH_SECRET].join("\u0000");
  if (memo?.signature !== signature) memo = { signature, trousseau: lireTrousseau(e) };
  return memo.trousseau;
}

/** La clé qui porte cet identifiant, active ou ancienne ; `null` si ce service ne l'a pas. */
export function cleParIdentifiant(t: TrousseauDrive, id: string): CleDrive | null {
  if (t.active.id === id) return t.active;
  return t.anciennes.find((c) => c.id === id) ?? null;
}

/**
 * Ce que dit l'empreinte de référence (AppSetting) face à la clé active de ce service :
 *   • `a-poser`    : aucune référence encore — ce service la pose ;
 *   • `conforme`   : même clé ;
 *   • `rotation`   : la référence est une ANCIENNE clé de ce trousseau — rotation voulue, la référence avance ;
 *   • `divergente` : autre clé, inconnue de ce trousseau — ce service écrirait des fichiers que les autres
 *                    ne sauraient pas relire : il refuse d'écrire.
 */
export type JugementEmpreinte = "a-poser" | "conforme" | "rotation" | "divergente";

export function jugerEmpreinte(reference: string | null, t: TrousseauDrive): JugementEmpreinte {
  if (!reference) return "a-poser";
  if (reference === t.active.id) return "conforme";
  return t.anciennes.some((c) => c.id === reference) ? "rotation" : "divergente";
}
