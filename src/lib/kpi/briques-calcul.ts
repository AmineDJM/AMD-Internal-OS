import { prisma } from "@/lib/prisma";
import { getSfeConfig } from "@/lib/sfe";
import { panelsDesKams } from "@/lib/queries/panel-kam";
import { chargerSegmentations, indexerLettres, type EntreeLettre } from "@/lib/segmentation/lettres-service";
import { choisirEntree, requisDuPraticien } from "@/lib/segmentation/lettre-requise";
import { bilanDesNotes, lireGrille, lireNotes } from "@/lib/coaching/grille";
import { BRIQUE_PAR_ID, type BriqueId, type LettreKpi } from "./briques";
import type { MesureKpi } from "./definition";
import type { Fenetre } from "./score";
import type { LigneDetail } from "./types";
import {
  ciblesAFrequence, ciblesVuesN, contacts, delaisDeReponse, delaisDeTraitement, mediane, noteCoaching, plansATemps, rapportsDansDelai,
  tachesATemps, type PraticienFenetre,
} from "./mesures";
import { calculerBriquePch, detailBriquePch } from "./briques-pch";
import { sansBloquer } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CALCUL DES BRIQUES — côté SERVEUR. Chaque brique lit ce que la plateforme tient déjà et passe les lignes à la
 * part pure (`mesures.ts`). Un `ChargeurBriques` vit le temps d'un calcul : la segmentation (lourde) n'est lue
 * qu'une fois, les visites d'une personne sur une fenêtre une fois, quel que soit le nombre de KPI qui les comptent.
 *
 * Jamais d'estimation : une source absente rend `valeur: null` avec sa raison.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface ResultatBrique {
  valeur: number | null;
  raison: string | null;
}

interface VisiteLue {
  id: string;
  date: Date;
  statut: string;
  doctorId: string | null;
  doctorNom: string | null;
  produits: string[];
  messages: number;
  rapportLe: Date | null;
}

interface PanelLu {
  buId: string | null;
  praticiens: { id: string; potential: string }[];
}

const SANS_PANEL = "Aucun panel : la personne n'a ni secteur ni praticien rattaché.";

export class ChargeurBriques {
  private lettres: Promise<Map<string, EntreeLettre[]>> | null = null;
  private config: ReturnType<typeof getSfeConfig> | null = null;
  private panels = new Map<string, Promise<PanelLu>>();
  private visites = new Map<string, Promise<VisiteLue[]>>();

  constructor(readonly maintenant: Date = new Date()) {}

  private lettresDe(): Promise<Map<string, EntreeLettre[]>> {
    if (!this.lettres) this.lettres = chargerSegmentations().then(indexerLettres).catch(sansBloquer("briques-calcul.lettresDe.chargerSegmentations", new Map()));
    return this.lettres;
  }

  private sfe() {
    if (!this.config) this.config = getSfeConfig();
    return this.config;
  }

  private panel(userId: string): Promise<PanelLu> {
    let p = this.panels.get(userId);
    if (!p) {
      p = Promise.all([
        panelsDesKams([userId]),
        prisma.salesRepProfile.findUnique({ where: { repId: userId }, select: { businessUnitId: true } }),
      ]).then(([m, profil]) => ({ buId: profil?.businessUnitId ?? null, praticiens: m.get(userId) ?? [] }));
      this.panels.set(userId, p);
    }
    return p;
  }

  /** Toutes les visites de la personne sur la fenêtre, avec l'heure de leur rapport. */
  private visitesDe(userId: string, f: Fenetre): Promise<VisiteLue[]> {
    const cle = `${userId}|${f.cle}`;
    let p = this.visites.get(cle);
    if (!p) {
      p = prisma.medicalVisit.findMany({
        where: { delegateId: userId, date: { gte: f.debut, lt: f.fin } },
        select: {
          id: true, date: true, status: true, doctorId: true, report: true, updatedAt: true,
          doctor: { select: { name: true } },
          productLinks: { select: { productId: true } },
          _count: { select: { messageLinks: true } },
          fieldReports: { select: { createdAt: true }, orderBy: { createdAt: "asc" }, take: 1 },
        },
        orderBy: { date: "asc" },
      }).then((rows) => rows.map((v) => {
        const vocal = v.fieldReports[0]?.createdAt ?? null;
        const ecrit = (v.report ?? "").trim() || v.status === "COMPLETED" ? v.updatedAt : null;
        const rapportLe = vocal && ecrit ? (vocal < ecrit ? vocal : ecrit) : vocal ?? ecrit;
        return {
          id: v.id, date: v.date, statut: v.status, doctorId: v.doctorId, doctorNom: v.doctor?.name ?? null,
          produits: v.productLinks.map((l) => l.productId), messages: v._count.messageLinks, rapportLe,
        };
      }));
      this.visites.set(cle, p);
    }
    return p;
  }

