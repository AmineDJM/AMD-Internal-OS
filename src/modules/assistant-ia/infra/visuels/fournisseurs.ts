import { attendu } from "@/lib/journal";
import { cleFournisseurVoix, urlFournisseur } from "../modele";
import { usageGemini, usageOpenAI, type UsageImage } from "../../domaine/visuels/regles";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES FOURNISSEURS DES VISUELS (lot K2, décision 0032) — OpenAI (images, vidéos), Gemini (secours d'image).
 *
 * Ces points (`/images/generations`, `/images/edits`, `/videos`, `:generateContent`) ne transportent pas de texte de
 * conversation : ils ne passent pas par la passerelle de texte (`lib/models/`, garde `passerelle-unique.test.ts`),
 * comme la transcription. Ils tiennent leur propre compte : chaque génération inscrit son coût réel au journal
 * (`service.ts`). La clé OpenAI est celle de l'assistant (`modele.ts`) ; celle de Gemini, `GEMINI_API_KEY`.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface ImageRendue {
  octets: Buffer;
  mime: string;
  usage: UsageImage;
  fournisseur: "openai" | "gemini";
  modele: string;
}

export type IssueImage = { ok: true; image: ImageRendue } | { ok: false; raison: string; refusContenu: boolean };

const DELAI_IMAGE_MS = 150_000;

function signalDelai(ms: number): AbortSignal {
  return AbortSignal.timeout(ms);
}

/** Le message d'erreur d'un fournisseur, lisible et court. */
async function erreurDe(r: Response): Promise<{ raison: string; refusContenu: boolean }> {
  const brut = await r.text().catch(attendu("corps d'erreur illisible : le statut suffit", ""));
  let message = brut.slice(0, 300);
  try {
    const o = JSON.parse(brut) as { error?: { message?: string; code?: string } };
    message = o.error?.message ?? message;
    const refus = /moderation|safety|content_policy|policy/i.test(`${o.error?.code ?? ""} ${message}`);
    return { raison: `${r.status} — ${message}`.slice(0, 300), refusContenu: refus };
  } catch {
    return { raison: `${r.status} — ${message || r.statusText}`.slice(0, 300), refusContenu: false };
  }
}

export interface ImageSource { octets: Buffer; mime: string; nom: string }

