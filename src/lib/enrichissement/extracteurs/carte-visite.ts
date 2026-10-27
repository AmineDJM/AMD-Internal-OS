/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'EXTRACTEUR « CARTE DE VISITE » — la personne (titulaire) et son organisation (mentionnée).
 *
 * Par règles, ligne à ligne : une carte est courte, chaque ligne porte UNE chose (nom, fonction,
 * société, adresse, coordonnées). Le partage se fait ainsi :
 *   - personne : nom, prénoms, civilité, fonction, e-mail nominatif, mobile ;
 *   - organisation (rôle MENTIONNE) : raison sociale ou nom commercial, adresse, standard, e-mail
 *     générique (contact@, info@…), site web.
 * Un fax n'a pas d'attribut au catalogue : il est noté, pas proposé.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import type { FaitExtrait, ResultatExtraction } from "../types";
import {
  aFormeDeNom, decouperNom, dedoublonner, estEmailGenerique, estMessageriePublique, estMobileAlgerien, fait,
  MOTIF_EMAIL, MOTIF_FONCTION, MOTIF_SITE, normaliserEmail, normaliserSite, normaliserTexte, pageDe,
  separerCivilite, trouverTelephones, type EntreeExtraction,
} from "./commun-personnes";

export const MOTEUR_CARTE_VISITE = "regles-carte-visite/1";

const FORME_JURIDIQUE = /(?<!\p{L})(sarl|spa|eurl|snc|sas|sasu|scs|epe|epic|ltd|llc|gmbh|inc|plc|s\.a\.r\.l|s\.p\.a|e\.u\.r\.l)(?!\p{L})/iu;
const MOT_ORGANISATION =
  /(?<!\p{L})(laboratoires?|laborator(?:y|ies)|labs?|labo|pharma|pharmaceuticals?|pharmaceutique|groupe|group|clinique|chu|ehs|eph|hopital|hospital|centre|center|universite|university|institut|institute|pharmacie|distribution|industries?|societe|company|cabinet|agence|consulting|international|holding|imprimerie)(?!\p{L})/iu;
const MOT_ADRESSE =
  /(?<!\p{L})(rue|cite|lot|lotissement|bp|b\.p|boulevard|bd|avenue|av|route|zone industrielle|zi|hai|cooperative|wilaya|commune|street|road|immeuble|residence|batiment|bt|bloc|n°|villa)(?!\p{L})|\b\d{5}\b/iu;
const LIBELLE_COORDONNEE = /^\s*(t[ée]l[ée]?(phone)?|tel|mob(ile)?|gsm|cell|portable|fax|t[ée]l[ée]copie|e-?mail|mail|courriel|site|web|www)\b/i;

interface Ligne {
  texte: string;
  index: number;
}

