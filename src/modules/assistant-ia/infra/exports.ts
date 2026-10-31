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
 * l'ouvre (`/drive/<id>` : l'écran en fait un bloc fichier) et celui qui le télécharge.
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
export const FAMILLES_EXPORTS: Readonly<Record<string, FamilleIa[]>> = Object.fromEntries(
  CATALOGUE_EXPORTS.map((f) => [f.outil, ["DRIVE", ...(FAMILLE_DU_DOMAINE[f.outil] ? [FAMILLE_DU_DOMAINE[f.outil]!] : [])]]),
);

/** Les fiches des exports pour le REGISTRE DES CAPACITÉS (une lecture : rien n'est écrit chez un autre). */
export const FICHES_EXPORTS: readonly OutilDecrit[] = CATALOGUE_EXPORTS.map((f) => ({
  nom: f.outil, libelle: f.libelle, description: f.description, ecriture: false, familles: FAMILLES_EXPORTS[f.outil] ?? ["DRIVE"],
}));

/** Les mots de chaque export, pour la sélection d'outils (pesés comme un libellé). */
export const MOTS_EXPORTS: ReadonlyMap<string, { mots: string; contexte: string }> = new Map(
  CATALOGUE_EXPORTS.map((f) => [f.outil, { mots: `${f.libelle} ${f.mots}`, contexte: `${f.format} ${f.ecran.replace(/[/-]/g, " ")}` }]),
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
      const ouvrir = `/drive/${nodeId}`;
      const telecharger = `/api/drive/${nodeId}/raw?dl=1`;
      return json({
        statut: "FAIT",
        fichier: { nom, nodeId, format: f.format, contenu: r.fichier.resume, dossier: `Drive › ${DOSSIER_EXPORTS}`, ouvrir, telecharger, octets: r.fichier.octets.byteLength },
        consigne: `Réponds en une ou deux phrases : ce que contient le fichier, le lien [${nom}](${ouvrir}) (l'écran l'affiche comme une pièce) et le lien [Télécharger](${telecharger}). `
          + `Pour l'envoyer à un collègue : send_message avec pieces: ["${nodeId}"] (une carte à confirmer).`,
      });
    },
  };
}

/** Les outils d'export offerts à CETTE personne (seulement ceux dont elle a le bouton à l'écran). */
export function outilsExports(user: CurrentUser): PowerTool[] {
  return CATALOGUE_EXPORTS.map((f) => outilExport(user, f));
}

