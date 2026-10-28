import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { DOCUMENT_CATEGORY } from "@/lib/labels";
import { AD_PRO_ENTITY_TYPE, AD_PRO_KINDS, type AdProKind } from "./unified";
import {
  AD_PRO_DOC_CATEGORIES, AD_PRO_ENTITY_TYPES, PROMO_MATERIAL_DOC_CATEGORIES, categoriesDePieces,
} from "./doc-categories";

const RACINE = path.join(process.cwd(), "src", "app", "(app)");

/** Tous les `.tsx` d'écran, lus une fois. */
function fichiersEcran(): { chemin: string; texte: string }[] {
  const out: { chemin: string; texte: string }[] = [];
  const marcher = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) marcher(p);
      else if (e.name.endsWith(".tsx")) out.push({ chemin: path.relative(process.cwd(), p), texte: fs.readFileSync(p, "utf8") });
    }
  };
  marcher(RACINE);
  return out;
}

describe("les catégories de pièces du pôle Ad & Pro", () => {
  it("chaque catégorie annoncée EXISTE dans la table canonique", () => {
    // Ce qui le ferait tomber : une faute de frappe. Le téléverseur rendrait une option dont le
    // libellé est la CLÉ brute (`PURCHASE_ORDR`), et la pièce serait classée sous une catégorie
    // qu'aucun autre écran ne sait afficher.
    for (const c of [...AD_PRO_DOC_CATEGORIES, ...PROMO_MATERIAL_DOC_CATEGORIES]) {
      expect(DOCUMENT_CATEGORY[c], c).toBeTruthy();
    }
  });

  it("AUCUNE catégorie de dossier réglementaire n'entre dans une demande Ad & Pro", () => {
    // LE DÉFAUT EXACT QUE CE MODULE FERME : « CTD complet » proposé sur la fiche d'un événement.
    // Ce qui le ferait tomber : élargir la liste « pour ne rien exclure » — c'est le repli sur la
    // table entière, c'est-à-dire le défaut d'origine obtenu par l'autre bout.
    const reglementaires = ["CTD_FULL", "MODULE_1", "MODULE_5", "GMP_CERTIFICATE", "CPP", "ORIGIN_AMM", "REGISTRATION_DECISION"];
    for (const c of reglementaires) {
      expect(DOCUMENT_CATEGORY[c], `${c} doit exister pour que ce cas mesure quelque chose`).toBeTruthy();
      expect(AD_PRO_DOC_CATEGORIES, c).not.toContain(c);
      expect(PROMO_MATERIAL_DOC_CATEGORIES, c).not.toContain(c);
    }
  });

  it("les quatre pièces NOMMÉES par la Direction sont proposées", () => {
    // « C'est facture, bon de commande, demandes, convention etc. » (22/09/2026). Le bon de
    // commande manquait des deux côtés de la prise en charge — il n'existait que sur le matériel
    // promotionnel.
    for (const c of ["INVOICE", "PURCHASE_ORDER", "REQUEST_LETTER", "CONVENTION"]) {
      expect(AD_PRO_DOC_CATEGORIES, c).toContain(c);
    }
  });

  it("la chaîne d'ACHAT et la prise en charge ne proposent pas les mêmes pièces", () => {
    // Deux listes, et c'est délibéré : un « visa publicitaire » n'a pas de sens sur un congrès,
    // une « convention » n'en a pas sur une brochure. Ce qui le ferait tomber : les fondre — un
    // menu qui propose tout n'aide plus à classer.
    expect(PROMO_MATERIAL_DOC_CATEGORIES).toContain("AD_VISA");
    expect(AD_PRO_DOC_CATEGORIES).not.toContain("AD_VISA");
    expect(AD_PRO_DOC_CATEGORIES).toContain("CONVENTION");
    expect(PROMO_MATERIAL_DOC_CATEGORIES).not.toContain("CONVENTION");
  });

  it("CHAQUE nature du registre obtient une liste NON VIDE — y compris une huitième ajoutée demain", () => {
    // Dérivé du registre canonique et non d'une table écrite à la main : c'est ce qui fait qu'une
    // nature ajoutée à `AD_PRO_KINDS` ne peut pas se retrouver sans liste, en silence (§118.73).
    for (const spec of AD_PRO_KINDS) {
      const liste = categoriesDePieces(spec.kind);
      expect(liste.length, spec.kind).toBeGreaterThan(0);
      for (const c of liste) expect(DOCUMENT_CATEGORY[c], `${spec.kind} → ${c}`).toBeTruthy();
    }
    // Le matériel promotionnel est la SEULE nature à recevoir l'autre liste. Sans cette moitié,
    // un aiguillage qui rendrait la liste d'achat à tout le monde passerait au vert.
    for (const spec of AD_PRO_KINDS) {
      const attendue = spec.kind === "PROMO_MATERIAL" ? PROMO_MATERIAL_DOC_CATEGORIES : AD_PRO_DOC_CATEGORIES;
      expect(categoriesDePieces(spec.kind), spec.kind).toBe(attendue);
    }
  });

  it("les types d'entité du pôle viennent du registre, sans en perdre un", () => {
    expect([...AD_PRO_ENTITY_TYPES].sort()).toEqual(Object.values(AD_PRO_ENTITY_TYPE).sort());
    expect(AD_PRO_ENTITY_TYPES.length).toBe(AD_PRO_KINDS.length);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CLIQUET D'ÉCRAN — parce que réparer trois fiches à la main ne protège pas la septième.
 *
 * Le défaut n'était pas une liste fausse : c'était l'ABSENCE de liste, sur trois écrans du pôle.
 * Le repli du téléverseur est la table entière — donc l'oubli est SILENCIEUX et ne se voit qu'en
 * ouvrant le menu. On s'arme donc sur un fait du CODE (un `DocumentUpload` dont l'`entityType`
 * est une entité du pôle) et sur le registre CANONIQUE des natures (§118.17, §118.58).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
describe("aucune fiche Ad & Pro ne laisse son téléverseur sans liste", () => {
  it("tout DocumentUpload d'une entité du pôle porte `categories`", () => {
    const manquants: string[] = [];
    const vus = new Set<string>();
    for (const { chemin, texte } of fichiersEcran()) {
      // Une balise à la fois : chercher `categories` dans tout le FICHIER laisserait passer un
      // second téléverseur ajouté dans un fichier déjà conforme (§118.141e).
      for (const balise of texte.match(/<DocumentUpload[\s\S]*?\/>/g) ?? []) {
        const t = balise.match(/entityType="([A-Z_]+)"/);
        if (!t || !AD_PRO_ENTITY_TYPES.includes(t[1])) continue;
        vus.add(t[1]);
        if (!/\bcategories=/.test(balise)) manquants.push(`${chemin} → ${t[1]}`);
      }
      // LA CARTE DES DÉTAILS (§118.204, 04/10) : sur les fiches à postes, le dépôt de la demande passe par
      // `CarteDetailsDemande`, dont le téléverseur prend la liste DANS l'objet `pieces` — c'est là que
      // la liste doit être nommée, sans quoi ce cliquet ne verrait plus ces quatre fiches.
      for (const m of texte.matchAll(/<CarteDetailsDemande[\s\S]*?pieces=\{\{([\s\S]*?)\}\}/g)) {
        const t = m[1].match(/entityType:\s*"([A-Z_]+)"/);
        if (!t || !AD_PRO_ENTITY_TYPES.includes(t[1])) continue;
        vus.add(t[1]);
        if (!/\bcategories:/.test(m[1])) manquants.push(`${chemin} → ${t[1]} (carte des détails)`);
      }
      // LES PRISES EN CHARGE (audit n° 18) : la page passe ses pièces à la vue détaillée, qui monte la carte.
      // Depuis le 07/10, c'est « La prise en charge » (`CartePriseEnCharge`) qui reçoit ces pièces (`pieces={{ … }}`).
      for (const m of texte.matchAll(/(?:piecesJointes|<CartePriseEnCharge[\s\S]*?pieces)=\{\{([\s\S]*?)\}\}/g)) {
        const t = m[1].match(/entityType:\s*"([A-Z_]+)"/);
        if (!t || !AD_PRO_ENTITY_TYPES.includes(t[1])) continue;
        vus.add(t[1]);
        if (!/\bcategories:/.test(m[1])) manquants.push(`${chemin} → ${t[1]} (pièces de la vue détaillée)`);
      }
    }
    expect(manquants, "sans liste, le menu propose « CTD complet » sur une facture de traiteur").toEqual([]);
    // LA PRÉMISSE : sans elle, un parcours cassé rendrait ce cas vert en ne trouvant RIEN
    // (§118.104). Mesuré au 22/09/2026 : les 7 entités du pôle ont chacune leur écran.
    expect(vus.size, "aucune fiche du pôle trouvée — le parcours des écrans est cassé").toBeGreaterThanOrEqual(7);
  });

  it("ces écrans lisent la liste PARTAGÉE, ils n'en réécrivent pas une", () => {
    // La copie locale du sponsoring était identique mot pour mot à celle des congrès, et n'attendait
    // qu'une catégorie ajoutée d'un seul côté pour diverger (§118.5). Ce qui le ferait tomber :
    // réintroduire une liste littérale de catégories sur une fiche du pôle.
    //
    // LE JUGEMENT EST PAR BALISE, et c'est ce qui le rend honnête. Une première version cherchait
    // un littéral n'importe où dans un fichier qui contient un `DocumentUpload` : elle accusait
    // le PCH, le Drive et Regulatory, dont les listes propres sont parfaitement légitimes —
    // l'assertion mesurait tout le dépôt en annonçant qu'elle mesurait le pôle (§118.111).
    const fautifs: string[] = [];
    for (const { chemin, texte } of fichiersEcran()) {
      for (const balise of texte.match(/<DocumentUpload[\s\S]*?\/>/g) ?? []) {
        const t = balise.match(/entityType="([A-Z_]+)"/);
        if (!t || !AD_PRO_ENTITY_TYPES.includes(t[1])) continue;
        if (/categories=\{\s*\[\s*"[A-Z_]+"/.test(balise)) fautifs.push(`${chemin} → ${t[1]}`);
      }
      for (const m of texte.matchAll(/<CarteDetailsDemande[\s\S]*?pieces=\{\{([\s\S]*?)\}\}/g)) {
        const t = m[1].match(/entityType:\s*"([A-Z_]+)"/);
        if (!t || !AD_PRO_ENTITY_TYPES.includes(t[1])) continue;
        if (/categories:\s*\[\s*"[A-Z_]+"/.test(m[1])) fautifs.push(`${chemin} → ${t[1]} (carte des détails)`);
      }
    }
    expect(fautifs, "la liste se lit dans `ad-pro/doc-categories.ts`").toEqual([]);
  });
});
