import type { PowerTool } from "@/platform/ia/outil";
import type { CurrentUser } from "@/lib/session";
import type { WorkspaceBlock } from "@/platform/ia/workspace/protocol";
import { nombresDe } from "../../domaine/ui/composants";
import { lireSpecVideoDonnees } from "../../domaine/visuels/video-donnees";
import { demanderVideoDonnees, FORMATS_IMAGE, genererImage, lancerVideoModele, type FormatImage, type IssueVisuel } from "./service";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES OUTILS DES VISUELS (lot K2, décision 0032).
 *
 *   generer_image      une image depuis une description (charte Adventum et logo officiel sur demande) ;
 *   modifier_image     une image retouchée à partir d'une pièce jointe ou d'un fichier du Drive (droits relus) ;
 *   generer_video      une vidéo par le modèle vidéo — lancée en ARRIÈRE-PLAN (la conversation continue) ;
 *   video_de_donnees   un graphique ANIMÉ des chiffres que les outils du tour ont LUS (jamais ceux du modèle).
 *
 * Famille de la console : « Images & vidéos générées » (`VISUELS`, `outils-v1.ts`). Le résultat entre dans la RÉPONSE
 * par `visuels` (un bloc `visuel` par génération, `fil/tour.ts`) ; le modèle ne reçoit que l'état, jamais l'image.
 * Ni les routines ni les travaux ne les reçoivent (`ECRITURES_DU_MOTEUR`) : une génération payante se demande.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const OUTILS_VISUELS = ["generer_image", "modifier_image", "generer_video", "video_de_donnees"] as const;

const texte = (e: Record<string, unknown>, cle: string, max = 3_000) => (typeof e[cle] === "string" ? (e[cle] as string).trim().slice(0, max) : "");
const titreDe = (e: Record<string, unknown>, repli: string) => texte(e, "titre", 90) || repli;

function sortie(r: IssueVisuel, visuels: WorkspaceBlock[] | undefined, consigne: string): string {
  if (!r.ok) return JSON.stringify({ statut: "REFUS", raison: r.raison, consigne: "Dis-le tel quel, en une phrase ; ne réessaie pas d'office." });
  visuels?.push(r.bloc);
  return JSON.stringify({
    statut: r.vue.etat === "pret" ? "PRET" : "EN_COURS",
    titre: r.vue.titre,
    ...(r.vue.drive ? { drive: r.vue.drive } : {}),
    ...(r.vue.detail ? { detail: r.vue.detail } : {}),
    ...(r.note ? { note: r.note } : {}),
    consigne,
  });
}

const CONSIGNE_PRETE = "Le visuel est AFFICHÉ sous ta réponse (téléchargeable, enregistré dans son Drive, dossier « Visuels de l'assistant »). "
  + "Réponds en une ou deux phrases ; ne le décris pas en détail, ne mets ni lien ni image Markdown. Si une note dit qu'un secours a servi, dis-le.";
const CONSIGNE_EN_COURS = "La génération tourne en ARRIÈRE-PLAN : une carte « en cours » est affichée sous ta réponse et se mettra à jour seule ; "
  + "la personne peut continuer à discuter et sera notifiée à la fin. Dis-le en une phrase ; n'invente aucun délai précis.";

export interface OptionsVisuels {
  /** Les blocs de la réponse (un par génération). */
  visuels?: WorkspaceBlock[];
  /** Les sorties d'outils du tour : la provenance des chiffres d'une vidéo de données. */
  journal?: string[];
}