  /** La lettre d'un praticien vue depuis la BU (celle du filtre, sinon celle du KAM). */
  private async lettreDe(doctorId: string | null, buId: string | null): Promise<string | null> {
    if (!doctorId) return null;
    return choisirEntree((await this.lettresDe()).get(doctorId), buId)?.lettre ?? null;
  }

  private async visitesFiltrees(m: MesureKpi, userId: string, f: Fenetre): Promise<VisiteLue[]> {
    const vs = (await this.visitesDe(userId, f)).filter((v) => v.statut === "COMPLETED" && (!m.produitId || v.produits.includes(m.produitId)));
    if (!m.lettres?.length) return vs;
    const bu = m.buId ?? (await this.panel(userId)).buId;
    const out: VisiteLue[] = [];
    for (const v of vs) {
      const l = await this.lettreDe(v.doctorId, bu);
      if (l && (m.lettres as readonly string[]).includes(l)) out.push(v);
    }
    return out;
  }

  /** Le panel sur la fenêtre : lettre, requis du cycle, visites réalisées par la personne. */
  private async praticiensFenetre(m: MesureKpi, userId: string, f: Fenetre): Promise<{ praticiens: (PraticienFenetre & { nom: string | null })[]; vide: boolean }> {
    const [panel, lettres, config, visites] = await Promise.all([this.panel(userId), this.lettresDe(), this.sfe(), this.visitesDe(userId, f)]);
    if (panel.praticiens.length === 0) return { praticiens: [], vide: true };
    const bu = m.buId ?? panel.buId;
    const faites = new Map<string, number>();
    const noms = new Map<string, string | null>();
    for (const v of visites) {
      if (v.statut !== "COMPLETED" || !v.doctorId) continue;
      faites.set(v.doctorId, (faites.get(v.doctorId) ?? 0) + 1);
      noms.set(v.doctorId, v.doctorNom);
    }
    return {
      vide: false,
      praticiens: panel.praticiens.map((d) => {
        const r = requisDuPraticien(lettres.get(d.id), bu, d.potential, config.frequencyByTier);
        return { doctorId: d.id, lettre: r.lettre, requis: r.visites, faites: faites.get(d.id) ?? 0, nom: noms.get(d.id) ?? null };
      }),
    };
  }

  /** LA VALEUR D'UNE BRIQUE pour une personne sur une fenêtre. */
  async calculer(m: MesureKpi, userId: string, f: Fenetre): Promise<ResultatBrique> {
    try {
      return await this.calculerSansGarde(m, userId, f);
    } catch (e) {
      console.error("[kpi] brique en échec", m.brique, e);
      return { valeur: null, raison: `La source de « ${BRIQUE_PAR_ID[m.brique].libelle} » n'a pas pu être lue.` };
    }
  }

