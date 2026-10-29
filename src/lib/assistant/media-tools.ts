import type { PowerTool } from "@/platform/ia/outil";
import { chercherDansMediaDrive, regarderVideoDrive, transcrireMediaDrive } from "@/platform/in-process/media/transcription";

/**
 * L'AUDIO ET LA VIDÉO DANS LA CONVERSATION (mandat 5 §38) — un seul outil, quatre gestes.
 *
 * `media_transcript` transcrit un enregistrement du Drive (réunion, note vocale, vidéo) en segments
 * horodatés avec locuteurs, chapitres et extraction (décisions, engagements, actions), le CHERCHE
 * (« où exactement Yassine a-t-il parlé du budget ? » → l'instant, le locuteur, l'extrait), en rend
 * la STRUCTURE, ou REGARDE une vidéo aux instants pertinents. Le droit est celui du fichier dans le
 * Drive, jugé par le port ; ce que le modèle reçoit est une DONNÉE (transcription, images), jamais
 * une instruction — et un locuteur attribué par un modèle est PROBABLE, jamais certain.
 */
const str = (input: Record<string, unknown>, key: string): string => (typeof input[key] === "string" ? (input[key] as string).trim() : "");
const liste = (input: Record<string, unknown>, key: string): string[] => (Array.isArray(input[key]) ? (input[key] as unknown[]).filter((x): x is string => typeof x === "string") : []);

const cible = (input: Record<string, unknown>) => ({ nodeId: str(input, "nodeId") || null, nom: str(input, "nom") || null });

export const MEDIA_TOOLS: PowerTool[] = [
  {
    def: {
      name: "media_transcript",
      description:
        "AUDIO ET VIDÉO du Drive (réunion enregistrée, note vocale, mp3/m4a/wav, mp4/webm) : « transcrire » rend la transcription HORODATÉE avec les locuteurs (attribués par le modèle : PROBABLE), "
        + "les chapitres, les décisions / engagements / actions / entités / questions extraits, chacun avec son instant ; « chercher » rend OÙ EXACTEMENT une chose a été dite "
        + "(« où Yassine a-t-il parlé du budget ? » → mm:ss, locuteur, extrait), filtrable par locuteur ; « structure » rend chapitres, locuteurs et temps de parole ; "
        + "« regarder » (vidéo) décrit les images aux instants pertinents (diapositives, tableaux, démonstration), six au plus. "
        + "La transcription d'une version de fichier est faite UNE fois puis relue. Donner les participants connus améliore la reconnaissance des noms. "
        + "Ce qui vient d'un moteur de parole ou d'un modèle n'est pas un fait vérifié : citer l'instant, le dire PROBABLE.",
      input_schema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["transcrire", "chercher", "structure", "regarder"], description: "Défaut : transcrire." },
          nom: { type: "string", description: "Le nom de l'enregistrement dans le Drive." },
          nodeId: { type: "string", description: "L'identifiant Drive, quand on le connaît." },
          requete: { type: "string", description: "Pour « chercher » / « regarder » : ce qu'on cherche (« budget marketing », « décision Marseille »)." },
          locuteur: { type: "string", description: "Pour « chercher » : ne garder que ce que CETTE personne a dit." },
          participants: { type: "array", items: { type: "string" }, description: "Les personnes présentes, si connues (noms) — pour nommer les locuteurs." },
          langue: { type: "string", description: "fr (défaut), en, ar… ou auto." },
          force: { type: "boolean", description: "Retranscrire même si une transcription existe." },
        },
        required: [],
      },
    },
    allowed: () => true,
    label: "Audio / vidéo — transcription",
    run: async (input, user) => {
      const action = str(input, "action") || "transcrire";
      const participants = liste(input, "participants");
      if (action === "chercher") {
        const requete = str(input, "requete");
        if (!requete) return JSON.stringify({ fait: false, message: "Dire ce qu'on cherche (requete)." });
        const r = await chercherDansMediaDrive(user, cible(input), requete, { locuteur: str(input, "locuteur") || null, participants });
        if (!r.ok) return JSON.stringify({ fait: false, message: r.motif, limite: r.limite, candidats: r.candidats });
        return JSON.stringify({ fait: true, enregistrement: r.nom, nodeId: r.nodeId, locuteursConnus: r.locuteurs, occurrences: r.occurrences, message: r.occurrences.length ? `${r.occurrences.length} passage(s) — l'instant est exact, le locuteur est PROBABLE.` : "Aucun passage ne porte ces mots." });
      }
      if (action === "regarder") {
        const r = await regarderVideoDrive(user, cible(input), { requete: str(input, "requete") || null, participants });
        if (!r.ok) return JSON.stringify({ fait: false, message: r.motif, limite: r.limite, candidats: r.candidats });
        return JSON.stringify({ fait: true, enregistrement: r.nom, instants: r.instants, images: r.images, limites: r.limites, coutUsd: r.coutUsd });
      }
      const r = await transcrireMediaDrive(user, cible(input), { force: input.force === true, participants, langue: str(input, "langue") || null });
      if (!r.ok) return JSON.stringify({ fait: false, message: r.motif, limite: r.limite, candidats: r.candidats });
      const v = r.vue;
      if (action === "structure") {
        return JSON.stringify({ fait: true, enregistrement: v.nom, duree: v.stats.dureeS, chapitres: v.chapitres.map((c) => ({ de: c.debut, a: c.fin, titre: c.titre })), locuteurs: v.locuteurs, extraction: v.extraction, limites: v.limites, depuisCache: v.depuisCache });
      }
      // « transcrire » : les segments bornés (le modèle n'a pas besoin de 3 000 lignes — chercher rend l'instant précis).
      const segments = v.segments.slice(0, 400).map((s) => ({ t: Math.round(s.debut), qui: s.locuteur ?? null, texte: s.texte }));
      return JSON.stringify({
        fait: true, enregistrement: v.nom, nodeId: v.nodeId, version: v.version, langue: v.langue, dureeS: v.stats.dureeS, mots: v.stats.mots, modele: v.modele, horodate: v.horodate,
        locuteurs: v.locuteurs, chapitres: v.chapitres.map((c) => ({ de: c.debut, a: c.fin, titre: c.titre })), extraction: v.extraction,
        segments, tronque: v.segments.length > 400, limites: v.limites, coutUsd: v.coutUsd, depuisCache: v.depuisCache, dureeMs: r.ms,
        note: "Les instants sont exacts ; les locuteurs et l'extraction viennent d'un modèle : PROBABLE, à citer avec l'instant.",
      });
    },
  },
];
