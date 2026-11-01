import type { PowerTool } from "@/platform/ia/outil";
import type { CurrentUser } from "@/lib/session";
import { recordAudit } from "@/lib/audit";
import { sansBloquer } from "@/lib/journal";
import type { Ligne } from "@/platform/ia/analyse/analyse";
import { fichierDeTable, FORMATS_EXPORT, tableDuJeu, type FormatExport } from "@/platform/ia/analyse/export";
import { portsArtefact } from "@/platform/ia/artifact/ports";
import { DOSSIER_EXPORTS } from "@/platform/ia/exports";
import { estColonneConfidentielle } from "../../domaine/analyse/confidentialite";
import { MASQUE_CONFIDENTIEL, reperesDe, type CoffretDuTour } from "../../domaine/filtre-confidentialite";
import type { AccesIa } from "../../domaine/acces-regles";
import { GESTE_EXPORT_FICHIER, Revelateur } from "../role-config";
import type { ContexteAnalyseTour } from "./outils";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * EXPORTER CE QUE LE TOUR A LU OU CALCULÉ (lot K7, décision 0037) — Direction, 01/11/2026 : « l'export de tout, quoi.
 * Tout ce qu'on veut. »
 *
 * Les 16 exports du catalogue couvrent les listes qui ont un BOUTON d'export à l'écran. Tout le reste passe ici :
 * `exporter_donnees` écrit en Excel (classeur vérifié de K1), CSV ou PDF un JEU DU TOUR — la sortie d'une LECTURE
 * appelée dans ce tour (déjà filtrée par les droits de la personne et jetonnée), un tableur lu, un résultat SQL, une
 * analyse calculée (`analyse:<titre>`). Le modèle nomme le jeu et les colonnes ; il ne recopie AUCUNE ligne.
 *
 * LA CONFIDENTIALITÉ, AVEC LE JUGE DE L'ÉCRAN :
 *   • une valeur sensible y est un REPÈRE ⟦S1⟧ (décision 0012) : elle n'est écrite dans le fichier que si la personne a
 *     le droit de la voir (`Revelateur`, K4 — même juge, même journal que l'affichage), « [confidentiel] » sinon ;
 *   • une colonne dont l'en-tête est confidentiel (salaire, IBAN, pièce d'identité…) et dont la valeur n'est PAS un
 *     repère jugé (un tableur, une saisie) devient « [confidentiel] » — jamais une valeur brute non jugée.
 * Une liste que le tour n'a pas lue ne s'exporte pas : l'outil le dit, et l'assistant la lit d'abord.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const OUTIL_EXPORTER_DONNEES = "exporter_donnees";

export interface ContexteExport extends Pick<ContexteAnalyseTour, "jeux"> {
  coffret?: CoffretDuTour | null;
  acces: AccesIa;
}

const json = (o: unknown) => JSON.stringify(o);
const str = (v: unknown, max = 200): string => (typeof v === "string" ? v.trim().slice(0, max) : "");
const RE_REPERE_SEUL = /^⟦S\d+⟧$/;

/** LE JUGE : les colonnes confidentielles non jugées masquées, puis chaque repère révélé ou masqué (K4). */
async function lignesJugees(user: CurrentUser, lignes: readonly Ligne[], ctx: ContexteExport): Promise<{ lignes: Ligne[]; masquees: string[] }> {
  const cles = [...new Set(lignes.slice(0, 2_000).flatMap((l) => Object.keys(l)))];
  const confidentielles = new Set(cles.filter(estColonneConfidentielle));
  const masquees = new Set<string>();
  const brutes = lignes.map((l) => Object.fromEntries(Object.entries(l).map(([k, v]) => {
    if (!confidentielles.has(k) || v === null || v === undefined || v === "") return [k, v];
    if (typeof v === "string" && RE_REPERE_SEUL.test(v.trim())) return [k, v];
    masquees.add(k);
    return [k, MASQUE_CONFIDENTIEL];
  })));
  const texte = JSON.stringify(brutes);
  if (!reperesDe(texte).length) return { lignes: brutes, masquees: [...masquees] };
  const revele = ctx.coffret
    ? await new Revelateur(ctx.coffret, user, ctx.acces, GESTE_EXPORT_FICHIER).enClair(texte)
    : texte.replace(/⟦S\d+⟧/g, MASQUE_CONFIDENTIEL);
  const jugees = JSON.parse(revele) as Ligne[];
  for (const l of jugees) for (const [k, v] of Object.entries(l)) if (v === MASQUE_CONFIDENTIEL) masquees.add(k);
  return { lignes: jugees, masquees: [...masquees] };
}

