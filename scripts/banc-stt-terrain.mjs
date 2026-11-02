/**
 * BANC STT DU TERRAIN (lot J13, décision 0025) — quel moteur de transcription pour un vocal de délégué
 * (français, arabe dialectal, mélange) ? Appels RÉELS, donc payants : à lancer à la main, jamais en CI.
 *
 *   node scripts/banc-stt-terrain.mjs synthese   → fabrique les clips (TTS) de data/bancs/terrain-voix/clips.json
 *   node scripts/banc-stt-terrain.mjs mesure     → transcrit chaque clip par chaque moteur, écrit resultats.json
 *
 * Score : taux d'erreur par mot (WER, forme repliée : minuscules, sans accents ni ponctuation) et présence des
 * entités qui comptent (médecin, établissement, produit) — un compte rendu se juge sur ses noms propres.
 */
import fs from "node:fs";
import path from "node:path";

const DOSSIER = "data/bancs/terrain-voix";
const BASE = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
const CLE = process.env.OPENAI_API_KEY || "proxy";
const MOTEURS = (process.env.BANC_MOTEURS || "whisper-1,gpt-4o-mini-transcribe,gpt-4o-transcribe,gpt-transcribe").split(",");
const { clips, indice } = JSON.parse(fs.readFileSync(path.join(DOSSIER, "clips.json"), "utf8"));

const plier = (s) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
function wer(ref, hyp) {
  const r = plier(ref).split(" ").filter(Boolean), h = plier(hyp).split(" ").filter(Boolean);
  const d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...Array(h.length).fill(0)]);
  for (let j = 1; j <= h.length; j++) d[0][j] = j;
  for (let i = 1; i <= r.length; i++) for (let j = 1; j <= h.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
  return r.length ? d[r.length][h.length] / r.length : 0;
}
/** Une entité est « entendue » si sa forme repliée (latine) ou sa variante arabe connue est dans la transcription. */
const VARIANTES = { benali: ["benali", "ben ali", "بن علي", "بنعلي"], haddad: ["haddad", "حداد"], "ould ali": ["ould ali", "ولد علي"],
  cardiovex: ["cardiovex", "كارديوفكس"], glucorine: ["glucorine", "غلوكورين"], neurolam: ["neurolam", "نيورولام"],
  oran: ["oran", "وهران"], mustapha: ["mustapha", "مصطفى"] };
function entites(clip, hyp) {
  const h = plier(hyp) + " " + hyp;
  const cles = [clip.attendus.medecin, ...clip.attendus.produits, clip.attendus.etablissement.split(" ").pop()].map((x) => plier(x));
  return cles.map((c) => ({ cle: c, entendu: (VARIANTES[c] ?? [c]).some((v) => h.includes(v)) }));
}

async function synthese() {
  for (const c of clips) {
    const res = await fetch(`${BASE}/audio/speech`, {
      method: "POST", headers: { authorization: `Bearer ${CLE}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o-mini-tts", voice: c.voix, input: c.texte, response_format: "mp3",
        instructions: "Délégué médical algérien qui dicte un compte rendu en sortant d'un cabinet : débit naturel, accent algérien, sans emphase." }),
    });
    if (!res.ok) throw new Error(`${c.id}: ${res.status} ${await res.text()}`);
    fs.writeFileSync(path.join(DOSSIER, `${c.id}.mp3`), Buffer.from(await res.arrayBuffer()));
    console.log("clip", c.id);
  }
}

async function transcrire(moteur, clip, avecIndice) {
  const form = new FormData();
  form.append("file", new Blob([fs.readFileSync(path.join(DOSSIER, `${clip.id}.mp3`))], { type: "audio/mpeg" }), `${clip.id}.mp3`);
  form.append("model", moteur);
  if (avecIndice) form.append("prompt", indice);
  form.append("response_format", moteur === "whisper-1" ? "verbose_json" : "json");
  const t0 = Date.now();
  const res = await fetch(`${BASE}/audio/transcriptions`, { method: "POST", headers: { authorization: `Bearer ${CLE}` }, body: form });
  const ms = Date.now() - t0;
  if (!res.ok) return { erreur: `${res.status} ${(await res.text()).slice(0, 200)}`, ms };
  const d = await res.json();
  return { texte: d.text ?? "", langue: d.language ?? null, ms };
}

async function mesure() {
  const lignes = [];
  for (const moteur of MOTEURS) for (const avecIndice of [false, true]) for (const clip of clips) {
    const r = await transcrire(moteur, clip, avecIndice);
    const ligne = { moteur, indice: avecIndice, clip: clip.id, ms: r.ms, ...(r.erreur ? { erreur: r.erreur } : { texte: r.texte, langue: r.langue, wer: +wer(clip.texte, r.texte).toFixed(3), entites: entites(clip, r.texte) }) };
    lignes.push(ligne);
    console.log(moteur, avecIndice ? "+indice" : "", clip.id, r.ms + "ms", ligne.wer ?? ligne.erreur, (ligne.entites ?? []).map((e) => `${e.cle}:${e.entendu ? "✓" : "✗"}`).join(" "));
  }
  const synth = {};
  for (const l of lignes.filter((x) => !x.erreur)) {
    const k = `${l.moteur}${l.indice ? " + indice" : ""}`;
    const s = (synth[k] ??= { wer: [], entites: 0, sur: 0, ms: [] });
    s.wer.push(l.wer); s.ms.push(l.ms); s.entites += l.entites.filter((e) => e.entendu).length; s.sur += l.entites.length;
  }
  const tableau = Object.entries(synth).map(([k, s]) => ({ moteur: k, werMoyen: +(s.wer.reduce((a, b) => a + b, 0) / s.wer.length).toFixed(3),
    entites: `${s.entites}/${s.sur}`, msMedian: s.ms.sort((a, b) => a - b)[Math.floor(s.ms.length / 2)] }));
  console.table(tableau);
  fs.writeFileSync(path.join(DOSSIER, "resultats.json"), JSON.stringify({ mesureLe: new Date().toISOString(), tableau, lignes }, null, 2) + "\n");
}

const geste = process.argv[2];
if (geste === "synthese") await synthese();
else if (geste === "mesure") await mesure();
else console.log("usage : node scripts/banc-stt-terrain.mjs synthese|mesure");
