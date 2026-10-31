/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « LANCER UN TRAVAIL » — l'outil par lequel un assistant (l'Assistant IA aujourd'hui, Adam demain)
 * ouvre un TRAVAIL quand la demande dépasse un tour (J2, décision 0016). SOCLE IA : n'importe ni Adam,
 * ni l'Assistant IA, ni l'ERP — zéro import. Le moteur (`lib/missions/travaux/`) est INJECTÉ par la
 * persona (`ouvrir`) : c'est lui qui relit le plan contre les droits de la personne et l'écrit.
 *
 * L'outil ne lance RIEN : il PROPOSE. Le plan attend le geste « Approuver le plan » de la personne
 * (panneau Travaux), qui voit les étapes, les gestes qu'elle autorise et le plafond de dépense.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** La forme d'un outil d'assistant (structurellement celle de `PowerTool`), décrite ici pour ne rien importer. */
export interface OutilTravail {
  def: { name: string; description: string; input_schema: Record<string, unknown> };
  allowed: (user: { id: string }) => boolean;
  label: string;
  run: (entree: Record<string, unknown>, user: { id: string }) => Promise<string>;
}

export type OuvertureTravail =
  | { ok: true; travailId: string; etapes: number; gestes: string[]; plafondUsd: number; demarre?: boolean; remplace?: string | null }
  | { ok: false; fautes: string[] };

export const NOM_OUTIL_TRAVAIL = "lancer_un_travail";

// LES OBJETS DU PLAN DÉCLARENT LEURS PROPRIÉTÉS (banc réel du 31/10/2026) : un objet sans `properties` ne laissait au
// modèle que `{}` — six plans de suite refusés (« lots exige { etape, chemin } »), le modèle n'ayant aucune clé à écrire.
const DELAI = { type: "object", properties: { jours: { type: "number" }, minutes: { type: "number" } } };

const ETAPE = {
  type: "object",
  properties: {
    cle: { type: "string", description: "Identifiant court, minuscules (« lire-demandes »)." },
    titre: { type: "string" },
    type: { type: "string", enum: ["LECTURE", "ANALYSE", "LOTS", "GESTE", "ATTENTE", "DEMANDE", "LIVRABLE"] },
    outil: { type: "string", description: "LECTURE : un de tes outils de lecture ; GESTE : un de tes gestes (préparer_…)." },
    apres: { type: "array", items: { type: "string" }, description: "Clés des étapes PRÉCÉDENTES à attendre." },
    entree: { type: "object", description: "Arguments ; « {{cle.chemin}} » lit la sortie d'une étape amont." },
    consigne: { type: "string", description: "ANALYSE / LIVRABLE : ce qu'il faut en tirer." },
    lots: {
      type: "object", description: "LOTS : { etape, chemin, taille } — la liste à découper (taille 5 à 100).",
      properties: {
        etape: { type: "string", description: "Clé de l'étape amont qui rend la liste." },
        chemin: { type: "string", description: "Où est la liste dans sa sortie (ex. « demandes »)." },
        taille: { type: "number", description: "Éléments par lot (5 à 100)." },
      },
      required: ["etape", "chemin"],
    },
    pourChaque: {
      type: "object", description: "ANALYSE : { etape } — une analyse par lot rendu par cette étape LOTS.",
      properties: { etape: { type: "string", description: "Clé de l'étape LOTS." } },
      required: ["etape"],
    },
    attente: {
      type: "object", description: "ATTENTE : { evenement, entite « TYPE:id », champs { statut: \"SIGNE\" }, jours, relance { jours }, escalade { jours, a: PRINCIPAL|RESPONSABLE } } ou une minuterie { jours | minutes } — délais comptés de l'APPROBATION du plan.",
      properties: {
        evenement: { type: "string" }, entite: { type: "string", description: "« TYPE:id »." },
        champs: { type: "object", properties: { statut: { type: "string" } } },
        jours: { type: "number" }, minutes: { type: "number" }, relance: DELAI,
        escalade: { type: "object", properties: { jours: { type: "number" }, minutes: { type: "number" }, a: { type: "string", enum: ["PRINCIPAL", "RESPONSABLE"] } } },
      },
    },
    demande: {
      type: "object", description: "DEMANDE (demander à une personne) : { a (nom exact ou e-mail), question, pieces [ce qu'on attend d'elle], partager [identifiants Drive à lui montrer], jours (échéance), relance { jours }, escalade { jours }, abandon { jours } } — délais comptés du DÉPÔT de la demande. Elle ne voit que la question et les pièces partagées.",
      properties: {
        a: { type: "string" }, question: { type: "string" },
        pieces: { type: "array", items: { type: "string" } }, partager: { type: "array", items: { type: "string" } },
        jours: { type: "number" }, minutes: { type: "number" }, relance: DELAI, escalade: DELAI, abandon: DELAI,
      },
    },
    format: { type: "string", enum: ["docx", "pdf", "xlsx", "md"], description: "LIVRABLE : le document déposé au Drive de la personne (défaut docx ; xlsx pour des tableaux ; md = au carnet seulement)." },
    si: {
      type: "object", description: "{ etape, issue: EVENT|TIMEOUT|DONE|FAILED|SKIPPED } — ne part que si l'étape s'est terminée ainsi (relance : TIMEOUT).",
      properties: { etape: { type: "string" }, issue: { type: "string", enum: ["EVENT", "TIMEOUT", "DONE", "FAILED", "SKIPPED"] } },
      required: ["etape", "issue"],
    },
  },
  required: ["cle", "titre", "type"],
};

