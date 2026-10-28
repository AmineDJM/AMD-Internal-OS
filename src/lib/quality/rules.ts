/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES RÈGLES — ce que le moteur cherche, ligne par ligne, dans la vraie base (mandat 4 §23).
 *
 * Chaque détecteur est BORNÉ (un `take`, une fenêtre de dates) : le balayage est un service de
 * fond, il n'a pas le droit de peser sur l'ERP. Chaque règle dit sa famille, sa criticité, sa
 * résolution par défaut et le MODULE qui gouverne la visibilité de ses constats — un salaire
 * aberrant est un constat RH, il ne s'affiche qu'à qui voit la paie.
 *
 * Une règle ne DEVINE pas : « aberrant » exige une médiane sur un échantillon suffisant,
 * « doublon » exige une clé de rapprochement stricte, « périmé » exige un délai généreux.
 * Mieux vaut manquer un cas limite que crier faux : un moteur qui se trompe une fois sur dix
 * finit ignoré, et ses vraies alertes avec.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { prisma } from "@/lib/prisma";
import { toNumber, formatMontant } from "@/lib/utils";
import { netDeLaFacture } from "@/lib/lecteurs/avoir";
import { totauxAvoirsActifs } from "@/lib/lecteurs/avoirs-actifs";
import { cleProduit, clePersonne, cleSociete, depassementDuCumul, emailNormalise, estAberrant, groupeReferenceFacture, joursEntre, jumellesDeReference, mediane, resolutionEffective, signatureDe, verdictEmail, type Constat, type DefinitionRegle } from "@/lib/quality/model";

export const LIMITE_PAR_REGLE = 200;
const JOUR = 86_400_000;

// ─────────────────────────────── Le catalogue ───────────────────────────────

export const REGLES: readonly DefinitionRegle[] = [
  { id: "doublon_email_salaries", famille: "DOUBLON", criticite: "HAUTE", resolution: "HUMAIN", module: "RH", description: "Deux salariés actifs partagent la même adresse e-mail." },
  { id: "doublon_nom_salaries", famille: "DOUBLON", criticite: "NORMALE", resolution: "HUMAIN", module: "RH", description: "Deux salariés actifs portent le même nom complet (mots triés, accents ignorés)." },
  { id: "doublon_fournisseurs", famille: "DOUBLON", criticite: "HAUTE", resolution: "HUMAIN", module: "REGULATORY", description: "Deux fournisseurs actifs ont le même nom une fois les formes juridiques retirées." },
  { id: "doublon_produits_regulatory", famille: "DOUBLON", criticite: "HAUTE", resolution: "HUMAIN", module: "REGULATORY", description: "Deux dossiers réglementaires portent la même DCI (triée), le même dosage, la même forme et le même conditionnement." },
  { id: "doublon_factures", famille: "DOUBLON", criticite: "CRITIQUE", resolution: "HUMAIN", module: "FINANCES", legere: true, description: "Deux factures de la même contrepartie, même montant, à moins de 45 jours — ou la même référence chez le même émetteur." },
  { id: "email_normalisable", famille: "EMAIL", criticite: "BASSE", resolution: "AUTO", module: "RH", description: "Une adresse valide une fois pliée (majuscules, espaces, « mailto: ») — corrigée seule, avant/après journalisés." },
  { id: "email_invalide", famille: "EMAIL", criticite: "HAUTE", resolution: "HUMAIN", module: "RH", description: "Une adresse qui n'en est pas une : aucun courrier ne partira." },
  { id: "champ_manquant_salarie", famille: "CHAMP_MANQUANT", criticite: "NORMALE", resolution: "HUMAIN", module: "RH", description: "Un salarié actif sans e-mail, sans département ou sans date d'embauche." },
  { id: "champ_manquant_fournisseur", famille: "CHAMP_MANQUANT", criticite: "BASSE", resolution: "HUMAIN", module: "REGULATORY", description: "Un fournisseur actif sans e-mail de contact." },
  { id: "champ_manquant_legal", famille: "CHAMP_MANQUANT", criticite: "HAUTE", resolution: "HUMAIN", module: "LEGAL", description: "Une facture ou un bon de commande sans montant ou sans contrepartie ; un contrat actif sans terme." },
  { id: "dossier_sans_responsable", famille: "CHAMP_MANQUANT", criticite: "HAUTE", resolution: "HUMAIN", module: "REGULATORY", description: "Un dossier réglementaire en cours sans responsable." },
  { id: "perime_dossier_regulatory", famille: "PERIME", criticite: "HAUTE", resolution: "HUMAIN", module: "REGULATORY", description: "Un dossier réglementaire en cours sans aucun mouvement depuis 180 jours." },
  { id: "perime_tache", famille: "PERIME", criticite: "NORMALE", resolution: "HUMAIN", module: "WORKSPACE", description: "Une tâche ouverte dont l'échéance est dépassée de plus de 60 jours." },
  { id: "contrat_actif_echu", famille: "STATUT_IMPOSSIBLE", criticite: "HAUTE", resolution: "PROPOSE", module: "LEGAL", description: "Un engagement marqué ACTIF dont le terme est passé : expiré, ou renouvelé ? — la correction proposée le passe en EXPIRÉ." },
  { id: "paiement_statut_impossible", famille: "STATUT_IMPOSSIBLE", criticite: "HAUTE", resolution: "HUMAIN", module: "FINANCES", legere: true, description: "Un ordre PAYÉ sans date ni écriture de règlement ; une demande de paiement décidée sans décideur." },
  { id: "validation_incoherente", famille: "STATUT_IMPOSSIBLE", criticite: "HAUTE", resolution: "HUMAIN", module: "VALIDATIONS", description: "Une demande de validation APPROUVÉE alors qu'une étape est encore en attente." },
  { id: "affectation_cassee", famille: "RELATION_CASSEE", criticite: "HAUTE", resolution: "HUMAIN", module: "WORKSPACE", description: "Une tâche ouverte, un dossier ou un produit confié à un compte désactivé." },
  { id: "document_orphelin", famille: "DOCUMENT_ORPHELIN", criticite: "NORMALE", resolution: "HUMAIN", module: "DRIVE", description: "Un fichier vivant dans un dossier mis à la corbeille ; un document légal dont la pièce Drive est à la corbeille." },
  { id: "date_incoherente", famille: "DATE", criticite: "HAUTE", resolution: "HUMAIN", module: "LEGAL", description: "Un début après une fin : contrat, période d'essai, naissance après l'embauche, tâche terminée avant d'être créée, soumission cible après la décision cible." },
  { id: "montant_contradictoire", famille: "MONTANT", criticite: "CRITIQUE", resolution: "HUMAIN", module: "FINANCES", legere: true, description: "Une facture qui ne vaut pas son bon de commande, un règlement qui ne vaut pas sa facture, un ordre payé pour un autre montant que son écriture (écart > 1 %)." },
  { id: "valeur_aberrante", famille: "VALEUR_ABERRANTE", criticite: "HAUTE", resolution: "HUMAIN", module: "FINANCES", description: "Une écriture négative ou nulle, un montant à 8× la médiane de sa catégorie, un salaire de base nul ou à 6× la médiane." },
  { id: "compte_actif_salarie_parti", famille: "INCOHERENCE_MODULES", criticite: "CRITIQUE", resolution: "PROPOSE", module: "RH", legere: true, description: "Un salarié inactif dont le compte utilisateur est encore actif — la correction proposée désactive le compte." },
  { id: "departement_divergent", famille: "INCOHERENCE_MODULES", criticite: "NORMALE", resolution: "PROPOSE", module: "RH", description: "Le département du salarié (RH) et celui de son compte divergent — la correction proposée aligne le compte sur la fiche RH." },
] as const;