export function extraireCarteVisite(entree: EntreeExtraction): ResultatExtraction {
  const { texte } = entree;
  const notes: string[] = [];
  const faits: FaitExtrait[] = [];
  const titulaire = { sujetRef: "titulaire", sujetType: "PERSONNE" as const, role: "TITULAIRE" as const };
  const organisation = { sujetRef: "organisation", sujetType: "ORGANISATION" as const, role: "MENTIONNE" as const };

  const lignes: Ligne[] = [];
  let offset = 0;
  for (const brute of texte.split("\n")) {
    const t = brute.replace(/\f/g, "").replace(/\s+/g, " ").trim();
    if (t) lignes.push({ texte: t, index: offset });
    offset += brute.length + 1;
  }
  if (!lignes.length) {
    notes.push(`Aucun texte lisible${entree.nomFichier ? ` dans « ${entree.nomFichier} »` : ""} : rien n'a été extrait.`);
    return { nature: "CARTE_VISITE", moteur: MOTEUR_CARTE_VISITE, local: true, faits, notes };
  }

  const prises = new Set<Ligne>();
  const emailsPersonnels: string[] = [];
  let domaine: string | null = null;

  // Coordonnées d'abord : elles « consomment » leurs lignes, qui ne seront pas prises pour un nom.
  for (const l of lignes) {
    const page = pageDe(texte, l.index);
    let vue = false;
    for (const m of l.texte.matchAll(MOTIF_EMAIL)) {
      vue = true;
      const email = normaliserEmail(m[0]);
      if (!estMessageriePublique(email)) domaine ??= email.split("@")[1] ?? null;
      if (estEmailGenerique(email)) faits.push(fait({ ...organisation, attribut: "organisation.email", valeur: m[0], valeurNormalisee: email, confiance: 0.85, page, extrait: l.texte }));
      else {
        emailsPersonnels.push(email);
        faits.push(fait({ ...titulaire, attribut: "personne.email", valeur: m[0], valeurNormalisee: email, confiance: 0.85, page, extrait: l.texte }));
      }
    }
    const sansEmail = l.texte.replace(MOTIF_EMAIL, " ");
    for (const m of sansEmail.matchAll(MOTIF_SITE)) {
      vue = true;
      faits.push(fait({ ...organisation, attribut: "organisation.siteWeb", valeur: m[0], valeurNormalisee: normaliserSite(m[0]), confiance: 0.85, page, extrait: l.texte }));
    }
    const sansSite = sansEmail.replace(MOTIF_SITE, " ");
    const tels = trouverTelephones(sansSite);
    for (const tel of tels) {
      vue = true;
      const avant = sansSite.slice(0, tel.index);
      // Le libellé qui précède le numéro le plus près : « Tél : 021… / Fax : 021… » sur une même ligne.
      const libelle = [...avant.matchAll(/(t[ée]l[ée]?(?:phone)?|tel|mob(?:ile)?|gsm|cell|portable|fax|t[ée]l[ée]copie|standard|direct|ligne directe)/gi)].pop()?.[0].toLowerCase() ?? "";
      if (/fax|copie/.test(libelle)) {
        notes.push(`Numéro de fax lu (${tel.e164}) : pas d'attribut au catalogue, non proposé.`);
        continue;
      }
      const mobile = /mob|gsm|cell|portable|direct/.test(libelle) || estMobileAlgerien(tel.e164);
      if (mobile) faits.push(fait({ ...titulaire, attribut: "personne.telephone", valeur: tel.brut, valeurNormalisee: tel.e164, confiance: 0.8, page, extrait: l.texte }));
      else if (tel.e164.startsWith("+213")) faits.push(fait({ ...organisation, attribut: "organisation.telephone", valeur: tel.brut, valeurNormalisee: tel.e164, confiance: 0.75, page, extrait: l.texte }));
      // Un fixe étranger sans libellé : rien ne dit s'il est à la personne ou à la société — la personne, avec doute.
      else faits.push(fait({ ...titulaire, attribut: "personne.telephone", valeur: tel.brut, valeurNormalisee: tel.e164, confiance: 0.55, page, extrait: l.texte }));
    }
    if (vue || LIBELLE_COORDONNEE.test(l.texte)) prises.add(l);
  }

  // Organisation : forme juridique (raison sociale) ou mot d'organisation (nom commercial).
  const restantes = () => lignes.filter((l) => !prises.has(l));
  const ligneOrg =
    restantes().find((l) => FORME_JURIDIQUE.test(l.texte)) ??
    restantes().find((l) => MOT_ORGANISATION.test(normaliserTexte(l.texte)) && !MOTIF_FONCTION.test(l.texte) && !MOT_ADRESSE.test(normaliserTexte(l.texte)));
  if (ligneOrg) {
    prises.add(ligneOrg);
    const attribut = FORME_JURIDIQUE.test(ligneOrg.texte) ? "organisation.raisonSociale" : "organisation.nomCommercial";
    faits.push(fait({ ...organisation, attribut, valeur: ligneOrg.texte, valeurNormalisee: normaliserTexte(ligneOrg.texte), confiance: 0.7, page: pageDe(texte, ligneOrg.index), extrait: ligneOrg.texte }));
  } else notes.push(`Nom de l'organisation non lu${domaine ? ` (domaine de messagerie : ${domaine})` : ""} : non deviné.`);

  // Nom : la première ligne qui a la forme d'un nom de personne.
  const ligneNom = restantes().find((l) => aFormeDeNom(l.texte) && !MOTIF_FONCTION.test(l.texte) && !MOT_ORGANISATION.test(normaliserTexte(l.texte)) && !MOT_ADRESSE.test(normaliserTexte(l.texte)));
  if (ligneNom) {
    prises.add(ligneNom);
    const page = pageDe(texte, ligneNom.index);
    const { civilite, reste } = separerCivilite(ligneNom.texte);
    if (civilite) faits.push(fait({ ...titulaire, attribut: "personne.civilite", valeur: civilite, valeurNormalisee: civilite, confiance: 0.75, page, extrait: ligneNom.texte }));
    const decoupe = decouperNom(reste, emailsPersonnels[0]);
    if (decoupe) {
      faits.push(fait({ ...titulaire, attribut: "personne.nom", valeur: decoupe.nom, valeurNormalisee: normaliserTexte(decoupe.nom).toUpperCase(), confiance: 0.7, page, extrait: ligneNom.texte }));
      faits.push(fait({ ...titulaire, attribut: "personne.prenoms", valeur: decoupe.prenoms, valeurNormalisee: normaliserTexte(decoupe.prenoms).toUpperCase(), confiance: 0.7, page, extrait: ligneNom.texte }));
    } else notes.push(`Nom complet lu (« ${reste} ») sans indice pour séparer nom et prénoms : non proposé.`);
  } else notes.push("Nom du titulaire non lu.");

  // Fonction : les lignes restantes qui portent un intitulé de poste.
  const fonctions = restantes().filter((l) => MOTIF_FONCTION.test(l.texte) && !MOT_ADRESSE.test(normaliserTexte(l.texte)));
  for (const l of fonctions) {
    prises.add(l);
    faits.push(fait({ ...titulaire, attribut: "personne.fonction", valeur: l.texte, valeurNormalisee: normaliserTexte(l.texte), confiance: 0.75, page: pageDe(texte, l.index), extrait: l.texte }));
  }
  if (!fonctions.length) notes.push("Fonction non lue.");

  // Adresse : les lignes d'adresse contiguës, réunies.
  const adresse = restantes().filter((l) => MOT_ADRESSE.test(normaliserTexte(l.texte)));
  if (adresse.length) {
    const valeur = adresse.map((l) => l.texte).join(", ");
    faits.push(fait({ ...organisation, attribut: "organisation.adresse", valeur, valeurNormalisee: normaliserTexte(valeur), confiance: 0.6, page: pageDe(texte, adresse[0]!.index), extrait: valeur }));
    adresse.forEach((l) => prises.add(l));
  }

  const ignorees = restantes();
  if (ignorees.length) notes.push(`Lignes non interprétées : ${ignorees.map((l) => `« ${l.texte} »`).join(", ")}.`);

  return { nature: "CARTE_VISITE", moteur: MOTEUR_CARTE_VISITE, local: true, faits: dedoublonner(faits), notes };
}
