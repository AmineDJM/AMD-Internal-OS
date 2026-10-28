import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import { attendu } from "@/lib/journal";
import { putBlob } from "@/lib/drive-storage";
import { enregistrerFichierDrive } from "@/lib/drive/depot";
import { getAppSettings } from "@/lib/settings";
import { quotaVerdict } from "@/lib/drive/quota";
import { addPhysicalUsage, physicalUsageBytes, userUsageBytes } from "@/lib/drive/usage";
import { appelVoix, jetonsAudio, jetonsTexte, type IssueVoix } from "@/lib/agent/consommation";
import { DEPENDANCES_REELLES, transcrireMedia } from "./pieces";
import { texteParlable, type AudioDuTour, type VocalDuTour } from "./regles";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES VOCAUX DU FIL — « comme WhatsApp » (Direction, 28/10/2026).
 *
 *   • ENTRÉE : la personne enregistre un vocal ; il part comme un MESSAGE du fil (fichier du Drive,
 *     `/api/assistant-ia/vocal`). Au moment de le jouer, le fil le TRANSCRIT ici ; la transcription
 *     s'affiche sous le lecteur, et l'assistant répond à son contenu.
 *   • SORTIE : option « réponse vocale » — la réponse texte, mise en parole (`texteParlable`, bornée
 *     et la coupe dite), synthétisée puis déposée dans le Drive de la personne.
 *
 * L'audio est relu SOUS LES DROITS de la personne (`charger` revérifie l'accès), jamais pris d'un
 * paramètre. Chaque appel (transcription, synthèse) passe l'interrupteur et le plafond (`appelVoix`).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let fetchDeTest: typeof fetch | null = null;

/** RÉSERVÉ AUX TESTS — le moteur de parole remplacé (transcription ET synthèse). `null` rend le vrai. */
export function remplacerFetchVoixPourTests(f: typeof fetch | null): void {
  fetchDeTest = f;
}

/** Transcrit le vocal d'un tour. Rend le vocal mis à jour (TRANSCRIT ou ECHEC, l'erreur dite). */
export async function transcrireVocal(user: CurrentUser, vocal: VocalDuTour): Promise<VocalDuTour> {
  const c = await DEPENDANCES_REELLES.charger(user, vocal.id);
  if ("erreur" in c) return { ...vocal, etat: "ECHEC", erreur: c.erreur };
  const octets = await c.octets();
  if (!octets?.length) return { ...vocal, etat: "ECHEC", erreur: "L'enregistrement est illisible dans le stockage." };
  const t = await transcrireMedia(octets, c.piece.nom, { fetchImpl: fetchDeTest ?? undefined });
  if (!t.ok) return { ...vocal, etat: "ECHEC", erreur: t.raison };
  const texte = t.valeur.texte.trim();
  if (!texte) return { ...vocal, etat: "ECHEC", erreur: "Aucune parole reconnue dans ce vocal." };
  return { ...vocal, etat: "TRANSCRIT", transcription: texte.slice(0, 8000), dureeS: vocal.dureeS ?? t.valeur.dureeS };
}

/** La réponse, dite à voix haute et déposée dans le Drive de la personne. `null` : rien à dire. */
export async function repondreAVoixHaute(user: CurrentUser, reponse: string): Promise<AudioDuTour | null> {
  const { texte, coupe } = texteParlable(reponse);
  if (!texte) return null;
  const s = await synthetiser(texte, { fetchImpl: fetchDeTest ?? undefined });
  if (!s.ok) return { id: "", dureeS: null, erreur: s.raison };
  const d = await deposerAudio(user, s.valeur.octets, nomDeVocal("reponse", "mp3"), s.valeur.mime);
  if ("erreur" in d) return { id: "", dureeS: null, erreur: d.erreur };
  return { id: d.id, dureeS: s.valeur.dureeS, ...(coupe ? { coupe: true } : {}) };
}

