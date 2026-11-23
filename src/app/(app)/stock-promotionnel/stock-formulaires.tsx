"use client";

import * as React from "react";
import { Sheet } from "@/components/ui/sheet";
import { RecordForm, type FieldDef } from "@/components/shared/create-record-button";
import type { ActionResult } from "@/lib/actions/types";
import { FAMILLE_LABEL, familleAValidite, familleQuantifiee } from "@/lib/promo/catalogue";
import { MOVEMENT_LABEL } from "@/lib/promo/stock";
import { peutTransfererVers, type FaitsStock } from "@/lib/promo/stock-acces";
import {
  CIBLE_COMPTAGE_LABEL, FREQUENCES_COMPTAGE, FREQUENCE_COMPTAGE_LABEL, libelleFamilleComptage,
  peutDemanderAEquipe, peutDemanderComptage, type CibleComptage,
} from "@/lib/promo/comptages";
import type {
  ArticleVue, ComptageVue, DemandeVue, LotVue, MouvementVue, PageStock, RefonteVue, SupportVue, TransfertVue,
} from "@/lib/queries/promo-stock";
import { annulerComptage, deciderRefonte, demanderComptage, planifierComptage, proposerRefonte } from "@/lib/actions/promo-comptage-actions";
import {
  annulerMouvement, annulerTransfert, confirmerReception, corrigerInventaire, declarerPerte, declarerSupportNumerique,
  demanderMateriel, doter, entrerEnStock, modifierArticleStock, modifierLot, poserInventaireOuverture, refuserDemande,
  refuserReception, servirDemande, transferer,
} from "@/lib/actions/promo-stock-actions";
import { date, distribuable, enLotPerime, jour, nombre, nomDe, quantiteDe } from "./stock-commun";
import { FormulaireRepartir } from "./stock-repartir";

/**
 * LES GESTES DU STOCK QUI DEMANDENT UNE SAISIE — un panneau, un formulaire canonique (`RecordForm` :
 * verrou anti double envoi, chronomètre, erreur rendue telle que l'action la dit).
 *
 * Le panneau ne décide d'AUCUN droit : il n'est ouvert que par un bouton que la vue a montré après
 * avoir interrogé la règle pure (`promo/stock-acces.ts`), et l'action relit cette même règle. Les
 * seules listes calculées ici — les destinataires d'un transfert — passent par le même prédicat
 * (`peutTransfererVers`) que l'action : proposer une personne que l'action refusera serait une
 * fausse promesse (§118.83).
 */

export type Dialogue =
  | { type: "doter"; article: ArticleVue }
  /** RÉPARTIR un article du magasin entre plusieurs personnes — un formulaire à lui (`stock-repartir.tsx`). */
  | { type: "repartir"; article: ArticleVue }
  | { type: "transferer"; article: ArticleVue; deId: string; retour: boolean }
  | { type: "perte"; article: ArticleVue; detenteurId: string | null }
  | { type: "corriger"; article: ArticleVue; detenteurId: string | null }
  | { type: "fiche"; article: ArticleVue }
  | { type: "ficheSupport"; support: SupportVue }
  | { type: "lot"; article: ArticleVue; lot: LotVue }
  | { type: "entrer" }
  | { type: "ouverture" }
  | { type: "support" }
  | { type: "demander"; itemId?: string }
  | { type: "servir"; demande: DemandeVue }
  | { type: "refuserDemande"; demande: DemandeVue }
  | { type: "recuEnPartie"; transfert: TransfertVue }
  | { type: "refuserReception"; transfert: TransfertVue }
  | { type: "annulerTransfert"; transfert: TransfertVue }
  | { type: "annulerMouvement"; article: ArticleVue; mouvement: MouvementVue }
  | { type: "demanderComptage" }
  | { type: "planifierComptage" }
  | { type: "annulerComptage"; comptage: ComptageVue }
  | { type: "proposerRefonte"; article: ArticleVue }
  | { type: "deciderRefonte"; refonte: RefonteVue; decision: "RETENUE" | "ECARTEE" };

