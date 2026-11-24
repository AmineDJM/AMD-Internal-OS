import JSZip from "jszip";
import { valeursCertificat, type ChampsCertificat } from "../../domaine/depart/certificat";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CERTIFICAT DE TRAVAIL SUR LE PAPIER DE LA SOCIÉTÉ (lot rhdepart).
 *
 * Pas de second modèle Word à tenir : le certificat se fabrique DEPUIS le modèle de l'attestation de travail (même
 * en-tête, même logo, même pied, mêmes styles — `attestation-travail/modele-attestation-de-travail.docx`). Le titre
 * devient « Certificat de travail », les trois paragraphes du corps de l'attestation sont remplacés par le TEXTE que
 * les RH ont relu (un paragraphe par ligne, dans le style du corps), et les marqueurs de signature se remplissent comme
 * pour l'attestation. Un modèle d'attestation retouché par la Direction profite donc aussi au certificat.
 *
 * Module pur (aucune lecture de fichier) : le serveur lui passe les octets du modèle ; les bancs aussi.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const echapper = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const PARAGRAPHE = /<w:p[ >][\s\S]*?<\/w:p>/g;
/** Les marqueurs qui signent un paragraphe du CORPS de l'attestation (remplacé par le texte du certificat). */
const MARQUEURS_DU_CORPS = ["{{SOUSSIGNE}}", "{{SALARIE}}", "{{INTERESSE}}"];

/** REMPLIT le papier : rend le .docx du certificat. */
export async function remplirCertificatDeTravail(modele: Buffer, c: ChampsCertificat): Promise<Buffer> {
  const zip = await JSZip.loadAsync(modele);
  const fichier = zip.file("word/document.xml");
  if (!fichier) throw new Error("Modèle de certificat de travail illisible.");
  let xml = await fichier.async("string");

  // Le titre.
  if (!xml.includes(">Attestation de travail<")) throw new Error("Le titre du modèle est introuvable.");
  xml = xml.replace(">Attestation de travail<", ">Certificat de travail<");

  // Le corps : le premier paragraphe du corps donne le style ; les trois cèdent la place au texte relu.
  const corpsAttestation = (xml.match(PARAGRAPHE) ?? []).filter((p) => MARQUEURS_DU_CORPS.some((m) => p.includes(m)));
  if (corpsAttestation.length === 0) throw new Error("Le corps du modèle est introuvable.");
  const style = corpsAttestation[corpsAttestation.length - 1];
  const pPr = /<w:pPr>[\s\S]*?<\/w:pPr>/.exec(style)?.[0] ?? "";
  const rPr = /<w:r(?: [^>]*)?>\s*(<w:rPr>[\s\S]*?<\/w:rPr>)/.exec(style)?.[1] ?? "";
  const lignes = c.corps.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const nouveau = lignes
    .map((l) => `<w:p>${pPr}<w:r>${rPr}<w:t xml:space="preserve">${echapper(l)}</w:t></w:r></w:p>`)
    .join(`<w:p>${pPr}</w:p>`);
  xml = xml.replace(corpsAttestation[0], nouveau);
  for (const p of corpsAttestation.slice(1)) xml = xml.replace(p, "");

  const valeurs = valeursCertificat(c);
  for (const [m, v] of Object.entries(valeurs)) xml = xml.split(`{{${m}}}`).join(echapper(v));
  if (/\{\{[A-Z_]+\}\}/.test(xml)) throw new Error("Un champ du modèle de certificat n'a pas été rempli.");
  zip.file("word/document.xml", xml);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
