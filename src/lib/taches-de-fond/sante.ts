import { prisma } from "@/lib/prisma";
import type { StatutTacheDeFond, TacheDeFond } from "@prisma/client";
import { etatMoteur } from "@/lib/office/conversions-haute-fidelite";
import { sansBloquer } from "@/lib/journal";
import { journalConsole, messageErreur, type Journal } from "./journal";
import { lireModeTachesDeFond, modeInconnu, type ModeTachesDeFond } from "./mode";

/**
 * LE SIGNAL DE SANTÉ DES TÂCHES DE FOND (refonte V2-F) — lu par `/api/health/worker` et par le
 * Diagnostic (Super Admin). Il ne lit que la table des baux : pas la chaîne des tâches, donc ni
 * battement armé ni module lourd chargé pour répondre.
 *
 * « Vivant » = au moins une tâche est partie depuis moins de `SEUIL_SILENCE_MS`. Une tâche dont
 * le dernier départ est plus vieux est EN RETARD ; une tâche EN_COURS dont le bail a expiré a été
 * INTERROMPUE (processus tué) et attend sa reprise.
 */

/** Cinq battements manqués : au-delà, quelque chose s'est arrêté. */
export const SEUIL_SILENCE_MS = 5 * 60_000;

export type EtatTache = {
  cle: string;
  executeur: string | null;
  dernierDebutA: string | null;
  dernierFinA: string | null;
  derniereDureeMs: number | null;
  statut: StatutTacheDeFond | null;
  enCours: boolean;
  interrompue: boolean;
  enRetard: boolean;
  executions: number;
  echecs: number;
  /** Détail réservé au Super Admin : identité du processus et message du dernier passage. */
  detenteur?: string | null;
  message?: string | null;
};

export type SanteTachesDeFond = {
  mode: ModeTachesDeFond;
  modeInconnu: boolean;
  verifieA: string;
  vivant: boolean;
  dernierBattementA: string | null;
  /** Qui a fait des passages récents (« web », « worker ») — la bascule se lit ici. */
  executeursRecents: string[];
  taches: EtatTache[];
};

type LigneTache = Pick<TacheDeFond,
  "cle" | "detenteur" | "executeur" | "bailJusqua" | "dernierDebutA" | "dernierFinA" | "derniereDureeMs"
  | "dernierStatut" | "dernierMessage" | "executions" | "echecs">;

/** Pur : des lignes de bail à l'état de santé. */
export function evaluerSante(lignes: LigneTache[], o: { maintenant: Date; mode: ModeTachesDeFond; modeInconnu: boolean; detail: boolean }): SanteTachesDeFond {
  const t = o.maintenant.getTime();
  const recent = (d: Date | null) => d !== null && t - d.getTime() < SEUIL_SILENCE_MS;
  const taches = [...lignes].sort((a, b) => a.cle.localeCompare(b.cle)).map((l): EtatTache => {
    const bailVivant = l.bailJusqua !== null && l.bailJusqua.getTime() >= t;
    return {
      cle: l.cle,
      executeur: l.executeur,
      dernierDebutA: l.dernierDebutA?.toISOString() ?? null,
      dernierFinA: l.dernierFinA?.toISOString() ?? null,
      derniereDureeMs: l.derniereDureeMs,
      statut: l.dernierStatut,
      enCours: l.dernierStatut === "EN_COURS" && bailVivant,
      interrompue: l.dernierStatut === "EN_COURS" && !bailVivant,
      enRetard: !recent(l.dernierDebutA),
      executions: l.executions,
      echecs: l.echecs,
      ...(o.detail ? { detenteur: l.detenteur, message: l.dernierMessage } : {}),
    };
  });
  const dernier = lignes.reduce<Date | null>((m, l) => (l.dernierDebutA && (!m || l.dernierDebutA > m) ? l.dernierDebutA : m), null);
  const executeursRecents = [...new Set(lignes.filter((l) => recent(l.dernierDebutA) && l.executeur).map((l) => l.executeur as string))].sort();
  return {
    mode: o.mode,
    modeInconnu: o.modeInconnu,
    verifieA: o.maintenant.toISOString(),
    vivant: recent(dernier),
    dernierBattementA: dernier?.toISOString() ?? null,
    executeursRecents,
    taches,
  };
}

