import type { Produit360 } from "./product-360";
import type { Pch360 } from "./pch-360";
import type { MetricValue } from "@/lib/metrics/catalog";
import { intentFor } from "@/platform/ia/workspace/direct-intents";
import { PAYMENT_STATUS, PCH_TENDER_STATUS, REGULATORY_STATUS } from "@/lib/labels";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * DE LA VUE MÉTIER À LA VUE 360 — la composition, faite là où les types existent.
 *
 * ── POURQUOI ICI PLUTÔT QUE CHEZ ADAM ────────────────────────────────────────────────────
 *
 * Adam reçoit la vue par le CONTRAT, qui la rend volontairement opaque (`[section: string]:
 * unknown`) : le contrat promet qu'une vue arrive, pas de quels champs elle est faite. Composer
 * l'écran de l'autre côté obligerait donc à re-deviner chaque champ à coups de `as`, c'est-à-dire
 * à réintroduire exactement l'inférence sur forme inconnue que tout ce chantier a supprimée.
 *
 * Ici, `Produit360` et `Pch360` sont typés. Un champ qui disparaît casse la compilation au lieu
 * de faire disparaître une section en silence.
 *
 * ── CE QUE ÇA NE FAIT PAS ────────────────────────────────────────────────────────────────
 *
 * Aucun calcul. Tout ce qui est affiché a déjà été calculé par `product-360`, `pch-360` et la
 * couche de métriques. Ce module RANGE — il ne recompte pas, sinon deux chemins donneraient
 * deux chiffres pour la même question, et c'est la faute la plus coûteuse d'un tableau de bord.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Md / M / k DZD — le PDG lit un ordre de grandeur, pas des centimes. */
export function dzd(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  if (a >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2).replace(".", ",")} Md`;
  if (a >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(".", ",")} M`;
  if (a >= 1_000) return `${Math.round(n / 1_000)} k`;
  return String(Math.round(n));
}

/** La valeur d'une métrique nommée, ou `null`. Le nom est celui du catalogue sémantique. */
function m(metriques: readonly MetricValue[], nom: string): number | null {
  return metriques.find((x) => x.nom === nom)?.valeur ?? null;
}

type Ton = "neutre" | "succes" | "attention" | "alerte";

/**
 * DU CODE DE BASE AU FRANÇAIS — et pourquoi ça n'est pas un détail.
 *
 * La capture 1440 de la vue produit affichait « PAID », « PARTIAL », « OVERDUE » en toutes
 * lettres dans le tableau des règlements. Ce sont des valeurs d'énumération Prisma : les
 * montrer au PDG, c'est lui demander de connaître le schéma pour lire son chiffre d'affaires.
 * Le dictionnaire existait déjà (`src/lib/labels`) et servait partout ailleurs dans l'ERP ;
 * il ne manquait qu'ici, parce que ce composeur est neuf.
 *
 * Le repli garde la valeur brute plutôt que de rendre une case vide : un code inconnu se
 * corrige, une donnée disparue ne se voit pas.
 */
function libelle(table: Record<string, { label: string; tone: string }>, code: string): string {
  return table[code]?.label ?? code;
}

/** Le ton du dictionnaire, traduit dans le vocabulaire du protocole d'affichage. */
const TON_DEPUIS_LABELS: Record<string, Ton> = {
  success: "succes", warning: "attention", danger: "alerte", info: "neutre", neutral: "neutre",
};
function ton(table: Record<string, { label: string; tone: string }>, code: string): Ton {
  return TON_DEPUIS_LABELS[table[code]?.tone ?? "neutral"] ?? "neutre";
}

/** Les statuts d'une ligne de marché — `PchLineStatus`, absent du dictionnaire général. */
const LIGNE_STATUT: Record<string, { label: string; tone: string }> = {
  PENDING: { label: "En attente", tone: "neutral" },
  QUOTED: { label: "Chiffrée", tone: "info" },
  SUBMITTED: { label: "Soumise", tone: "info" },
  WON: { label: "Gagnée", tone: "success" },
  LOST: { label: "Perdue", tone: "danger" },
};

/**
 * LA VUE 360 D'UN PRODUIT.
 *
 * QUATRE KPI EN TÊTE, DEUX SECTIONS OUVERTES. Le choix des sections ouvertes n'est pas fixe :
 * « finance » s'ouvre quand la créance est non nulle, parce qu'une section ouverte parce qu'il
 * s'y passe quelque chose vaut mieux qu'un ordre décidé une fois pour toutes.
 */
