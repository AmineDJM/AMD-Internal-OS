import type { PowerTool } from "@/platform/ia/outil";
import type { CurrentUser } from "@/lib/session";
import { ongletDesigne } from "@/platform/ia/artifact/store";
import { SCHEMA_GESTE, type GesteAtelier } from "@/platform/ia/artifact/atelier/gestes";
import { structurePourModele } from "@/platform/ia/artifact/atelier/structure";
import { appliquerGestes, ouvrirDansAtelier, PREFIXE_ATELIER, vueAtelier, type OuvertureAtelier } from "@/platform/ia/artifact/atelier/service";
import { demanderConversion, LIBELLE_VOIE, type VersFormat } from "@/platform/ia/artifact/atelier/conversions";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES OUTILS DE L'ATELIER (J3, décision 0017) — l'Assistant IA ouvre, modifie EN PLACE et convertit.
 *
 *   ouvrir_dans_l_atelier   ouvre un document (pièce jointe, renvoyée, trouvée) dans un onglet de l'Atelier
 *                           et rend sa STRUCTURE (rangs, titres, diapositives, cellules) pour désigner ;
 *   modifier_document       applique des GESTES typés sur le FICHIER D'ORIGINE (styles, tableaux, mise en
 *                           page conservés) — un par un, l'écran les montre arriver ; rien n'est enregistré ;
 *   convertir_document      Word/PowerPoint/Excel → PDF, tableau → Excel, PDF → Word/Excel, image → PDF/Word,
 *                           PowerPoint → images ; dit la voie (décision 0019).
 *
 * Au-dessus du socle (`platform/ia/artifact/atelier`) : les droits du Drive y sont relus à chaque geste.
 * Ce ne sont pas des écritures de l'ERP : modifier un document ouvert ne change rien tant que la personne
 * n'a pas ENREGISTRÉ (une nouvelle version, jamais un écrasement ; carte de confirmation si le document
 * est rattaché à un objet métier). Ils restent hors des routines et des travaux (`ECRITURES_DU_MOTEUR`).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const OUTILS_ATELIER = ["ouvrir_dans_l_atelier", "modifier_document", "convertir_document"] as const;

const RE_ID = /^[a-z0-9]{20,32}$/i;

type Resolu = { ok: true; sessionId: string; o: OuvertureAtelier | null } | { ok: false; sortie: string };

/** Le document désigné : un onglet déjà ouvert, un identifiant Drive, ou un nom — ouvert au besoin. */
async function resoudre(user: CurrentUser, document: string): Promise<Resolu> {
  const ref = document.trim();
  if (!ref) return { ok: false, sortie: JSON.stringify({ statut: "INCOMPLET", raison: "il faut désigner le document (identifiant Drive ou nom)" }) };
  const onglet = await ongletDesigne(user.id, PREFIXE_ATELIER, ref);
  if (onglet) return { ok: true, sessionId: onglet.id, o: null };
  let o = RE_ID.test(ref) ? await ouvrirDansAtelier(user, { nodeId: ref }) : null;
  if (!o || (!o.ok && !o.candidats.length)) o = await ouvrirDansAtelier(user, { nom: ref.replace(/^«\s*|\s*»$/g, "") });
  if (o.ok && o.vue) return { ok: true, sessionId: o.vue.sessionId, o };
  if (o.candidats.length) {
    return { ok: false, sortie: JSON.stringify({ statut: "AMBIGU", raison: o.motif, candidats: o.candidats, consigne: "Demande à l'utilisateur lequel ; ne choisis pas." }) };
  }
  return { ok: false, sortie: JSON.stringify({ statut: "REFUS", raison: o.motif ?? "Ce document n'existe pas, ou vous n'y avez pas accès." }) };
}

/** Ce que le modèle relit d'une conversion : l'état, la VOIE (à répéter), le fichier produit, la note du moteur. */
function reponseConversion(c: Awaited<ReturnType<typeof demanderConversion>>, nonEnregistre: boolean): string {
  return JSON.stringify({
    statut: c.etat ?? "REFUS",
    ...(c.motif ? { raison: c.motif } : {}),
    ...(c.voie ? { voie: LIBELLE_VOIE[c.voie] } : {}),
    ...(c.resultat ? { fichier: c.resultat.nom, lien: `/drive/${c.resultat.nodeId}` } : {}),
    ...(c.note ? { note: c.note } : {}),
    ...(nonEnregistre ? { avertissement: "Des modifications non enregistrées ne sont PAS dans la conversion : dis-le." } : {}),
  });
}

