import JSZip from "jszip";
import { valeursDuModele, type ChampsAttestation } from "./regles";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ATTESTATION DE TRAVAIL, GÉNÉRÉE PAR LA PLATEFORME (Direction, 10/2026) — comme l'ordre de mission.
 *
 * Le modèle (`modele-attestation-de-travail.docx`) est BÂTI sur l'attestation fournie par la Direction : même papier
 * à en-tête (en-tête, logo et pied identiques à ceux de l'ordre de mission), mêmes styles, même titre, même mise en
 * page. Ses champs variables sont devenus des marqueurs `{{…}}` — aucune donnée de la personne de l'exemple n'y reste
 * (le banc le vérifie). Générer, c'est remplacer ces marqueurs ; les valeurs (accords, dates à la française) sont
 * calculées par `regles.ts`.
 *
 * Module pur (aucune lecture de fichier) : le serveur lui passe les octets du modèle ; les bancs aussi.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export * from "./regles";

export const MARQUEURS_ATTESTATION = [
  "REFERENCE_LIGNE", "SOUSSIGNE", "SIGNATAIRE_CIVILITE", "SIGNATAIRE", "SIGNATAIRE_FONCTION", "CIVILITE", "SALARIE", "NAISSANCE",
  "EMPLOYE", "SOCIETE", "POSTE", "DATE_EMBAUCHE", "INTERESSE", "LIEU_SIGNATURE", "DATE_SIGNATURE", "SOCIETE_SIGNATURE",
] as const;

const echapper = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** La valeur d'un marqueur, prête pour le XML : échappée, espaces de bord GARDÉS (« Monsieur » + nom), sauts de ligne rendus. */
function valeurXml(v: string): string {
  return v.split(/\r?\n/).map(echapper).join('</w:t><w:br/><w:t xml:space="preserve">');
}

/** REMPLIT le modèle : rend le .docx de l'attestation. */
export async function remplirAttestationDeTravail(modele: Buffer, c: ChampsAttestation): Promise<Buffer> {
  const zip = await JSZip.loadAsync(modele);
  const fichier = zip.file("word/document.xml");
  if (!fichier) throw new Error("Modèle d'attestation de travail illisible.");
  let xml = await fichier.async("string");
  const valeurs = valeursDuModele(c);
  for (const m of MARQUEURS_ATTESTATION) xml = xml.split(`{{${m}}}`).join(valeurXml(valeurs[m] ?? ""));
  if (/\{\{[A-Z_]+\}\}/.test(xml)) throw new Error("Un champ du modèle d'attestation n'a pas été rempli.");
  zip.file("word/document.xml", xml);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