export function blocProduit360(
  vue: Produit360,
  metriques: readonly MetricValue[],
  limitesMetriques: readonly string[],
): Record<string, unknown> {
  const encaisse = m(metriques, "collectedRevenue");
  const creance = m(metriques, "outstandingReceivables");
  const attribue = m(metriques, "awardedRevenue");
  const promo = m(metriques, "adProSpend");
  const contribution = m(metriques, "productContribution");
  const retard = m(metriques, "regulatoryDelay");

  const porteurs = vue.portefeuille.filter((p) => p.enCours);
  const enCoursReglementaire = vue.profils.reglementaire.filter(
    (r) => r.statut !== "DECISION_OBTAINED" && r.statut !== "REJECTED" && r.statut !== "ABANDONED",
  );

  // La créance ouverte est la seule chose qui doit s'ouvrir SANS qu'on la cherche.
  const financeUrgente = (creance ?? 0) > 0;

  return {
    kind: "entity360",
    title: vue.produit.nom,
    subtitle: [vue.produit.dci, vue.produit.dosage, vue.produit.forme].filter(Boolean).join(" · ") || null,
    badges: [
      { label: vue.produit.code, ton: "neutre" },
      { label: vue.produit.actif ? "Actif" : "Inactif", ton: vue.produit.actif ? "succes" : "attention" },
      ...(vue.produit.entite ? [{ label: vue.produit.entite, ton: "neutre" as Ton }] : []),
    ],
    kpis: [
      { valeur: dzd(encaisse), label: "Encaissé (12 m)", ton: "succes" },
      { valeur: dzd(creance), label: "Créance ouverte", ton: (creance ?? 0) > 0 ? "attention" : "neutre" },
      { valeur: dzd(attribue), label: "Attribué sur marchés", ton: "neutre" },
      { valeur: contribution === null ? "—" : dzd(contribution), label: "Contribution", ton: (contribution ?? 0) < 0 ? "alerte" : "neutre" },
    ],
    sections: [
      {
        id: "reglementaire",
        label: `Réglementaire — ${vue.profils.reglementaire.length} dossier(s)`,
        ouvert: !financeUrgente && enCoursReglementaire.length > 0,
        items: vue.profils.reglementaire.slice(0, 10).map((r) => ({
          titre: r.reference,
          detail: [r.nomCommercial, r.chargeDuDossier].filter(Boolean).join(" · ") || null,
          statut: libelle(REGULATORY_STATUS, r.statut),
          echeance: r.cibleEnregistrement ?? r.cibleDepot,
        })),
        note: retard === null
          ? "Aucun retard calculable : les dates cibles ne sont pas toutes renseignées."
          : `Retard réglementaire moyen : ${Math.round(retard)} jour(s).`,
      },
      {
        id: "finance",
        label: "Finance",
        ouvert: financeUrgente,
        fields: [
          { label: "Ventes enregistrées", value: String(vue.ventes.nombre) },
          { label: "Chiffre d'affaires", value: `${dzd(vue.ventes.chiffreAffairesDzd)} DZD` },
          { label: "Créance ouverte", value: `${dzd(creance)} DZD`, ton: (creance ?? 0) > 0 ? "attention" : "neutre" },
          { label: "Première vente", value: vue.ventes.premiere ?? "—" },
          { label: "Dernière vente", value: vue.ventes.derniere ?? "—" },
        ],
        table: vue.ventes.parStatutDeReglement.length > 0 ? {
          columns: [
            { key: "statut", label: "Règlement" },
            { key: "nombre", label: "Ventes", numeric: true },
            { key: "montant", label: "Montant DZD", numeric: true },
          ],
          rows: vue.ventes.parStatutDeReglement.map((s) => ({
            cells: {
              statut: libelle(PAYMENT_STATUS, s.statut),
              nombre: String(s.nombre),
              montant: dzd(s.montantDzd),
            },
            tons: { statut: ton(PAYMENT_STATUS, s.statut) },
          })),
        } : undefined,
      },
      {
        id: "marches",
        label: `Marchés PCH — ${vue.marches.length} ligne(s)`,
        ouvert: !financeUrgente && enCoursReglementaire.length === 0 && vue.marches.length > 0,
        table: vue.marches.length > 0 ? {
          columns: [
            { key: "marche", label: "Marché" },
            { key: "designation", label: "Désignation" },
            { key: "statut", label: "Statut" },
            { key: "valeur", label: "Attribué DZD", numeric: true },
          ],
          rows: vue.marches.slice(0, 20).map((l) => ({
            cells: {
              marche: l.marche,
              designation: l.designation,
              statut: libelle(LIGNE_STATUT, l.statut),
              valeur: l.prixAttributionDzd === null ? "—" : dzd(l.quantiteUnites * l.prixAttributionDzd),
            },
            tons: { statut: ton(LIGNE_STATUT, l.statut) },
            // ZOOM SANS MODÈLE : la référence du marché est connue, il n'y a rien à interpréter.
            actions: [{
              libelle: "Le marché",
              phrase: `État du marché ${l.marche}`,
              icone: "voir",
              ...(intentFor("pch.status", { marche: l.marche }) ? { intent: intentFor("pch.status", { marche: l.marche })! } : {}),
            }],
          })),
          total: vue.marches.length,
        } : undefined,
        note: vue.marches.length === 0 ? "Ce produit n'est nommé sur aucune ligne de marché." : null,
      },
      {
        id: "portefeuille",
        label: `Portefeuille — ${porteurs.length} personne(s)`,
        people: porteurs.slice(0, 6).map((p) => ({
          nom: p.personne,
          poste: [p.role, p.territoire].filter(Boolean).join(" · ") || null,
        })),
        note: porteurs.length === 0 ? "Personne ne porte ce produit aujourd'hui." : null,
      },
      {
        id: "promotion",
        label: "Promotion & terrain",
        fields: [
          { label: "Investissement imputé", value: `${dzd(promo)} DZD` },
          { label: "Postes Ad&Pro", value: String(vue.investissementAdPro.nombreDePostes) },
          { label: "Visites", value: String(vue.terrain.nombreDeVisites) },
          { label: "Dernière visite", value: vue.terrain.derniereVisite ?? "—" },
        ],
        // CE QUI N'EST IMPUTÉ NULLE PART SE DIT. Un investissement sous-évalué ferait passer
        // une contribution négative pour positive.
        note: vue.investissementAdPro.postesSansPart > 0
          ? `${vue.investissementAdPro.postesSansPart} poste(s) sans part saisie : leur montant n'est imputé à aucun produit.`
          : null,
      },
    ],
    limites: [...vue.limites, ...limitesMetriques],
    href: `/business-development/explorateur?produit=${encodeURIComponent(vue.produit.code)}`,
    entityRef: { type: "PRODUCT", id: vue.produit.id, label: vue.produit.code },
    blockId: `e360:PRODUCT:${vue.produit.id}`,
    state: "complete",
    certitude: "fait",
    actions: [{
      libelle: "Retracer",
      phrase: `Retracer ${vue.produit.code}`,
      icone: "voir",
      ...(intentFor("story.open", { affaire: vue.produit.code }) ? { intent: intentFor("story.open", { affaire: vue.produit.code })! } : {}),
    }],
  };
}