export const CONSIGNE_TRAVAUX = [
  "TRAVAUX LONGS : quand une demande dépasse un tour — beaucoup de lectures, un gros volume à analyser (« toutes les demandes de l'année »), une attente (« quand le BC sera signé », « si pas de réponse sous 21 jours, relance »), ou plusieurs heures de travail —, ne la fais pas dans la conversation : appelle `lancer_un_travail` avec un PLAN.",
  "Le plan : des étapes LECTURE (tes outils de lecture), LOTS (découper une liste), ANALYSE (avec `pourChaque` sur les lots, puis une synthèse), GESTE (une écriture, autorisée une fois avec le plan), ATTENTE (événement métier avec échéance, relance et escalade, ou minuterie), DEMANDE (demander à un collègue une information ou une pièce, avec une échéance : le travail attend sa réponse), et au moins un LIVRABLE à la fin (un document Word, PDF ou Excel déposé dans son Drive).",
  "DEMANDE : jamais une discussion — une question précise, les pièces attendues, une échéance. N'y mets rien que la personne sollicitée ne doive voir : elle voit la question et les pièces partagées, pas le reste du travail.",
  "SOUS-MISSIONS (K3) : une demande qui se découpe en parties INDÉPENDANTES (ex. lire un dossier, analyser des chiffres, rédiger une note) se lance en PLUSIEURS sous-missions — un appel de `lancer_un_travail` par partie, dans le même tour : elles tournent en parallèle, en arrière-plan, et la conversation continue. Pour CORRIGER un plan que tu viens de proposer, rappelle l'outil avec `remplace` = son travailId (sinon c'est une sous-mission DE PLUS). `parent` = le travailId d'une mission existante dont celle-ci est une sous-mission.",
  "Un plan qui comporte un geste, une demande ou une attente attend que la personne l'approuve (carte dans la conversation, tableau « Missions ») : dis-le-lui, en une phrase, avec le nombre d'étapes et les gestes qu'elle autorisera. Un plan SANS geste peut démarrer d'office (le résultat de l'outil le dit : DEMARRE). Ne prétends jamais que le travail est fait : le résultat reviendra dans la conversation à la fin.",
].join("\n");