export function outilExporterDonnees(user: CurrentUser, ctx: ContexteExport): PowerTool {
  return {
    def: {
      name: OUTIL_EXPORTER_DONNEES,
      description:
        "EXPORTE EN FICHIER (Excel, CSV ou PDF) une liste ou un tableau que tu as LU ou CALCULÉ dans ce tour : `source` = le nom de la lecture "
        + "(« directory_list », « demandes_adpro », « read_budget »…), d'une feuille (« Fichier.xlsx#Feuille »), « sql:<titre> » ou « analyse:<titre> ». "
        + "`colonnes` (facultatif) : les colonnes à garder, dans l'ordre. Les lignes viennent du jeu — tu n'en recopies aucune. "
        + "Une liste que le tour n'a pas lue : lis-la d'abord avec la lecture adéquate. Pour une liste qui a un bouton d'export à l'écran, préfère l'outil exporter_<écran>. "
        + "Le fichier est déposé dans le Drive de la personne (« Exports ») et rendu par un lien de téléchargement.",
      input_schema: {
        type: "object",
        properties: {
          source: { type: "string", description: "Le jeu du tour (nom de la lecture, « analyse:<titre> », « sql:<titre> », « Fichier.xlsx#Feuille »)." },
          format: { type: "string", enum: [...FORMATS_EXPORT], description: "xlsx (défaut), csv ou pdf." },
          colonnes: { type: "array", items: { type: "string" }, description: "Facultatif : les colonnes à garder, dans l'ordre." },
          titre: { type: "string", description: "Le titre du fichier (« Médecins de Blida »)." },
        },
        required: ["source"],
      },
    },
    allowed: (u) => u.id === user.id,
    label: "Données exportées",
    run: async (entree, u) => {
      const source = str(entree.source, 240);
      const format = ((FORMATS_EXPORT as readonly string[]).includes(str(entree.format, 8).toLowerCase()) ? str(entree.format, 8).toLowerCase() : "xlsx") as FormatExport;
      const jeu = ctx.jeux.trouver(source);
      if (!jeu) {
        const dispo = ctx.jeux.lister();
        return json({
          ok: false,
          erreur: dispo.length
            ? `aucun jeu « ${source} » dans ce tour — jeux disponibles : ${dispo.map((d) => `${d.id} (${d.lignes} lignes)`).join(" ; ")}`
            : `aucun jeu « ${source} » : ce tour n'a rien lu.`,
          consigne: "Lis d'abord la liste avec la lecture adéquate (dans CE tour), puis rappelle exporter_donnees avec son nom en source. Jamais de lignes recopiées par toi.",
        });
      }
      const titre = str(entree.titre, 120) || jeu.id.replace(/^(analyse|sql):/, "");
      const colonnes = Array.isArray(entree.colonnes) ? entree.colonnes.map((c) => str(c, 80)).filter(Boolean) : [];
      const juge = await lignesJugees(u, jeu.lignes, ctx);
      const t = tableDuJeu(juge.lignes, { titre, source: jeu.origine, colonnes, masquees: [...new Set([...jeu.masquees, ...juge.masquees])] });
      if (!t.ok) return json({ ok: false, erreur: t.erreur });
      const f = await fichierDeTable(t.table, format, u.name ?? "Adventum IA");
      if (!f.ok) return json({ ok: false, erreur: `le fichier n'a pas été produit : ${f.motif}` });
      let nodeId: string;
      try {
        ({ nodeId } = await portsArtefact.documents.creerFichier(u.id, { nom: f.nom, octets: f.octets, mime: f.mime, dossier: DOSSIER_EXPORTS }));
      } catch (e) {
        return json({ ok: false, erreur: `le fichier a été produit mais n'a pas pu être déposé dans votre Drive : ${(e as Error).message}` });
      }
      await recordAudit({
        actorId: u.id, action: "EXPORT", module: "Assistant IA",
        summary: `Export ${format.toUpperCase()} « ${titre} » — ${t.table.matrice.length} ligne(s), ${t.table.colonnes.length} colonne(s), depuis ${jeu.origine}${t.table.masquees.length ? ` (masquées : ${t.table.masquees.join(", ")})` : ""}`,
      }).catch(sansBloquer("assistant-ia.exporter-donnees.audit"));
      const telecharger = `/api/drive/${nodeId}/raw?dl=1`;
      return json({
        statut: "FAIT",
        fichier: {
          nom: f.nom, nodeId, format: format.toUpperCase(), lignes: t.table.matrice.length, colonnes: t.table.colonnes.map((c) => c.libelle),
          source: jeu.origine, dossier: `Drive › ${DOSSIER_EXPORTS}`, telecharger,
          ...(t.table.masquees.length ? { masquees: t.table.masquees.map((m) => `${m} : valeurs confidentielles écrites « [confidentiel] » là où vous n'avez pas le droit de les voir`) } : {}),
        },
        consigne: `Réponds en une ou deux phrases : ce que contient le fichier (lignes, colonnes) et le lien [Télécharger ${f.nom}](${telecharger}) — l'écran affiche aussi le fichier comme une pièce ouvrable. `
          + `Pour l'envoyer à un collègue : send_message avec pieces: ["${nodeId}"] (une carte à confirmer).`,
      });
    },
  };
}
