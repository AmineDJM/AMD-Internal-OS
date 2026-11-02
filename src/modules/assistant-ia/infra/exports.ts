import type { PowerTool } from "@/platform/ia/outil";
import type { CurrentUser } from "@/lib/session";
import type { FamilleIa } from "@/platform/ia/capacites/familles";
import type { OutilDecrit } from "@/platform/ia/capacites/types";
import { portsArtefact } from "@/platform/ia/artifact/ports";
import { CATALOGUE_EXPORTS, DOSSIER_EXPORTS, exportOuvert, nomDeFichierSur, produireExport, type FicheExport } from "@/platform/ia/exports";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES EXPORTS DE L'ERP, POUR L'ASSISTANT IA (lot K7, décision 0037) — « génère le suivi Regulatory ».
 *
 * Un outil par fiche du catalogue (`lib/exports/catalogue.ts`) : il appelle LA fonction d'export que le bouton de
 * l'écran appelle aussi (même portée, mêmes droits, même audit), DÉPOSE le fichier dans le Drive personnel de la
 * personne (dossier « Exports », inscrit à la Bibliothèque par le port du Live Office) et rend au modèle le lien qui
 * le télécharge (`/api/drive/<id>/raw?dl=1` : l'écran en fait aussi un bloc fichier ouvrable).
 *
 * Rien ne part chez personne : envoyer le fichier à un collègue est un AUTRE geste, une carte à confirmer
 * (`send_message` avec la pièce). L'outil n'est offert qu'à qui a le bouton (`exportOuvert`) ; la famille de la console
 * (Drive, et celle du domaine) se juge à l'appel (`FAMILLES_EXPORTS`, lue par `outils-v1.ts`).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Les familles de la console qu'un export exige : le Drive (le fichier y est déposé), et celle de son domaine. */
const FAMILLE_DU_DOMAINE: Readonly<Record<string, FamilleIa>> = {
  exporter_suivi_regulatory: "REGLEMENTAIRE",
  exporter_budget: "BUDGETS",
  exporter_budget_marketing: "BUDGETS",
  exporter_inscrits_evenement: "AD_PRO",
};
/**
 * L'EXPORT DE TOUT (`exporter_donnees`, `infra/analyse/exporter.ts`) — ce que le tour a lu ou calculé : une fiche hors
 * catalogue (aucune route d'écran), mêmes familles (le Drive), au registre et à la sélection comme les autres.
 */
const EXPORT_DONNEES = {
  outil: "exporter_donnees",
  libelle: "Exporter des données lues ou calculées (Excel, CSV, PDF)",
  description: "EXPORTE en Excel, CSV ou PDF une liste ou un tableau lu ou calculé dans la conversation (une lecture, un tableur, une analyse) — déposé dans le Drive (« Exports »).",
  mots: "export exporte exporter excel csv pdf fichier tableau liste ce tableau cette liste que tu viens de donner telecharger sors moi extraction donnees medecins resultats",
  contexte: "Excel CSV PDF tableau lu calcule conversation",
} as const;

export const FAMILLES_EXPORTS: Readonly<Record<string, FamilleIa[]>> = Object.fromEntries([
  ...CATALOGUE_EXPORTS.map((f) => [f.outil, ["DRIVE", ...(FAMILLE_DU_DOMAINE[f.outil] ? [FAMILLE_DU_DOMAINE[f.outil]!] : [])]]),
  [EXPORT_DONNEES.outil, ["DRIVE"]],
]);

/** Les fiches des exports pour le REGISTRE DES CAPACITÉS (une lecture : rien n'est écrit chez un autre). */
export const FICHES_EXPORTS: readonly OutilDecrit[] = [...CATALOGUE_EXPORTS, EXPORT_DONNEES].map((f) => ({
  nom: f.outil, libelle: f.libelle, description: f.description, ecriture: false, familles: FAMILLES_EXPORTS[f.outil] ?? ["DRIVE"],
}));

/** Les mots de chaque export, pour la sélection d'outils (pesés comme un libellé). */
export const MOTS_EXPORTS: ReadonlyMap<string, { mots: string; contexte: string }> = new Map(
  [
    ...CATALOGUE_EXPORTS.map((f) => [f.outil, { mots: `${f.libelle} ${f.mots}`, contexte: `${f.format} ${f.ecran.replace(/[/-]/g, " ")}` }] as const),
    [EXPORT_DONNEES.outil, { mots: `${EXPORT_DONNEES.libelle} ${EXPORT_DONNEES.mots}`, contexte: EXPORT_DONNEES.contexte }] as const,
  ],
);

const json = (o: unknown) => JSON.stringify(o);

function outilExport(user: CurrentUser, f: FicheExport): PowerTool {
  return {
    def: {
      name: f.outil,
      description: `${f.description} Rien n'est envoyé à personne : pour l'envoyer à un collègue, prépare ensuite send_message avec la pièce (nodeId).`,
      input_schema: { type: "object", properties: f.proprietes as Record<string, unknown>, ...(f.requis?.length ? { required: [...f.requis] } : {}) },
    },
    allowed: (u) => u.id === user.id && exportOuvert(f.outil, u),
    refus: `L'export « ${f.libelle} » se fait depuis l'écran ${f.ecran}, que votre rôle n'ouvre pas.`,
    label: f.libelle,
    run: async (entree, u) => {
      const r = await produireExport(f.outil, u, entree ?? {});
      if (!r.ok) {
        return json({
          statut: "REFUS", raison: r.erreur, ecran: f.ecran,
          consigne: `Dis la raison telle quelle. Le même export existe à l'écran ${f.ecran} (lien Markdown [ouvrir l'écran](${f.ecran})) — sous les mêmes droits.`,
        });
      }
      const nom = nomDeFichierSur(r.fichier.nomDeFichier);
      let nodeId: string;
      try {
        ({ nodeId } = await portsArtefact.documents.creerFichier(u.id, { nom, octets: Buffer.from(r.fichier.octets), mime: r.fichier.mime, dossier: DOSSIER_EXPORTS }));
      } catch (e) {
        return json({ statut: "ERREUR", raison: `Le fichier a été produit mais n'a pas pu être déposé dans votre Drive : ${(e as Error).message}`, ecran: f.ecran });
      }
      // UN SEUL LIEN, celui du téléchargement : permis dans l'app Adventum IA comme dans l'ERP, et l'écran en tire le BLOC
      // FICHIER ouvrable (`idsDriveCites` reconnaît `/api/drive/<id>/…`). Le lien de page `/drive/<id>` est une page de
      // l'ERP : dans l'app, elle n'existe pas (mesuré : 404 au préchargement).
      const telecharger = `/api/drive/${nodeId}/raw?dl=1`;
      return json({
        statut: "FAIT",
        fichier: { nom, nodeId, format: f.format, contenu: r.fichier.resume, dossier: `Drive › ${DOSSIER_EXPORTS}`, telecharger, octets: r.fichier.octets.byteLength },
        consigne: `Réponds en une ou deux phrases : ce que contient le fichier et le lien [Télécharger ${nom}](${telecharger}) — l'écran affiche aussi le fichier comme une pièce ouvrable ; il est rangé dans le Drive (dossier « ${DOSSIER_EXPORTS} »). `
          + `Pour l'envoyer à un collègue : send_message avec pieces: ["${nodeId}"] (une carte à confirmer).`,
      });
    },
  };
}

/** Les outils d'export offerts à CETTE personne (seulement ceux dont elle a le bouton à l'écran). */
export function outilsExports(user: CurrentUser): PowerTool[] {
  return CATALOGUE_EXPORTS.map((f) => outilExport(user, f));
}

