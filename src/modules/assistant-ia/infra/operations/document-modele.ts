import { putBlob } from "@/lib/drive-storage";
import { enregistrerFichierDrive } from "@/lib/drive/depot";
import { composerDocx, MIME_DOCX, paragraphe, tableau, vide, type Fragment } from "@/lib/artifact/factory/word";
import { profilDocumentaire } from "@/platform/ia/artifact/factory";
import type { CurrentUser } from "@/lib/session";
import { champs, texte, type OperationIA, type PropositionOperation } from "../../domaine/operations/types";
import { replier } from "./annuaire-medical";
import { analyserMarkdown, type MdBlock, type MdInline } from "../../domaine/ui/markdown";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UN DOCUMENT DEPUIS UN MODÈLE — lettre, note, compte rendu — sur le PAPIER EN-TÊTE de la bonne
 * société, déposé dans le Drive de la personne.
 *
 * La SOCIÉTÉ se résout parmi celles qui sont OUVERTES à la personne (`profilDocumentaire` :
 * par défaut la sienne ; plusieurs possibles → l'agent demande laquelle), avec son papier en-tête
 * Word, sa charte et son signataire. Le TEXTE est celui que la personne a dicté ou fait rédiger ;
 * l'opération le met en forme (paragraphes, intertitres « ## », puces « - »).
 *
 * Écrire un fichier dans son Drive reste une écriture : carte, puis confirmation.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

type Modele = "LETTRE" | "NOTE" | "COMPTE_RENDU";
const MODELES: Record<string, Modele> = { lettre: "LETTRE", courrier: "LETTRE", note: "NOTE", "note de service": "NOTE", "compte rendu": "COMPTE_RENDU", "compte-rendu": "COMPTE_RENDU", cr: "COMPTE_RENDU", pv: "COMPTE_RENDU" };
const LIBELLE: Record<Modele, string> = { LETTRE: "Lettre", NOTE: "Note", COMPTE_RENDU: "Compte rendu" };

const dateLongue = (d: Date) => d.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric", timeZone: "Africa/Algiers" });

/** Le corps dicté → des paragraphes Word : « ## » intertitre, « - » puce, ligne vide = nouveau paragraphe. */
export function corpsEnBlocs(corps: string): string[] {
  const blocs: string[] = [];
  for (const bloc of corps.replace(/\r/g, "").split(/\n{2,}/)) {
    const lignes = bloc.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim());
    if (!lignes.length) continue;
    if (/^#{1,3}\s/.test(lignes[0]!)) {
      blocs.push(paragraphe(lignes[0]!.replace(/^#{1,3}\s+/, ""), { style: "Titre2", garderAvecSuivant: true }));
      lignes.shift();
    }
    const puces = lignes.filter((l) => /^\s*[-•*]\s+/.test(l));
    if (puces.length === lignes.length && lignes.length) {
      for (const l of lignes) blocs.push(paragraphe(`•  ${l.replace(/^\s*[-•*]\s+/, "")}`, { apresPt: 2 }));
      continue;
    }
    if (lignes.length) blocs.push(paragraphe(lignes.join("\n"), { alignement: "both", apresPt: 8 }));
  }
  return blocs;
}

export const DOCUMENT_MODELE: OperationIA = {
  nom: "preparer_document",
  module: "DRIVE",
  libelle: "Document préparé",
  description:
    "PRÉPARE un document Word depuis un modèle — LETTRE, NOTE ou COMPTE RENDU — sur le papier en-tête de la société (par défaut celle de l'utilisateur), "
    + "déposé dans son Drive à la confirmation. Toi, tu rédiges `contenu` à partir de ce qu'il a dit (paragraphes séparés par une ligne vide, « ## » pour "
    + "un intertitre, « - » pour une puce) — sans inventer de fait. Elle répond `manque` — pose alors UNE seule question.",
  schema: {
    type: "object",
    properties: {
      modele: { type: "string", enum: ["lettre", "note", "compte rendu"] },
      objet: { type: "string" },
      destinataire: { type: "string", description: "Lettre : le destinataire (nom, fonction, adresse sur plusieurs lignes). Note : à qui elle s'adresse." },
      participants: { type: "string", description: "Compte rendu : les participants." },
      contenu: { type: "string", description: "Le corps du document, rédigé." },
      societe: { type: "string", description: "La société émettrice, si l'utilisateur la précise." },
      lieu: { type: "string", description: "Ville de la date (« Alger » par défaut)." },
    },
  },
  ouverte: (u) => Boolean(u.id),

  async proposer(e, user: CurrentUser): Promise<PropositionOperation> {
    const modele = MODELES[replier(texte(e, "modele"))] ?? null;
    const manque = [
      !modele ? "le type de document : lettre, note ou compte rendu" : null,
      !texte(e, "objet") ? "l'objet du document" : null,
      modele === "LETTRE" && !texte(e, "destinataire") ? "le destinataire de la lettre" : null,
      !texte(e, "contenu") ? "ce que le document doit dire" : null,
    ].filter((x): x is string => x !== null);
    if (manque.length) return { manque };
    const p = await profilDocumentaire(user, texte(e, "societe") || null);
    if (!p.ok) return p.candidats?.length ? { manque: [`au nom de quelle société : ${p.candidats.map((c) => c.nom).join(", ")}`] } : { erreur: p.motif };
    const nom = `${LIBELLE[modele!]} — ${texte(e, "objet")}`.replace(/[\\/:*?"<>|]/g, "-").slice(0, 120);
    return {
      carte: {
        title: `${LIBELLE[modele!]} — ${texte(e, "objet")}`,
        fields: champs([
          ["Société", p.profil.societe.nom],
          ["Papier en-tête", p.profil.papierEnTete?.nom ?? "aucun enregistré — mise en forme de la charte et logo"],
          ["Destinataire", texte(e, "destinataire") || null],
          ["Participants", texte(e, "participants") || null],
          ["Début du texte", texte(e, "contenu").slice(0, 220) + (texte(e, "contenu").length > 220 ? "…" : "")],
          ["Fichier", `${nom}.docx (dans votre Drive)`],
        ]),
        warnings: p.profil.papierEnTete ? [] : [`${p.profil.societe.nom} n'a pas de papier en-tête Word actif : le document suit sa charte, avec son logo s'il est enregistré.`],
        libelleBouton: "Créer le document",
      },
      args: {
        modele, objet: texte(e, "objet"), destinataire: texte(e, "destinataire") || null, participants: texte(e, "participants") || null,
        contenu: texte(e, "contenu"), societe: p.profil.societe.id, lieu: texte(e, "lieu") || "Alger", nom,
      },
    };
  },

  async executer(a, user) {
    const p = await profilDocumentaire(user, a.societe);
    if (!p.ok) return { ok: false, error: p.motif };
    const maintenant = new Date();
    const signataire = p.profil.reglages.signatoryName ? `${p.profil.reglages.signatoryName}${p.profil.reglages.signatoryTitle ? `\n${p.profil.reglages.signatoryTitle}` : ""}` : user.name;
    const blocs: string[] = [];
    if (a.modele === "LETTRE") {
      blocs.push(paragraphe(`${a.lieu}, le ${dateLongue(maintenant)}`, { alignement: "right", apresPt: 18 }));
      if (a.destinataire) blocs.push(paragraphe(a.destinataire, { alignement: "right", apresPt: 18 }));
      blocs.push(paragraphe([{ texte: "Objet : ", gras: true }, { texte: a.objet ?? "" }], { apresPt: 14 }));
      blocs.push(...corpsEnBlocs(a.contenu ?? ""));
      blocs.push(vide(18), paragraphe(signataire, { alignement: "right", gras: true }));
    } else if (a.modele === "NOTE") {
      blocs.push(paragraphe("NOTE", { style: "Titre", alignement: "center" }));
      blocs.push(paragraphe([{ texte: "Objet : ", gras: true }, { texte: a.objet ?? "" }], { apresPt: 2 }));
      if (a.destinataire) blocs.push(paragraphe([{ texte: "À : ", gras: true }, { texte: a.destinataire }], { apresPt: 2 }));
      blocs.push(paragraphe([{ texte: "De : ", gras: true }, { texte: user.name }], { apresPt: 2 }));
      blocs.push(paragraphe([{ texte: "Date : ", gras: true }, { texte: dateLongue(maintenant) }], { apresPt: 14 }));
      blocs.push(...corpsEnBlocs(a.contenu ?? ""));
    } else {
      blocs.push(paragraphe(`Compte rendu — ${a.objet}`, { style: "Titre" }));
      blocs.push(paragraphe([{ texte: "Date : ", gras: true }, { texte: dateLongue(maintenant) }], { apresPt: 2 }));
      if (a.participants) blocs.push(paragraphe([{ texte: "Participants : ", gras: true }, { texte: a.participants }], { apresPt: 14 }));
      blocs.push(...corpsEnBlocs(a.contenu ?? ""));
      blocs.push(vide(12), paragraphe(`Rédigé par ${user.name}`, { italique: true, alignement: "right" }));
    }
    const doc = composerDocx({
      blocs, base: p.habillage.base, titre: `${a.objet}`, auteur: user.name, police: p.habillage.police ?? undefined,
      logo: p.habillage.base ? null : p.habillage.logo, maintenant,
    });
    const { blobId, size } = await putBlob(doc.octets);
    const r = await enregistrerFichierDrive(user, { nodeId: null, parentId: null, spaceId: null, category: null, viewers: [], editors: [] }, { blobId, size, mimeType: MIME_DOCX, name: `${a.nom}.docx` });
    return { ok: true, message: `Document créé dans votre Drive${doc.surPapierEnTete ? ", sur le papier en-tête" : ""}.`, link: `/drive/${r.id}` };
  },
};

// ─────────────────────────── J8 (décision 0023) : le livrable d'un travail en Word ───────────────────────────

const enLigne = (xs: MdInline[], h: { gras?: boolean; italique?: boolean } = {}): Fragment[] => xs.flatMap((x): Fragment[] => {
  switch (x.t) {
    case "texte": return [{ texte: x.v, ...(h.gras ? { gras: true } : {}), ...(h.italique ? { italique: true } : {}) }];
    case "code": return [{ texte: x.v }];
    case "saut": return [{ texte: "\n" }];
    case "gras": return enLigne(x.c, { ...h, gras: true });
    case "italique": return enLigne(x.c, { ...h, italique: true });
    case "barre": return enLigne(x.c, h);
    case "lien": return enLigne(x.c, h);
  }
});
/** Le texte d'une ligne Markdown, sans sa mise en forme. */
export const texteEnLigne = (xs: MdInline[]): string => enLigne(xs).map((f) => f.texte).join("");
const brut = texteEnLigne;

/** Le Markdown du modèle → les blocs Word de la fabrique (J8 : les livrables des travaux). */
export function blocsWord(md: string): string[] {
  const out: string[] = [];
  const poser = (blocs: MdBlock[], retrait = "") => {
    for (const b of blocs) {
      switch (b.t) {
        case "titre": out.push(paragraphe(enLigne(b.c), { style: b.niveau === 1 ? "Titre1" : "Titre2", garderAvecSuivant: true })); break;
        case "paragraphe": out.push(paragraphe(enLigne(b.c), { alignement: "both", apresPt: 6 })); break;
        case "liste":
          b.items.forEach((item, k) => {
            const [tete, ...reste] = item;
            const puce = b.ordonnee ? `${b.debut + k}.` : "•";
            out.push(paragraphe([{ texte: `${retrait}${puce}  ` }, ...(tete && (tete.t === "paragraphe" || tete.t === "titre") ? enLigne(tete.c) : [])], { apresPt: 2 }));
            poser(tete && tete.t !== "paragraphe" && tete.t !== "titre" ? item : reste, `${retrait}    `);
          });
          break;
        case "tableau": {
          const n = Math.max(1, b.entete.length);
          const largeur = Math.max(1.5, 16 / n);
          out.push(tableau([b.entete.map(brut), ...b.lignes.map((l) => Array.from({ length: n }, (_, j) => brut(l[j] ?? [])))], {
            colonnes: Array.from({ length: n }, () => ({ largeurCm: largeur })), entete: true,
          }));
          out.push(paragraphe("", { apresPt: 4 }));
          break;
        }
        case "code": out.push(paragraphe(b.v, { apresPt: 6 })); break;
        case "citation": poser(b.c, retrait); break;
        case "separateur": out.push(paragraphe("", { apresPt: 6 })); break;
      }
    }
  };
  poser(analyserMarkdown(md));
  return out;
}

/** UNE NOTE WORD DEPUIS LE MARKDOWN D'UN TRAVAIL — titre, intertitres, gras, puces, tableaux ; paquet neuf. */
export function composerNoteMarkdown(titre: string, md: string, auteur?: string): { octets: Buffer; mime: string } {
  return { octets: composerDocx({ blocs: [paragraphe(titre, { style: "Titre" }), ...blocsWord(md)], titre, auteur, maintenant: new Date() }).octets, mime: MIME_DOCX };
}