  private async calculerSansGarde(m: MesureKpi, userId: string, f: Fenetre): Promise<ResultatBrique> {
    const ok = (valeur: number | null, raison: string | null = null): ResultatBrique => ({ valeur, raison: valeur === null ? raison : null });
    const lettres = m.lettres as LettreKpi[] | undefined;
    switch (m.brique) {
      case "VISITES_REALISEES":
        return ok((await this.visitesFiltrees(m, userId, f)).length);
      case "VISITES_AVEC_MESSAGE":
        return ok((await this.visitesFiltrees(m, userId, f)).filter((v) => v.messages > 0).length);
      case "MESSAGES_PORTES":
        return ok((await this.visitesFiltrees(m, userId, f)).reduce((s, v) => s + v.messages, 0));
      case "CONTACTS_REQUIS":
      case "CONTACTS_REALISES": {
        const p = await this.praticiensFenetre(m, userId, f);
        if (p.vide) return ok(null, SANS_PANEL);
        const c = contacts(p.praticiens, f.mois, lettres);
        return ok(m.brique === "CONTACTS_REQUIS" ? c.requis : c.realise);
      }
      case "CIBLES_PANEL":
      case "CIBLES_VUES_A_FREQUENCE": {
        const p = await this.praticiensFenetre(m, userId, f);
        if (p.vide) return ok(null, SANS_PANEL);
        const c = ciblesAFrequence(p.praticiens, f.mois, lettres);
        return ok(m.brique === "CIBLES_PANEL" ? c.cibles : c.vues);
      }
      case "CIBLES_VUES_N": {
        const p = await this.praticiensFenetre(m, userId, f);
        if (p.vide) return ok(null, SANS_PANEL);
        return ok(ciblesVuesN(p.praticiens, f.mois, m.seuilN ?? 2, lettres).vues);
      }
      case "VISITES_A_RAPPORTER":
      case "RAPPORTS_DANS_DELAI": {
        const r = rapportsDansDelai(await this.visitesDe(userId, f), m.heures ?? 48, this.maintenant);
        return ok(m.brique === "VISITES_A_RAPPORTER" ? r.aRapporter : r.dansDelai);
      }
      case "PLANS_DE_TOURNEE":
      case "PLANS_VALIDES_A_TEMPS": {
        const plans = await prisma.tourPlan.findMany({
          where: { repId: userId, periodStart: { lt: f.fin }, periodEnd: { gte: f.debut } },
          select: { status: true, submittedAt: true, submissionDueAt: true },
        });
        const r = plansATemps(plans.map((p) => ({ statut: p.status, submittedAt: p.submittedAt, submissionDueAt: p.submissionDueAt })));
        return ok(m.brique === "PLANS_DE_TOURNEE" ? r.plans : r.aTemps);
      }
      case "NOTE_COACHING": {
        const fiches = await prisma.coachingSheet.findMany({
          where: { collaboratorId: userId, status: "FINALIZED", visitDate: { gte: f.debut, lt: f.fin } },
          select: { scores: true, grid: { select: { content: true } } },
        });
        const lues = fiches.flatMap((x) => {
          const g = lireGrille(x.grid.content);
          if (!g) return [];
          const b = bilanDesNotes(g, lireNotes(x.scores, g));
          return [{ total: b.total, max: b.max }];
        });
        return ok(noteCoaching(lues), "Aucune fiche de coaching finalisée sur la période.");
      }
      case "TACHES_ECHUES":
      case "TACHES_A_TEMPS": {
        const taches = await prisma.task.findMany({
          where: { assignedToId: userId, dueDate: { gte: f.debut, lt: f.fin } },
          select: { dueDate: true, completedAt: true, status: true },
        });
        const r = tachesATemps(taches.flatMap((t) => (t.dueDate ? [{ dueDate: t.dueDate, completedAt: t.completedAt, statut: t.status }] : [])), this.maintenant);
        return ok(m.brique === "TACHES_ECHUES" ? r.echues : r.aTemps);
      }
      case "VALIDATIONS_REPONDUES":
        return ok(await prisma.validationStep.count({ where: { validatorId: userId, status: { not: "PENDING" }, decidedAt: { gte: f.debut, lt: f.fin } } }));
      case "DELAI_VALIDATIONS": {
        const etapes = await prisma.validationStep.findMany({
          where: { validatorId: userId, status: { not: "PENDING" }, decidedAt: { gte: f.debut, lt: f.fin } },
          select: { order: true, createdAt: true, decidedAt: true, request: { select: { mode: true } } },
        });
        const d = delaisDeReponse(etapes.map((e) => ({ creeLe: e.createdAt, decideLe: e.decidedAt, arriveeConnue: e.order === 1 || e.request.mode === "PARALLEL" })));
        return ok(mediane(d), "Aucune validation tranchée dont l'heure d'arrivée est connue.");
      }
      case "DEMANDES_TRAITEES": {
        const d = await this.demandesTraitees(userId, f);
        return ok(d.length);
      }
      case "DELAI_DEMANDES": {
        const d = await this.demandesTraitees(userId, f);
        return ok(mediane(delaisDeTraitement(d)), "Aucune demande traitée et datée sur la période.");
      }
      case "LIVRE_PCH":
      case "NON_SERVI_PCH":
      case "EXECUTION_MARCHES":
        return calculerBriquePch(m, userId, f);
    }
  }

