import type { PowerTool, UtilisateurOutil as CurrentUser } from "@/platform/ia/outil";
import { chercherDocuments, extraitAPlat, faitsConfirmesPourModele, fichesDeDossier, ouvrirDocuments, type FicheDeDossier } from "@/modules/bibliotheque/api";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA CONNAISSANCE DE L'ENTREPRISE, POUR UN MODÈLE (lot J4, couche (d) de la mémoire — décision 0018).
 *
 *   • `chercher_documents` — la Bibliothèque (J1) : une pièce retrouvée par son CONTENU, quelle que soit sa porte
 *     d'entrée (Drive, dossier RH, pièce d'une demande…), filtrée par les droits de la personne ;
 *   • `ouvrir_documents` — le texte lu de une à trois pièces trouvées ;
 *   • `faits_confirmes` — ce que le référentiel tient pour vrai (faits confirmés d'une pièce), à qui peut ouvrir
 *     la pièce dont le fait vient.
 *
 * TOUJOURS `pourModele: true` : ni pièce CONFIDENTIELLE, ni pièce sensible (bulletin, pièce d'identité), et les
 * extraits passent le filtre de confidentialité de la Bibliothèque. Un fait SENSIBLE (qui pointe le coffre) n'est
 * jamais rendu. Ce que rend l'outil passe ensuite, comme toute sortie, le filtre du tour (repères ⟦Sn⟧).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const txt = (v: unknown, max = 300) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const jour = (d: Date) => d.toISOString().slice(0, 10);

function chercher(user: CurrentUser): PowerTool {
  return {
    def: {
      name: "chercher_documents",
      description:
        "LA BIBLIOTHÈQUE : retrouve un document de l'entreprise PAR SON CONTENU (note, compte rendu, contrat, courrier, pièce d'une demande), "
        + "quelle que soit la porte par laquelle il est entré, parmi ceux que la personne peut ouvrir. Rend titre, date, endroit (lien) et un extrait. "
        + "Pour lire le texte entier : ouvrir_documents avec les identifiants rendus.",
      input_schema: {
        type: "object",
        properties: {
          requete: { type: "string", description: "Ce que dit le document, en quelques mots (« rupture chaîne du froid Ouargla »)." },
          formats: { type: "array", items: { type: "string", enum: ["PDF", "WORD", "EXCEL", "POWERPOINT", "IMAGE", "TEXTE", "AUDIO", "VIDEO", "AUTRE"] } },
          du: { type: "string", description: "AAAA-MM-JJ" },
          au: { type: "string", description: "AAAA-MM-JJ" },
        },
        required: ["requete"],
      },
    },
    allowed: (u) => u.id === user.id,
    label: "Bibliothèque consultée",
    run: async (entree, u) => {
      const r = await chercherDocuments(u, txt(entree.requete), { formats: entree.formats, du: entree.du, au: entree.au }, { limite: 6, pourModele: true });
      if (!r.resultats.length) {
        return JSON.stringify({ resultats: [], note: "Aucun document trouvé parmi ceux que la personne peut ouvrir. Reformuler avec d'autres mots du contenu." });
      }
      return JSON.stringify({
        resultats: r.resultats.map((d) => ({
          id: d.pieceId, titre: d.titre, format: d.format, date: jour(d.date), endroit: d.endroit.libelle, lien: d.endroit.lien,
          extrait: extraitAPlat(d.extrait).slice(0, 600),
        })),
      });
    },
  };
}

function ouvrir(user: CurrentUser): PowerTool {
  return {
    def: {
      name: "ouvrir_documents",
      description: "OUVRE et lit le texte de 1 à 3 documents de la Bibliothèque, désignés par les identifiants que chercher_documents a rendus.",
      input_schema: {
        type: "object",
        properties: { ids: { type: "array", items: { type: "string" }, description: "Identifiants rendus par chercher_documents (3 au plus)." } },
        required: ["ids"],
      },
    },
    allowed: (u) => u.id === user.id,
    label: "Document ouvert",
    run: async (entree, u) => {
      const ids = (Array.isArray(entree.ids) ? entree.ids : []).map((x) => txt(x, 120)).filter(Boolean).slice(0, 3);
      if (!ids.length) return JSON.stringify({ statut: "REFUS", raison: "Aucun identifiant : appelle d'abord chercher_documents." });
      const { documents, refus } = await ouvrirDocuments(u, ids, { pourModele: true, caracteresMax: 12_000 });
      return JSON.stringify({
        documents: documents.map((d) => ({ id: d.pieceId, titre: d.titre, date: jour(d.date), lien: d.endroit.lien, texte: d.texte, tronque: d.tronque })),
        refus: refus.map((x) => ({ id: x.pieceId, raison: x.message })),
      });
    },
  };
}

function faits(user: CurrentUser): PowerTool {
  return {
    def: {
      name: "faits_confirmes",
      description:
        "Les FAITS CONFIRMÉS du référentiel (raison sociale, forme juridique, adresse, site, identité d'une personne, données d'un produit), tirés "
        + "de pièces et confirmés par une personne, avec leur source et leur date. Donne un nom ou une valeur à chercher.",
      input_schema: { type: "object", properties: { recherche: { type: "string" } }, required: ["recherche"] },
    },
    allowed: (u) => u.id === user.id,
    label: "Faits confirmés consultés",
    run: async (entree, u) => {
      const q = txt(entree.recherche, 120);
      if (q.length < 2) return JSON.stringify({ statut: "REFUS", raison: "Recherche trop courte." });
      // La règle (non sensible, pièce ouvrable) est celle de la Bibliothèque — `faitsConfirmesPourModele`.
      const r = await faitsConfirmesPourModele(u, q);
      if (!r.existe) return JSON.stringify({ faits: [], note: "Aucun fait confirmé ne correspond." });
      return JSON.stringify(r.faits.length
        ? { faits: r.faits, ...(r.caches ? { note: `${r.caches} fait(s) non rendu(s) : sensibles ou tirés d'une pièce que la personne ne peut pas ouvrir.` } : {}) }
        : { faits: [], note: "Des faits existent, mais aucun n'est lisible par cette personne (sensibles, ou pièce hors de ses droits)." });
    },
  };
}

/** Les outils de la connaissance, pour CETTE personne. */
export function outilsConnaissance(user: CurrentUser): PowerTool[] {
  return [chercher(user), ouvrir(user), faits(user)];
}

/**
 * LES FICHES D'UN DOSSIER DÉPOSÉ, pour un modèle (J11, décision 0030) — ce que la Bibliothèque sait déjà de chaque pièce
 * (titre, nature, état, début du texte lu), sous les droits de la personne et la politique « pour modèle » (coffre et
 * confidentiel : le titre seul). L'Assistant IA y classe un dossier sans relire les fichiers un à un.
 */
export function fichesDeDossierPourModele(user: CurrentUser, pieceIds: readonly string[]): Promise<FicheDeDossier[]> {
  return fichesDeDossier(user as Parameters<typeof fichesDeDossier>[0], pieceIds, { pourModele: true });
}
export type { FicheDeDossier };
