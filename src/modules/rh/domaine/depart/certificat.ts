import {
  accords, dateCourteFr, dateLongueFr, estDateIso, phraseNaissance, type ChampsAttestation, type Civilite,
} from "../attestation-travail/regles";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CERTIFICAT DE TRAVAIL D'UN SALARIÉ QUI PART (lot rhdepart) — le pendant de l'attestation de travail.
 *
 * Même papier, mêmes champs (l'attestation fournit les dates à la française et les accords), plus la DATE DE FIN, et un
 * TEXTE que les RH peuvent réécrire entièrement avant l'émission : « toujours tout modifiable ». Le texte proposé se
 * recompose depuis les champs ; une fois modifié à la main, il reste ce que les RH ont écrit.
 *
 * PUR : n'importe que les règles pures de l'attestation. Le formulaire (navigateur) et le serveur lisent la même règle.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface ChampsCertificat extends ChampsAttestation {
  /** Le dernier jour travaillé, `AAAA-MM-JJ`. */
  dateFin: string;
  /** Le corps du certificat — un paragraphe par ligne. */
  corps: string;
}

/** Le texte proposé, recomposé depuis les champs. */
export function corpsCertificatParDefaut(c: Omit<ChampsCertificat, "corps">): string {
  const a = accords(c.civilite);
  const s = accords(c.signataireCivilite);
  const il = c.civilite === "Madame" ? "Elle" : "Il";
  const signataire = [c.signataireCivilite, c.signataire.trim()].filter(Boolean).join(" ");
  const salarie = [c.civilite, c.salarie.trim()].filter(Boolean).join(" ");
  return [
    `Je ${s.soussigne}, ${signataire}, agissant en qualité de ${c.signataireFonction.trim()}, certifie que ${salarie}${phraseNaissance(c)}, a été ${a.employe} au sein de ${c.societe.trim()} en qualité de ${c.poste.trim()} du ${dateCourteFr(c.dateEmbauche)} au ${dateCourteFr(c.dateFin)}.`,
    `${il} quitte la société libre de tout engagement.`,
    `Le présent certificat est délivré à ${a.interesse} pour servir et valoir ce que de droit.`,
  ].join("\n");
}

/** Ce qu'il manque pour émettre — `null` si tout y est. */
export function refusCertificat(c: ChampsCertificat): string | null {
  const manque: string[] = [];
  if (!c.salarie.trim()) manque.push("le nom du salarié");
  if (!c.societe.trim() && !c.societeSignature.trim()) manque.push("la société");
  if (!estDateIso(c.dateFin)) manque.push("la date de fin");
  if (!c.signataire.trim()) manque.push("le signataire");
  if (!c.lieuSignature.trim()) manque.push("le lieu (« Fait à »)");
  if (!estDateIso(c.dateSignature)) manque.push("la date (« Fait à … le »)");
  if (!c.corps.trim()) manque.push("le texte du certificat");
  return manque.length > 0 ? `Pour émettre le certificat, indiquez ${manque.join(", ")}.` : null;
}

/** Les valeurs des marqueurs restants du papier (référence, signature) — le corps est posé à part. */
export function valeursCertificat(c: ChampsCertificat): Record<string, string> {
  return {
    REFERENCE_LIGNE: c.reference.trim() ? `Réf. : ${c.reference.trim()}` : "",
    SIGNATAIRE: c.signataire.trim(),
    SIGNATAIRE_FONCTION: c.signataireFonction.trim(),
    LIEU_SIGNATURE: c.lieuSignature.trim(),
    DATE_SIGNATURE: dateLongueFr(c.dateSignature),
    SOCIETE_SIGNATURE: c.societeSignature.trim() || c.societe.trim(),
  };
}

export function nomCertificat(reference: string, salarie: string, version = 1): string {
  const ref = reference.replace(/[\\/:*?"<>|]+/g, "-").trim();
  const qui = salarie.replace(/[\\/:*?"<>|]+/g, "").trim();
  return `Certificat de travail${ref ? ` ${ref}` : ""}${qui ? ` — ${qui}` : ""}${version > 1 ? ` (v${version})` : ""}`;
}

/** Relit des champs envoyés par l'écran : chaque champ est une chaîne bornée ; la civilité est connue ou vide. */
export function lireCertificatSaisi(brut: unknown): ChampsCertificat | null {
  if (!brut || typeof brut !== "object" || Array.isArray(brut)) return null;
  const o = brut as Record<string, unknown>;
  const t = (k: string, max = 300) => (typeof o[k] === "string" ? (o[k] as string).slice(0, max) : "");
  const civ = (k: string): Civilite | "" => (o[k] === "Monsieur" || o[k] === "Madame" ? (o[k] as Civilite) : "");
  return {
    reference: t("reference", 60), civilite: civ("civilite"), salarie: t("salarie"), dateNaissance: t("dateNaissance", 10),
    lieuNaissance: t("lieuNaissance"), societe: t("societe"), societeSignature: t("societeSignature"), poste: t("poste"),
    dateEmbauche: t("dateEmbauche", 10), signataireCivilite: civ("signataireCivilite"), signataire: t("signataire"),
    signataireFonction: t("signataireFonction"), lieuSignature: t("lieuSignature"), dateSignature: t("dateSignature", 10),
    dateFin: t("dateFin", 10), corps: t("corps", 6000),
  };
}