/**
 * LA VUE 360 D'UN MARCHÉ PCH.
 *
 * LES CINQ MONTANTS SONT EN TÊTE, et jamais additionnés — c'est la règle métier la plus
 * facile à trahir par un affichage : quatre chiffres côte à côte invitent à faire la somme.
 * Ils sont donc présentés comme une PROGRESSION (attribué → commandé → livré → encaissé), qui
 * se lit comme un entonnoir et non comme un total.
 */
export function blocMarche360(vue: Pch360, metriques: readonly MetricValue[]): Record<string, unknown> {
  const mo = vue.montants;
  const cautionRisque = Boolean(vue.caution.alerte);
  const retards = vue.execution.enRetardDArrivee;

  return {
    kind: "entity360",
    title: vue.marche.reference,
    subtitle: vue.marche.titre ?? vue.marche.client,
    badges: [
      { label: libelle(PCH_TENDER_STATUS, vue.marche.statut), ton: ton(PCH_TENDER_STATUS, vue.marche.statut) },
      ...(vue.marche.entite ? [{ label: vue.marche.entite, ton: "neutre" as Ton }] : []),
      ...(cautionRisque ? [{ label: "Caution", ton: "alerte" as Ton }] : []),
    ],
    kpis: [
      { valeur: dzd(mo.attribueDzd), label: "Attribué", ton: "neutre" },
      { valeur: dzd(mo.commandeDzd), label: "Commandé", ton: "neutre" },
      { valeur: dzd(mo.encaisseDzd), label: "Encaissé", ton: "succes" },
      { valeur: dzd(mo.resteAEncaisserDzd), label: "Reste à encaisser", ton: mo.resteAEncaisserDzd > 0 ? "attention" : "neutre" },
    ],
    sections: [
      {
        id: "execution",
        label: "Exécution",
        ouvert: true,
        gauges: [
          { label: "Commandé sur attribué", valeur: mo.commandeDzd, total: Math.max(mo.attribueDzd, 1), detail: `${dzd(mo.commandeDzd)} / ${dzd(mo.attribueDzd)} DZD` },
          { label: "Livré sur commandé", valeur: mo.livreDzd, total: Math.max(mo.commandeDzd, 1), detail: `${dzd(mo.livreDzd)} / ${dzd(mo.commandeDzd)} DZD` },
          { label: "Encaissé sur livré", valeur: mo.encaisseDzd, total: Math.max(mo.livreDzd, 1), detail: `${dzd(mo.encaisseDzd)} / ${dzd(mo.livreDzd)} DZD`, ton: mo.encaisseDzd < mo.livreDzd ? "attention" : "succes" },
        ],
        fields: [
          { label: "Bons de commande", value: String(vue.execution.nombreDeBons) },
          { label: "En attente", value: String(vue.execution.bonsEnAttente) },
          { label: "Livrés", value: String(vue.execution.bonsLivres) },
          { label: "Payés", value: String(vue.execution.bonsPayes) },
          ...(vue.execution.bonsAnnules > 0 ? [{ label: "Annulés", value: String(vue.execution.bonsAnnules), ton: "attention" as Ton }] : []),
        ],
        note: retards.length > 0 ? `${retards.length} bon(s) en retard d'arrivée.` : null,
      },
      {
        id: "caution",
        label: "Caution",
        ouvert: cautionRisque,
        fields: [
          { label: "Montant", value: vue.caution.montantDzd === null ? "—" : `${dzd(vue.caution.montantDzd)} DZD` },
          { label: "Déposée", value: vue.caution.deposee ? "Oui" : "Non", ton: vue.caution.deposee ? "succes" : "attention" },
          { label: "Début", value: vue.caution.debut ?? "—" },
          { label: "Fin", value: vue.caution.fin ?? "—" },
          ...(vue.caution.joursAvantEcheance !== null
            ? [{ label: "Avant échéance", value: `${vue.caution.joursAvantEcheance} jour(s)`, ton: (vue.caution.joursAvantEcheance < 30 ? "alerte" : "neutre") as Ton }]
            : []),
        ],
        note: vue.caution.alerte,
      },
      {
        id: "lignes",
        label: `Lots — ${vue.lignes.length}`,
        table: vue.lignes.length > 0 ? {
          columns: [
            { key: "designation", label: "Désignation" },
            { key: "produit", label: "Produit" },
            { key: "statut", label: "Statut" },
            { key: "valeur", label: "Attribué DZD", numeric: true },
            { key: "taux", label: "Réalisé %", numeric: true },
          ],
          rows: vue.lignes.slice(0, 30).map((l) => ({
            cells: {
              designation: l.designation,
              produit: l.produit?.code ?? l.notreProduitTexte ?? "—",
              statut: libelle(LIGNE_STATUT, l.statut),
              valeur: dzd(l.valeurAttribueeDzd),
              taux: l.tauxDeRealisationPct === null ? "—" : String(Math.round(l.tauxDeRealisationPct)),
            },
            tons: { statut: ton(LIGNE_STATUT, l.statut) },
            ...(l.produit ? {
              actions: [{
                libelle: "Économie",
                phrase: `Économie du produit ${l.produit.code}`,
                icone: "voir",
                ...(intentFor("product.economics", { produit: l.produit.code })
                  ? { intent: intentFor("product.economics", { produit: l.produit.code })! }
                  : {}),
              }],
            } : {}),
          })),
          total: vue.lignes.length,
        } : undefined,
        note: vue.lignes.length === 0 ? "Aucun lot enregistré sur ce marché." : null,
      },
      {
        id: "ventes",
        label: "Ventes enregistrées (à part)",
        fields: [
          { label: "Nombre", value: String(vue.ventesEnregistrees.nombre) },
          { label: "Chiffre d'affaires", value: `${dzd(vue.ventesEnregistrees.chiffreAffairesDzd)} DZD` },
          { label: "Écart avec les bons", value: `${dzd(vue.ventesEnregistrees.ecartAvecCommandeDzd)} DZD`, ton: "attention" },
        ],
        // LA RÈGLE MÉTIER, RAPPELÉE LÀ OÙ ON POURRAIT L'OUBLIER.
        note: "Ces ventes ne s'additionnent PAS aux bons de commande : les cumuler doublerait le chiffre d'affaires du marché.",
      },
      {
        id: "definitions",
        label: "Ce que chaque montant veut dire",
        fields: Object.entries(mo.definitions).map(([k, v]) => ({ label: k, value: v })),
      },
    ],
    limites: [
      ...vue.limites,
      ...(metriques.length === 0 ? ["Les métriques sémantiques n'ont pas pu être calculées sur ce marché."] : []),
    ],
    // La fiche d'un marché vit sous `/pch/<id>` — `/pch/marches/…` n'a jamais existé, et ce
    // bloc envoyait donc sur un 404 depuis la fiche 360. Épinglé par `dead-links.test.ts`.
    href: `/pch/${vue.marche.id}`,
    entityRef: { type: "PCH_TENDER", id: vue.marche.id, label: vue.marche.reference },
    blockId: `e360:PCH_TENDER:${vue.marche.id}`,
    state: "complete",
    certitude: "fait",
    actions: [{
      libelle: "Retracer",
      phrase: `Retracer ${vue.marche.reference}`,
      icone: "voir",
      ...(intentFor("story.open", { affaire: vue.marche.reference })
        ? { intent: intentFor("story.open", { affaire: vue.marche.reference })! }
        : {}),
    }],
  };
}