/** UNE DEMANDE QUI DÉPASSE UN TOUR, vue à ses mots — un indice ajouté à la consigne, jamais une décision : le modèle choisit. */
export function demandeLongue(texte: string): boolean {
  const t = (texte ?? "").toLowerCase();
  return /\b(toutes?|tous|chaque|l'ensemble)\b.{0,40}\b(demandes?|dossiers?|factures?|contrats?|courriers?|fichiers?|bons? de commande)\b/.test(t)
    || /\b(de l'année|du trimestre|des \d+ derniers mois|depuis (janvier|le début))\b/.test(t)
    || /\b(si (pas|aucune?) (de )?réponse|relance[rs]? (si|dans|sous)|quand (le|la|les) .{0,30}(sign|valid|répon|reçu))/.test(t)
    || /\b(surveille|suis|suivre) .{0,40}\b(jusqu'à|pendant)\b/.test(t)
    // J8 : « demande à Karim le devis, attends sa réponse, puis… » — une délégation.
    || /\bdemander? à [a-zà-ÿ-]+\b.{0,80}\b(attends?|sa réponse|puis|ensuite|relance)/.test(t);
}

export const INDICE_DEMANDE_LONGUE = "INDICE : cette demande ressemble à un TRAVAIL LONG (volume, attente ou relance). Propose un plan avec `lancer_un_travail` plutôt que de tout faire dans ce tour.";

/** L'outil, pour CETTE personne : `ouvrir` relit le plan contre ses droits et l'écrit en attente d'approbation. */
export function outilLancerUnTravail(principalId: string, ouvrir: (plan: unknown) => Promise<OuvertureTravail>, decrireCatalogue = ""): OutilTravail {
  return {
    def: {
      name: NOM_OUTIL_TRAVAIL,
      description: "Ouvre un TRAVAIL long (arrière-plan, reprise après redémarrage, attentes, lots) à partir d'un PLAN. Rien ne s'exécute avant que la personne approuve le plan."
        + (decrireCatalogue ? ` ${decrireCatalogue}` : ""),
      input_schema: {
        type: "object",
        properties: {
          titre: { type: "string" },
          objectif: { type: "string", description: "Ce qu'on cherche à obtenir, en une ou deux phrases." },
          priorite: { type: "string", enum: ["HAUTE", "NORMALE", "BASSE"], description: "Parmi les travaux de la personne (défaut NORMALE)." },
          remplace: { type: "string", description: "Pour CORRIGER un plan proposé dans ce tour : son travailId (il est remplacé). Absent : une sous-mission de plus." },
          parent: { type: "string", description: "Le travailId d'une mission existante dont celle-ci est une SOUS-MISSION (facultatif)." },
          etapes: { type: "array", items: ETAPE },
        },
        required: ["titre", "objectif", "etapes"],
      },
    },
    allowed: (u) => u.id === principalId,
    label: "Travail proposé",
    run: async (entree, u) => {
      if (u.id !== principalId) return JSON.stringify({ statut: "REFUS", raison: "Cet outil a été préparé pour une autre personne." });
      const r = await ouvrir(entree);
      if (!r.ok) {
        return JSON.stringify({ statut: "PLAN_REFUSE", fautes: r.fautes.slice(0, 12), consigne: "Corrige le plan et rappelle l'outil ; n'invente pas d'outil ni de geste." });
      }
      if (r.demarre) {
        return JSON.stringify({
          statut: "DEMARRE", travailId: r.travailId, etapes: r.etapes, plafondUsd: r.plafondUsd, ...(r.remplace ? { remplace: r.remplace } : {}),
          consigne: "Plan sans geste démarré d'office, en arrière-plan : dis-le en une phrase (la personne suit ses étapes dans le tableau « Missions », la synthèse reviendra dans la conversation). Ne donne aucun résultat maintenant — tu ne l'as pas encore.",
        });
      }
      return JSON.stringify({
        statut: "EN_ATTENTE_D_APPROBATION", travailId: r.travailId, etapes: r.etapes, gestes: r.gestes, plafondUsd: r.plafondUsd, ...(r.remplace ? { remplace: r.remplace } : {}),
        consigne: "Rien n'a démarré : dis à la personne que le plan l'attend (carte « Approuver » dans la conversation ou tableau « Missions »), avec le nombre d'étapes, les gestes qu'elle autorisera et le plafond. Ne dis jamais que c'est fait. Pour corriger CE plan : `remplace` = ce travailId ; un appel sans `remplace` lance une sous-mission DE PLUS.",
      });
    },
  };
}