interface Definition {
  titre: string;
  description?: string;
  champs: FieldDef[];
  action: (fd: FormData) => Promise<ActionResult>;
  bouton: string;
  /** La phrase de succès quand l'action n'en rend pas. */
  succes: string;
}

const NOTE: FieldDef = { type: "textarea", name: "note", label: "Note (facultative)" };

function optionsCatalogue(page: PageStock, numerique: boolean) {
  return page.catalogue
    .filter((c) => familleQuantifiee(c.famille) !== numerique)
    .map((c) => ({
      value: c.id,
      label: `${c.reference} — ${c.nom} (${FAMILLE_LABEL[c.famille]}${c.exigeProduit ? ", par produit" : ""})`,
    }));
}

/**
 * La SOCIÉTÉ d'un article saisi. Une seule société ouverte : elle va de soi, on la porte sans la
 * demander. Plusieurs : on la demande. Aucune : l'article n'est rattaché à aucune (le serveur
 * revérifie que la société proposée est bien ouverte à la personne).
 */
function champSociete(page: PageStock): FieldDef[] {
  if (page.societes.length === 0) return [];
  if (page.societes.length === 1) return [{ type: "hidden", name: "companyId", value: page.societes[0].value }];
  return [{ type: "select", name: "companyId", label: "Société", options: page.societes, required: true, defaultValue: page.societes[0].value }];
}

function champProduits(page: PageStock): FieldDef {
  return {
    type: "multiselect", name: "produitIds", label: "Produit(s) concerné(s)",
    options: page.produitsOptions.map((p) => ({ value: p.id, label: p.nom })),
    hint: "Obligatoire pour un article « par produit » (fiche posologique, aide de visite…) ; vide pour un support générique (stylo, bloc-notes).",
    searchPlaceholder: "Rechercher un produit…",
    emptyLabel: "Aucun produit actif dans le référentiel.",
  };
}

/** « AAAA-MM-JJ » dans `n` jours, compté en UTC — la date que le serveur relit. */
function dansJours(page: PageStock, n: number): string {
  const d = new Date(page.maintenant);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + n)).toISOString().slice(0, 10);
}

/**
 * À QUI DEMANDER UN COMPTAGE — seulement les cibles que la RÈGLE ouvre à la personne, et pour une
 * personne, seulement celles de `peutFaireCompter` (la même règle, côté serveur). Proposer « le
 * magasin » à qui n'a pas la vue globale serait proposer un geste que l'action refuse (§118.83).
 */
function champsCibleComptage(page: PageStock, f: FaitsStock): FieldDef[] {
  const cibles: CibleComptage[] = [];
  if (page.peutFaireCompter.length > 0) cibles.push("PERSONNE");
  if (peutDemanderAEquipe(f)) cibles.push("EQUIPE");
  if (peutDemanderComptage(f, null)) cibles.push("MAGASIN");
  return [
    {
      type: "select", name: "cible", label: "Qui compte", required: true, defaultValue: cibles[0],
      options: cibles.map((c) => ({ value: c, label: CIBLE_COMPTAGE_LABEL[c] })),
      hint: "« Toute mon équipe » : un comptage par personne qui a le stock — l'équipe est relue à chaque fois.",
    },
    {
      type: "select", name: "holderId", label: "La personne (si « Une personne »)", placeholder: "Choisir la personne",
      options: page.peutFaireCompter.map((p) => ({ value: p.id, label: p.nom })),
    },
    {
      type: "select", name: "famille", label: "Quoi compter", defaultValue: "",
      options: [
        { value: "", label: "Tout le matériel" },
        { value: "CONSOMMABLE", label: "Les consommables" },
        { value: "DURABLE", label: "Les durables" },
      ],
    },
  ];
}

