/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'EXTRACTEUR « CNI » — la carte nationale d'identité biométrique algérienne, lue SUR CE SERVEUR.
 *
 * Le verso porte une MRZ au format TD1 (ICAO 9303, partie 5) : trois lignes de 30 caractères.
 *
 *   ligne 1 : type (2) · État émetteur (3) · n° du document (9) · contrôle (1) · données facultatives (15)
 *   ligne 2 : naissance AAMMJJ (6) · contrôle · sexe · expiration AAMMJJ (6) · contrôle · nationalité (3)
 *             · données facultatives (11) · contrôle composite
 *   ligne 3 : NOM<<PRENOMS
 *
 * Un n° de document de plus de 9 caractères déborde dans les données facultatives : la position du
 * contrôle porte alors « < » et le vrai chiffre de contrôle suit la fin du numéro (9303-5, note j).
 *
 * Le recto (zone visuelle) porte le NIN — 18 chiffres — et le lieu de naissance : lus par étiquette,
 * avec une confiance moindre. Un chiffre de contrôle faux n'est jamais corrigé : il est DIT.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { casse, chiffreDeControle } from "@/modules/assistant-ia/partage";
import type { FaitExtrait, ResultatExtraction } from "../types";
import { champEtiquete, dedoublonner, fait, MOTIF_DATE, normaliserDate, normaliserTexte, pageDe, paysMrz, type EntreeExtraction } from "./commun-personnes";

export const MOTEUR_CNI = "mrz-td1-local/1";

export interface CarteIdentiteLue {
  typeDocument: string;
  pays: string;
  numero: string;
  /** Données facultatives des lignes 1 et 2, sans les « < » de remplissage. */
  facultatif1: string;
  facultatif2: string;
  nom: string;
  prenoms: string;
  nationalite: string;
  /** ISO AAAA-MM-JJ. */
  naissance: string | null;
  sexe: "M" | "F" | null;
  /** ISO AAAA-MM-JJ. */
  expiration: string | null;
  /** Les contrôles qui ont échoué (numéro, naissance, expiration, composite) — vide : tout est cohérent. */
  controlesFaux: string[];
  /** Les trois lignes telles que normalisées (30 caractères chacune). */
  lignes: [string, string, string];
}

/** Confusions OCR-B ordinaires, appliquées aux seules positions NUMÉRIQUES. */
const VERS_CHIFFRE: Record<string, string> = { O: "0", Q: "0", D: "0", I: "1", L: "1", Z: "2", S: "5", B: "8", G: "6" };
const chiffres = (s: string) => s.replace(/[OQDILZSBG]/g, (c) => VERS_CHIFFRE[c] ?? c);

function normaliserLigne(l: string): string {
  return l.toUpperCase().replace(/[«‹＜]/g, "<").replace(/\s+/g, "").replace(/[^A-Z0-9<]/g, "");
}

function dateMrz(aammjj: string, futur: boolean): string | null {
  if (!/^\d{6}$/.test(aammjj)) return null;
  const aa = Number(aammjj.slice(0, 2));
  const mm = Number(aammjj.slice(2, 4));
  const jj = Number(aammjj.slice(4, 6));
  if (mm < 1 || mm > 12 || jj < 1 || jj > 31) return null;
  const siecle = new Date().getUTCFullYear() % 100;
  const annee = futur ? 2000 + aa : aa > siecle ? 1900 + aa : 2000 + aa;
  return `${annee}-${String(mm).padStart(2, "0")}-${String(jj).padStart(2, "0")}`;
}

const nomsDe = (champ: string) => champ.replace(/<+$/, "").split("<").filter(Boolean).join(" ").trim();
const controle = (donnee: string, chiffre: string) => /\d/.test(chiffre) && String(chiffreDeControle(donnee)) === chiffre;

