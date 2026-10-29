import { putBlob } from "@/lib/drive-storage";
import { enregistrerFichierDrive } from "@/lib/drive/depot";
import type { PowerTool } from "@/platform/ia/outil";
import type { CurrentUser } from "@/lib/session";
import { censurerTexte } from "@/lib/agent/filtre-confidentialite";
import { champs, texte, type OperationIA, type PropositionOperation } from "./types";
import { fichiersDepuisDrive, resoudrePiece, type PieceResolue } from "./pieces";
import { replier } from "./annuaire-medical";
import { sansBloquer } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * REMPLIR UN FORMULAIRE PDF — ses champs interactifs (AcroForm), lus puis remplis par mupdf.
 *
 * `lire_formulaire_pdf` dit au modèle les champs (nom, libellé, type, choix possibles) ; la valeur
 * déjà saisie d'un champ SENSIBLE n'est pas rendue. `preparer_formulaire_pdf` montre sur la carte ce
 * qui sera écrit, puis dépose une COPIE remplie dans le Drive : l'original n'est pas modifié.
 *
 * UN CHAMP SENSIBLE (numéro de passeport ou d'identité, RIB, IBAN, compte, salaire) n'est JAMAIS
 * rempli par l'assistant — une valeur que le modèle proposerait viendrait du modèle, et le modèle
 * ne doit pas en connaître. Il reste vide, et la carte dit à la personne de le compléter elle-même.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const RE_CHAMP_SENSIBLE = /passe?port|passport|identit|\bcni\b|\bnin\b|\brib\b|iban|\bccp\b|bic|swift|compte|account|salaire|salary|r[ée]mun[ée]ration|s[ée]curit[ée] sociale/i;

export interface ChampFormulaire {
  nom: string;
  libelle: string | null;
  type: "texte" | "case" | "radio" | "liste" | "signature" | "autre";
  choix: string[];
  valeur: string | null;
  sensible: boolean;
  lectureSeule: boolean;
}

type MuPdf = typeof import("mupdf");
type Widget = InstanceType<MuPdf["PDFWidget"]>;

async function ouvrir(octets: Buffer) {
  const mupdf = await import("mupdf");
  const doc = new mupdf.PDFDocument(new Uint8Array(octets));
  const widgets: Widget[] = [];
  for (let i = 0; i < doc.countPages(); i++) widgets.push(...doc.loadPage(i).getWidgets());
  return { doc, widgets };
}

function typeDe(w: Widget): ChampFormulaire["type"] {
  if (w.isText()) return "texte";
  if (w.isCheckbox()) return "case";
  if (w.isRadioButton()) return "radio";
  if (w.isChoice()) return "liste";
  return w.getFieldType() === "signature" ? "signature" : "autre";
}

export async function champsDuFormulaire(octets: Buffer): Promise<ChampFormulaire[]> {
  const { doc, widgets } = await ouvrir(octets);
  const vus = new Map<string, ChampFormulaire>();
  for (const w of widgets) {
    const nom = w.getName();
    if (!nom || vus.has(nom)) continue;
    const libelle = w.getLabel() || null;
    const sensible = RE_CHAMP_SENSIBLE.test(`${nom} ${libelle ?? ""}`);
    const type = typeDe(w);
    vus.set(nom, {
      nom, libelle, type,
      choix: type === "liste" ? w.getOptions() : [],
      valeur: sensible ? null : (w.getValue() || null),
      sensible, lectureSeule: w.isReadOnly(),
    });
  }
  (doc as unknown as { destroy?: () => void }).destroy?.();
  return [...vus.values()];
}

const OUI = /^(oui|yes|vrai|true|x|1|coch[ée]e?)$/i;

/** Remplit une copie : texte, liste, case (oui / non). Rend la copie et ce qui n'a pas pu être écrit. */
export async function remplirFormulaire(octets: Buffer, valeurs: Record<string, string>): Promise<{ octets: Buffer; nonEcrits: string[] }> {
  const { doc, widgets } = await ouvrir(octets);
  const nonEcrits: string[] = [];
  const faits = new Set<string>();
  for (const w of widgets) {
    const nom = w.getName();
    if (!(nom in valeurs) || faits.has(nom)) continue;
    const v = valeurs[nom]!;
    try {
      if (w.isText()) w.setTextValue(v);
      else if (w.isChoice()) w.setChoiceValue(v);
      else if (w.isCheckbox()) { if (OUI.test(v) !== (w.getValue() !== "Off" && w.getValue() !== "")) w.toggle(); }
      else { nonEcrits.push(nom); continue; }
      w.update();
      faits.add(nom);
    } catch {
      nonEcrits.push(nom);
    }
  }
  const buf = doc.saveToBuffer("garbage");
  const out = Buffer.from(buf.asUint8Array());
  (doc as unknown as { destroy?: () => void }).destroy?.();
  for (const n of Object.keys(valeurs)) if (!faits.has(n) && !nonEcrits.includes(n)) nonEcrits.push(n);
  return { octets: out, nonEcrits };
}

async function lePdf(user: CurrentUser, ref: string): Promise<{ piece: PieceResolue; octets: Buffer } | { erreur: string }> {
  const piece = await resoudrePiece(user, ref);
  if ("erreur" in piece) return piece;
  if (!/\.pdf$/i.test(piece.nom)) return { erreur: "Ce n'est pas un PDF." };
  const f = await fichiersDepuisDrive(user, [piece.id]);
  if (!Array.isArray(f) || !f[0]) return { erreur: "Fichier introuvable." };
  return { piece, octets: Buffer.from(await f[0].arrayBuffer()) };
}

export function lectureFormulaire(user: CurrentUser): PowerTool {
  return {
    def: {
      name: "lire_formulaire_pdf",
      description: "LIT les champs d'un FORMULAIRE PDF (nom, libellé, type, choix possibles, valeur actuelle) avant de le remplir avec preparer_formulaire_pdf. "
        + "Les champs marqués `sensible` (identité, banque, salaire) ne se remplissent pas par toi.",
      input_schema: { type: "object", properties: { fichier: { type: "string", description: "Nom ou identifiant du PDF." } } },
    } as PowerTool["def"],
    allowed: (u) => u.id === user.id,
    label: "Formulaire PDF lu",
    run: async (e) => {
      const p = await lePdf(user, typeof e.fichier === "string" ? e.fichier : "");
      if ("erreur" in p) return JSON.stringify({ statut: "REFUS", raison: p.erreur });
      const c = await champsDuFormulaire(p.octets).catch(sansBloquer("formulaire-pdf.run.champsDuFormulaire", null));
      if (!c) return JSON.stringify({ statut: "REFUS", raison: "Ce PDF n'a pas pu être ouvert." });
      if (!c.length) return JSON.stringify({ statut: "REFUS", raison: "Ce PDF n'a pas de champs à remplir (formulaire non interactif)." });
      return censurerTexte(JSON.stringify({ fichier: p.piece.nom, champs: c.map(({ valeur, ...x }) => ({ ...x, valeur: valeur ?? undefined })) })).texte;
    },
  };
}

export const FORMULAIRE_PDF: OperationIA = {
  nom: "preparer_formulaire_pdf",
  module: "DRIVE",
  libelle: "Formulaire PDF préparé",
  description:
    "REMPLIT un FORMULAIRE PDF (lis-le d'abord avec lire_formulaire_pdf) : `valeurs` associe le NOM de chaque champ à sa valeur, tirée de ce que l'utilisateur "
    + "a dit ou de ce que tu as lu dans l'ERP. Une copie remplie est déposée dans son Drive à la confirmation. Ne remplis jamais un champ `sensible`.",
  schema: {
    type: "object",
    properties: {
      fichier: { type: "string" },
      valeurs: { type: "object", description: "{ \"nom du champ\": \"valeur\" } — pour une case : « oui » ou « non ».", additionalProperties: { type: "string" } },
    },
  },
  ouverte: (u) => Boolean(u.id),

  async proposer(e, user): Promise<PropositionOperation> {
    if (!texte(e, "fichier")) return { manque: ["le formulaire PDF à remplir"] };
    const p = await lePdf(user, texte(e, "fichier"));
    if ("erreur" in p) return { erreur: p.erreur };
    const c = await champsDuFormulaire(p.octets).catch(sansBloquer("formulaire-pdf.proposer.champsDuFormulaire", null));
    if (!c?.length) return { erreur: "Ce PDF n'a pas de champs à remplir (formulaire non interactif)." };
    const brutes = e.valeurs && typeof e.valeurs === "object" ? (e.valeurs as Record<string, unknown>) : {};
    const parNom = new Map(c.map((x) => [replier(x.nom), x]));
    const valeurs: Record<string, string> = {};
    const inconnus: string[] = [];
    const ecartes: string[] = [];
    for (const [cle, v] of Object.entries(brutes)) {
      if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") continue;
      const ch = parNom.get(replier(cle)) ?? c.find((x) => x.libelle && replier(x.libelle) === replier(cle));
      if (!ch) { inconnus.push(cle); continue; }
      if (ch.sensible || ch.lectureSeule) { ecartes.push(ch.libelle ?? ch.nom); continue; }
      if (ch.type === "liste" && ch.choix.length && !ch.choix.includes(String(v))) return { manque: [`la valeur du champ « ${ch.libelle ?? ch.nom} » parmi : ${ch.choix.join(", ")}`] };
      valeurs[ch.nom] = String(v);
    }
    if (!Object.keys(valeurs).length) return { manque: ["les valeurs à saisir (lis d'abord les champs avec lire_formulaire_pdf)"] };
    const sensiblesVides = c.filter((x) => x.sensible && !x.lectureSeule).map((x) => x.libelle ?? x.nom);
    const vides = c.filter((x) => !x.sensible && !x.lectureSeule && !(x.nom in valeurs) && !x.valeur && x.type !== "signature").map((x) => x.libelle ?? x.nom);
    const sortie = `${p.piece.nom.replace(/\.pdf$/i, "")} (rempli).pdf`;
    const warnings = [
      ...(sensiblesVides.length ? [`À compléter par vous dans le PDF (identité, banque ou rémunération — jamais par l'assistant) : ${sensiblesVides.join(", ")}.`] : []),
      ...(ecartes.length ? [`Non rempli${ecartes.length > 1 ? "s" : ""} (champ sensible ou en lecture seule) : ${ecartes.join(", ")}.`] : []),
      ...(inconnus.length ? [`Champ${inconnus.length > 1 ? "s" : ""} introuvable${inconnus.length > 1 ? "s" : ""} dans ce formulaire, ignoré${inconnus.length > 1 ? "s" : ""} : ${inconnus.join(", ")}.`] : []),
      ...(vides.length ? [`Restent vides : ${vides.slice(0, 12).join(", ")}${vides.length > 12 ? "…" : ""}.`] : []),
    ];
    return {
      carte: {
        title: `Remplir « ${p.piece.nom} »`,
        fields: champs([
          ...Object.entries(valeurs).map(([n, v]) => [c.find((x) => x.nom === n)?.libelle ?? n, v] as [string, string]),
          ["Fichier produit", `${sortie} (dans votre Drive — l'original n'est pas modifié)`],
        ]),
        warnings,
        libelleBouton: "Remplir le formulaire",
      },
      args: { fichier: p.piece.id, valeurs: JSON.stringify(valeurs), sortie },
    };
  },

  async executer(a, user) {
    const p = await lePdf(user, a.fichier ?? "");
    if ("erreur" in p) return { ok: false, error: p.erreur };
    let valeurs: Record<string, string>;
    try { valeurs = JSON.parse(a.valeurs ?? "{}"); } catch { return { ok: false, error: "Valeurs illisibles." }; }
    const r = await remplirFormulaire(p.octets, valeurs);
    const { blobId, size } = await putBlob(r.octets);
    const n = await enregistrerFichierDrive(user, { nodeId: null, parentId: null, spaceId: null, category: null, viewers: [], editors: [] }, { blobId, size, mimeType: "application/pdf", name: a.sortie ?? "Formulaire rempli.pdf" });
    return {
      ok: true, link: `/drive/${n.id}`,
      message: `Formulaire rempli déposé dans votre Drive : ${a.sortie}.${r.nonEcrits.length ? ` Non écrit : ${r.nonEcrits.join(", ")}.` : ""}`,
    };
  },
};