function definition(d: Exclude<Dialogue, { type: "repartir" }>, page: PageStock, f: FaitsStock): Definition {
  switch (d.type) {
    case "demanderComptage":
      return {
        titre: "Demander un comptage",
        description: "La personne compte ce qu'elle a réellement en main ; chaque écart avec le registre est corrigé, et vous recevez le résultat.",
        champs: [
          ...champsCibleComptage(page, f),
          { type: "date", name: "echeance", label: "À saisir avant le", required: true, defaultValue: dansJours(page, 7) },
          { type: "textarea", name: "note", label: "Note pour la personne (facultative)" },
        ],
        action: demanderComptage,
        bouton: "Demander",
        succes: "Comptage demandé.",
      };
    case "planifierComptage":
      return {
        titre: "Planifier un comptage régulier",
        description: "Il repart seul à chaque échéance, à 8 h. Si vous perdez le droit de le demander (équipe ou rôle changés), il se met en pause et vous en êtes prévenu.",
        champs: [
          ...champsCibleComptage(page, f),
          {
            type: "select", name: "frequence", label: "Cadence", required: true, defaultValue: "MENSUEL",
            options: FREQUENCES_COMPTAGE.map((x) => ({ value: x, label: FREQUENCE_COMPTAGE_LABEL[x] })),
          },
          { type: "date", name: "premiereLe", label: "Premier comptage le", required: true, defaultValue: dansJours(page, 1) },
          { type: "number", name: "delaiJours", label: "Jours pour compter", defaultValue: 7, hint: "De 1 à 60 jours après chaque déclenchement." },
          { type: "textarea", name: "note", label: "Note pour la personne (facultative)" },
        ],
        action: planifierComptage,
        bouton: "Planifier",
        succes: "Comptage planifié.",
      };
    case "annulerComptage": {
      const c = d.comptage;
      return {
        titre: "Annuler ce comptage",
        description: `Comptage ${c.holderId === null ? "du magasin central" : `de ${nomDe(page, c.holderId)}`} (${libelleFamilleComptage(c.famille)}), attendu le ${jour(c.echeance)}. La personne en est prévenue.`,
        champs: [
          { type: "hidden", name: "comptageId", value: c.id },
          { type: "textarea", name: "motif", label: "Pourquoi", required: true, placeholder: "Inventaire déjà fait, demande en double…" },
        ],
        action: annulerComptage,
        bouton: "Annuler le comptage",
        succes: "Comptage annulé.",
      };
    }
    case "proposerRefonte":
      return {
        titre: `Proposer une refonte — ${d.article.libelle}`,
        description: "La Direction Marketing la lit, puis la retient ou l'écarte ; vous en êtes prévenu.",
        champs: [
          { type: "hidden", name: "itemId", value: d.article.id },
          { type: "textarea", name: "motif", label: "Ce qui ne va pas", required: true, placeholder: "Toile usée, visuel dépassé, mentions à mettre à jour, format inadapté au stand…" },
        ],
        action: proposerRefonte,
        bouton: "Proposer",
        succes: "Proposition envoyée.",
      };
    case "deciderRefonte": {
      const r = d.refonte;
      const retenir = d.decision === "RETENUE";
      return {
        titre: retenir ? `Retenir la refonte — ${r.libelle}` : `Écarter la refonte — ${r.libelle}`,
        description: `Proposée par ${nomDe(page, r.auteurId)} : « ${r.motif} ». ${retenir ? "Retenir ne commande rien : la commande passe ensuite par le circuit d'achat." : "La personne qui l'a proposée lit votre réponse."}`,
        champs: [
          { type: "hidden", name: "refonteId", value: r.id },
          { type: "hidden", name: "decision", value: d.decision },
          { type: "textarea", name: "note", label: retenir ? "Note (facultative)" : "Pourquoi", required: !retenir },
        ],
        action: deciderRefonte,
        bouton: retenir ? "Retenir" : "Écarter",
        succes: retenir ? "Refonte retenue." : "Refonte écartée.",
      };
    }
    case "doter": {
      const a = d.article;
      const dispo = distribuable(a, null);
      return {
        titre: `Doter — ${a.libelle}`,
        description: "La personne le voit « en route » et confirme la réception : rien n'entre dans son stock avant.",
        champs: [
          { type: "hidden", name: "itemId", value: a.id },
          {
            type: "select", name: "versId", label: "Personne dotée", required: true, placeholder: "Choisir la personne",
            options: page.destinataires.map((p) => ({ value: p.id, label: p.nom })),
            hint: "Seules les personnes qui ont le stock promotionnel peuvent confirmer une réception.",
          },
          { type: "number", name: "quantite", label: `Quantité (${a.catalogue.unite})`, required: true, hint: `Distribuable au magasin : ${nombre(dispo)} (hors lots périmés).` },
          NOTE,
        ],
        action: doter,
        bouton: "Envoyer",
        succes: "Dotation en route.",
      };
    }
    case "transferer": {
      const a = d.article;
      const dispo = distribuable(a, d.deId);
      const depuisAutrui = d.deId !== f.userId;
      const options = page.destinataires
        .filter((p) => p.id !== d.deId && peutTransfererVers(f, d.deId, p.id))
        .map((p) => ({ value: p.id, label: p.id === f.userId ? `${p.nom} (moi)` : p.nom }));
      const source = depuisAutrui ? `Depuis le stock de ${nomDe(page, d.deId)} — il en est prévenu. ` : "";
      return d.retour
        ? {
            titre: `Rendre au magasin — ${a.libelle}`,
            description: `${source}Le magasin confirme l'arrivée ; jusque-là le matériel est « en route ».`,
            champs: [
              { type: "hidden", name: "itemId", value: a.id },
              { type: "hidden", name: "deId", value: d.deId },
              { type: "hidden", name: "versId", value: "" },
              { type: "number", name: "quantite", label: `Quantité (${a.catalogue.unite})`, required: true, defaultValue: dispo || undefined, hint: `Distribuable : ${nombre(dispo)}.` },
              NOTE,
            ],
            action: transferer,
            bouton: "Rendre au magasin",
            succes: "Retour en route vers le magasin.",
          }
        : {
            titre: `Transférer — ${a.libelle}`,
            description: `${source}Le destinataire confirme la réception ; jusque-là le matériel est « en route ».`,
            champs: [
              { type: "hidden", name: "itemId", value: a.id },
              { type: "hidden", name: "deId", value: d.deId },
              {
                type: "select", name: "versId", label: "Destinataire", required: true, placeholder: options.length ? "Choisir le destinataire" : "Aucun destinataire possible",
                options,
                hint: depuisAutrui && !f.superAdmin ? "Le matériel de vos équipes se déplace à l'intérieur de vos équipes, vers vous, ou se rend au magasin." : undefined,
              },
              { type: "number", name: "quantite", label: `Quantité (${a.catalogue.unite})`, required: true, hint: `Distribuable : ${nombre(dispo)}.` },
              NOTE,
            ],
            action: transferer,
            bouton: "Transférer",
            succes: "Transfert en route.",
          };
    }
    case "perte": {
      const a = d.article;
      const tenu = quantiteDe(a, d.detenteurId);
      const perime = enLotPerime(a, d.detenteurId);
      const lots = new Map(a.lots.map((l) => [l.id, l]));
      const options = (a.soldes.find((s) => s.detenteurId === d.detenteurId)?.parLot ?? [])
        .filter((p) => p.quantite > 0)
        .map((p) => {
          const l = lots.get(p.lotId);
          const etat = l?.etat === "PERIME" ? " — périmé" : l?.etat === "BIENTOT" ? " — expire bientôt" : "";
          return { value: p.lotId, label: `Lot ${l?.numero ?? "?"} · ${nombre(p.quantite)}${l?.valableJusquau ? ` · jusqu'au ${jour(l.valableJusquau)}` : ""}${etat}` };
        });
      return {
        titre: `Déclarer une perte — ${a.libelle}`,
        description: `${d.detenteurId === null ? "Magasin central" : `Stock de ${nomDe(page, d.detenteurId)}`} : ${nombre(tenu)} en main${perime > 0 ? `, dont ${nombre(perime)} dans un lot périmé` : ""}. Casse, perte, lot périmé détruit : la perte sort du stock, avec son motif. Un article REMIS à un médecin n'est pas une perte : il se dit dans le rapport de visite, ou sur le poste « Matériel du stock » de la demande Ad & Pro.`,
        champs: [
          { type: "hidden", name: "itemId", value: a.id },
          { type: "hidden", name: "detenteurId", value: d.detenteurId ?? "" },
          ...(options.length > 1
            ? [{ type: "select", name: "lotId", label: "Lot", options, placeholder: "Automatique — les lots périmés d'abord, puis le plus tôt périmé" } as FieldDef]
            : []),
          { type: "number", name: "quantite", label: `Quantité perdue (${a.catalogue.unite})`, required: true },
          { type: "textarea", name: "motif", label: "Ce qui s'est passé", required: true, placeholder: "Casse au congrès, carton perdu, lot périmé détruit…" },
        ],
        action: declarerPerte,
        bouton: "Déclarer la perte",
        succes: "Perte enregistrée.",
      };
    }
    case "corriger": {
      const a = d.article;
      return {
        titre: `Corriger l'inventaire — ${a.libelle}`,
        description: `${d.detenteurId === null ? "Magasin central" : `Stock de ${nomDe(page, d.detenteurId)}`} — solde au registre : ${nombre(quantiteDe(a, d.detenteurId))} ${a.catalogue.unite}. Indiquez ce que vous avez COMPTÉ : l'écart s'écrit comme une correction, avec son motif.`,
        champs: [
          { type: "hidden", name: "itemId", value: a.id },
          { type: "hidden", name: "detenteurId", value: d.detenteurId ?? "" },
          { type: "number", name: "compte", label: `Quantité comptée (${a.catalogue.unite})`, required: true },
          { type: "textarea", name: "motif", label: "D'où vient l'écart", required: true, placeholder: "Comptage du jour, carton retrouvé…" },
        ],
        action: corrigerInventaire,
        bouton: "Corriger",
        succes: "Inventaire corrigé.",
      };
    }
    case "fiche": {
      const a = d.article;
      return {
        titre: `Fiche — ${a.libelle}`,
        description: "La quantité ne se saisit jamais ici : elle se calcule à partir des mouvements.",
        champs: [
          { type: "hidden", name: "id", value: a.id },
          { type: "number", name: "alertThreshold", label: "Seuil d'alerte (magasin)", defaultValue: a.alertThreshold ?? undefined, hint: "Sous ce nombre, l'article est signalé « stock bas ». Vide : seule la rupture est signalée." },
          { type: "text", name: "location", label: "Emplacement au magasin", defaultValue: a.location ?? undefined, placeholder: "Étagère B3, réserve du 2ᵉ…" },
          {
            type: "select", name: "isActive", label: "Statut", defaultValue: a.isActive ? "true" : "false",
            options: [{ value: "true", label: "Actif" }, { value: "false", label: "Archivé" }],
            hint: "Un article ne s'archive qu'à stock nul, sans transfert en route ni demande ouverte.",
          },
          { type: "textarea", name: "notes", label: "Notes", defaultValue: a.notes ?? undefined },
        ],
        action: modifierArticleStock,
        bouton: "Enregistrer",
        succes: "Fiche enregistrée.",
      };
    }
    case "ficheSupport": {
      const s = d.support;
      return {
        titre: `Support numérique — ${s.libelle}`,
        champs: [
          { type: "hidden", name: "id", value: s.id },
          { type: "text", name: "lien", label: "Lien", defaultValue: s.lien ?? undefined, placeholder: "https://…", full: true },
          { type: "date", name: "valableJusquau", label: "Valable jusqu'au", defaultValue: s.valableJusquau?.slice(0, 10) },
          {
            type: "select", name: "isActive", label: "Statut", defaultValue: s.isActive ? "true" : "false",
            options: [{ value: "true", label: "En service" }, { value: "false", label: "Archivé" }],
          },
          { type: "textarea", name: "notes", label: "Notes", defaultValue: s.notes ?? undefined },
        ],
        action: modifierArticleStock,
        bouton: "Enregistrer",
        succes: "Support enregistré.",
      };
    }
    case "lot": {
      const { article: a, lot } = d;
      const avecValidite = familleAValidite(a.catalogue.famille);
      return {
        titre: `Lot ${lot.numero} — ${a.libelle}`,
        description: `Reçu le ${jour(lot.recuLe)}. Ce qui se trouve dans le lot ne change pas ici.`,
        champs: [
          { type: "hidden", name: "lotId", value: lot.id },
          ...(avecValidite
            ? [{ type: "date", name: "valableJusquau", label: "Valable jusqu'au", defaultValue: lot.valableJusquau?.slice(0, 10), hint: "Inclusif : le lot se distribue encore ce jour-là." } as FieldDef]
            : []),
          { type: "number", name: "coutUnitaire", label: "Coût unitaire (DZD)", defaultValue: lot.coutUnitaire ?? undefined },
          { type: "text", name: "libelle", label: "Libellé du lot", defaultValue: lot.libelle ?? undefined, placeholder: "Impression mars 2026…" },
        ],
        action: modifierLot,
        bouton: "Enregistrer",
        succes: "Lot enregistré.",
      };
    }
    case "entrer":
      return {
        titre: "Entrée manuelle au magasin",
        description: "Don, retour fournisseur, stock retrouvé : une entrée sans facture ni transfert. Elle crée un lot, qui garde sa date, son coût et sa fin de validité. Un support absent de la liste : choisissez « Autre article », il est ajouté au catalogue.",
        champs: [
          {
            type: "select", name: "catalogueId", label: "Article du catalogue", required: true, placeholder: "Choisir l'article", full: true,
            options: [...optionsCatalogue(page, false), { value: "AUTRE", label: "Autre article — absent du catalogue" }],
          },
          // Ajouté au catalogue sous une référence CAT-…, ou retrouvé s'il y est déjà sous ce nom.
          { type: "text", name: "autreNom", label: "Nom du nouvel article (si « Autre article »)", placeholder: "Porte-badge, kakémono 85×200…" },
          {
            type: "select", name: "autreFamille", label: "Famille du nouvel article (si « Autre article »)", defaultValue: "CONSOMMABLE",
            options: [{ value: "CONSOMMABLE", label: FAMILLE_LABEL.CONSOMMABLE }, { value: "DURABLE", label: FAMILLE_LABEL.DURABLE }],
            hint: "Les produits choisis ci-dessous en font un article « par produit ».",
          },
          champProduits(page),
          ...champSociete(page),
          { type: "number", name: "quantite", label: "Quantité", required: true },
          { type: "date", name: "valableJusquau", label: "Valable jusqu'au", hint: "Consommables seulement — un durable ne périme pas." },
          { type: "number", name: "coutUnitaire", label: "Coût unitaire (DZD)" },
          { type: "text", name: "libelleLot", label: "Libellé du lot", placeholder: "Don du laboratoire, réimpression…" },
          { type: "textarea", name: "motif", label: "D'où vient ce matériel", required: true },
        ],
        action: entrerEnStock,
        bouton: "Entrer au magasin",
        succes: "Entrée enregistrée.",
      };
    case "ouverture":
      return {
        titre: "Inventaire d'ouverture",
        description: "Une fois par article et par détenteur : ce qui existait avant le registre — au magasin, ou déjà en main chez quelqu'un. Ensuite, un solde ne bouge plus que par des mouvements.",
        champs: [
          { type: "select", name: "catalogueId", label: "Article du catalogue", required: true, placeholder: "Choisir l'article", options: optionsCatalogue(page, false), full: true },
          champProduits(page),
          ...champSociete(page),
          {
            type: "select", name: "detenteurId", label: "Chez qui", defaultValue: "",
            options: [{ value: "", label: "Magasin central" }, ...page.destinataires.map((p) => ({ value: p.id, label: p.nom }))],
          },
          { type: "number", name: "quantite", label: "Quantité comptée", required: true, hint: "Zéro compris : un zéro compté est une information." },
          { type: "date", name: "valableJusquau", label: "Valable jusqu'au", hint: "Consommables seulement." },
          { type: "textarea", name: "motif", label: "Note", placeholder: "Inventaire d'ouverture" },
        ],
        action: poserInventaireOuverture,
        bouton: "Poser l'inventaire",
        succes: "Inventaire d'ouverture posé.",
      };
    case "support":
      return {
        titre: "Déclarer un support numérique",
        description: "E-flyer, vidéo, e-ADV : pas de quantité — un lien et une période de validité.",
        champs: [
          { type: "select", name: "catalogueId", label: "Article du catalogue", required: true, placeholder: "Choisir l'article", options: optionsCatalogue(page, true), full: true },
          champProduits(page),
          ...champSociete(page),
          { type: "text", name: "lien", label: "Lien", placeholder: "https://…", full: true },
          { type: "date", name: "valableJusquau", label: "Valable jusqu'au" },
        ],
        action: declarerSupportNumerique,
        bouton: "Déclarer",
        succes: "Support déclaré.",
      };
    case "demander":
      return {
        titre: "Demander du matériel au magasin",
        description: "La directrice de la Direction Marketing (ou le Super Admin) la sert en une dotation, que vous confirmerez à réception.",
        champs: [
          {
            type: "select", name: "itemId", label: "Article", required: true, placeholder: "Choisir l'article", defaultValue: d.itemId,
            options: page.demandables.map((a) => ({ value: a.id, label: a.libelle })), full: true,
          },
          { type: "number", name: "quantite", label: "Quantité", required: true },
          { type: "textarea", name: "note", label: "Pour quoi faire (facultatif)", placeholder: "Tournée de la semaine prochaine, congrès…" },
        ],
        action: demanderMateriel,
        bouton: "Envoyer la demande",
        succes: "Demande envoyée.",
      };
    case "servir": {
      const dm = d.demande;
      const a = page.articles.find((x) => x.id === dm.itemId);
      const dispo = a ? distribuable(a, null) : 0;
      return {
        titre: `Servir la demande de ${nomDe(page, dm.demandeurId)}`,
        description: `${dm.libelle} — demandé : ${nombre(dm.quantite)} le ${date(dm.createdAt)}.${dm.note ? ` « ${dm.note} »` : ""}`,
        champs: [
          { type: "hidden", name: "demandeId", value: dm.id },
          { type: "number", name: "quantite", label: "Quantité envoyée", required: true, defaultValue: dm.quantite, hint: `Distribuable au magasin : ${nombre(dispo)}.` },
          NOTE,
        ],
        action: servirDemande,
        bouton: "Envoyer",
        succes: "Demande servie.",
      };
    }
    case "refuserDemande": {
      const dm = d.demande;
      return {
        titre: `Refuser la demande de ${nomDe(page, dm.demandeurId)}`,
        description: `${dm.libelle} — ${nombre(dm.quantite)} demandé(s).`,
        champs: [
          { type: "hidden", name: "demandeId", value: dm.id },
          { type: "textarea", name: "note", label: "Pourquoi", required: true, placeholder: "Stock réservé au congrès, réimpression en cours…" },
        ],
        action: refuserDemande,
        bouton: "Refuser",
        succes: "Demande refusée.",
      };
    }
    case "recuEnPartie": {
      const t = d.transfert;
      return {
        titre: "Reçu en partie",
        description: `${t.libelle} — envoyé : ${nombre(t.quantite)} par ${nomDe(page, t.deId)}. Ce qui manque est signalé à l'envoyeur.`,
        champs: [
          { type: "hidden", name: "transfertId", value: t.id },
          { type: "number", name: "quantiteRecue", label: "Quantité réellement reçue", required: true, hint: `Entre 0 et ${nombre(t.quantite)}.` },
          { type: "textarea", name: "note", label: "Ce qui manque", required: true, placeholder: "Carton abîmé, 20 fiches manquantes…" },
        ],
        action: confirmerReception,
        bouton: "Confirmer ce que j'ai reçu",
        succes: "Réception confirmée.",
      };
    }
    case "refuserReception": {
      const t = d.transfert;
      return {
        titre: "Refuser la réception",
        description: `${t.libelle} — ${nombre(t.quantite)} de ${nomDe(page, t.deId)}. Tout revient à l'envoyeur, au même lot.`,
        champs: [
          { type: "hidden", name: "transfertId", value: t.id },
          { type: "textarea", name: "note", label: "Pourquoi", required: true, placeholder: "Ce n'est pas ce que j'avais demandé, matériel abîmé…" },
        ],
        action: refuserReception,
        bouton: "Refuser",
        succes: "Réception refusée.",
      };
    }
    case "annulerTransfert": {
      const t = d.transfert;
      return {
        titre: "Annuler le transfert",
        description: `${t.libelle} — ${nombre(t.quantite)} de ${nomDe(page, t.deId)} vers ${nomDe(page, t.versId)}. Tout revient à l'envoyeur ; le destinataire en est prévenu.`,
        champs: [{ type: "hidden", name: "transfertId", value: t.id }, NOTE],
        action: annulerTransfert,
        bouton: "Annuler le transfert",
        succes: "Transfert annulé.",
      };
    }
    case "annulerMouvement": {
      const m = d.mouvement;
      return {
        titre: "Annuler ce mouvement",
        description: `${MOVEMENT_LABEL[m.kind]} de ${m.delta > 0 ? "+" : ""}${nombre(m.delta)} du ${date(m.occurredAt)} (lot ${m.lotNumero}) — ${d.article.libelle}. Rien ne disparaît : l'exact inverse s'écrit, et l'original reste lisible, marqué annulé.`,
        champs: [
          { type: "hidden", name: "mouvementId", value: m.id },
          // Une annulation est un geste DÉFINITIF : elle dit pourquoi (audit 360°, R17).
          { type: "textarea", name: "motif", label: "Pourquoi", required: true, placeholder: "Saisie en double, mauvaise quantité…" },
        ],
        action: annulerMouvement,
        bouton: "Annuler le mouvement",
        succes: "Mouvement annulé.",
      };
    }
  }
}

export function FormulaireStock({
  dialogue, page, f, onClose, onSucces,
}: {
  dialogue: Dialogue;
  page: PageStock;
  f: FaitsStock;
  onClose: () => void;
  onSucces: (message: string) => void;
}) {
  // Une ligne par personne, un total en direct : une saisie que `RecordForm` ne sait pas dessiner.
  if (dialogue.type === "repartir") return <FormulaireRepartir article={dialogue.article} page={page} onClose={onClose} onSucces={onSucces} />;
  const def = definition(dialogue, page, f);
  const action = async (_prev: ActionResult | undefined, fd: FormData): Promise<ActionResult> => {
    const r = await def.action(fd);
    if (r.ok) onSucces(r.message ?? def.succes);
    return r;
  };
  return (
    <Sheet open onClose={onClose} title={def.titre} description={def.description} width="lg">
      <RecordForm fields={def.champs} action={action} onDone={onClose} onCancel={onClose} submitLabel={def.bouton} />
    </Sheet>
  );
}