export async function lireSanteTachesDeFond(o: { detail: boolean }): Promise<SanteTachesDeFond> {
  const lignes = await prisma.tacheDeFond.findMany({
    select: {
      cle: true, detenteur: true, executeur: true, bailJusqua: true, dernierDebutA: true, dernierFinA: true,
      derniereDureeMs: true, dernierStatut: true, dernierMessage: true, executions: true, echecs: true,
    },
  });
  return evaluerSante(lignes, { maintenant: new Date(), mode: lireModeTachesDeFond(), modeInconnu: modeInconnu(), detail: o.detail });
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CONTRÔLE AU DÉMARRAGE DU WORKER (décision 0019) — « Cliquez Sync, c'est tout ».
 *
 * La Direction ne veut aucune manipulation après la synchronisation du Blueprint. Le worker reçoit ses variables du
 * web (`fromService`, `render.yaml`) ; si une manque (posée nulle part, ou que Render n'a pas pu relier), il le DIT :
 *   • une ligne de journal par manque, en français, au démarrage (`worker.controle`) ;
 *   • le rapport en base (`ControleWorker`) : Administration › Diagnostic › Worker le montre au Super Admin.
 * Il ne refuse pas de démarrer pour une clé facultative : une tâche qui n'en a pas besoin doit tourner.
 * Seules les CRITIQUES (base, clé maître) le mettent en échec — et même alors il écrit d'abord pourquoi.
 *
 * Aucune VALEUR n'est lue au-delà de « présente / absente » : le rapport ne porte jamais un secret.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type GraviteVariable = "critique" | "importante" | "facultative";

export interface VariableAttendue {
  cle: string;
  gravite: GraviteVariable;
  /** Ce qui ne marche pas sans elle — la phrase du journal et de l'écran. */
  sans: string;
}

/**
 * Les variables que le CODE du worker lit (recensées dans `src/` : `process.env.X`) et qui ne se devinent pas — les
 * réglages à valeur par défaut (REG_*, plafonds, délais…) n'y sont pas. Chacune est reliée au web dans `render.yaml`.
 */
export const VARIABLES_DU_WORKER: VariableAttendue[] = [
  { cle: "DATABASE_URL", gravite: "critique", sans: "aucune tâche ne peut tourner (base injoignable)" },
  { cle: "AUTH_SECRET", gravite: "critique", sans: "le coffre et les secrets de connexion sont illisibles (il faut la MÊME valeur que le web)" },
  { cle: "APP_URL", gravite: "importante", sans: "les liens des notifications et courriels pointent nulle part" },
  { cle: "OPENAI_API_KEY", gravite: "importante", sans: "les travaux de l'Assistant IA et les routines ne peuvent pas appeler le modèle" },
  { cle: "S3_BUCKET", gravite: "importante", sans: "les gros fichiers stockés hors base (R2/S3) sont inaccessibles aux conversions et travaux" },
  { cle: "S3_ENDPOINT", gravite: "importante", sans: "stockage objet : point d'accès absent" },
  { cle: "S3_ACCESS_KEY_ID", gravite: "importante", sans: "stockage objet : identifiant absent" },
  { cle: "S3_SECRET_ACCESS_KEY", gravite: "importante", sans: "stockage objet : secret absent" },
  { cle: "VAPID_PUBLIC_KEY", gravite: "facultative", sans: "les notifications push des tâches de fond restent muettes" },
  { cle: "VAPID_PRIVATE_KEY", gravite: "facultative", sans: "les notifications push des tâches de fond restent muettes" },
  { cle: "MISTRAL_API_KEY", gravite: "facultative", sans: "l'OCR Mistral des dossiers réglementaires retombe sur tesseract" },
  { cle: "GOOGLE_CLIENT_ID", gravite: "facultative", sans: "la synchronisation Google (agenda, boîte) ne tourne pas" },
  { cle: "GOOGLE_CLIENT_SECRET", gravite: "facultative", sans: "la synchronisation Google (agenda, boîte) ne tourne pas" },
  { cle: "MICROSOFT_CLIENT_ID", gravite: "facultative", sans: "la synchronisation Microsoft 365 ne tourne pas" },
  { cle: "MICROSOFT_CLIENT_SECRET", gravite: "facultative", sans: "la synchronisation Microsoft 365 ne tourne pas" },
  { cle: "MAIL_API_KEY", gravite: "facultative", sans: "les courriels envoyés par les tâches de fond partent par le repli (ou pas du tout)" },
  { cle: "ADVENTUM_BASE_URL", gravite: "facultative", sans: "la publication vers le site public se tait" },
  { cle: "ADVENTUM_API_KEY", gravite: "facultative", sans: "la publication vers le site public se tait" },
];

export interface RapportControle {
  verifieA: string;
  detenteur: string;
  mode: string;
  pret: boolean;
  variables: { cle: string; gravite: GraviteVariable; presente: boolean; sans: string }[];
  manquantes: string[];
  moteur: { pret: boolean; manquants: string[]; detail: Record<string, unknown> | null; erreur: string | null } | null;
  messages: string[];
}

/** Pur : l'environnement (et l'état du moteur) → le rapport, avec les phrases à journaliser. */
export function evaluerControle(env: Record<string, string | undefined>, o: { detenteur: string; mode: string; moteur: RapportControle["moteur"]; maintenant?: Date }): RapportControle {
  const variables = VARIABLES_DU_WORKER.map((v) => ({ ...v, presente: Boolean((env[v.cle] ?? "").trim()) }));
  const manquantes = variables.filter((v) => !v.presente);
  const messages = manquantes.map((v) => `${v.gravite === "critique" ? "CRITIQUE" : v.gravite === "importante" ? "À poser" : "Facultatif"} — ${v.cle} absente : ${v.sans}.`);
  if (o.moteur && !o.moteur.pret) {
    messages.push(`Moteur de conversion incomplet — ${o.moteur.manquants.join(", ") || o.moteur.erreur || "raison inconnue"} : les conversions de l'Atelier échoueront en le disant.`);
  }
  const critique = manquantes.some((v) => v.gravite === "critique");
  return {
    verifieA: (o.maintenant ?? new Date()).toISOString(),
    detenteur: o.detenteur,
    mode: o.mode,
    pret: !critique && (o.moteur?.pret ?? true),
    variables: variables.map(({ cle, gravite, presente, sans }) => ({ cle, gravite, presente, sans })),
    manquantes: manquantes.map((v) => v.cle),
    moteur: o.moteur,
    messages,
  };
}

/**
 * LE CONTRÔLE, EXÉCUTÉ (décision 0019) — appelé par `scripts/worker.ts` au démarrage. Journalise chaque manque en
 * clair, puis écrit le rapport en base (`ControleWorker`, ligne « worker »). Ne lève jamais : un contrôle qui
 * échoue ne doit pas empêcher le worker de travailler.
 */
export async function controlerAuDemarrage(o: { detenteur: string; journal?: Journal }): Promise<RapportControle> {
  const journal = o.journal ?? journalConsole;
  const moteur = await etatMoteur(true).catch((e) => ({ pret: false, manquants: [], detail: null, erreur: messageErreur(e) }));
  const r = evaluerControle(process.env, { detenteur: o.detenteur, mode: lireModeTachesDeFond(), moteur });
  journal(r.pret && !r.messages.length ? "info" : "avertissement", "worker.controle", {
    pret: r.pret,
    moteur: moteur.pret ? "complet" : "incomplet",
    manquantes: r.manquantes,
  });
  for (const m of r.messages) journal(m.startsWith("CRITIQUE") ? "erreur" : "avertissement", "worker.controle.manque", { message: m });
  await Promise.resolve().then(() => prisma.controleWorker.upsert({
    where: { id: "worker" },
    create: { id: "worker", detenteur: r.detenteur, verifieA: new Date(r.verifieA), pret: r.pret, rapport: r as never },
    update: { detenteur: r.detenteur, verifieA: new Date(r.verifieA), pret: r.pret, rapport: r as never },
  })).catch((e) => journal("avertissement", "worker.controle.ecriture", { erreur: messageErreur(e) }));
  return r;
}

/** Ce que l'écran d'administration lit : le dernier contrôle, et la file des conversions. */
export async function lireEtatWorker(): Promise<{
  controle: (RapportControle & { verifieA: string }) | null;
  conversions: { enFile: number; enCours: number; faites24h: number; echecs24h: number; plusAncienneEnFile: string | null; derniersEchecs: { quand: string; vers: string; voie: string; erreur: string }[] };
}> {
  const depuis = new Date(Date.now() - 24 * 3600_000);
  const [ligne, enFile, enCours, faites, echecs, ancienne, derniers] = await Promise.all([
    prisma.controleWorker.findUnique({ where: { id: "worker" } }).catch(sansBloquer("worker.lireControle", null)),
    prisma.atelierConversion.count({ where: { etat: "EN_FILE" } }),
    prisma.atelierConversion.count({ where: { etat: "EN_COURS" } }),
    prisma.atelierConversion.count({ where: { etat: "FAITE", updatedAt: { gte: depuis } } }),
    prisma.atelierConversion.count({ where: { etat: "ECHEC", updatedAt: { gte: depuis } } }),
    prisma.atelierConversion.findFirst({ where: { etat: "EN_FILE" }, orderBy: { createdAt: "asc" }, select: { createdAt: true } }),
    prisma.atelierConversion.findMany({ where: { etat: "ECHEC" }, orderBy: { updatedAt: "desc" }, take: 5, select: { updatedAt: true, vers: true, voie: true, erreur: true } }),
  ]);
  return {
    controle: ligne ? { ...(ligne.rapport as unknown as RapportControle), verifieA: ligne.verifieA.toISOString() } : null,
    conversions: {
      enFile, enCours, faites24h: faites, echecs24h: echecs,
      plusAncienneEnFile: ancienne?.createdAt.toISOString() ?? null,
      derniersEchecs: derniers.map((d) => ({ quand: d.updatedAt.toISOString(), vers: d.vers, voie: d.voie, erreur: d.erreur ?? "" })),
    },
  };
}
