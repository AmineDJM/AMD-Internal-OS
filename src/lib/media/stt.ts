import { normaliserSegments, type Segment } from "./transcription";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA PAROLE EN SEGMENTS HORODATÉS (mandat 5 §38) — le client du moteur de reconnaissance.
 *
 * `transcribeAudio` (lib/ai.ts) rend un texte plat : bon pour une dictée, insuffisant pour une
 * réunion — sans horodatage, « où exactement Yassine a-t-il parlé du budget ? » n'a pas de
 * réponse. Ici : `verbose_json` avec la granularité SEGMENT, la langue détectée, la durée, et un
 * `fetch` injectable pour que le banc tienne le contrat sans réseau. Une vidéo (mp4, webm, mov)
 * passe telle quelle : le moteur en lit la piste audio. Au-delà de la taille que le moteur
 * accepte, la limite est DITE (ressource : découpage indisponible sans ffmpeg), jamais contournée
 * par une lecture partielle silencieuse.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const TAILLE_MAX_STT = 25 * 1024 * 1024;
export const DELAI_STT_MS = 120_000;

/**
 * LA RECONNAISSANCE PAR LE NOM vit au SOCLE (`media/formats.ts`, zéro import) : l'indexation du
 * Drive en a besoin sans avoir le droit d'importer ce fichier-ci (§118.72). On la RÉEXPORTE
 * pour ne pas casser les appelants existants — une seconde table divergerait au premier format
 * ajouté (§118.5).
 */
export { estMedia, estVideo } from "./formats";
import { MIMES_MEDIA, extensionDe } from "./formats";
import { interrupteurIaCoupe, REFUS_IA_COUPEE } from "../ai-settings";
import { attendu } from "@/lib/journal";
import { cleOpenAI, urlOpenAI } from "../models/openai-acces";

export interface OptionsStt {
  /** `fr` par défaut ; `auto` laisse le moteur détecter. */
  langue?: string | null;
  modele?: string | null;
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  /** Un indice de vocabulaire (noms des participants, produits) — améliore la reconnaissance, n'invente rien. */
  indice?: string | null;
}

export type ResultatStt =
  | { ok: true; texte: string; langue: string | null; dureeS: number | null; segments: Segment[]; modele: string; ms: number; horodate: boolean }
  | { ok: false; configured: boolean; erreur: string; limite?: "RESSOURCE" };

/** Les modèles qui ne rendent pas `verbose_json` : un seul segment, sans horodatage — dit dans `horodate: false`. */
const SANS_SEGMENTS = /^gpt-4o/i;

export async function transcrireAvecSegments(buffer: Buffer, nom: string, opts: OptionsStt = {}): Promise<ResultatStt> {
  // Un enregistrement envoyé au moteur de transcription est un appel d'IA comme un autre : la lecture
  // des médias du Drive ne passe pas par `lib/ai.ts`, donc l'interrupteur se lit ICI, avant la clé (§118.196).
  if (await interrupteurIaCoupe()) return { ok: false, configured: true, erreur: REFUS_IA_COUPEE };
  const env = opts.env ?? process.env;
  const key = cleOpenAI(env);
  if (!key) return { ok: false, configured: false, erreur: "Clé OPENAI_API_KEY non configurée : la transcription est indisponible." };
  const ext = extensionDe(nom);
  const mime = MIMES_MEDIA[ext];
  if (!mime) return { ok: false, configured: true, erreur: `Format « .${ext || "?"} » non pris en charge par la transcription (audio : mp3, m4a, wav, ogg, flac ; vidéo : mp4, webm, mov).` };
  if (buffer.length > TAILLE_MAX_STT) {
    return { ok: false, configured: true, limite: "RESSOURCE", erreur: `Fichier de ${(buffer.length / 1048576).toFixed(1)} Mo : le moteur accepte ${TAILLE_MAX_STT / 1048576} Mo au plus, et ce serveur n'a pas ffmpeg pour découper — compresser ou découper le média avant de le déposer.` };
  }
  const modele = (opts.modele ?? env.STT_MODEL ?? "whisper-1").trim();
  const horodate = !SANS_SEGMENTS.test(modele);
  const f = opts.fetchImpl ?? fetch;
  const t0 = Date.now();
  let derniere = "Transcription impossible (réseau).";
  for (let tentative = 1; tentative <= 3; tentative += 1) {
    try {
      const form = new FormData();
      form.append("file", new Blob([buffer], { type: mime }), nom || `media.${ext}`);
      form.append("model", modele);
      const langue = (opts.langue ?? "fr").trim().toLowerCase();
      if (langue && langue !== "auto") form.append("language", langue);
      if (opts.indice?.trim()) form.append("prompt", opts.indice.trim().slice(0, 800));
      form.append("response_format", horodate ? "verbose_json" : "json");
      if (horodate) form.append("timestamp_granularities[]", "segment");
      const res = await f(urlOpenAI("/audio/transcriptions", env), { method: "POST", headers: { authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(DELAI_STT_MS) });
      if (res.ok) {
        const data = (await res.json()) as { text?: string; language?: string; duration?: number; segments?: unknown };
        const fournis = horodate ? normaliserSegments(data.segments) : [];
        const texte = (data.text ?? "").trim();
        const dureeS = typeof data.duration === "number" && Number.isFinite(data.duration) ? Math.round(data.duration) : null;
        // Sans segments du moteur, un seul segment porte le texte — et `horodate: false` le DIT.
        const segments = fournis.length ? fournis : texte ? [{ debut: 0, fin: dureeS ?? 0, texte, locuteur: null }] : [];
        return { ok: true, texte, langue: typeof data.language === "string" ? data.language : null, dureeS, segments, modele, ms: Date.now() - t0, horodate: fournis.length > 0 };
      }
      const corps = await res.text().catch(attendu("corps d\'une réponse en échec : le statut HTTP suffit au diagnostic", ""));
      if (res.status === 429) {
        const quota = /quota|billing|insufficient/i.test(corps);
        derniere = quota ? "Transcription indisponible : quota du fournisseur épuisé." : "Limite de débit du fournisseur atteinte : réessayer dans un instant.";
        if (quota) return { ok: false, configured: true, erreur: derniere, limite: "RESSOURCE" };
      } else if (res.status >= 500) {
        derniere = `Service de transcription momentanément indisponible (HTTP ${res.status}).`;
      } else {
        return { ok: false, configured: true, erreur: `Erreur de transcription (HTTP ${res.status}) : ${corps.slice(0, 200)}` };
      }
    } catch (e) {
      derniere = `Transcription impossible (réseau ou délai dépassé) : ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`;
    }
    if (tentative < 3) await new Promise((r) => setTimeout(r, 600 * tentative));
  }
  return { ok: false, configured: true, erreur: derniere };
}
