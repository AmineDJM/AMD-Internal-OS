import JSZip from "jszip";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ORDRE DE MISSION, GÉNÉRÉ PAR LA PLATEFORME (Direction, 06/10) — « comme ce document ci-joint, exact ».
 *
 * Le modèle (`modele-ordre-de-mission.docx`) EST le document fourni par la Direction : même en-tête, même logo, même
 * pied, mêmes styles et tabulations. Seuls ses champs variables y sont devenus des marqueurs `{{…}}` (date
 * d'émission, référence, collaborateur, fonction, objet, destination, dates, transport, signataire). Générer, c'est
 * remplacer ces marqueurs — rien d'autre ne bouge, donc le document sort à l'identique.
 *
 * Module pur (aucune lecture de fichier) : le serveur lui passe les octets du modèle ; les bancs aussi.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface ChampsOrdreMission {
  /** Date d'émission, `AAAA-MM-JJ`. */
  dateEmission: string;
  /** « 007/DPG/2026 ». */
  reference: string;
  entreprise: string;
  adresse: string;
  /** « Mme Radia KEBIR ». */
  collaborateur: string;
  fonction: string;
  /** Ce qui suit « ayant pour but » — « de récupérer une commande… ». */
  objet: string;
  /** Le(s) lieu(x) de mission ; une ligne par lieu. */
  destination: string;
  /** Dates `AAAA-MM-JJ` — plusieurs jours de départ possibles (« le 23/07/2026 et le 24/07/2026 »). */
  datesDepart: string[];
  datesRetour: string[];
  transport: string;
  signataire: string;
  signataireFonction: string;
}

export { VALEURS_DU_MODELE } from "../../domaine/ordre-mission/constantes";

const MARQUEURS = [
  "DATE_EMISSION", "REFERENCE", "ENTREPRISE", "ADRESSE", "COLLABORATEUR", "FONCTION", "OBJET", "DESTINATION",
  "DATES_DEPART", "DATES_RETOUR", "TRANSPORT", "SIGNATAIRE", "SIGNATAIRE_FONCTION",
] as const;

const echapper = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** `AAAA-MM-JJ` → `JJ/MM/AAAA` ; une valeur qui n'en est pas une est rendue telle quelle. */
export function dateFr(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso.trim();
}

/** « le 23/07/2026 et le 24/07/2026 » — comme sur le document de la Direction. */
export function phraseDesDates(dates: readonly string[]): string {
  const d = dates.map((x) => x.trim()).filter(Boolean).map((x) => `le ${dateFr(x)}`);
  if (d.length <= 1) return d[0] ?? "";
  return `${d.slice(0, -1).join(", ")} et ${d[d.length - 1]}`;
}

/** Ce qu'il manque pour générer — `null` si tout y est. */
export function refusOrdreMission(c: ChampsOrdreMission): string | null {
  const manque: string[] = [];
  if (!c.reference.trim()) manque.push("la référence");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(c.dateEmission)) manque.push("la date d'émission");
  if (!c.collaborateur.trim()) manque.push("le collaborateur");
  if (!c.objet.trim()) manque.push("l'objet de la mission");
  if (!c.destination.trim()) manque.push("le lieu de la mission");
  if (c.datesDepart.filter((d) => d.trim()).length === 0) manque.push("la date de départ");
  if (!c.transport.trim()) manque.push("le mode de transport");
  if (!c.signataire.trim()) manque.push("le signataire");
  return manque.length > 0 ? `Pour générer l'ordre de mission, indiquez ${manque.join(", ")}.` : null;
}

/** La valeur d'un marqueur, prête pour le XML : échappée, une ligne saisie = un saut de ligne dans le document. */
function valeurXml(v: string): string {
  return v.trim().split(/\r?\n/).map((l) => echapper(l.trim())).join('</w:t><w:br/><w:t xml:space="preserve">');
}

/** REMPLIT le modèle : rend le .docx de l'ordre de mission. */
export async function remplirOrdreDeMission(modele: Buffer, c: ChampsOrdreMission): Promise<Buffer> {
  const zip = await JSZip.loadAsync(modele);
  const fichier = zip.file("word/document.xml");
  if (!fichier) throw new Error("Modèle d'ordre de mission illisible.");
  let xml = await fichier.async("string");
  const objet = c.objet.trim().replace(/^(?:ayant pour but\s+)/i, "");
  const valeurs: Record<(typeof MARQUEURS)[number], string> = {
    DATE_EMISSION: dateFr(c.dateEmission),
    REFERENCE: c.reference,
    ENTREPRISE: c.entreprise,
    ADRESSE: c.adresse,
    COLLABORATEUR: c.collaborateur,
    FONCTION: c.fonction,
    // « … ayant pour but de récupérer… » : le « de » vient de la saisie s'il y est, sinon on le pose.
    OBJET: /^(de|d['’])\s?/i.test(objet) ? objet : `de ${objet}`,
    DESTINATION: c.destination,
    DATES_DEPART: phraseDesDates(c.datesDepart),
    DATES_RETOUR: phraseDesDates(c.datesRetour),
    TRANSPORT: c.transport,
    SIGNATAIRE: c.signataire,
    SIGNATAIRE_FONCTION: c.signataireFonction,
  };
  for (const m of MARQUEURS) xml = xml.split(`{{${m}}}`).join(valeurXml(valeurs[m]));
  if (/\{\{[A-Z_]+\}\}/.test(xml)) throw new Error("Un champ du modèle n'a pas été rempli.");
  zip.file("word/document.xml", xml);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

/** Le nom du fichier : « Ordre de mission 007-DPG-2026 — Radia KEBIR ». */
export function nomOrdreMission(reference: string, collaborateur: string): string {
  const ref = reference.replace(/[\\/:*?"<>|]+/g, "-").trim();
  const qui = collaborateur.replace(/^(M\.|Mme|Mlle)\s+/i, "").replace(/[\\/:*?"<>|]+/g, "").trim();
  return `Ordre de mission ${ref}${qui ? ` — ${qui}` : ""}`;
}