export const regleDe = (id: string): DefinitionRegle | undefined => REGLES.find((r) => r.id === id);

// ─────────────────────────────── Aides ───────────────────────────────

const HREF = {
  employe: (id: string) => `/rh/${id}`,
  fournisseur: () => "/regulatory?onglet=fournisseurs",
  produit: (id: string) => `/regulatory/${id}`,
  legal: (id: string) => `/legal/${id}`,
  tache: () => "/mon-espace",
  drive: (id: string) => `/drive?node=${id}`,
  ordre: () => "/finances/paiements-a-faire",
  paiement: (id: string) => `/validations/paiements/${id}`,
  validation: (id: string) => `/validations?focus=${id}`,
  transaction: () => "/finances/comptabilite",
  dossier: (id: string) => `/dossiers/${id}`,
  compte: () => "/admin/access",
};

const dzd = (n: number): string => `${formatMontant(n)} DZD`;
const fr = (d: Date | null | undefined): string => (d ? d.toISOString().slice(0, 10).split("-").reverse().join("/") : "—");

function constat(
  regle: DefinitionRegle,
  base: Pick<Constat, "entite" | "entiteId" | "titre" | "detail"> & Partial<Pick<Constat, "confiance" | "criticite" | "module" | "href" | "correction" | "montant">> & { cle?: (string | number | null | undefined)[] },
): Constat {
  const confiance = base.confiance ?? 1;
  const correction = base.correction ?? null;
  return {
    regle: regle.id, famille: regle.famille, criticite: base.criticite ?? regle.criticite, confiance,
    resolution: resolutionEffective(regle.resolution, confiance, correction),
    entite: base.entite, entiteId: base.entiteId, module: base.module ?? regle.module,
    titre: base.titre, detail: base.detail,
    signature: signatureDe(regle.id, base.entite, base.entiteId, ...(base.cle ?? [])),
    href: base.href ?? null, correction, montant: base.montant ?? null,
  };
}

/** Les groupes d'au moins deux éléments partageant une clé, par ordre d'apparition. */
function grouper<T>(items: readonly T[], cle: (t: T) => string | null): T[][] {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = cle(it);
    if (!k) continue;
    m.set(k, [...(m.get(k) ?? []), it]);
  }
  return [...m.values()].filter((g) => g.length >= 2);
}

const REG_EN_COURS = ["PRE_SUBMISSION", "IN_PREPARATION", "SUBMITTED", "AWAITING_BV_PAYMENT", "AWAITING_ANPP", "RESPONDING_TO_QUERIES", "BLOCKED"] as const;
const TACHE_OUVERTE = ["REQUESTED", "TODO", "IN_PROGRESS"] as const;

type Detecteur = (now: Date) => Promise<Constat[]>;

// ─────────────────────────────── Les détecteurs ───────────────────────────────

