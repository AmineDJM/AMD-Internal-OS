/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'EXTRACTEUR « CV » — coordonnées, état civil, diplômes, expériences, langues, PAR RÈGLES (FR/EN).
 *
 * Aucun modèle : le texte est découpé en rubriques par leurs titres (« Formation », « Expérience
 * professionnelle », « Languages »…) puis chaque rubrique est lue par motifs. Ce qui n'a pas la forme
 * attendue n'est pas proposé — on ne devine pas un diplôme dans un paragraphe — et le manque est noté.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import type { FaitExtrait, ResultatExtraction } from "../types";
import {
  aFormeDeNom, champEtiquete, decouperNom, dedoublonner, fait, MOTIF_DATE, MOTIF_EMAIL, MOTIF_FONCTION,
  normaliserDate, normaliserEmail, normaliserTexte, pageDe, paysIso3, separerCivilite, trouverTelephones,
  type EntreeExtraction, type FaitBrut,
} from "./commun-personnes";

export const MOTEUR_CV = "regles-cv/1";

type Rubrique = "entete" | "formation" | "experience" | "langues" | "autre";

const TITRES: [Rubrique, RegExp][] = [
  ["formation", /^(formations?( academiques?| et diplomes)?|diplomes?( et formations?)?|cursus( universitaire| academique)?|parcours (academique|universitaire)|etudes( et diplomes)?|education|academic (background|qualifications)|qualifications|degrees)$/],
  ["experience", /^(experiences?( professionnelles?)?|parcours professionnel|emplois?( occupes)?|carriere|work experience|professional experience|employment( history)?|career( history)?|experience)$/],
  ["langues", /^(langues?( parlees| etrangeres)?|competences linguistiques|languages?( skills)?)$/],
  ["autre", /^(competences?.*|skills?.*|informatique|outils informatiques|centres? d'interets?|loisirs|interests|hobbies|references|publications|communications|certifications?|projets|projects|profil|profile|objectif|objective|resume|summary|a propos|about me|coordonnees|contact|informations personnelles|etat civil|personal (information|details)|activites extra.*|benevolat|volunteering|divers|atouts|qualites)$/],
];

function rubriqueDe(ligne: string): Rubrique | null {
  const t = normaliserTexte(ligne).replace(/^[\s#*•■▪►\-–—_|]+|[\s:*•■▪►\-–—_|]+$/g, "");
  if (!t || t.length > 45) return null;
  for (const [r, motif] of TITRES) if (motif.test(t)) return r;
  return null;
}

interface Ligne {
  texte: string;
  index: number;
  rubrique: Rubrique;
}

function decouper(texte: string): Ligne[] {
  const sortie: Ligne[] = [];
  let rubrique: Rubrique = "entete";
  let offset = 0;
  for (const brute of texte.split("\n")) {
    const t = brute.replace(/\f/g, "").trim();
    const r = rubriqueDe(t);
    if (r) rubrique = r;
    else if (t) sortie.push({ texte: t, index: offset, rubrique });
    offset += brute.length + 1;
  }
  return sortie;
}

const nettoyer = (s: string) => s.replace(/^[\s•●○■□▪▫►▶✓✔\-–—*·]+/, "").replace(/\s+/g, " ").trim();

// ─── Diplômes ─────────────────────────────────────────────────────────────────────────────

const MOTIF_DIPLOME =
  /(?<!\p{L})(doctorat|docteur en|docteur d'etat|dr\.? en|phd|ph\.d|master|mastere|magister|mba|msc|m\.sc|licence|bachelor|bsc|b\.sc|baccalaureat|bac(?: \+ ?\d)?|bts|dut|deua|des |deug|dess|dea|dems|desa|cesa|ingenieur d'etat|diplome( d'etat| d'etudes| universitaire)?|diploma|degree|residanat|certificat d'etudes|habilitation|agregation|capes|dfasm|dfgsm)(?!\p{L})/iu;
const MOTIF_PERIODE = /(?<!\d)(19|20)\d{2}(?!\d)/;

function diplomes(lignes: Ligne[], texte: string, faits: FaitExtrait[], notes: string[], titulaire: Pick<FaitBrut, "sujetRef" | "sujetType" | "role">) {
  const formation = lignes.filter((l) => l.rubrique === "formation");
  const sourceRubrique = formation.length > 0;
  const candidates = sourceRubrique ? formation : lignes.filter((l) => l.rubrique !== "experience");
  let precedente: Ligne | null = null;
  let n = 0;
  for (const l of candidates) {
    const t = nettoyer(l.texte);
    if (MOTIF_DIPLOME.test(normaliserTexte(t)) && !t.includes("@")) {
      // Une année seule sur la ligne d'avant (« 2012 » puis « Master… ») est rattachée au diplôme.
      const annee = !MOTIF_PERIODE.test(t) && precedente && /^[\d\s\-–/àa]+$|^(19|20)\d{2}\s*[-–]\s*((19|20)\d{2})?$/i.test(nettoyer(precedente.texte)) ? `${nettoyer(precedente.texte)} : ` : "";
      const valeur = `${annee}${t}`;
      faits.push(fait({ ...titulaire, attribut: "personne.diplome", valeur, valeurNormalisee: normaliserTexte(t), confiance: sourceRubrique ? 0.75 : 0.5, page: pageDe(texte, l.index), extrait: valeur }));
      n++;
    }
    precedente = l;
  }
  if (!n) notes.push(sourceRubrique ? "Rubrique « Formation » trouvée, mais aucun intitulé de diplôme reconnu." : "Aucun diplôme reconnu (pas de rubrique « Formation »).");
  else if (!sourceRubrique) notes.push("Diplômes repérés hors rubrique « Formation » : confiance réduite.");
}

// ─── Expériences ──────────────────────────────────────────────────────────────────────────

const MOIS_TXT = "(?:janv(?:ier)?|f[ée]v(?:r(?:ier)?)?|mars|avr(?:il)?|mai|juin|juil(?:let)?|ao[uû]t|sept?(?:embre)?|oct(?:obre)?|nov(?:embre)?|d[ée]c(?:embre)?|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|september|october|november|december)\\.?";
const BORNE = `(?:(?:\\d{1,2}[/.])?(?:19|20)\\d{2}|${MOIS_TXT}\\s+(?:19|20)\\d{2})`;
const EN_COURS = "(?:pr[ée]sent|aujourd'hui|ce jour|now|present|current|actuel(?:lement)?|en cours|to date)";
const MOTIF_PERIODE_EXP = new RegExp(
  `^(?:(?:depuis|since)\\s+${BORNE}|(?:de\\s+|from\\s+|du\\s+)?${BORNE}\\s*(?:[-–—]|à|a|to|au|jusqu'?(?:à|en))\\s*(?:${BORNE}|${EN_COURS})|${BORNE})\\s*[:\\-–—|,]?\\s*`,
  "i",
);
const MOTIF_EN_COURS = new RegExp(`(?<!\\p{L})(?:depuis|since|${EN_COURS})(?!\\p{L})`, "iu");

function experiences(lignes: Ligne[], texte: string, faits: FaitExtrait[], notes: string[], titulaire: Pick<FaitBrut, "sujetRef" | "sujetType" | "role">) {
  const exp = lignes.filter((l) => l.rubrique === "experience");
  if (!exp.length) {
    notes.push("Aucune rubrique « Expérience » trouvée : aucune expérience proposée.");
    return;
  }
  let n = 0;
  for (let i = 0; i < exp.length; i++) {
    const l = exp[i]!;
    const t = nettoyer(l.texte);
    const m = t.match(MOTIF_PERIODE_EXP);
    if (!m) continue;
    const periode = m[0].replace(/[\s:\-–—|,]+$/, "").trim();
    let description = t.slice(m[0].length).trim();
    // Période seule sur sa ligne : l'intitulé est sur la suivante (si elle n'ouvre pas elle-même une période).
    const suivante = exp[i + 1];
    if (description.replace(/[^\p{L}]/gu, "").length < 4 && suivante && !nettoyer(suivante.texte).match(MOTIF_PERIODE_EXP)) {
      description = nettoyer(suivante.texte);
    }
    if (!description) continue;
    const valeur = `${periode} : ${description}`;
    faits.push(fait({ ...titulaire, attribut: "personne.experience", valeur, valeurNormalisee: normaliserTexte(valeur), confiance: 0.7, page: pageDe(texte, l.index), extrait: valeur }));
    n++;
    if (MOTIF_EN_COURS.test(periode)) {
      // Le poste en cours donne la fonction — seulement si l'un des morceaux de l'intitulé EST un intitulé de poste.
      const poste = description.split(/\s+(?:chez|at|au sein d[eu']|@)\s+|\s*[,|]\s*|\s+[-–—]\s+/i).find((p) => MOTIF_FONCTION.test(p));
      if (poste) faits.push(fait({ ...titulaire, attribut: "personne.fonction", valeur: poste, valeurNormalisee: normaliserTexte(poste), confiance: 0.5, page: pageDe(texte, l.index), extrait: valeur }));
    }
  }
  if (!n) notes.push("Rubrique « Expérience » trouvée, mais aucune entrée datée lisible.");
}

// ─── Langues ──────────────────────────────────────────────────────────────────────────────

const LANGUES: [RegExp, string, string][] = [
  [/^(arabe|arabic)/, "ar", "Arabe"],
  [/^(francais|french)/, "fr", "Français"],
  [/^(anglais|english)/, "en", "Anglais"],
  [/^(espagnol|spanish)/, "es", "Espagnol"],
  [/^(allemand|german)/, "de", "Allemand"],
  [/^(italien|italian)/, "it", "Italien"],
  [/^(turc|turkish)/, "tr", "Turc"],
  [/^(chinois|chinese|mandarin)/, "zh", "Chinois"],
  [/^(russe|russian)/, "ru", "Russe"],
  [/^(portugais|portuguese)/, "pt", "Portugais"],
  [/^(neerlandais|dutch)/, "nl", "Néerlandais"],
  [/^(japonais|japanese)/, "ja", "Japonais"],
  [/^(kabyle|kabyl)/, "kab", "Kabyle"],
  [/^(tamazight|amazigh|berbere|berber)/, "ber", "Tamazight"],
];

function langues(lignes: Ligne[], texte: string, faits: FaitExtrait[], notes: string[], titulaire: Pick<FaitBrut, "sujetRef" | "sujetType" | "role">) {
  const sources: { texte: string; index: number }[] = lignes.filter((l) => l.rubrique === "langues");
  // « Langues : arabe, français, anglais » sur une seule ligne, n'importe où.
  for (const l of lignes) {
    const m = l.texte.match(/^\s*(langues?|languages?)\s*(parl[ée]es)?\s*:\s*(.+)$/i);
    if (m) sources.push({ texte: m[3]!, index: l.index });
  }
  let n = 0;
  for (const s of sources) {
    for (const morceau of nettoyer(s.texte).split(/\s*[,;•|]\s*|\s+[-–]\s+(?=\p{L}+\s*[:(])/u)) {
      const item = nettoyer(morceau);
      const cle = normaliserTexte(item);
      const langue = LANGUES.find(([motif]) => motif.test(cle));
      if (!langue) continue;
      const niveau = item.replace(/^\S+\s*/, "").replace(/^[:\-–(]\s*|\)$/g, "").trim();
      const valeur = niveau ? `${langue[2]} (${niveau})` : langue[2];
      faits.push(fait({ ...titulaire, attribut: "personne.langue", valeur, valeurNormalisee: langue[1], confiance: 0.75, page: pageDe(texte, s.index), extrait: item }));
      n++;
    }
  }
  if (!n) notes.push("Aucune langue reconnue.");
}

// ─── L'extracteur ─────────────────────────────────────────────────────────────────────────

export function extraireCv(entree: EntreeExtraction): ResultatExtraction {
  const { texte } = entree;
  const notes: string[] = [];
  const faits: FaitExtrait[] = [];
  const titulaire = { sujetRef: "titulaire", sujetType: "PERSONNE" as const, role: "TITULAIRE" as const };
  const lignes = decouper(texte);
  if (!lignes.length) {
    notes.push(`Aucun texte lisible${entree.nomFichier ? ` dans « ${entree.nomFichier} »` : ""} : rien n'a été extrait.`);
    return { nature: "CV", moteur: MOTEUR_CV, local: true, faits, notes };
  }

  // Coordonnées — partout dans le CV.
  const emails: string[] = [];
  for (const l of lignes) {
    for (const m of l.texte.matchAll(MOTIF_EMAIL)) {
      const email = normaliserEmail(m[0]);
      emails.push(email);
      faits.push(fait({ ...titulaire, attribut: "personne.email", valeur: m[0], valeurNormalisee: email, confiance: 0.9, page: pageDe(texte, l.index), extrait: l.texte }));
    }
    if (/\b(fax|t[ée]l[ée]copie)\b/i.test(l.texte)) continue;
    for (const tel of trouverTelephones(l.texte.replace(MOTIF_EMAIL, " "))) {
      faits.push(fait({ ...titulaire, attribut: "personne.telephone", valeur: tel.brut, valeurNormalisee: tel.e164, confiance: 0.85, page: pageDe(texte, l.index), extrait: l.texte }));
    }
  }
  if (!emails.length) notes.push("Aucune adresse e-mail lue.");
  if (!faits.some((f) => f.attribut === "personne.telephone")) notes.push("Aucun numéro de téléphone lu (ou forme non reconnue).");

  const adresse = champEtiquete(texte, /^\s*(adresse|address|domicile)\s*:/im);
  if (adresse) faits.push(fait({ ...titulaire, attribut: "personne.adresse", valeur: adresse.valeur, valeurNormalisee: normaliserTexte(adresse.valeur), confiance: 0.7, page: pageDe(texte, adresse.index), extrait: adresse.ligne }));

  // Identité : étiquettes d'abord, sinon la première ligne qui a la forme d'un nom.
  const nomEtiq = champEtiquete(texte, /^\s*(nom|last name|surname)\s*:/im);
  const prenomEtiq = champEtiquete(texte, /^\s*(pr[ée]noms?(?:\(s\))?|first name|given names?)\s*:/im);
  if (nomEtiq) faits.push(fait({ ...titulaire, attribut: "personne.nom", valeur: nomEtiq.valeur, valeurNormalisee: normaliserTexte(nomEtiq.valeur).toUpperCase(), confiance: 0.8, page: pageDe(texte, nomEtiq.index), extrait: nomEtiq.ligne }));
  if (prenomEtiq) faits.push(fait({ ...titulaire, attribut: "personne.prenoms", valeur: prenomEtiq.valeur, valeurNormalisee: normaliserTexte(prenomEtiq.valeur).toUpperCase(), confiance: 0.8, page: pageDe(texte, prenomEtiq.index), extrait: prenomEtiq.ligne }));
  if (!nomEtiq) {
    const ligneNom = lignes.slice(0, 6).find((l) => l.rubrique === "entete" && aFormeDeNom(l.texte) && !MOTIF_FONCTION.test(l.texte) && !/curriculum|vitae|\bcv\b|resume/i.test(l.texte));
    if (ligneNom) {
      const { civilite, reste } = separerCivilite(ligneNom.texte);
      const page = pageDe(texte, ligneNom.index);
      if (civilite) faits.push(fait({ ...titulaire, attribut: "personne.civilite", valeur: civilite, valeurNormalisee: civilite, confiance: 0.7, page, extrait: ligneNom.texte }));
      const decoupe = decouperNom(reste, emails[0]);
      if (decoupe) {
        faits.push(fait({ ...titulaire, attribut: "personne.nom", valeur: decoupe.nom, valeurNormalisee: normaliserTexte(decoupe.nom).toUpperCase(), confiance: 0.65, page, extrait: ligneNom.texte }));
        faits.push(fait({ ...titulaire, attribut: "personne.prenoms", valeur: decoupe.prenoms, valeurNormalisee: normaliserTexte(decoupe.prenoms).toUpperCase(), confiance: 0.65, page, extrait: ligneNom.texte }));
      } else notes.push(`Nom complet lu (« ${reste} ») sans indice pour séparer nom et prénoms : non proposé.`);
    } else notes.push("Nom du titulaire non lu en tête du CV.");
  }

  // Naissance : « Né(e) le 12/03/1985 à Oran », « Date de naissance : … », « Date of birth: … ».
  const naissance = lireNaissance(texte);
  if (naissance) {
    faits.push(fait({ ...titulaire, attribut: "personne.naissance", valeur: naissance.date, valeurNormalisee: naissance.iso, confiance: 0.75, page: pageDe(texte, naissance.index), extrait: naissance.ligne }));
    if (naissance.lieu) faits.push(fait({ ...titulaire, attribut: "personne.lieuNaissance", valeur: naissance.lieu, valeurNormalisee: normaliserTexte(naissance.lieu), confiance: 0.65, page: pageDe(texte, naissance.index), extrait: naissance.ligne }));
  } else notes.push("Date de naissance non lue.");
  if (!naissance?.lieu) {
    const lieu = champEtiquete(texte, /^\s*(lieu de naissance|place of birth)\s*:/im);
    if (lieu) faits.push(fait({ ...titulaire, attribut: "personne.lieuNaissance", valeur: lieu.valeur, valeurNormalisee: normaliserTexte(lieu.valeur), confiance: 0.7, page: pageDe(texte, lieu.index), extrait: lieu.ligne }));
  }

  const nationalite = champEtiquete(texte, /^\s*(nationalit[ée]|nationality)\s*:/im);
  if (nationalite) {
    const iso = paysIso3(nationalite.valeur);
    if (iso) faits.push(fait({ ...titulaire, attribut: "personne.nationalite", valeur: nationalite.valeur, valeurNormalisee: iso, confiance: 0.75, page: pageDe(texte, nationalite.index), extrait: nationalite.ligne }));
    else notes.push(`Nationalité lue (« ${nationalite.valeur} ») sans correspondance ISO connue : non proposée.`);
  }

  const specialite = champEtiquete(texte, /^\s*(sp[ée]cialit[ée]|specialty|speciality)\s*:/im);
  if (specialite) faits.push(fait({ ...titulaire, attribut: "personne.specialite", valeur: specialite.valeur, valeurNormalisee: normaliserTexte(specialite.valeur), confiance: 0.7, page: pageDe(texte, specialite.index), extrait: specialite.ligne }));

  diplomes(lignes, texte, faits, notes, titulaire);
  experiences(lignes, texte, faits, notes, titulaire);
  langues(lignes, texte, faits, notes, titulaire);

  return { nature: "CV", moteur: MOTEUR_CV, local: true, faits: dedoublonner(faits), notes };
}

function lireNaissance(texte: string): { date: string; iso: string; lieu: string | null; index: number; ligne: string } | null {
  let offset = 0;
  for (const ligne of texte.split("\n")) {
    const m = ligne.match(/(?<!\p{L})(n[ée]e?\s*(?:\(e\)\s*)?le|date de naissance|date of birth|born( on)?)\s*:?\s*/iu);
    if (m && m.index !== undefined) {
      const reste = ligne.slice(m.index + m[0].length);
      const date = reste.match(MOTIF_DATE);
      const iso = date ? normaliserDate(date[0]) : null;
      if (date && iso && date.index !== undefined && date.index < 3) {
        const apres = reste.slice(date.index + date[0].length);
        const lieu = apres.match(/^\s*(?:à|a|in)\s+([\p{L}][\p{L}'’\- ]{1,40}?)\s*(?:[,;(|.]|$)/u)?.[1]?.trim() ?? null;
        return { date: date[0], iso, lieu, index: offset + m.index, ligne: ligne.trim() };
      }
    }
    offset += ligne.length + 1;
  }
  return null;
}
