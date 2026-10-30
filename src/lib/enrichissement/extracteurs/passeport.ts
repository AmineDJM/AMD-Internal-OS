/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'EXTRACTEUR « PASSEPORT » — la zone MRZ (TD3) lue SUR CE SERVEUR, rendue en faits.
 *
 * La lecture elle-même est celle de l'assistant (`lireMrz`) : on ne la réécrit pas, on la traduit
 * en `FaitExtrait` du sujet « titulaire ». Le numéro et l'expiration sont sensibles (coffre).
 * Un chiffre de contrôle faux n'est jamais corrigé : la valeur concernée part avec une confiance
 * basse et une note qui le dit.
 *
 * Les preuves des faits NON sensibles ne citent que leur propre segment de la MRZ : la ligne 2
 * porte le numéro du passeport, elle ne doit pas se retrouver en clair à côté d'une date de naissance.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { casse, lireMrz } from "@/modules/assistant-ia/partage";
import type { FaitExtrait, ResultatExtraction } from "../types";
import { champEtiquete, dedoublonner, fait, normaliserTexte, pageDe, paysMrz, type EntreeExtraction } from "./commun-personnes";

export const MOTEUR_PASSEPORT = "mrz-local/1";

const CONFIANCE_MRZ = 0.95;
const CONFIANCE_NOMS_MRZ = 0.9;
const CONFIANCE_CONTROLE_FAUX = 0.3;
const CONFIANCE_DOUTE_GLOBAL = 0.5;
const CONFIANCE_ZONE_VISUELLE = 0.6;

/** La ligne 1 de la MRZ dans le texte brut (même critère que `lireMrz`), pour la page de la preuve. */
function indexLigneMrz(texte: string): number {
  let offset = 0;
  for (const ligne of texte.split("\n")) {
    const n = ligne.toUpperCase().replace(/[«‹＜]/g, "<").replace(/\s+/g, "");
    if (n.length >= 30 && /^P[A-Z<]/.test(n) && (n.match(/</g)?.length ?? 0) >= 3) return offset;
    offset += ligne.length + 1;
  }
  return -1;
}

export function extrairePasseport(entree: EntreeExtraction): ResultatExtraction {
  const { texte } = entree;
  const notes: string[] = [];
  const lu = lireMrz(texte);
  if (!lu) {
    notes.push(`Aucune zone MRZ de passeport lisible${entree.nomFichier ? ` dans « ${entree.nomFichier} »` : ""} : rien n'a été extrait.`);
    return { nature: "PASSEPORT", moteur: MOTEUR_PASSEPORT, local: true, faits: [], notes };
  }

  const page = pageDe(texte, indexLigneMrz(texte));
  const faux = new Set(lu.controlesFaux);
  const douteGlobal = faux.has("contrôle global");
  const plafond = (c: number) => (douteGlobal ? Math.min(c, CONFIANCE_DOUTE_GLOBAL) : c);
  const confianceChamp = (controle: string) => (faux.has(controle) ? CONFIANCE_CONTROLE_FAUX : plafond(CONFIANCE_MRZ));
  const confianceNoms = lu.controlesFaux.length ? CONFIANCE_ZONE_VISUELLE : CONFIANCE_NOMS_MRZ;
  const titulaire = { sujetRef: "titulaire", sujetType: "PERSONNE" as const, role: "TITULAIRE" as const, page };
  const faits: FaitExtrait[] = [];

  faits.push(fait({ ...titulaire, attribut: "personne.nom", valeur: casse(lu.nom), valeurNormalisee: lu.nom, confiance: confianceNoms, extrait: `MRZ ligne 1 — nom : ${lu.nom}` }));
  if (lu.prenoms) {
    faits.push(fait({ ...titulaire, attribut: "personne.prenoms", valeur: casse(lu.prenoms), valeurNormalisee: lu.prenoms, confiance: confianceNoms, extrait: `MRZ ligne 1 — prénoms : ${lu.prenoms}` }));
  } else notes.push("Prénoms absents de la zone MRZ.");

  if (lu.naissance) {
    faits.push(fait({ ...titulaire, attribut: "personne.naissance", valeur: lu.naissance, valeurNormalisee: lu.naissance, confiance: confianceChamp("date de naissance"), extrait: `MRZ ligne 2 — naissance : ${lu.naissance}` }));
  } else notes.push("Date de naissance illisible dans la zone MRZ.");

  if (lu.sexe) {
    faits.push(fait({ ...titulaire, attribut: "personne.sexe", valeur: lu.sexe, valeurNormalisee: lu.sexe, confiance: plafond(CONFIANCE_MRZ), extrait: `MRZ ligne 2 — sexe : ${lu.sexe}` }));
  } else notes.push("Sexe non précisé dans la zone MRZ.");

  const nationalite = paysMrz(lu.nationalite);
  if (nationalite) {
    faits.push(fait({ ...titulaire, attribut: "personne.nationalite", valeur: lu.nationalite, valeurNormalisee: nationalite, confiance: plafond(CONFIANCE_MRZ), extrait: `MRZ ligne 2 — nationalité : ${lu.nationalite}` }));
  } else notes.push("Nationalité illisible dans la zone MRZ.");

  if (lu.numero) {
    faits.push(fait({ ...titulaire, attribut: "personne.passeport.numero", valeur: lu.numero, valeurNormalisee: lu.numero.replace(/[^A-Z0-9]/g, ""), confiance: confianceChamp("numéro du passeport"), extrait: `MRZ ligne 2 — numéro : ${lu.numero}` }));
  } else notes.push("Numéro du passeport illisible dans la zone MRZ.");

  if (lu.expiration) {
    faits.push(fait({ ...titulaire, attribut: "personne.passeport.expiration", valeur: lu.expiration, valeurNormalisee: lu.expiration, confiance: confianceChamp("date d'expiration"), extrait: `MRZ ligne 2 — expiration : ${lu.expiration}` }));
  } else notes.push("Date d'expiration illisible dans la zone MRZ.");

  for (const c of lu.controlesFaux) notes.push(`Chiffre de contrôle MRZ faux (${c}) : la valeur n'est pas corrigée, elle est à vérifier sur la pièce.`);

  // La zone visuelle porte ce que la MRZ n'a pas : le lieu de naissance.
  const lieu = champEtiquete(texte, /lieu de naissance(?:\s*\/\s*place of birth)?|place of birth/i);
  if (lieu && !/\d{2}[/.\-]\d{2}/.test(lieu.valeur)) {
    faits.push(fait({ ...titulaire, attribut: "personne.lieuNaissance", valeur: lieu.valeur, valeurNormalisee: normaliserTexte(lieu.valeur), confiance: CONFIANCE_ZONE_VISUELLE, page: pageDe(texte, lieu.index), extrait: lieu.ligne }));
  } else notes.push("Lieu de naissance non lu (absent de la MRZ, zone visuelle muette).");

  // Les noms de la MRZ sont translittérés sans accents : la zone visuelle, si elle les porte, est dite.
  const nomVisuel = champEtiquete(texte, /^\s*nom(?:\s*\/\s*surname)?\s*[:/]|^\s*surname\s*[:/]/im);
  if (nomVisuel && normaliserTexte(nomVisuel.valeur).replace(/[-']/g, " ").toUpperCase() !== lu.nom) {
    notes.push(`Le nom de la zone visuelle (« ${nomVisuel.valeur} ») diffère de la MRZ (« ${lu.nom} ») : la MRZ est retenue.`);
  }

  return { nature: "PASSEPORT", moteur: MOTEUR_PASSEPORT, local: true, faits: dedoublonner(faits), notes };
}