/** Une image OpenAI : générée (`sources` vide) ou MODIFIÉE à partir d'une ou plusieurs images (`/images/edits`). */
export async function imageOpenAI(p: { modele: string; consigne: string; taille: string; qualite: string; sources: ImageSource[] }): Promise<IssueImage> {
  const cle = cleFournisseurVoix();
  if (!cle) return { ok: false, raison: "clé OpenAI absente", refusContenu: false };
  let r: Response;
  try {
    if (p.sources.length) {
      const fd = new FormData();
      fd.set("model", p.modele);
      fd.set("prompt", p.consigne);
      fd.set("size", p.taille);
      fd.set("quality", p.qualite);
      for (const s of p.sources) fd.append("image[]", new Blob([new Uint8Array(s.octets)], { type: s.mime }), s.nom);
      r = await fetch(urlFournisseur("/images/edits"), { method: "POST", headers: { Authorization: `Bearer ${cle}` }, body: fd, signal: signalDelai(DELAI_IMAGE_MS) });
    } else {
      r = await fetch(urlFournisseur("/images/generations"), {
        method: "POST",
        headers: { Authorization: `Bearer ${cle}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: p.modele, prompt: p.consigne, size: p.taille, quality: p.qualite, n: 1 }),
        signal: signalDelai(DELAI_IMAGE_MS),
      });
    }
  } catch (e) {
    return { ok: false, raison: e instanceof Error ? e.message.slice(0, 200) : String(e), refusContenu: false };
  }
  if (!r.ok) return { ok: false, ...(await erreurDe(r)) };
  const o = (await r.json()) as { data?: { b64_json?: string }[]; usage?: unknown; output_format?: string };
  const b64 = o.data?.[0]?.b64_json;
  if (!b64) return { ok: false, raison: "aucune image rendue", refusContenu: false };
  const format = o.output_format ?? "png";
  return { ok: true, image: { octets: Buffer.from(b64, "base64"), mime: `image/${format === "jpeg" ? "jpeg" : format}`, usage: usageOpenAI(o.usage), fournisseur: "openai", modele: p.modele } };
}

/** Le SECOURS : `gemini-3-pro-image`, seulement quand OpenAI a refusé. */
export async function imageGemini(p: { modele: string; consigne: string; sources: ImageSource[] }): Promise<IssueImage> {
  const cle = (process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? "").trim();
  if (!cle) return { ok: false, raison: "clé Gemini absente (GEMINI_API_KEY)", refusContenu: false };
  const parts: unknown[] = [{ text: p.consigne }, ...p.sources.map((s) => ({ inline_data: { mime_type: s.mime, data: s.octets.toString("base64") } }))];
  let r: Response;
  try {
    r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(p.modele)}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": cle, "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig: { responseModalities: ["IMAGE"] } }),
      signal: signalDelai(DELAI_IMAGE_MS),
    });
  } catch (e) {
    return { ok: false, raison: e instanceof Error ? e.message.slice(0, 200) : String(e), refusContenu: false };
  }
  if (!r.ok) return { ok: false, ...(await erreurDe(r)) };
  const o = (await r.json()) as { candidates?: { content?: { parts?: { inlineData?: { mimeType?: string; data?: string } }[] } }[]; usageMetadata?: unknown };
  const image = o.candidates?.[0]?.content?.parts?.find((x) => x.inlineData?.data)?.inlineData;
  if (!image?.data) return { ok: false, raison: "aucune image rendue par le secours", refusContenu: true };
  return { ok: true, image: { octets: Buffer.from(image.data, "base64"), mime: image.mimeType ?? "image/png", usage: usageGemini(o.usageMetadata), fournisseur: "gemini", modele: p.modele } };
}

// ─────────────────────────────── LA VIDÉO (OpenAI `/videos`) ───────────────────────────────

/**
 * LE MODÈLE VIDÉO EST-IL SERVI ? Avant de rien lancer (ni dépenser) : la fiche du modèle (`/models/{id}`) et sa date
 * d'arrêt. Mesuré le 31/10/2026 : `sora-2` et `sora-2-pro` portent `shutdown_date: 2026-09-24` et `/videos` répond 404.
 */
export async function etatModeleVideo(modele: string, maintenant = new Date()): Promise<{ servi: true } | { servi: false; raison: string }> {
  const cle = cleFournisseurVoix();
  if (!cle) return { servi: false, raison: "clé OpenAI absente" };
  try {
    const r = await fetch(urlFournisseur(`/models/${encodeURIComponent(modele)}`), { headers: { Authorization: `Bearer ${cle}` }, signal: signalDelai(20_000) });
    if (!r.ok) return { servi: false, raison: `le modèle ${modele} n'est pas disponible sur la clé (${r.status})` };
    const o = (await r.json()) as { shutdown_date?: string | null };
    if (o.shutdown_date && new Date(o.shutdown_date) <= maintenant) {
      return { servi: false, raison: `le fournisseur a arrêté ${modele} le ${new Date(o.shutdown_date).toLocaleDateString("fr-FR", { timeZone: "UTC" })}` };
    }
    return { servi: true };
  } catch (e) {
    return { servi: false, raison: e instanceof Error ? e.message.slice(0, 200) : String(e) };
  }
}

export type EtatTravailVideo = { etat: "en-cours"; progression: number } | { etat: "pret" } | { etat: "echec"; raison: string };

export async function lancerVideo(p: { modele: string; consigne: string; secondes: number; taille: string }): Promise<{ ok: true; id: string } | { ok: false; raison: string }> {
  const cle = cleFournisseurVoix();
  if (!cle) return { ok: false, raison: "clé OpenAI absente" };
  try {
    const r = await fetch(urlFournisseur("/videos"), {
      method: "POST",
      headers: { Authorization: `Bearer ${cle}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: p.modele, prompt: p.consigne, seconds: String(p.secondes), size: p.taille }),
      signal: signalDelai(60_000),
    });
    if (!r.ok) return { ok: false, raison: (await erreurDe(r)).raison };
    const o = (await r.json()) as { id?: string };
    return o.id ? { ok: true, id: o.id } : { ok: false, raison: "le fournisseur n'a pas rendu d'identifiant" };
  } catch (e) {
    return { ok: false, raison: e instanceof Error ? e.message.slice(0, 200) : String(e) };
  }
}

export async function suivreVideo(id: string): Promise<EtatTravailVideo> {
  const cle = cleFournisseurVoix();
  try {
    const r = await fetch(urlFournisseur(`/videos/${encodeURIComponent(id)}`), { headers: { Authorization: `Bearer ${cle}` }, signal: signalDelai(30_000) });
    if (!r.ok) return { etat: "echec", raison: (await erreurDe(r)).raison };
    const o = (await r.json()) as { status?: string; progress?: number; error?: { message?: string } };
    if (o.status === "completed") return { etat: "pret" };
    if (o.status === "failed" || o.status === "cancelled") return { etat: "echec", raison: o.error?.message ?? `travail ${o.status}` };
    return { etat: "en-cours", progression: typeof o.progress === "number" ? o.progress : 0 };
  } catch {
    // Une coupure réseau n'est pas un échec du travail : on repassera au battement suivant.
    return { etat: "en-cours", progression: -1 };
  }
}

export async function telechargerVideo(id: string): Promise<Buffer | null> {
  const cle = cleFournisseurVoix();
  const r = await fetch(urlFournisseur(`/videos/${encodeURIComponent(id)}/content`), { headers: { Authorization: `Bearer ${cle}` }, signal: signalDelai(120_000) });
  return r.ok ? Buffer.from(await r.arrayBuffer()) : null;
}
