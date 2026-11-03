import { prisma } from "@/lib/prisma";
import type { PowerTool } from "@/platform/ia/outil";
import type { CurrentUser } from "@/lib/session";
import { journaliserGeste } from "@/platform/ia/hors-requete";
import { portsArtefact } from "@/platform/ia/artifact/ports";
import { traduireGeste, SCHEMA_GESTE, type GesteAtelier } from "@/platform/ia/artifact/atelier/gestes";
import { demanderConversion, type VersFormat } from "@/platform/ia/artifact/atelier/conversions";
import { deposerDansLEspace, derniereVersionLisible, dossierDeLEspace } from "@/lib/actions/internes/primitives/espace";
import { mimeOffice, ouvrirOffice, vueDe } from "@/lib/actions/internes/primitives/office";
import { observationDe, occurrences, type Observation } from "../../domaine/primitives/observation";
import { resoudrePiece } from "../operations/pieces";
import { fabriqueVisionOcr } from "../atelier/ocr-vision";
import { observerOctets, texteIntegral } from "./observer";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LOT I3 — `fichier` : MODIFIER, CONVERTIR, COPIER un fichier du Drive (décision 0065, AU2 §6.1 (d), étape M2).
 *
 * Écrire un fichier est DÉJÀ réversible par nature : le Drive garde les versions. `fichier` écrit donc une NOUVELLE VERSION
 * (l'ancienne reste), sous le journal des effets (K10) — « annuler » rétablit la version précédente. Plus besoin qu'un
 * humain accepte puis enregistre dans l'Atelier pour que la demande se termine (constat C4) ; l'Atelier reste l'écran
 * où la personne relit et retouche elle-même SI ELLE LE VEUT (`ouvrir_dans_l_atelier`).
 *
 *   • modifier — `remplacements` (avant → après, tout le document) et/ou `gestes` (ceux de l'Atelier : paragraphe, tableau,
 *     cellule Excel, diapositive, pages PDF…), appliqués EN PLACE par les adaptateurs de l'Atelier (styles conservés) ;
 *     sans droit d'écrire sur l'original (fichier partagé en lecture), la modification va dans une COPIE de l'espace d'Adam ;
 *   • convertir — `versFormat` (pdf, docx, xlsx) : la conversion de l'Atelier (worker, LibreOffice, rendu intégré),
 *     le résultat rangé dans l'espace d'Adam (« Copies ») ;
 *   • copier — une copie dans l'espace d'Adam (même contenu, aucun octet recopié), sous un autre nom si demandé.
 * Chaque appel rend l'OBSERVATION du fichier réellement écrit : un remplacement qui n'a rien trouvé SE VOIT (0 occurrence,
 * le texte cherché encore présent) — le modèle rappelle l'outil, juste (AU2 §3.3).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const OUTIL_FICHIER = "fichier";
const json = (o: unknown) => JSON.stringify(o);
const texte = (e: Record<string, unknown>, k: string) => (typeof e[k] === "string" ? (e[k] as string).trim() : "");
const VERS: Record<string, VersFormat> = { pdf: "PDF", docx: "DOCX", word: "DOCX", xlsx: "XLSX", excel: "XLSX" };

interface Remplacement { avant: string; apres: string }
const remplacementsDe = (v: unknown): Remplacement[] => (Array.isArray(v) ? v : [])
  .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
  .map((r) => ({ avant: String(r.avant ?? r.chercher ?? ""), apres: String(r.apres ?? r.remplacer ?? "") }))
  .filter((r) => r.avant.length > 0)
  .slice(0, 30);


/** MODIFIER des octets par des gestes de l'Atelier : rend les octets neufs et le compte rendu de chaque geste. */
async function appliquer(octets: Buffer, nom: string, mime: string | null, gestes: GesteAtelier[]): Promise<{ octets: Buffer; comptes: { geste: string; ok: boolean; fait: string[]; refus?: string }[] } | { erreur: string }> {
  const o = await ouvrirOffice(octets, nom, mime);
  if ("erreur" in o) return o;
  const comptes: { geste: string; ok: boolean; fait: string[]; refus?: string }[] = [];
  for (const g of gestes) {
    const t = traduireGeste(g, vueDe(o.doc));
    if (t.refus) { comptes.push({ geste: String(g.action), ok: false, fait: [], refus: t.refus }); continue; }
    const fait: string[] = [];
    const refus: string[] = [];
    for (const c of t.commandes) {
      const r = o.doc.appliquer(c);
      if (r.ok) fait.push(r.resume); else refus.push(r.motif ?? "refusé");
    }
    comptes.push({ geste: String(g.action), ok: fait.length > 0, fait, ...(refus.length ? { refus: refus.join(" ; ") } : {}) });
  }
  return { octets: await o.doc.serialiser(), comptes };
}

/** Le résultat d'une conversion, rangé dans l'espace d'Adam (« Copies » ou le dossier dit). */
async function rangerConversion(u: CurrentUser, nodeId: string, dossier: string): Promise<string> {
  const d = await dossierDeLEspace(u.id, dossier);
  await prisma.driveNode.update({ where: { id: nodeId }, data: { parentId: d.dossierId, spaceId: d.spaceId } });
  return d.chemin;
}

export async function executerFichier(u: CurrentUser, e: Record<string, unknown>): Promise<Record<string, unknown>> {
  const ref = texte(e, "fichier");
  const p = await resoudrePiece(u, ref);
  if ("erreur" in p) return { statut: "REFUS", raison: p.erreur };
  const fiche = await portsArtefact.documents.decrire(u.id, p.id);
  if (!fiche) return { statut: "REFUS", raison: "Ce fichier ne vous est pas accessible." };
  const remplacements = remplacementsDe(e.remplacements);
  const gestes = [
    ...remplacements.map((r): GesteAtelier => ({ action: "remplacer_texte", chercher: r.avant, remplacer: r.apres, tout: true })),
    ...(Array.isArray(e.gestes) ? (e.gestes as GesteAtelier[]).filter((g) => g && typeof g === "object").slice(0, 30) : []),
  ];
  const vers = VERS[texte(e, "versFormat").toLowerCase().replace(/^\./, "")] ?? null;
  const copier = e.copier === true || String(e.copier ?? "").toLowerCase() === "oui";
  if (!gestes.length && !vers && !copier) return { statut: "INCOMPLET", raison: "rien à faire : `remplacements` ou `gestes` (modifier), `versFormat` (convertir), `copier: true`." };
  const dossier = texte(e, "dossier") || "Copies";
  const etapes: Record<string, unknown>[] = [];
  let courant = { nodeId: p.id, nom: fiche.nom, mime: fiche.mime };

  const { resultat, gesteId } = await journaliserGeste(u, { origine: "carte", capaciteId: "outil:fichier", libelle: `Adam a travaillé sur « ${fiche.nom} »` }, async () => {
    // ── COPIER (avant toute modification : la copie porte les changements, l'original reste tel quel) ──
    if (copier) {
      const v = await derniereVersionLisible(u, p.id);
      if (!v) return { statut: "REFUS", raison: "Le fichier n'a pas pu être lu." };
      const nom = texte(e, "nom") ? `${texte(e, "nom").replace(/\.[a-z0-9]{2,5}$/i, "")}${/\.[a-z0-9]{2,5}$/i.exec(v.nom)?.[0] ?? ""}` : v.nom;
      const c = await deposerDansLEspace(u, { dossier, nom, mime: v.mime ?? "application/octet-stream", blob: v.blob });
      courant = { nodeId: c.nodeId, nom: c.nom, mime: v.mime };
      etapes.push({ etape: "copie", fichier: c.nom, rangeDans: c.chemin, lien: `/drive/${c.nodeId}` });
    }
    // ── MODIFIER : une nouvelle version (ou, sans droit d'écrire, une copie modifiée) ──
    if (gestes.length) {
      const f = await portsArtefact.documents.decrire(u.id, courant.nodeId);
      const octets = f ? await portsArtefact.documents.lire(u.id, courant.nodeId, f.version) : null;
      if (!f || !octets) return { statut: "REFUS", raison: "Le contenu du fichier n'a pas pu être lu." };
      const a = await appliquer(octets, f.nom, f.mime, gestes);
      if ("erreur" in a) return { statut: "REFUS", raison: a.erreur };
      if (!a.comptes.some((c) => c.ok)) {
        etapes.push({ etape: "modification", fait: false, gestes: a.comptes });
      } else {
        const mime = f.mime ?? (f.format ? mimeOffice(f.format) : "application/octet-stream");
        const resume = a.comptes.flatMap((c) => c.fait).join(" ; ").slice(0, 900) || "modifié par Adam";
        try {
          const v = await portsArtefact.documents.ecrireVersion(u.id, courant.nodeId, a.octets, { mime, resume });
          etapes.push({ etape: "modification", fait: true, nouvelleVersion: v.version, versionPrecedenteGardee: v.version - 1, gestes: a.comptes });
        } catch {
          // Lecture seule : la modification part dans une COPIE de l'espace d'Adam, l'original n'est pas touché.
          const c = await deposerDansLEspace(u, { dossier, nom: f.nom, mime, octets: a.octets });
          courant = { nodeId: c.nodeId, nom: c.nom, mime };
          etapes.push({ etape: "modification", fait: true, dansUneCopie: true, raison: "vous lisez ce fichier sans pouvoir l'écrire : l'original est intact", rangeDans: c.chemin, gestes: a.comptes });
        }
      }
    }
    // ── CONVERTIR la version courante ──
    if (vers) {
      const c = await demanderConversion(u, courant.nodeId, vers, null, { vision: fabriqueVisionOcr });
      if (!c.ok) return { statut: "ECHEC", raison: c.motif ?? "conversion impossible", etapes };
      if (c.resultat) {
        const chemin = await rangerConversion(u, c.resultat.nodeId, dossier);
        etapes.push({ etape: "conversion", vers, fichier: c.resultat.nom, rangeDans: chemin, voie: c.voie, lien: `/drive/${c.resultat.nodeId}`, ...(c.note ? { note: c.note } : {}) });
      } else {
        etapes.push({ etape: "conversion", vers, etat: c.etat, voie: c.voie, note: c.note });
      }
    }
    return { statut: "FAIT" };
  });
  if (resultat.statut !== "FAIT") return { ...resultat, etapes };

  // ── L'OBSERVATION : chaque fichier écrit, relu depuis le Drive ──
  const observations: Observation[] = [];
  let texteFinal = "";
  for (const et of etapes) {
    const id = typeof et.lien === "string" ? et.lien.replace("/drive/", "") : et.etape === "modification" && et.fait ? courant.nodeId : null;
    if (!id) continue;
    const f = await portsArtefact.documents.decrire(u.id, id);
    const octets = f ? await portsArtefact.documents.lire(u.id, id, f.version) : null;
    if (!f || !octets) continue;
    observations.push(await observerOctets({ type: "fichier", id, lien: `/drive/${id}` }, `VERSION_${f.version}`, octets, f.nom, f.mime));
    if (et.etape === "modification") texteFinal = await texteIntegral(octets, f.nom, f.mime);
  }
  // Un remplacement qui n'a rien trouvé, ou dont le texte cherché est ENCORE là : visible, pas tu (AU2 §3.3).
  const verifs = remplacements.map((r) => ({ avant: r.avant, apres: r.apres, encorePresent: occurrences(texteFinal, r.avant), nouveauPresent: occurrences(texteFinal, r.apres) }));
  return {
    statut: "FAIT", source: fiche.nom, etapes, ...(gesteId ? { annulable: "« Annuler » rétablit la version précédente et retire les fichiers créés." } : {}),
    ...(verifs.length ? { remplacementsVerifies: verifs } : {}),
    observations: observations.length ? observations : [observationDe({ type: "fichier", id: p.id, lien: `/drive/${p.id}` }, "INCHANGE", { raison: "rien n'a été écrit" })],
  };
}

export function outilFichier(user: CurrentUser): PowerTool {
  return {
    def: {
      name: OUTIL_FICHIER,
      description: "MODIFIE, CONVERTIT ou COPIE un fichier du Drive (Word, Excel, PowerPoint, PDF) — directement, sans passer par l'Atelier : "
        + "`remplacements` [{avant, apres}] et/ou `gestes` (ceux de l'Atelier) écrivent une NOUVELLE VERSION (la précédente reste : annulable) ; "
        + "`versFormat` (pdf, docx, xlsx) convertit la version courante, résultat rangé dans l'espace d'Adam (« Copies ») ; `copier: true` en fait d'abord "
        + "une copie dans l'espace d'Adam (l'original n'est pas touché ; `nom` pour la renommer). Tout se combine en UN appel (« convertis ce Word en PDF et "
        + "remplace la date »). Rend l'OBSERVATION du fichier écrit et, pour chaque remplacement, si le texte cherché est encore présent : vérifie-la.",
      input_schema: {
        type: "object",
        properties: {
          fichier: { type: "string", description: "Nom ou identifiant Drive du fichier." },
          remplacements: { type: "array", items: { type: "object", properties: { avant: { type: "string" }, apres: { type: "string" } }, required: ["avant", "apres"] } },
          gestes: { type: "array", items: SCHEMA_GESTE },
          versFormat: { type: "string", enum: ["pdf", "docx", "xlsx"] },
          copier: { type: "boolean" },
          nom: { type: "string", description: "Nom de la copie." },
          dossier: { type: "string", description: "Dossier de l'espace d'Adam (défaut « Copies »)." },
        },
        required: ["fichier"],
      },
    },
    allowed: (u) => u.id === user.id,
    label: "Fichier modifié",
    run: async (e, u) => json(await executerFichier(u, e ?? {})),
  };
}