  /**
   * LES DEMANDES TRAITÉES par une personne dans la fenêtre : support (répondant, première réponse ou clôture), demandes RH
   * (traitant, prête / remise / accordée / refusée) et demandes administratives terminées (assigné). Une demande sans
   * date de traitement ne compte pas — jamais de date estimée.
   */
  private async demandesTraitees(userId: string, f: Fenetre): Promise<{ libelle: string; creeLe: Date; traiteLe: Date }[]> {
    const dans = { gte: f.debut, lt: f.fin };
    const [support, rh, admin] = await Promise.all([
      prisma.supportRequest.findMany({ where: { assignedToId: userId, resolvedAt: dans }, select: { reference: true, subject: true, createdAt: true, resolvedAt: true }, take: 500 }),
      prisma.hrDocumentRequest.findMany({ where: { handledById: userId, handledAt: dans }, select: { type: true, createdAt: true, handledAt: true, employee: { select: { fullName: true } } }, take: 500 }),
      prisma.administrativeRequest.findMany({ where: { assignedToId: userId, status: "DONE", deletedAt: null, completedAt: dans }, select: { reference: true, title: true, createdAt: true, completedAt: true }, take: 500 }),
    ]);
    return [
      ...support.flatMap((r) => (r.resolvedAt ? [{ libelle: `Support · ${r.reference} — ${r.subject}`, creeLe: r.createdAt, traiteLe: r.resolvedAt }] : [])),
      ...rh.flatMap((r) => (r.handledAt ? [{ libelle: `Demande RH · ${r.employee.fullName} — ${r.type.toLowerCase().replace(/_/g, " ")}`, creeLe: r.createdAt, traiteLe: r.handledAt }] : [])),
      ...admin.flatMap((r) => (r.completedAt ? [{ libelle: `Demande administrative · ${r.reference} — ${r.title}`, creeLe: r.createdAt, traiteLe: r.completedAt }] : [])),
    ].sort((a, z) => a.traiteLe.getTime() - z.traiteLe.getTime());
  }