const DETECTEURS: Record<string, Detecteur> = {
  async doublon_email_salaries() {
    const r = regleDe("doublon_email_salaries")!;
    const rows = await prisma.employee.findMany({ where: { isActive: true, email: { not: null } }, select: { id: true, fullName: true, email: true }, take: 5000 });
    const out: Constat[] = [];
    for (const g of grouper(rows, (e) => emailNormalise(e.email) || null)) {
      const noms = g.map((e) => e.fullName).join(", ");
      for (const e of g) {
        out.push(constat(r, {
          entite: "Employee", entiteId: e.id, confiance: 0.9, href: HREF.employe(e.id), cle: [emailNormalise(e.email)],
          titre: `Adresse partagée par ${g.length} salariés : ${emailNormalise(e.email)}`,
          detail: `${noms} ont la même adresse e-mail. Deux fiches pour une personne, ou une adresse mal saisie : à trancher fiche en main — le moteur ne fusionne jamais.`,
        }));
      }
    }
    return out.slice(0, LIMITE_PAR_REGLE);
  },

  async doublon_nom_salaries() {
    const r = regleDe("doublon_nom_salaries")!;
    const rows = await prisma.employee.findMany({ where: { isActive: true }, select: { id: true, fullName: true, email: true, departmentId: true }, take: 5000 });
    const out: Constat[] = [];
    for (const g of grouper(rows, (e) => clePersonne(e.fullName) || null)) {
      // Deux homonymes dans deux départements différents sont plausibles : confiance plus basse.
      const memeDept = new Set(g.map((e) => e.departmentId ?? "")).size === 1;
      for (const e of g) {
        out.push(constat(r, {
          entite: "Employee", entiteId: e.id, confiance: memeDept ? 0.7 : 0.5, href: HREF.employe(e.id), cle: [clePersonne(e.fullName)],
          titre: `${g.length} fiches au nom de ${e.fullName}`,
          detail: `${g.length} salariés actifs portent ce nom${memeDept ? ", dans le même département" : ", dans des départements différents"}. Homonymes ou doublon : à vérifier avant toute paie.`,
        }));
      }
    }
    return out.slice(0, LIMITE_PAR_REGLE);
  },

  async doublon_fournisseurs() {
    const r = regleDe("doublon_fournisseurs")!;
    const rows = await prisma.supplier.findMany({ where: { active: true }, select: { id: true, name: true, country: true }, take: 3000 });
    const out: Constat[] = [];
    for (const g of grouper(rows, (s) => cleSociete(s.name) || null)) {
      for (const s of g) {
        out.push(constat(r, {
          entite: "Supplier", entiteId: s.id, confiance: 0.8, href: HREF.fournisseur(), cle: [cleSociete(s.name)],
          titre: `Fournisseur en ${g.length} exemplaires : ${s.name}`,
          detail: `${g.map((x) => `« ${x.name} »${x.country ? ` (${x.country})` : ""}`).join(", ")} désignent la même société une fois les formes juridiques retirées. Les dossiers se répartissent entre les fiches : à fusionner par une personne.`,
        }));
      }
    }
    return out.slice(0, LIMITE_PAR_REGLE);
  },

  async doublon_produits_regulatory() {
    const r = regleDe("doublon_produits_regulatory")!;
    const rows = await prisma.regulatoryProduct.findMany({
      where: { status: { in: [...REG_EN_COURS] }, isLocked: false },
      select: { id: true, reference: true, dci: true, dosage: true, dosageUnit: true, pharmaceuticalForm: true, packaging: true, companyId: true },
      take: 4000,
    });
    const out: Constat[] = [];
    for (const g of grouper(rows, (p) => (p.dci ? `${p.companyId ?? ""}|${cleProduit(p)}` : null))) {
      for (const p of g) {
        out.push(constat(r, {
          entite: "RegulatoryProduct", entiteId: p.id, confiance: 0.85, href: HREF.produit(p.id), cle: [cleProduit(p)],
          titre: `Dossier en double : ${p.dci}${p.dosage ? ` ${p.dosage}${p.dosageUnit ?? ""}` : ""}`,
          detail: `${g.map((x) => x.reference).join(", ")} portent la même DCI, le même dosage, la même forme et le même conditionnement. Deux dossiers pour un produit : l'un des deux est à clore ou à distinguer.`,
        }));
      }
    }
    return out.slice(0, LIMITE_PAR_REGLE);
  },

  async doublon_factures(now) {
    const r = regleDe("doublon_factures")!;
    const rows = await prisma.legalDocument.findMany({
      where: { kind: "INVOICE", status: { not: "CANCELLED" }, createdAt: { gte: new Date(now.getTime() - 730 * JOUR) } },
      select: { id: true, reference: true, title: true, counterparty: true, counterpartyIds: true, direction: true, companyId: true, amount: true, createdAt: true, startDate: true },
      orderBy: { createdAt: "asc" }, take: 6000,
    });
    const out: Constat[] = [];
    const vus = new Set<string>();
    // 1. La même référence chez le MÊME émetteur — quasi certain ; émetteur inconnu — à vérifier (§118.196). Deux
    //    fournisseurs qui numérotent pareil, ou deux sociétés du groupe, ne font pas un doublon.
    for (const g of grouper(rows, (x) => groupeReferenceFacture(x))) {
      for (const { facture: x, certain, lot } of jumellesDeReference(g)) {
        const ref = (x.reference ?? "").trim().toLowerCase();
        vus.add(x.id);
        out.push(constat(r, {
          entite: "LegalDocument", entiteId: x.id, confiance: certain ? 0.95 : 0.6, href: HREF.legal(x.id), cle: [certain ? "ref" : "ref-emetteur-inconnu", ref],
          montant: x.amount != null ? toNumber(x.amount) : null,
          titre: certain ? `Facture ${x.reference} enregistrée ${lot.length} fois` : `Facture ${x.reference} : même numéro qu'une autre, émetteur à vérifier`,
          detail: certain
            ? `${lot.length} factures portent la référence ${x.reference} chez le même émetteur (${lot.map((y) => y.counterparty ?? "—").join(", ")}). Risque : payer deux fois. À vérifier pièce en main.`
            : `${lot.length} factures portent la référence ${x.reference}, et rien ne dit qui a émis l'une d'elles (${lot.map((y) => y.counterparty ?? "partie non renseignée").join(", ")}) : deux fournisseurs numérotent souvent pareil. Renseignez la partie, puis vérifiez pièce en main avant tout règlement.`,
        }));
      }
    }
    // 2. Même contrepartie, même montant, à moins de 45 jours — probable.
    for (const g of grouper(rows.filter((x) => x.counterparty && x.amount != null), (x) => `${cleSociete(x.counterparty)}|${Math.round(toNumber(x.amount) * 100)}`)) {
      for (let i = 1; i < g.length; i += 1) {
        const a = g[i - 1]; const b = g[i];
        const ecart = Math.abs(joursEntre(a.createdAt, b.createdAt));
        if (ecart > 45 || vus.has(b.id)) continue;
        out.push(constat(r, {
          entite: "LegalDocument", entiteId: b.id, confiance: 0.8, href: HREF.legal(b.id), cle: ["paire", a.id],
          montant: toNumber(b.amount),
          titre: `Facture candidate au doublon : ${b.reference ?? b.title}`,
          detail: `${a.reference ?? a.title} et ${b.reference ?? b.title} — ${b.counterparty}, même montant (${dzd(toNumber(b.amount))}), à ${ecart} j d'écart. Règle : même contrepartie + même montant sous 45 j. À vérifier pièce en main avant tout règlement.`,
        }));
      }
    }
    return out.slice(0, LIMITE_PAR_REGLE);
  },

  async email_normalisable() { return detecterEmails("email_normalisable"); },
  async email_invalide() { return detecterEmails("email_invalide"); },

  async champ_manquant_salarie() {
    const r = regleDe("champ_manquant_salarie")!;
    const rows = await prisma.employee.findMany({
      where: { isActive: true, OR: [{ email: null }, { email: "" }, { departmentId: null }, { hireDate: null }] },
      select: { id: true, fullName: true, email: true, departmentId: true, hireDate: true }, take: LIMITE_PAR_REGLE,
    });
    return rows.map((e) => {
      const manque = [!e.email ? "e-mail" : null, !e.departmentId ? "département" : null, !e.hireDate ? "date d'embauche" : null].filter(Boolean) as string[];
      return constat(r, {
        entite: "Employee", entiteId: e.id, href: HREF.employe(e.id), cle: [manque.join(",")],
        titre: `${e.fullName} : ${manque.join(", ")} manquant${manque.length > 1 ? "s" : ""}`,
        detail: `La fiche salarié n'a pas de ${manque.join(" ni de ")}. Sans e-mail, aucune notification ne l'atteint ; sans département, l'organigramme et les budgets l'ignorent.`,
      });
    });
  },

  async champ_manquant_fournisseur() {
    const r = regleDe("champ_manquant_fournisseur")!;
    const rows = await prisma.supplier.findMany({ where: { active: true, OR: [{ contactEmail: null }, { contactEmail: "" }] }, select: { id: true, name: true }, take: LIMITE_PAR_REGLE });
    return rows.map((s) => constat(r, {
      entite: "Supplier", entiteId: s.id, href: HREF.fournisseur(),
      titre: `${s.name} : aucun e-mail de contact`,
      detail: "Le fournisseur n'a pas d'adresse : aucune relance ni aucun envoi de documents ne peut partir vers lui depuis l'ERP.",
    }));
  },

  async champ_manquant_legal() {
    const r = regleDe("champ_manquant_legal")!;
    const rows = await prisma.legalDocument.findMany({
      where: {
        status: { not: "CANCELLED" },
        OR: [
          { kind: { in: ["INVOICE", "PURCHASE_ORDER"] }, OR: [{ amount: null }, { counterparty: null }, { counterparty: "" }] },
          { kind: "CONTRACT", status: "ACTIVE", endDate: null },
        ],
      },
      select: { id: true, reference: true, title: true, kind: true, amount: true, counterparty: true, endDate: true }, take: LIMITE_PAR_REGLE,
    });
    return rows.map((d) => {
      const manque = d.kind === "CONTRACT"
        ? ["terme (date de fin)"]
        : [d.amount == null ? "montant" : null, !d.counterparty ? "contrepartie" : null].filter(Boolean) as string[];
      const critique = d.kind !== "CONTRACT";
      return constat(r, {
        entite: "LegalDocument", entiteId: d.id, href: HREF.legal(d.id), criticite: critique ? "HAUTE" : "NORMALE", cle: [manque.join(",")],
        titre: `${d.reference ?? d.title} : ${manque.join(", ")} manquant`,
        detail: critique
          ? `Une ${d.kind === "INVOICE" ? "facture" : "commande"} sans ${manque.join(" ni ")} ne se rapproche d'aucun règlement et fausse les totaux.`
          : "Un contrat actif sans terme n'entrera jamais dans les alertes d'échéance : il expirera sans que personne ne le voie.",
      });
    });
  },

  async dossier_sans_responsable() {
    const r = regleDe("dossier_sans_responsable")!;
    const rows = await prisma.regulatoryProduct.findMany({
      where: { status: { in: [...REG_EN_COURS] }, isLocked: false, responsibleId: null },
      select: { id: true, reference: true, dci: true, status: true }, take: LIMITE_PAR_REGLE,
    });
    return rows.map((p) => constat(r, {
      entite: "RegulatoryProduct", entiteId: p.id, href: HREF.produit(p.id),
      titre: `${p.reference} — ${p.dci} : aucun responsable`,
      detail: `Le dossier est ${p.status} et personne n'en répond : aucune relance ne partira, aucune échéance ne sera tenue.`,
    }));
  },

  async perime_dossier_regulatory(now) {
    const r = regleDe("perime_dossier_regulatory")!;
    const limite = new Date(now.getTime() - 180 * JOUR);
    const rows = await prisma.regulatoryProduct.findMany({
      where: { status: { in: [...REG_EN_COURS] }, isLocked: false, updatedAt: { lt: limite } },
      select: { id: true, reference: true, dci: true, status: true, updatedAt: true }, orderBy: { updatedAt: "asc" }, take: LIMITE_PAR_REGLE,
    });
    return rows.map((p) => constat(r, {
      entite: "RegulatoryProduct", entiteId: p.id, href: HREF.produit(p.id), cle: [p.status],
      titre: `${p.reference} — ${p.dci} : sans mouvement depuis ${joursEntre(p.updatedAt, now)} j`,
      detail: `Statut ${p.status}, dernière modification le ${fr(p.updatedAt)}. Un dossier en cours qui ne bouge plus est soit abandonné sans l'être dit, soit bloqué sans alerte.`,
    }));
  },

  async perime_tache(now) {
    const r = regleDe("perime_tache")!;
    const limite = new Date(now.getTime() - 60 * JOUR);
    const rows = await prisma.task.findMany({
      where: { status: { in: [...TACHE_OUVERTE] }, dueDate: { lt: limite } },
      select: { id: true, title: true, dueDate: true, assignedTo: { select: { name: true } } }, orderBy: { dueDate: "asc" }, take: LIMITE_PAR_REGLE,
    });
    return rows.map((t) => constat(r, {
      entite: "Task", entiteId: t.id, href: HREF.tache(),
      titre: `Tâche en retard de ${joursEntre(t.dueDate!, now)} j : ${t.title}`,
      detail: `Échéance ${fr(t.dueDate)}${t.assignedTo ? `, confiée à ${t.assignedTo.name}` : ", sans assigné"}. Passé deux mois, une tâche ouverte est une donnée périmée : à clore, à replanifier ou à réaffecter.`,
    }));
  },

  async contrat_actif_echu(now) {
    const r = regleDe("contrat_actif_echu")!;
    const rows = await prisma.legalDocument.findMany({
      where: { status: "ACTIVE", endDate: { lt: new Date(now.getTime() - JOUR) }, kind: { notIn: ["INVOICE", "QUOTE", "PURCHASE_ORDER"] } },
      select: { id: true, reference: true, title: true, endDate: true, kind: true }, orderBy: { endDate: "asc" }, take: LIMITE_PAR_REGLE,
    });
    return rows.map((d) => constat(r, {
      entite: "LegalDocument", entiteId: d.id, href: HREF.legal(d.id), confiance: 0.9,
      correction: { entite: "LegalDocument", entiteId: d.id, champ: "status", avant: "ACTIVE", apres: "EXPIRED", description: `Passer ${d.reference ?? d.title} en EXPIRÉ (terme le ${fr(d.endDate)}).` },
      titre: `${d.reference ?? d.title} : ACTIF mais échu depuis ${joursEntre(d.endDate!, now)} j`,
      detail: `Terme le ${fr(d.endDate)}, statut encore ACTIF. S'il a été renouvelé, le renouvellement doit exister ; sinon il est expiré — la correction proposée le passe en EXPIRÉ.`,
    }));
  },

  async paiement_statut_impossible() {
    const r = regleDe("paiement_statut_impossible")!;
    const [ordres, demandes] = await Promise.all([
      prisma.expenseOrder.findMany({ where: { status: "PAID", OR: [{ paidDate: null }, { transactionId: null }] }, select: { id: true, reference: true, label: true, amount: true, paidDate: true, transactionId: true }, take: LIMITE_PAR_REGLE }),
      prisma.paymentRequest.findMany({ where: { status: { in: ["APPROVED", "REJECTED"] }, decidedById: null }, select: { id: true, reference: true, title: true, amount: true, status: true }, take: LIMITE_PAR_REGLE }),
    ]);
    return [
      ...ordres.map((o) => constat(r, {
        entite: "ExpenseOrder", entiteId: o.id, href: HREF.ordre(), montant: toNumber(o.amount), cle: [o.paidDate ? "" : "sansDate", o.transactionId ? "" : "sansEcriture"],
        titre: `${o.reference} : PAYÉ ${!o.paidDate ? "sans date" : ""}${!o.paidDate && !o.transactionId ? " ni" : ""}${!o.transactionId ? " sans écriture de règlement" : ""}`,
        detail: `${o.label} — ${dzd(toNumber(o.amount))}. Un ordre payé sans ${!o.transactionId ? "écriture" : "date"} n'apparaît pas dans la trésorerie : les totaux payés sont faux d'autant.`,
      })),
      ...demandes.map((d) => constat(r, {
        entite: "PaymentRequest", entiteId: d.id, href: HREF.paiement(d.id), montant: toNumber(d.amount), cle: [d.status],
        titre: `${d.reference} : ${d.status === "APPROVED" ? "approuvée" : "refusée"} sans décideur`,
        detail: `${d.title} — ${dzd(toNumber(d.amount))}. Une décision sans nom n'est pas auditable.`,
      })),
    ].slice(0, LIMITE_PAR_REGLE);
  },

  async validation_incoherente() {
    const r = regleDe("validation_incoherente")!;
    const rows = await prisma.validationRequest.findMany({
      where: { status: "APPROVED", steps: { some: { status: "PENDING" } } },
      select: { id: true, reference: true, title: true, steps: { where: { status: "PENDING" }, select: { order: true } } }, take: LIMITE_PAR_REGLE,
    });
    return rows.map((v) => constat(r, {
      entite: "ValidationRequest", entiteId: v.id, href: HREF.validation(v.id),
      titre: `${v.reference} : APPROUVÉE avec ${v.steps.length} étape(s) encore en attente`,
      detail: `${v.title} — étape(s) ${v.steps.map((s) => s.order).join(", ")} toujours PENDING. Soit l'approbation est prématurée, soit les étapes n'ont pas été closes.`,
    }));
  },

  async affectation_cassee() {
    const r = regleDe("affectation_cassee")!;
    const [taches, produits, dossiers] = await Promise.all([
      prisma.task.findMany({ where: { status: { in: [...TACHE_OUVERTE] }, assignedTo: { isActive: false } }, select: { id: true, title: true, assignedTo: { select: { name: true } } }, take: LIMITE_PAR_REGLE }),
      prisma.regulatoryProduct.findMany({ where: { status: { in: [...REG_EN_COURS] }, responsible: { isActive: false } }, select: { id: true, reference: true, dci: true, responsible: { select: { name: true } } }, take: LIMITE_PAR_REGLE }),
      prisma.dossier.findMany({ where: { status: { in: ["OPEN", "IN_PROGRESS", "ON_HOLD"] }, assignedTo: { isActive: false } }, select: { id: true, reference: true, title: true, assignedTo: { select: { name: true } } }, take: LIMITE_PAR_REGLE }),
    ]);
    return [
      ...taches.map((t) => constat(r, { entite: "Task", entiteId: t.id, href: HREF.tache(), module: "WORKSPACE", titre: `Tâche confiée à un compte désactivé : ${t.title}`, detail: `${t.assignedTo?.name ?? "—"} n'a plus accès à l'ERP : la tâche ne sera jamais faite tant qu'elle n'est pas réaffectée.` })),
      ...produits.map((p) => constat(r, { entite: "RegulatoryProduct", entiteId: p.id, href: HREF.produit(p.id), module: "REGULATORY", titre: `${p.reference} — ${p.dci} : responsable désactivé`, detail: `${p.responsible?.name ?? "—"} n'a plus accès : le dossier n'a de responsable que sur le papier.` })),
      ...dossiers.map((d) => constat(r, { entite: "Dossier", entiteId: d.id, href: HREF.dossier(d.id), module: "DOSSIERS", titre: `${d.reference} — ${d.title} : assigné à un compte désactivé`, detail: `${d.assignedTo?.name ?? "—"} n'a plus accès : le dossier attend quelqu'un qui ne viendra pas.` })),
    ].slice(0, LIMITE_PAR_REGLE);
  },

  async document_orphelin() {
    const r = regleDe("document_orphelin")!;
    const [fichiers, legaux] = await Promise.all([
      prisma.driveNode.findMany({ where: { type: "FILE", isTrashed: false, parent: { isTrashed: true } }, select: { id: true, name: true, parent: { select: { name: true } } }, take: LIMITE_PAR_REGLE }),
      prisma.legalDocument.findMany({ where: { status: { not: "CANCELLED" }, driveNode: { isTrashed: true } }, select: { id: true, reference: true, title: true, driveNode: { select: { name: true } } }, take: LIMITE_PAR_REGLE }),
    ]);
    return [
      ...fichiers.map((f) => constat(r, { entite: "DriveNode", entiteId: f.id, href: HREF.drive(f.id), module: "DRIVE", titre: `Fichier vivant dans un dossier à la corbeille : ${f.name}`, detail: `Le dossier « ${f.parent?.name ?? "—"} » est à la corbeille, pas le fichier : il n'apparaît plus nulle part sans être supprimé.` })),
      ...legaux.map((d) => constat(r, { entite: "LegalDocument", entiteId: d.id, href: HREF.legal(d.id), module: "LEGAL", titre: `${d.reference ?? d.title} : sa pièce Drive est à la corbeille`, detail: `Le fichier « ${d.driveNode?.name ?? "—"} » a été mis à la corbeille alors que le document légal est toujours actif.` })),
    ].slice(0, LIMITE_PAR_REGLE);
  },

  async date_incoherente(now) {
    const r = regleDe("date_incoherente")!;
    const out: Constat[] = [];
    const [contrats, salaries, taches, produits] = await Promise.all([
      prisma.legalDocument.findMany({ where: { status: { not: "CANCELLED" }, startDate: { not: null }, endDate: { not: null } }, select: { id: true, reference: true, title: true, startDate: true, endDate: true }, take: 6000 }),
      prisma.employee.findMany({ where: { isActive: true }, select: { id: true, fullName: true, contractStart: true, contractEnd: true, trialStart: true, trialEnd: true, birthDate: true, hireDate: true }, take: 5000 }),
      prisma.task.findMany({ where: { completedAt: { not: null } }, select: { id: true, title: true, createdAt: true, completedAt: true }, orderBy: { completedAt: "desc" }, take: 5000 }),
      prisma.regulatoryProduct.findMany({ where: { targetSubmissionDate: { not: null }, targetDate: { not: null } }, select: { id: true, reference: true, dci: true, targetSubmissionDate: true, targetDate: true }, take: 4000 }),
    ]);
    for (const c of contrats) if (c.startDate! > c.endDate!) out.push(constat(r, { entite: "LegalDocument", entiteId: c.id, href: HREF.legal(c.id), module: "LEGAL", cle: ["debut>fin"], titre: `${c.reference ?? c.title} : début (${fr(c.startDate)}) après la fin (${fr(c.endDate)})`, detail: "Un engagement qui finit avant de commencer : l'une des deux dates est fausse, et les alertes d'échéance avec." }));
    for (const e of salaries) {
      if (e.contractStart && e.contractEnd && e.contractStart > e.contractEnd) out.push(constat(r, { entite: "Employee", entiteId: e.id, href: HREF.employe(e.id), module: "RH", cle: ["contrat"], titre: `${e.fullName} : contrat qui finit (${fr(e.contractEnd)}) avant de commencer (${fr(e.contractStart)})`, detail: "Les dates du contrat sont inversées." }));
      if (e.trialStart && e.trialEnd && e.trialStart > e.trialEnd) out.push(constat(r, { entite: "Employee", entiteId: e.id, href: HREF.employe(e.id), module: "RH", cle: ["essai"], titre: `${e.fullName} : période d'essai inversée`, detail: `Début ${fr(e.trialStart)}, fin ${fr(e.trialEnd)}.` }));
      if (e.birthDate && e.hireDate && e.birthDate >= e.hireDate) out.push(constat(r, { entite: "Employee", entiteId: e.id, href: HREF.employe(e.id), module: "RH", cle: ["naissance"], titre: `${e.fullName} : né(e) le ${fr(e.birthDate)}, embauché(e) le ${fr(e.hireDate)}`, detail: "La date de naissance n'est pas antérieure à l'embauche : une des deux est fausse." }));
      if (e.hireDate && e.hireDate.getTime() > now.getTime() + 366 * JOUR) out.push(constat(r, { entite: "Employee", entiteId: e.id, href: HREF.employe(e.id), module: "RH", cle: ["embauche-futur"], titre: `${e.fullName} : embauche dans plus d'un an (${fr(e.hireDate)})`, detail: "Une date d'embauche à plus d'un an est presque toujours une année mal saisie." }));
    }
    for (const t of taches) if (t.completedAt! < t.createdAt) out.push(constat(r, { entite: "Task", entiteId: t.id, href: HREF.tache(), module: "WORKSPACE", cle: ["terminee-avant"], titre: `Tâche terminée avant d'être créée : ${t.title}`, detail: `Créée le ${fr(t.createdAt)}, terminée le ${fr(t.completedAt)}.` }));
    for (const p of produits) if (p.targetSubmissionDate! > p.targetDate!) out.push(constat(r, { entite: "RegulatoryProduct", entiteId: p.id, href: HREF.produit(p.id), module: "REGULATORY", cle: ["cibles"], titre: `${p.reference} — ${p.dci} : soumission cible (${fr(p.targetSubmissionDate)}) après la décision cible (${fr(p.targetDate)})`, detail: "On ne peut pas obtenir la décision avant d'avoir soumis : les deux cibles sont à revoir." }));
    return out.slice(0, LIMITE_PAR_REGLE);
  },

  async montant_contradictoire() {
    const r = regleDe("montant_contradictoire")!;
    const out: Constat[] = [];
    const ecartPct = (a: number, b: number): number => (b === 0 ? (a === 0 ? 0 : 100) : Math.abs(a - b) / Math.abs(b) * 100);
    const [factures, ordres] = await Promise.all([
      prisma.legalDocument.findMany({
        where: { kind: "INVOICE", status: { not: "CANCELLED" }, amount: { not: null }, OR: [{ chainFromId: { not: null } }, { settlementTxId: { not: null } }] },
        select: { id: true, reference: true, title: true, amount: true, counterparty: true, startDate: true, createdAt: true, chainFrom: { select: { id: true, reference: true, kind: true, amount: true, amendments: { select: { id: true }, take: 1 } } }, settlementTx: { select: { reference: true, amount: true } } },
        take: 4000,
      }),
      prisma.expenseOrder.findMany({ where: { status: "PAID", transactionId: { not: null } }, select: { id: true, reference: true, label: true, amount: true, transactionId: true }, take: 4000 }),
    ]);
    // CE QUE LA FACTURE DOIT VRAIMENT (§118.195) : son NET, avoirs actifs retirés — c'est ce que le règlement
    // encaisse. Comparer l'écriture au TTC dénoncerait comme « contradictoire » chaque facture créditée réglée juste.
    const avoirsParFacture = await totauxAvoirsActifs(factures.filter((f) => f.settlementTx?.amount != null || f.chainFrom?.amount != null).map((f) => f.id));
    // LE CUMUL, PAS CHAQUE FACTURE (§118.196) : un bon de commande de 100 000 facturé en deux fois 50 000 n'est pas
    // « contradictoire » deux fois — c'est pourtant ce que la règle dénonçait, à chaque facturation partielle. Ce qui
    // l'est, c'est le DÉPASSEMENT : les factures d'une pièce amont, nettes de leurs avoirs, qui totalisent plus que ce
    // qu'elle engage. Le constat se pose sur la facture qui franchit le seuil, une fois par pièce amont ; facturer MOINS
    // n'est pas une contradiction, c'est une livraison qui n'est pas finie.
    const parAmont = new Map<string, typeof factures>();
    for (const f of factures) {
      if (f.chainFrom?.amount == null || f.chainFrom.amendments.length > 0) continue;
      parAmont.set(f.chainFrom.id, [...(parAmont.get(f.chainFrom.id) ?? []), f]);
    }
    for (const lot of parAmont.values()) {
      const amont = lot[0].chainFrom!;
      const base = toNumber(amont.amount);
      const d = depassementDuCumul(lot.map((f) => ({
        id: f.id, f, net: netDeLaFacture(toNumber(f.amount), [avoirsParFacture.get(f.id) ?? 0]), quand: (f.startDate ?? f.createdAt).getTime(),
      })), base);
      if (d) {
        const { f } = d.facture;
        const { rang: i, cumul, ecartPct: e } = d;
        const piece = amont.kind === "PURCHASE_ORDER" ? "bon de commande" : "devis";
        out.push(constat(r, {
          entite: "LegalDocument", entiteId: f.id, href: HREF.legal(f.id), module: "FINANCES", montant: toNumber(f.amount), cle: ["chaine", amont.id],
          titre: i === 0
            ? `${f.reference ?? f.title} : ${dzd(cumul)} pour un ${piece} de ${dzd(base)} (${e.toFixed(1)} %)`
            : `${f.reference ?? f.title} : les ${i + 1} factures du ${piece}${amont.reference ? ` ${amont.reference}` : ""} totalisent ${dzd(cumul)} pour ${dzd(base)} (${e.toFixed(1)} %)`,
          detail: `Chaînée${i === 0 ? "" : "s"} à ${amont.reference ?? amont.id} sans avenant, avoirs déduits : le dépassement de ${dzd(cumul - base)} doit être expliqué avant règlement.`,
        }));
      }
    }
    for (const f of factures) {
      const montant = toNumber(f.amount);
      if (f.settlementTx?.amount != null) {
        const regle = toNumber(f.settlementTx.amount);
        const avoirs = avoirsParFacture.get(f.id) ?? 0;
        const du = netDeLaFacture(montant, [avoirs]);
        const e = ecartPct(regle, du);
        if (e > 1) out.push(constat(r, { entite: "LegalDocument", entiteId: f.id, href: HREF.legal(f.id), module: "FINANCES", montant, cle: ["reglement"], titre: `${f.reference ?? f.title} : réglée ${dzd(regle)} pour ${dzd(du)} ${avoirs > 0 ? "dus (avoirs déduits)" : "facturés"}`, detail: `L'écriture ${f.settlementTx.reference} ne vaut pas la facture (écart ${e.toFixed(1)} %) : trop-perçu, reste dû ou mauvais rapprochement.` }));
      }
    }
    const txIds = ordres.map((o) => o.transactionId!).filter(Boolean);
    const txs = txIds.length ? await prisma.financeTransaction.findMany({ where: { id: { in: txIds } }, select: { id: true, reference: true, amount: true } }) : [];
    const parTx = new Map(txs.map((t) => [t.id, t]));
    for (const o of ordres) {
      const tx = parTx.get(o.transactionId!);
      if (!tx) continue;
      const e = ecartPct(toNumber(tx.amount), toNumber(o.amount));
      if (e > 1) out.push(constat(r, { entite: "ExpenseOrder", entiteId: o.id, href: HREF.ordre(), module: "FINANCES", montant: toNumber(o.amount), cle: ["ecriture", tx.id], titre: `${o.reference} : payé ${dzd(toNumber(tx.amount))} pour un ordre de ${dzd(toNumber(o.amount))}`, detail: `${o.label} — l'écriture ${tx.reference} ne vaut pas l'ordre (écart ${e.toFixed(1)} %).` }));
    }
    return out.slice(0, LIMITE_PAR_REGLE);
  },

  async valeur_aberrante(now) {
    const r = regleDe("valeur_aberrante")!;
    const out: Constat[] = [];
    const [txs, salaries, legaux] = await Promise.all([
      prisma.financeTransaction.findMany({ where: { status: { not: "CANCELLED" }, date: { gte: new Date(now.getTime() - 548 * JOUR) } }, select: { id: true, reference: true, label: true, amount: true, category: true, counterparty: true }, take: 20000 }),
      prisma.employee.findMany({ where: { isActive: true }, select: { id: true, fullName: true, baseSalary: true }, take: 5000 }),
      prisma.legalDocument.findMany({ where: { amount: { lt: 0 } }, select: { id: true, reference: true, title: true, amount: true }, take: LIMITE_PAR_REGLE }),
    ]);
    const parCategorie = new Map<string, number[]>();
    for (const t of txs) {
      const m = toNumber(t.amount);
      if (m > 0) parCategorie.set(t.category, [...(parCategorie.get(t.category) ?? []), m]);
    }
    for (const t of txs) {
      const m = toNumber(t.amount);
      if (m <= 0) { out.push(constat(r, { entite: "FinanceTransaction", entiteId: t.id, href: HREF.transaction(), module: "FINANCES", montant: m, cle: ["<=0"], titre: `${t.reference} : montant ${m <= 0 && m !== 0 ? "négatif" : "nul"} (${dzd(m)})`, detail: `${t.label} — une écriture ${m === 0 ? "nulle" : "négative"} fausse les totaux : le sens s'exprime par la direction (IN/OUT), pas par le signe.` })); continue; }
      const ech = (parCategorie.get(t.category) ?? []).filter((x) => x !== m);
      if (estAberrant(m, ech)) {
        out.push(constat(r, { entite: "FinanceTransaction", entiteId: t.id, href: HREF.transaction(), module: "FINANCES", montant: m, confiance: 0.7, cle: ["mediane"], titre: `${t.reference} : ${dzd(m)} — ${Math.round(m / (mediane(ech) ?? 1))}× la médiane de ${t.category}`, detail: `${t.label}${t.counterparty ? ` (${t.counterparty})` : ""} — médiane de la catégorie ${dzd(mediane(ech) ?? 0)} sur ${ech.length} écritures. Une virgule déplacée, ou une vraie exception : à confirmer.` }));
      }
    }
    const sal = salaries.map((s) => toNumber(s.baseSalary)).filter((x) => x > 0);
    for (const s of salaries) {
      const b = toNumber(s.baseSalary);
      if (b <= 0) out.push(constat(r, { entite: "Employee", entiteId: s.id, href: HREF.employe(s.id), module: "RH", montant: b, cle: ["salaire<=0"], titre: `${s.fullName} : salaire de base ${b === 0 ? "nul" : "négatif"}`, detail: "Un salarié actif sans salaire de base : la paie et le coût employeur sont faux d'autant." }));
      else if (estAberrant(b, sal.filter((x) => x !== b), 6, 8)) out.push(constat(r, { entite: "Employee", entiteId: s.id, href: HREF.employe(s.id), module: "RH", montant: b, confiance: 0.7, cle: ["salaire-mediane"], titre: `${s.fullName} : salaire de base à ${Math.round(b / (mediane(sal) ?? 1))}× la médiane`, detail: `Médiane des salaires actifs ${dzd(mediane(sal) ?? 0)} sur ${sal.length} fiches. À confirmer avant la prochaine paie.` }));
    }
    for (const d of legaux) out.push(constat(r, { entite: "LegalDocument", entiteId: d.id, href: HREF.legal(d.id), module: "LEGAL", montant: toNumber(d.amount), cle: ["<0"], titre: `${d.reference ?? d.title} : montant négatif (${dzd(toNumber(d.amount))})`, detail: "Un document légal ne porte pas de montant négatif : un avoir se saisit comme tel." }));
    return out.slice(0, LIMITE_PAR_REGLE);
  },

  async compte_actif_salarie_parti() {
    const r = regleDe("compte_actif_salarie_parti")!;
    const rows = await prisma.employee.findMany({ where: { isActive: false, user: { isActive: true, isSystem: false } }, select: { id: true, fullName: true, user: { select: { id: true, email: true } } }, take: LIMITE_PAR_REGLE });
    return rows.map((e) => constat(r, {
      entite: "User", entiteId: e.user!.id, href: HREF.compte(), confiance: 0.95,
      correction: { entite: "User", entiteId: e.user!.id, champ: "isActive", avant: "true", apres: "false", description: `Désactiver le compte ${e.user!.email} (salarié ${e.fullName} inactif).` },
      titre: `${e.fullName} : salarié inactif, compte encore actif (${e.user!.email})`,
      detail: "La fiche RH dit parti, le compte dit présent : l'accès à l'ERP survit au départ. La correction proposée désactive le compte — à confirmer par une personne (un congé long n'est pas un départ).",
    }));
  },

  async departement_divergent() {
    const r = regleDe("departement_divergent")!;
    const rows = await prisma.employee.findMany({
      where: { isActive: true, departmentId: { not: null }, user: { isActive: true, departmentId: { not: null } } },
      select: { id: true, fullName: true, departmentId: true, departmentRef: { select: { name: true } }, user: { select: { id: true, departmentId: true, department: { select: { name: true } } } } },
      take: 5000,
    });
    return rows
      .filter((e) => e.user && e.user.departmentId !== e.departmentId)
      .slice(0, LIMITE_PAR_REGLE)
      .map((e) => constat(r, {
        entite: "User", entiteId: e.user!.id, href: HREF.employe(e.id), confiance: 0.85, cle: [e.departmentId],
        correction: { entite: "User", entiteId: e.user!.id, champ: "departmentId", avant: e.user!.departmentId, apres: e.departmentId, description: `Aligner le compte de ${e.fullName} sur le département RH « ${e.departmentRef?.name ?? e.departmentId} ».` },
        titre: `${e.fullName} : département RH « ${e.departmentRef?.name ?? "—"} », compte « ${e.user!.department?.name ?? "—"} »`,
        detail: "La fiche RH fait foi sur le rattachement ; le compte utilisateur en diverge, et avec lui les droits et budgets par département.",
      }));
  },
};