// ─────────────────────────────── La synthèse ───────────────────────────────

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA RÉPONSE VOCALE — l'assistant répond AUSSI en audio, quand la personne l'a demandé (option
 * « réponse vocale » de l'écran). La réponse TEXTE reste affichée : l'audio en est la lecture, jamais
 * un second contenu.
 *
 * Synthèse vocale OpenAI (`/v1/audio/speech`), par la clé déjà en service — mesuré le 28/10/2026 :
 * `gpt-4o-mini-tts`, voix `alloy`, MP3 24 kHz mono, ~3 s pour une phrase. Modèle et voix se changent
 * sans code (`ASSISTANT_IA_TTS_MODEL`, `ASSISTANT_IA_TTS_VOICE`). Compté et borné (`appelVoix`,
 * rôle « synthese », fournisseur `openai-audio`) ; le texte est déjà borné par `texteParlable`.
 * `fetchImpl` s'injecte : un banc tient le contrat sans réseau.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const MODELE_TTS_DEFAUT = "gpt-4o-mini-tts";
export const VOIX_TTS_DEFAUT = "alloy";
const DELAI_TTS_MS = 60_000;
/** MP3 rendu à 128 kbit/s : la durée se lit sur la taille (l'écran relit la vraie durée au chargement). */
const OCTETS_PAR_SECONDE = 16_000;

export interface AudioSynthetise {
  octets: Buffer;
  mime: "audio/mpeg";
  dureeS: number;
  modele: string;
}

export async function synthetiser(
  texte: string,
  opts: { fetchImpl?: typeof fetch; env?: Record<string, string | undefined> } = {},
): Promise<IssueVoix<AudioSynthetise>> {
  const env = opts.env ?? process.env;
  const cle = (env.OPENAI_API_KEY ?? "").trim();
  if (!cle) return { ok: false, raison: "Clé OPENAI_API_KEY non configurée : la réponse vocale est indisponible.", code: "ECHEC" };
  if (!texte.trim()) return { ok: false, raison: "Rien à dire.", code: "ECHEC" };
  const base = (env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const modele = env.ASSISTANT_IA_TTS_MODEL?.trim() || MODELE_TTS_DEFAUT;
  const voix = env.ASSISTANT_IA_TTS_VOICE?.trim() || VOIX_TTS_DEFAUT;
  const f = opts.fetchImpl ?? fetch;
  return appelVoix("synthese", async (inscrire) => {
    const t0 = Date.now();
    const res = await f(`${base}/audio/speech`, {
      method: "POST",
      headers: { authorization: `Bearer ${cle}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: modele, voice: voix, input: texte, response_format: "mp3",
        // Les modèles récents acceptent une consigne de diction ; les anciens (`tts-1`) l'ignorent.
        ...(/^gpt-/.test(modele) ? { instructions: "Parle en français, d'un ton professionnel, clair et posé." } : {}),
      }),
      signal: AbortSignal.timeout(DELAI_TTS_MS),
    });
    if (!res.ok) {
      const corps = await res.text().catch(attendu("corps d'une réponse en échec : le statut HTTP suffit au diagnostic", ""));
      return { ok: false, raison: `Synthèse vocale refusée (HTTP ${res.status}) : ${corps.slice(0, 160)}` };
    }
    const octets = Buffer.from(await res.arrayBuffer());
    if (!octets.length) return { ok: false, raison: "Synthèse vocale vide." };
    const dureeS = Math.max(1, Math.round(octets.length / OCTETS_PAR_SECONDE));
    inscrire({ provider: "openai-audio", model: modele, entree: jetonsTexte(texte), sortie: jetonsAudio(dureeS), ms: Date.now() - t0 });
    return { ok: true, valeur: { octets, mime: "audio/mpeg", dureeS, modele } };
  });
}

// ─────────────────────────────── Le stockage ───────────────────────────────

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * OÙ VIVENT LES VOCAUX — dans le Drive PERSONNEL de la personne, dossier « Assistant IA — vocaux ».
 *
 * Un message vocal et une réponse parlée sont des FICHIERS, stockés comme les autres pièces
 * (`putBlob` : chiffrement, stockage objet ou base, déduplication ; `enregistrerFichierDrive` :
 * version, audit). JAMAIS en base64 dans la conversation : le fil ne garde que l'identifiant.
 *
 * LES DROITS SONT CEUX DU FIL : le dossier appartient à la personne, sans partage — elle seule
 * (et ce que le Drive accorde déjà au propriétaire) l'écoute, par `/api/drive/<id>/raw` qui revérifie
 * l'accès à chaque lecture. Les quotas du Drive s'appliquent, comme à un fichier déposé à la main.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const NOM_DOSSIER_VOCAUX = "Assistant IA — vocaux";

/** Le dossier des vocaux de la personne — retrouvé, ou créé à la racine de SON Drive. */
export async function dossierVocaux(userId: string): Promise<string> {
  const existant = await prisma.driveNode.findFirst({
    where: { ownerId: userId, type: "FOLDER", name: NOM_DOSSIER_VOCAUX, parentId: null, spaceId: null, isTrashed: false },
    select: { id: true },
  });
  if (existant) return existant.id;
  const cree = await prisma.driveNode.create({
    data: { name: NOM_DOSSIER_VOCAUX, type: "FOLDER", ownerId: userId, createdById: userId, category: "Assistant IA" },
    select: { id: true },
  });
  return cree.id;
}

/** « Vocal 28-10-2026 14h05.webm » — un nom qu'on reconnaît dans le Drive. */
export function nomDeVocal(sorte: "vocal" | "reponse", ext: string, quand = new Date()): string {
  const d = new Intl.DateTimeFormat("fr-FR", { timeZone: "Africa/Algiers", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .format(quand).replace(/\//g, "-").replace(/\s+/, " ").replace(/:(\d\d):(\d\d)$/, "h$1-$2");
  return `${sorte === "vocal" ? "Vocal" : "Réponse vocale"} ${d}.${ext}`;
}

/** Dépose un audio dans le dossier des vocaux. Rend l'identifiant du fichier, ou le refus (quota). */
export async function deposerAudio(user: CurrentUser, octets: Buffer, nom: string, mime: string): Promise<{ id: string } | { erreur: string }> {
  const reglages = await getAppSettings();
  const [mien, physique] = await Promise.all([userUsageBytes(user.id), physicalUsageBytes()]);
  const verdict = quotaVerdict({
    userUsageBytes: mien, physicalUsageBytes: physique, fileSize: octets.length,
    userQuotaGb: reglages.driveUserQuotaGb, capacityGb: reglages.driveCapacityGb,
  });
  if (!verdict.ok) return { erreur: verdict.error };
  const ecrit = await putBlob(octets);
  if (!ecrit.deduplicated) addPhysicalUsage(ecrit.storedSize ?? ecrit.size);
  const parentId = await dossierVocaux(user.id);
  const r = await enregistrerFichierDrive(user, { parentId }, { blobId: ecrit.blobId, size: ecrit.size, mimeType: mime, name: nom, sha256: ecrit.sha256 });
  return { id: r.id };
}