const texteDe = (e: Record<string, unknown>, cle: string) => (typeof e[cle] === "string" ? (e[cle] as string) : "");

export function outilsAtelier(user: CurrentUser): PowerTool[] {
  const aSoi = (u: CurrentUser) => u.id === user.id;
  return [
    {
      def: {
        name: "ouvrir_dans_l_atelier",
        description:
          "OUVRE un document (Word, PowerPoint, Excel, PDF) dans l'Atelier, à côté de la conversation — une pièce jointe, une pièce que tu as renvoyée, "
          + "ou un fichier du Drive trouvé par son nom — et rend sa STRUCTURE (paragraphes numérotés, titres, diapositives, zones, cellules) pour "
          + "désigner une cible. À appeler AVANT modifier_document. Plusieurs documents peuvent être ouverts côte à côte (un appel chacun).",
        input_schema: {
          type: "object",
          properties: { document: { type: "string", description: "L'identifiant Drive de la pièce (de préférence) ou le nom du fichier." } },
          required: ["document"],
        },
      },
      allowed: aSoi,
      label: "Document ouvert dans l'Atelier",
      run: async (e, u) => {
        const r = await resoudre(u, texteDe(e, "document"));
        if (!r.ok) return r.sortie;
        const vue = r.o?.vue ?? (await vueAtelier(u, r.sessionId));
        if (!vue) return JSON.stringify({ statut: "ECHEC", raison: "Le document n'a pas pu être relu." });
        const droits = r.o?.droits;
        return JSON.stringify({
          statut: "OUVERT",
          document: r.sessionId,
          nom: vue.nom,
          format: vue.format,
          modifiable: droits ? droits.modifier : true,
          ...(droits && !droits.modifier ? { avertissement: "La personne peut LIRE ce document mais pas le modifier (droits du Drive) : ne propose pas de modification, propose une copie (« enregistrer sous »)." } : {}),
          structure: structurePourModele(vue.contenu),
        });
      },
    },
    {
      def: {
        name: "modifier_document",
        description:
          "MODIFIE EN PLACE un document ouvert dans l'Atelier, par des GESTES typés appliqués sur le fichier d'origine (styles, tableaux, mise en page "
          + "conservés) — jamais en le recomposant. Gestes : remplacer_texte (chercher → remplacer, tout le document), reecrire_paragraphe (index ou contient + texte), "
          + "inserer_paragraphe, supprimer_paragraphe, modifier_titre (titre ; PowerPoint : diapo), mettre_en_forme, inserer_tableau (lignes « A | B | C », la 1re = en-tête), "
          + "modifier_cellule (Excel : plage + valeur ou « =formule » ; Word : tableau, ligne, colonne), ajouter_diapo (titre + texte une ligne par puce ; diapo = après laquelle), "
          + "supprimer_diapo, dupliquer_diapo, deplacer_diapo, texte_forme, et pour un PDF : supprimer_pages, pivoter_pages, filigrane. "
          + "Chaque geste s'affiche en direct à l'écran et devient une ligne d'historique que la personne ACCEPTE ou REFUSE ; RIEN n'est enregistré : "
          + "dis-lui de relire puis d'appuyer sur « Enregistrer » (nouvelle version dans le Drive, l'original reste). Une cible ambiguë revient avec ses candidats : demande, ne devine pas.",
        input_schema: {
          type: "object",
          properties: {
            document: { type: "string", description: "La référence rendue par ouvrir_dans_l_atelier (ou l'identifiant Drive)." },
            gestes: { type: "array", items: SCHEMA_GESTE, description: "Les gestes, dans l'ordre." },
          },
          required: ["document", "gestes"],
        },
      },
      allowed: aSoi,
      label: "Document modifié dans l'Atelier",
      run: async (e, u) => {
        const gestes = Array.isArray(e.gestes) ? (e.gestes as GesteAtelier[]).filter((g) => g && typeof g === "object").slice(0, 30) : [];
        if (!gestes.length) return JSON.stringify({ statut: "INCOMPLET", raison: "aucun geste (`gestes`)" });
        const r = await resoudre(u, texteDe(e, "document"));
        if (!r.ok) return r.sortie;
        const a = await appliquerGestes(u, r.sessionId, gestes);
        return JSON.stringify({
          statut: a.ok ? "MODIFIE_NON_ENREGISTRE" : "REFUS",
          document: r.sessionId,
          ...(a.motif ? { raison: a.motif } : {}),
          gestes: a.gestes.map((g) => ({ geste: g.geste, ok: g.ok, fait: g.resumes, ...(g.motif ? { refus: g.motif } : {}), ...(g.candidats.length ? { candidats: g.candidats } : {}) })),
          consigne: a.ok
            ? "Les modifications sont à l'écran, dans l'Atelier, surlignées. Rien n'est enregistré : dis à la personne de les relire (accepter / refuser chacune), puis d'appuyer sur « Enregistrer » — une NOUVELLE version, l'original reste. Cite les refus."
            : "Rien n'a été modifié. Dis pourquoi ; une cible ambiguë : demande laquelle.",
        });
      },
    },
    {
      def: {
        name: "convertir_document",
        description:
          "CONVERTIT un document : Word → PDF, PowerPoint → PDF ou images, Excel → PDF, tableau d'un Word → Excel, PDF → Word (mise en page, images, tableaux, "
          + "arabe ; pages scannées lues par OCR), PDF → Excel (ses tableaux), image → PDF ou Word (OCR). Le résultat est un "
          + "NOUVEAU fichier dans le Drive de la personne (dossier « Atelier »), l'original n'est pas touché ; c'est la dernière version ENREGISTRÉE qui est convertie. "
          + "La réponse dit la VOIE (LibreOffice du worker, éditeur Office, rendu intégré…) : répète-la.",
        input_schema: {
          type: "object",
          properties: {
            document: { type: "string", description: "La référence de l'Atelier, l'identifiant Drive ou le nom du fichier." },
            vers: { type: "string", enum: ["PDF", "XLSX", "DOCX", "IMAGES"] },
          },
          required: ["document", "vers"],
        },
      },
      allowed: aSoi,
      label: "Document converti",
      run: async (e, u) => {
        const vers = texteDe(e, "vers").toUpperCase() as VersFormat;
        if (!["PDF", "XLSX", "DOCX", "IMAGES"].includes(vers)) return JSON.stringify({ statut: "INCOMPLET", raison: "`vers` : PDF, XLSX, DOCX ou IMAGES" });
        const ref = texteDe(e, "document").trim();
        const r = await resoudre(u, ref);
        if (!r.ok) {
          // Une IMAGE ne s'ouvre pas dans l'Atelier : désignée par son identifiant Drive, elle se convertit directement.
          if (!RE_ID.test(ref)) return r.sortie;
          const c = await demanderConversion(u, ref, vers, null);
          return !c.ok && !c.id ? r.sortie : reponseConversion(c, false);
        }
        const vue = r.o?.vue ?? (await vueAtelier(u, r.sessionId));
        if (!vue) return JSON.stringify({ statut: "ECHEC", raison: "Le document n'a pas pu être relu." });
        return reponseConversion(await demanderConversion(u, vue.nodeId, vers, r.sessionId), vue.dirty);
      },
    },
  ];
}

/** La consigne de l'Atelier — dite à chaque tour. */
export const CONSIGNE_ATELIER =
  "ATELIER (documents) : pour MODIFIER un document existant (Word, PowerPoint, Excel, PDF) — une pièce jointe, renvoyée ou trouvée —, "
  + "appelle ouvrir_dans_l_atelier puis modifier_document : la modification se fait EN PLACE sur le fichier d'origine (styles, tableaux et mise en page "
  + "conservés), sous les yeux de la personne, qui accepte ou refuse chaque modification puis enregistre une NOUVELLE version. "
  + "preparer_document sert uniquement à CRÉER un document neuf (lettre, note, compte rendu) — jamais à refaire un document existant. "
  + "Pour montrer un document sans le modifier : ouvrir_dans_l_atelier. Pour un PDF, un Excel ou un Word à convertir : convertir_document.";