/** Les adresses e-mail des quatre référentiels : normalisables (AUTO) ou invalides (HUMAIN). */
async function detecterEmails(regleId: "email_normalisable" | "email_invalide"): Promise<Constat[]> {
  const r = regleDe(regleId)!;
  const cible = regleId === "email_normalisable" ? "NORMALISABLE" : "INVALIDE";
  const [salaries, fournisseurs, medecins, comptes] = await Promise.all([
    prisma.employee.findMany({ where: { isActive: true, email: { not: null } }, select: { id: true, fullName: true, email: true }, take: 5000 }),
    prisma.supplier.findMany({ where: { active: true, contactEmail: { not: null } }, select: { id: true, name: true, contactEmail: true }, take: 3000 }),
    prisma.medicalDoctor.findMany({ where: { email: { not: null } }, select: { id: true, name: true, email: true }, take: 5000 }),
    prisma.user.findMany({ where: { isActive: true }, select: { id: true, name: true, email: true }, take: 3000 }),
  ]);
  const out: Constat[] = [];
  const pousser = (entite: string, id: string, champ: string, valeur: string, qui: string, module: string, href: string | null) => {
    if (verdictEmail(valeur) !== cible) return;
    const apres = emailNormalise(valeur);
    out.push(constat(r, {
      entite, entiteId: id, module, href, cle: [champ],
      correction: cible === "NORMALISABLE" ? { entite, entiteId: id, champ, avant: valeur, apres, description: `Plier « ${valeur} » en « ${apres} ».` } : null,
      titre: cible === "NORMALISABLE" ? `${qui} : adresse à normaliser (« ${valeur} »)` : `${qui} : adresse invalide (« ${valeur} »)`,
      detail: cible === "NORMALISABLE"
        ? "Majuscules, espaces ou préfixe : la même adresse, mal écrite. Corrigée seule ; l'avant et l'après sont dans l'audit."
        : "Cette valeur n'est pas une adresse e-mail : aucun message ne partira, et les recherches par domaine la manqueront.",
    }));
  };
  for (const e of salaries) pousser("Employee", e.id, "email", e.email!, e.fullName, "RH", HREF.employe(e.id));
  for (const s of fournisseurs) pousser("Supplier", s.id, "contactEmail", s.contactEmail!, s.name, "REGULATORY", HREF.fournisseur());
  for (const m of medecins) pousser("MedicalDoctor", m.id, "email", m.email!, m.name, "MEDICAL", null);
  for (const u of comptes) pousser("User", u.id, "email", u.email, u.name, "RH", HREF.compte());
  return out.slice(0, LIMITE_PAR_REGLE);
}

export async function detecter(regleId: string, now = new Date()): Promise<Constat[]> {
  const d = DETECTEURS[regleId];
  if (!d) throw new Error(`règle inconnue : ${regleId}`);
  return d(now);
}

/** Toute règle du catalogue a son détecteur, et réciproquement — vérifié par test. */
export const REGLES_SANS_DETECTEUR = REGLES.filter((r) => !DETECTEURS[r.id]).map((r) => r.id);
export const DETECTEURS_SANS_REGLE = Object.keys(DETECTEURS).filter((id) => !regleDe(id));