/** La MRZ TD1 d'un texte lu, ou `null` s'il n'y en a pas. */
export function lireMrzTd1(texte: string): (CarteIdentiteLue & { indexLigne1: number }) | null {
  const brutes = texte.split("\n");
  const lignes: { n: string; index: number }[] = [];
  let offset = 0;
  for (const b of brutes) {
    const n = normaliserLigne(b);
    if (n.length >= 28 && n.length <= 32) lignes.push({ n, index: offset });
    offset += b.length + 1;
  }
  for (let i = 0; i + 2 < lignes.length; i++) {
    const un = lignes[i]!.n.padEnd(30, "<").slice(0, 30);
    if (!/^[ACI][A-Z<]/.test(un) || (un.match(/</g)?.length ?? 0) < 2) continue;
    const deux = lignes[i + 1]!.n.padEnd(30, "<").slice(0, 30);
    const trois = lignes[i + 2]!.n.padEnd(30, "<").slice(0, 30);
    if (!/^[0-9OQDILZSBG]{6}/.test(deux) || !/^[A-Z]/.test(trois)) continue;

    const controlesFaux: string[] = [];
    let numero = un.slice(5, 14);
    let facultatif1 = un.slice(15, 30);
    if (un[14] === "<") {
      // N° long : il continue dans les données facultatives, son contrôle est le dernier caractère avant « < ».
      const suite = facultatif1.replace(/<.*$/, "");
      if (suite.length >= 1) {
        const cNum = chiffres(suite.slice(-1));
        numero = numero + suite.slice(0, -1);
        if (!controle(numero, cNum)) controlesFaux.push("numéro de la carte");
        facultatif1 = facultatif1.slice(suite.length);
      } else controlesFaux.push("numéro de la carte");
    } else if (!controle(numero, chiffres(un[14]!))) controlesFaux.push("numéro de la carte");

    const naissance = chiffres(deux.slice(0, 6));
    const cNai = chiffres(deux[6]!);
    const expiration = chiffres(deux.slice(8, 14));
    const cExp = chiffres(deux[14]!);
    const cComp = chiffres(deux[29]!);
    if (!controle(naissance, cNai)) controlesFaux.push("date de naissance");
    if (!controle(expiration, cExp)) controlesFaux.push("date d'expiration");
    const composite = un.slice(5, 30) + naissance + cNai + expiration + cExp + deux.slice(18, 29);
    if (!controle(composite, cComp)) controlesFaux.push("contrôle composite");

    const [nomBrut, ...prenomsBruts] = trois.split("<<");
    const nom = nomsDe(nomBrut ?? "");
    if (!nom) continue;
    return {
      typeDocument: un.slice(0, 2).replace(/</g, ""),
      pays: un.slice(2, 5).replace(/</g, ""),
      numero: numero.replace(/<+$/, "").replace(/</g, ""),
      facultatif1: facultatif1.replace(/</g, " ").trim(),
      facultatif2: deux.slice(18, 29).replace(/</g, " ").trim(),
      nom,
      prenoms: nomsDe(prenomsBruts.join("<<")),
      nationalite: deux.slice(15, 18).replace(/</g, ""),
      naissance: dateMrz(naissance, false),
      sexe: deux[7] === "M" || deux[7] === "F" ? deux[7] : null,
      expiration: dateMrz(expiration, true),
      controlesFaux,
      lignes: [un, deux, trois],
      indexLigne1: lignes[i]!.index,
    };
  }
  return null;
}

const CONFIANCE_MRZ = 0.95;
const CONFIANCE_NOMS_MRZ = 0.9;
const CONFIANCE_CONTROLE_FAUX = 0.3;
const CONFIANCE_DOUTE_COMPOSITE = 0.5;
const CONFIANCE_ZONE_VISUELLE = 0.6;
const CONFIANCE_NIN_VISUEL = 0.7;

const ETIQUETTE_NIN = /\bN\.?\s?I\.?\s?N\.?\b|num[ée]ro d'identification national|رقم التعريف الوطني/i;