export function outilsVisuels(user: CurrentUser, o: OptionsVisuels = {}): PowerTool[] {
  const aSoi = (u: CurrentUser) => u.id === user.id;
  const formatDe = (v: unknown): FormatImage => (typeof v === "string" && v in FORMATS_IMAGE ? (v as FormatImage) : "carre");
  return [
    {
      def: {
        name: "generer_image",
        description:
          "GÉNÈRE une image (illustration, visuel de présentation, affiche, pictogramme, photo d'ambiance) à partir d'une description, sur le meilleur "
          + "modèle d'image. Elle s'affiche dans la réponse et va dans le Drive de la personne. Propose la charte Adventum (couleurs) et le logo officiel "
          + "pour un visuel de l'entreprise. JAMAIS de donnée confidentielle (rémunération, coordonnée bancaire, pièce d'identité, dossier RH) dans la "
          + "description : elle serait refusée. Pour un GRAPHIQUE de chiffres de l'ERP, utilise plutôt video_de_donnees ou un composant chart.",
        input_schema: {
          type: "object",
          properties: {
            description: { type: "string", description: "Ce que l'image montre, en détail (sujet, style, cadrage, texte éventuel à écrire, en français)." },
            titre: { type: "string", description: "Un titre court (nom du fichier)." },
            charte: { type: "boolean", description: "Appliquer la charte Adventum (bleu #2C59A7, sarcelle #2B6E82, style sobre)." },
            logo: { type: "boolean", description: "Intégrer le logo officiel Adventum (fourni par l'application, jamais redessiné)." },
            format: { type: "string", enum: Object.keys(FORMATS_IMAGE), description: "carre (défaut), portrait ou paysage." },
            haute_qualite: { type: "boolean", description: "Qualité maximale (plus lent, plus cher) — seulement si la personne la demande." },
          },
          required: ["description"],
        },
      },
      allowed: aSoi,
      label: "Image générée",
      run: async (e) => sortie(await genererImage(user, {
        titre: titreDe(e, "Image"), consigne: e.description, charte: e.charte === true, logo: e.logo === true,
        format: formatDe(e.format), qualite: e.haute_qualite === true ? "high" : "medium", sources: [],
      }), o.visuels, CONSIGNE_PRETE),
    },
    {
      def: {
        name: "modifier_image",
        description:
          "MODIFIE une image existante — une pièce jointe du message ou un fichier image du Drive (PNG, JPEG, WebP) — selon une consigne (changer le fond, "
          + "retirer un élément, recadrer, styliser, ajouter un texte, mettre aux couleurs Adventum). Le résultat est une NOUVELLE image (l'originale ne "
          + "change pas), affichée dans la réponse et enregistrée au Drive. Jamais de donnée confidentielle dans la consigne.",
        input_schema: {
          type: "object",
          properties: {
            image: { type: "string", description: "L'identifiant Drive de l'image (de préférence) ou son nom de fichier." },
            consigne: { type: "string", description: "Ce qu'il faut changer, précisément." },
            titre: { type: "string" },
            charte: { type: "boolean" },
            logo: { type: "boolean" },
            format: { type: "string", enum: Object.keys(FORMATS_IMAGE) },
          },
          required: ["image", "consigne"],
        },
      },
      allowed: aSoi,
      label: "Image modifiée",
      run: async (e) => {
        const ref = texte(e, "image", 300);
        if (!ref) return JSON.stringify({ statut: "INCOMPLET", raison: "il faut désigner l'image (pièce jointe ou fichier du Drive)" });
        return sortie(await genererImage(user, {
          titre: titreDe(e, "Image modifiée"), consigne: e.consigne, charte: e.charte === true, logo: e.logo === true,
          format: formatDe(e.format), qualite: "medium", sources: [ref],
        }), o.visuels, CONSIGNE_PRETE);
      },
    },
    {
      def: {
        name: "generer_video",
        description:
          "LANCE la génération d'une courte vidéo (4 à 12 s) par le modèle vidéo, à partir d'une description (scène, mouvement de caméra, ambiance). "
          + "C'est LONG : elle tourne en arrière-plan, une carte « Vidéo en cours » se met à jour et la personne est notifiée. Si le modèle vidéo n'est "
          + "pas disponible, l'outil le dit : propose alors une vidéo de données ou une image. Jamais de donnée confidentielle.",
        input_schema: {
          type: "object",
          properties: {
            description: { type: "string" },
            titre: { type: "string" },
            secondes: { type: "number", description: "Durée souhaitée (4, 8 ou 12 ; bornée par le réglage du Super Admin)." },
            format: { type: "string", enum: ["paysage", "portrait"] },
          },
          required: ["description"],
        },
      },
      allowed: aSoi,
      label: "Vidéo demandée",
      run: async (e) => sortie(await lancerVideoModele(user, {
        titre: titreDe(e, "Vidéo"), consigne: e.description, secondes: e.secondes, format: e.format === "portrait" ? "portrait" : "paysage",
      }), o.visuels, CONSIGNE_EN_COURS),
    },
    {
      def: {
        name: "video_de_donnees",
        description:
          "FAIT UNE COURTE VIDÉO ANIMÉE (8 s, MP4) d'une série de chiffres DE L'ERP — barres qui montent, courbe qui se trace ou classement — aux couleurs "
          + "Adventum, sous-titrée en français (plus haut, total ou évolution, source : calculés par l'application). Lis D'ABORD les chiffres avec un outil "
          + "(budget, ventes, demandes, classement…) puis recopie-les EXACTEMENT : une valeur absente des données lues est refusée. Rendue en arrière-plan.",
        input_schema: {
          type: "object",
          properties: {
            titre: { type: "string", description: "Le titre, SANS chiffre (« Budget marketing 2026 par poste »)." },
            forme: { type: "string", enum: ["barres", "courbe", "classement"], description: "barres (comparer), courbe (évolution dans le temps), classement (du plus grand au plus petit)." },
            libelles: { type: "array", items: { type: "string" }, description: "Un libellé par valeur (2 à 12)." },
            valeurs: { type: "array", items: { type: "number" }, description: "Les nombres, recopiés tels que les outils les ont rendus." },
            unite: { type: "string", description: "DZD, %, boîtes…" },
            source: { type: "string", description: "D'où viennent les chiffres (l'outil et ce qu'il a lu)." },
          },
          required: ["titre", "forme", "libelles", "valeurs", "source"],
        },
      },
      allowed: aSoi,
      label: "Vidéo de données",
      run: async (e) => {
        const sorties = (o.journal ?? []).filter((s) => !/"statut":"(REFUS|EN_COURS|PRET)"/.test(s));
        const connus = new Set(sorties.flatMap((s) => nombresDe(s)));
        const lu = lireSpecVideoDonnees(e, (v) => connus.has(v), sorties.length > 0);
        if (!lu.ok) return JSON.stringify({ statut: "REFUS", raison: lu.raison });
        return sortie(await demanderVideoDonnees(user, lu.spec), o.visuels, CONSIGNE_EN_COURS);
      },
    },
  ];
}
