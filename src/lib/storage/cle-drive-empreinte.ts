import { prisma } from "@/lib/prisma";
import { journal, sansBloquer } from "@/lib/journal";
import { ErreurCleDrive, jugerEmpreinte, lireTrousseau } from "./cle-drive";

/**
 * L'EMPREINTE DE LA CLÉ, PARTAGÉE PAR TOUS LES SERVICES (audit Drive du 24/11, A2).
 *
 * Le premier service qui démarre pose l'identifiant de sa clé dans `AppSetting.driveKeyFingerprint` ;
 * chaque service qui démarre ensuite compare le sien. Un service dont la clé diffère (et n'est pas une
 * rotation : la référence n'est pas dans son trousseau d'anciennes clés) écrirait des fichiers que les
 * autres ne sauraient pas relire — en production, il REFUSE D'ÉCRIRE, et `/api/health` le signale.
 * Il continue de lire : ce qu'il sait déchiffrer, il le sert.
 *
 * Hors production, la divergence est seulement journalisée : un poste de développement change de clé
 * sans que cela engage personne.
 *
 * SANS `DRIVE_ENCRYPTION_KEY` EN PRODUCTION (Super Admin, 24/11/2026 : déploiement sans clé posée, à poser plus tard), le
 * service chiffre avec la dérivation d'avant (`cle-drive.ts`) : il écrit et lit, mais l'état est « absente » — dégradé,
 * avertissement au démarrage. L'empreinte joue pareil : un service dont le secret diffère reste « divergente » et
 * refuse d'écrire.
 */

export type EtatCleFichiers = "ok" | "absente" | "invalide" | "divergente" | "inconnue";

export interface VerificationCle {
  etat: EtatCleFichiers;
  /** Ce qu'il faut faire, en clair (jamais la clé ; l'identifiant n'est pas un secret). */
  message: string | null;
}

/** Où vit la référence : la ligne globale des réglages ; injectable pour les tests. */
export interface MagasinEmpreinte {
  lire(): Promise<string | null>;
  /** Pose la référence si elle est encore vide (le premier service gagne). */
  poser(id: string): Promise<void>;
  /** Avance la référence d'une ancienne clé vers la nouvelle (rotation), seulement si elle vaut encore `de`. */
  avancer(de: string, vers: string): Promise<void>;
}

export const MAGASIN_REGLAGES: MagasinEmpreinte = {
  lire: async () => (await prisma.appSetting.findUnique({ where: { id: "global" }, select: { driveKeyFingerprint: true } }))?.driveKeyFingerprint ?? null,
  poser: async (id) => {
    await prisma.appSetting.upsert({ where: { id: "global" }, create: { id: "global", driveKeyFingerprint: id }, update: {} });
    await prisma.appSetting.updateMany({ where: { id: "global", driveKeyFingerprint: null }, data: { driveKeyFingerprint: id } });
  },
  avancer: async (de, vers) => {
    await prisma.appSetting.updateMany({ where: { id: "global", driveKeyFingerprint: de }, data: { driveKeyFingerprint: vers } });
  },
};

export async function verifierCleDrive(o: {
  magasin?: MagasinEmpreinte; ecrire?: boolean; env?: NodeJS.ProcessEnv;
} = {}): Promise<VerificationCle> {
  const magasin = o.magasin ?? MAGASIN_REGLAGES;
  let t: ReturnType<typeof lireTrousseau>;
  try {
    t = lireTrousseau(o.env ?? process.env);
  } catch (e) {
    if (!(e instanceof ErreurCleDrive)) throw e;
    return { etat: "invalide", message: e.message };
  }
  const env = o.env ?? process.env;
  const repli: VerificationCle = t.source === "repli" && env.NODE_ENV === "production"
    ? {
        etat: "absente",
        message: "DRIVE_ENCRYPTION_KEY n'est pas posée : les fichiers se chiffrent avec la clé dérivée du secret d'authentification "
          + "(comportement d'avant). Posez la MÊME clé sur chaque service (web, Adventum IA, worker) dans Render › Environment, "
          + "avec l'ancienne clé dérivée dans DRIVE_ENCRYPTION_KEYS — voir docs/readme/37-sauvegardes-restauration.md.",
      }
    : { etat: "ok", message: null };
  let reference: string | null;
  try {
    reference = await magasin.lire();
    let j = jugerEmpreinte(reference, t);
    if (o.ecrire && j === "a-poser") {
      await magasin.poser(t.active.id);
      reference = await magasin.lire(); // un autre service a pu poser la sienne au même instant
      j = jugerEmpreinte(reference, t);
    }
    if (o.ecrire && j === "rotation" && reference) {
      await magasin.avancer(reference, t.active.id);
      j = "conforme";
    }
    if (j !== "divergente") return repli;
  } catch (e) {
    journal.avertissement("drive.cle.empreinte-illisible", {}, e);
    return { etat: "inconnue", message: "Empreinte de la clé des fichiers illisible (base en retard de migration ?)." };
  }
  return {
    etat: "divergente",
    message: `La clé des fichiers de ce service (empreinte ${t.active.id}) n'est pas celle des autres services (référence ${reference}). `
      + "Posez sur ce service la MÊME DRIVE_ENCRYPTION_KEY que les autres ; pour une rotation voulue, mettez l'ancienne clé dans "
      + "DRIVE_ENCRYPTION_KEYS. Tant que ce n'est pas fait, ce service refuse d'enregistrer des fichiers.",
  };
}

let refus: string | null = null;

/** Le refus d'écrire de CE processus (production, clé divergente), ou `null`. Lu par `putBlob`. */
export function refusEcritureCle(): string | null {
  return refus;
}

function appliquer(v: VerificationCle, production = process.env.NODE_ENV === "production"): VerificationCle {
  // « absente » (repli sur la dérivation d'avant) écrit normalement : seule la divergence ferme l'écriture.
  if (production) refus = v.etat === "divergente" ? v.message : v.etat === "ok" || v.etat === "absente" ? null : refus;
  return v;
}

/** Au démarrage de chaque service (web : `instrumentation.ts`, worker : `scripts/worker.ts`). Ne lève jamais. */
export async function verifierCleDriveAuDemarrage(o: { magasin?: MagasinEmpreinte; production?: boolean } = {}): Promise<VerificationCle> {
  const v = appliquer(await verifierCleDrive({ ecrire: true, magasin: o.magasin }).catch((e) => {
    journal.avertissement("drive.cle.verification", {}, e);
    return { etat: "inconnue" as const, message: null };
  }), o.production);
  if (v.etat === "ok") journal.info("drive.cle.verifiee", {});
  else if (v.etat === "absente") journal.avertissement("drive.cle.repli", { message: v.message });
  else journal.erreur("drive.cle." + v.etat, { message: v.message });
  return v;
}

let sante: { quand: number; v: VerificationCle } | null = null;

/** Pour `/api/health` : relue au plus toutes les minutes, sans rien écrire. Ne lève jamais. */
export async function etatCleDrivePourSante(): Promise<EtatCleFichiers> {
  if (sante && Date.now() - sante.quand < 60_000) return sante.v.etat;
  const v = appliquer(await verifierCleDrive().catch(sansBloquer("drive.cle.sante", { etat: "inconnue" as const, message: null })));
  sante = { quand: Date.now(), v };
  return v.etat;
}