export function extraireCni(entree: EntreeExtraction): ResultatExtraction {
  const { texte } = entree;
  const notes: string[] = [];
  const faits: FaitExtrait[] = [];
  const lu = lireMrzTd1(texte);
  const titulaire = { sujetRef: "titulaire", sujetType: "PERSONNE" as const, role: "TITULAIRE" as const };

  if (lu) {
    const page = pageDe(texte, lu.indexLigne1);
    const faux = new Set(lu.controlesFaux);
    const plafond = (c: number) => (faux.has("contrôle composite") ? Math.min(c, CONFIANCE_DOUTE_COMPOSITE) : c);
    const confianceChamp = (c: string) => (faux.has(c) ? CONFIANCE_CONTROLE_FAUX : plafond(CONFIANCE_MRZ));
    const confianceNoms = lu.controlesFaux.length ? CONFIANCE_ZONE_VISUELLE : CONFIANCE_NOMS_MRZ;
    const t = { ...titulaire, page };

    if (lu.pays && lu.pays !== "DZA") notes.push(`Carte émise par « ${lu.pays} » et non par l'Algérie : lue selon la norme TD1 générale.`);
    faits.push(fait({ ...t, attribut: "personne.nom", valeur: casse(lu.nom), valeurNormalisee: lu.nom, confiance: confianceNoms, extrait: `MRZ ligne 3 — nom : ${lu.nom}` }));
    if (lu.prenoms) faits.push(fait({ ...t, attribut: "personne.prenoms", valeur: casse(lu.prenoms), valeurNormalisee: lu.prenoms, confiance: confianceNoms, extrait: `MRZ ligne 3 — prénoms : ${lu.prenoms}` }));
    else notes.push("Prénoms absents de la zone MRZ.");
    if (lu.naissance) faits.push(fait({ ...t, attribut: "personne.naissance", valeur: lu.naissance, valeurNormalisee: lu.naissance, confiance: confianceChamp("date de naissance"), extrait: `MRZ ligne 2 — naissance : ${lu.naissance}` }));
    else notes.push("Date de naissance illisible dans la zone MRZ.");
    if (lu.sexe) faits.push(fait({ ...t, attribut: "personne.sexe", valeur: lu.sexe, valeurNormalisee: lu.sexe, confiance: plafond(CONFIANCE_MRZ), extrait: `MRZ ligne 2 — sexe : ${lu.sexe}` }));
    else notes.push("Sexe non précisé dans la zone MRZ.");
    const nationalite = paysMrz(lu.nationalite);
    if (nationalite) faits.push(fait({ ...t, attribut: "personne.nationalite", valeur: lu.nationalite, valeurNormalisee: nationalite, confiance: plafond(CONFIANCE_MRZ), extrait: `MRZ ligne 2 — nationalité : ${lu.nationalite}` }));
    else notes.push("Nationalité illisible dans la zone MRZ.");
    if (lu.numero) faits.push(fait({ ...t, attribut: "personne.cni.numero", valeur: lu.numero, valeurNormalisee: lu.numero, confiance: confianceChamp("numéro de la carte"), extrait: `MRZ ligne 1 — n° de la carte : ${lu.numero}` }));
    else notes.push("Numéro de la carte illisible dans la zone MRZ.");
    if (!lu.expiration) notes.push("Date d'expiration illisible dans la zone MRZ.");
    else notes.push(`Expiration de la carte lue (${lu.expiration}) : le catalogue n'a pas d'attribut pour elle, elle n'est pas proposée.`);
    for (const c of lu.controlesFaux) notes.push(`Chiffre de contrôle MRZ faux (${c}) : la valeur n'est pas corrigée, elle est à vérifier sur la pièce.`);
  } else {
    notes.push(`Aucune zone MRZ TD1 lisible${entree.nomFichier ? ` dans « ${entree.nomFichier} »` : ""} (verso absent ou illisible) : seule la zone visuelle est lue.`);
    const nom = champEtiquete(texte, /^\s*nom(?:\s*\/\s*surname)?\s*[:/]?(?=\s|$)|^\s*surname\b/im);
    const prenoms = champEtiquete(texte, /^\s*pr[ée]noms?(?:\(s\))?(?:\s*\/\s*given names?)?\s*[:/]?(?=\s|$)|^\s*given names?\b/im);
    if (nom) faits.push(fait({ ...titulaire, attribut: "personne.nom", valeur: casse(nom.valeur), valeurNormalisee: normaliserTexte(nom.valeur).toUpperCase(), confiance: CONFIANCE_ZONE_VISUELLE, page: pageDe(texte, nom.index), extrait: nom.ligne }));
    else notes.push("Nom non lu dans la zone visuelle.");
    if (prenoms) faits.push(fait({ ...titulaire, attribut: "personne.prenoms", valeur: casse(prenoms.valeur), valeurNormalisee: normaliserTexte(prenoms.valeur).toUpperCase(), confiance: CONFIANCE_ZONE_VISUELLE, page: pageDe(texte, prenoms.index), extrait: prenoms.ligne }));
    else notes.push("Prénoms non lus dans la zone visuelle.");
    const naissance = champEtiquete(texte, /date de naissance(?:\s*\/\s*date of birth)?|date of birth/i);
    const dateLue = naissance?.valeur.match(MOTIF_DATE)?.[0];
    const iso = dateLue ? normaliserDate(dateLue) : null;
    if (naissance && dateLue && iso) faits.push(fait({ ...titulaire, attribut: "personne.naissance", valeur: dateLue, valeurNormalisee: iso, confiance: CONFIANCE_ZONE_VISUELLE, page: pageDe(texte, naissance.index), extrait: naissance.ligne }));
    else notes.push("Date de naissance non lue dans la zone visuelle.");
  }

  // Recto : lieu de naissance et NIN — par étiquette.
  const lieu = champEtiquete(texte, /lieu de naissance(?:\s*\/\s*place of birth)?|place of birth/i);
  if (lieu && !MOTIF_DATE.test(lieu.valeur)) {
    faits.push(fait({ ...titulaire, attribut: "personne.lieuNaissance", valeur: lieu.valeur, valeurNormalisee: normaliserTexte(lieu.valeur), confiance: CONFIANCE_ZONE_VISUELLE, page: pageDe(texte, lieu.index), extrait: lieu.ligne }));
  } else notes.push("Lieu de naissance non lu (absent de la MRZ, zone visuelle muette).");

  const nin = lireNin(texte);
  if (nin) faits.push(fait({ ...titulaire, attribut: "personne.nin", valeur: nin.valeur, valeurNormalisee: nin.valeur, confiance: CONFIANCE_NIN_VISUEL, page: pageDe(texte, nin.index), extrait: nin.ligne }));
  else notes.push("NIN (18 chiffres) non lu sur le recto.");

  return { nature: "CNI", moteur: MOTEUR_CNI, local: true, faits: dedoublonner(faits), notes };
}

/** Le NIN : 18 chiffres derrière son étiquette (même ligne ou ligne suivante), espaces tolérés. */
function lireNin(texte: string): { valeur: string; index: number; ligne: string } | null {
  const lignes = texte.split("\n");
  let offset = 0;
  for (let i = 0; i < lignes.length; i++) {
    const ligne = lignes[i]!;
    const m = ligne.match(ETIQUETTE_NIN);
    if (m && m.index !== undefined) {
      for (const candidat of [ligne.slice(m.index + m[0].length), lignes[i + 1] ?? ""]) {
        const n = candidat.match(/\d[\d\s]{16,30}\d/)?.[0].replace(/\s/g, "");
        if (n && n.length === 18) return { valeur: n, index: offset + m.index, ligne: ligne.trim() };
      }
    }
    offset += ligne.length + 1;
  }
  return null;
}