  /** « D'OÙ VIENT LE CHIFFRE » — les lignes qui composent la brique (visites, cibles, plans, fiches, tâches…). */
  async detail(m: MesureKpi, userId: string, f: Fenetre): Promise<LigneDetail[]> {
    const jour = (d: Date | null) => (d ? d.toISOString() : null);
    const b: BriqueId = m.brique;
    if (b === "VISITES_REALISEES" || b === "VISITES_AVEC_MESSAGE" || b === "MESSAGES_PORTES") {
      return (await this.visitesFiltrees(m, userId, f)).map((v) => ({
        date: jour(v.date), libelle: v.doctorNom ?? "Visite sans praticien",
        etat: v.messages > 0 ? `${v.messages} message(s) porté(s)` : "aucun message", compte: b === "VISITES_REALISEES" || v.messages > 0,
      }));
    }
    if (b === "VISITES_A_RAPPORTER" || b === "RAPPORTS_DANS_DELAI") {
      const h = m.heures ?? 48;
      return (await this.visitesDe(userId, f)).filter((v) => v.statut !== "CANCELLED" && v.statut !== "POSTPONED").map((v) => {
        const delai = v.rapportLe ? Math.round((v.rapportLe.getTime() - v.date.getTime()) / 3_600_000) : null;
        return {
          date: jour(v.date), libelle: v.doctorNom ?? "Visite sans praticien",
          etat: delai === null ? "pas de rapport" : `rapport à ${Math.max(0, delai)} h`, compte: delai !== null && delai <= h,
        };
      });
    }
    if (b === "CONTACTS_REQUIS" || b === "CONTACTS_REALISES" || b === "CIBLES_PANEL" || b === "CIBLES_VUES_A_FREQUENCE" || b === "CIBLES_VUES_N") {
      const p = await this.praticiensFenetre(m, userId, f);
      const lettres = (m.lettres?.length ? m.lettres : b === "CIBLES_VUES_N" ? ["H"] : b.startsWith("CIBLES") ? ["H", "A", "B"] : null) as string[] | null;
      const seuil = b === "CIBLES_VUES_N" ? (m.seuilN ?? 2) * f.mois : null;
      return p.praticiens
        .filter((x) => !lettres || (x.lettre !== null && lettres.includes(x.lettre)))
        .sort((a, z) => (a.lettre ?? "Z").localeCompare(z.lettre ?? "Z") || z.requis - a.requis)
        .map((x) => {
          const requis = Math.round(x.requis * f.mois * 10) / 10;
          return {
            date: null, libelle: `${x.nom ?? "Praticien du panel"}${x.lettre ? ` · ${x.lettre}` : ""}`,
            etat: `${x.faites} visite(s) / ${seuil ?? requis} requise(s)`, compte: x.faites >= (seuil ?? requis) && (seuil !== null || requis > 0),
          };
        });
    }
    if (b === "PLANS_DE_TOURNEE" || b === "PLANS_VALIDES_A_TEMPS") {
      const plans = await prisma.tourPlan.findMany({
        where: { repId: userId, periodStart: { lt: f.fin }, periodEnd: { gte: f.debut } },
        select: { periodStart: true, status: true, submittedAt: true, submissionDueAt: true }, orderBy: { periodStart: "asc" },
      });
      return plans.map((p) => ({
        date: jour(p.periodStart), libelle: "Plan de tournée", etat: `${p.status.toLowerCase()}${p.submittedAt ? (p.submittedAt <= p.submissionDueAt ? " · soumis à temps" : " · soumis en retard") : " · non soumis"}`,
        compte: p.status === "APPROVED" && p.submittedAt !== null && p.submittedAt <= p.submissionDueAt,
      }));
    }
    if (b === "NOTE_COACHING") {
      const fiches = await prisma.coachingSheet.findMany({
        where: { collaboratorId: userId, status: "FINALIZED", visitDate: { gte: f.debut, lt: f.fin } },
        select: { visitDate: true, scores: true, grid: { select: { content: true } } }, orderBy: { visitDate: "asc" },
      });
      return fiches.map((x) => {
        const g = lireGrille(x.grid.content);
        const bn = g ? bilanDesNotes(g, lireNotes(x.scores, g)) : null;
        return { date: jour(x.visitDate), libelle: "Fiche de coaching", etat: bn ? `${bn.total}/${bn.max}` : "grille illisible", compte: bn !== null };
      });
    }
    if (b === "TACHES_ECHUES" || b === "TACHES_A_TEMPS") {
      const taches = await prisma.task.findMany({
        where: { assignedToId: userId, dueDate: { gte: f.debut, lt: f.fin } },
        select: { title: true, dueDate: true, completedAt: true, status: true }, orderBy: { dueDate: "asc" }, take: 300,
      });
      return taches.map((t) => ({
        date: jour(t.dueDate), libelle: t.title, etat: t.status === "DONE" ? `faite le ${t.completedAt?.toLocaleDateString("fr-FR") ?? "—"}` : t.status.toLowerCase(),
        compte: t.status === "DONE" && !!t.completedAt && !!t.dueDate && t.completedAt < new Date(t.dueDate.getFullYear(), t.dueDate.getMonth(), t.dueDate.getDate() + 1),
      }));
    }
    if (b === "DEMANDES_TRAITEES" || b === "DELAI_DEMANDES") {
      return (await this.demandesTraitees(userId, f)).map((d) => ({
        date: jour(d.traiteLe), libelle: d.libelle,
        etat: `traitée en ${Math.max(0, Math.round((d.traiteLe.getTime() - d.creeLe.getTime()) / 3_600_000))} h`, compte: d.traiteLe.getTime() >= d.creeLe.getTime(),
      }));
    }
    if (b === "LIVRE_PCH" || b === "NON_SERVI_PCH" || b === "EXECUTION_MARCHES") return detailBriquePch(m, userId, f);
    const etapes = await prisma.validationStep.findMany({
      where: { validatorId: userId, status: { not: "PENDING" }, decidedAt: { gte: f.debut, lt: f.fin } },
      select: { createdAt: true, decidedAt: true, status: true, order: true, request: { select: { title: true, mode: true } } }, orderBy: { decidedAt: "asc" }, take: 300,
    });
    return etapes.map((e) => ({
      date: jour(e.decidedAt), libelle: e.request.title,
      etat: `${e.status.toLowerCase()}${e.decidedAt ? ` en ${Math.round((e.decidedAt.getTime() - e.createdAt.getTime()) / 3_600_000)} h` : ""}`,
      compte: b === "VALIDATIONS_REPONDUES" || e.order === 1 || e.request.mode === "PARALLEL",
    }));
  }
}
