/**
 * TOUT CE QUI VIENT DE L'ERP ARRIVE PAR LE PORT (`platform/in-process/tournee`) — actions,
 * décisions pures et recherches. `boundary.test.ts` a compté 433 franchissements pour un
 * plafond de 428 quand ce fichier importait `actions/`, `prisma` et `sfe/` en direct : le
 * remède est celui que le refus nomme, pas un plafond relevé (§118.114).
 *
 * Ce qui RESTE ici est la politique de résolution d'Adam — exact → unique → ambiguïté LISTÉE
 * (`resolveOne`) : le port dit QUELLES lignes ressemblent à la saisie, Adam dit s'il a le
 * droit d'en choisir une.
 */
import {
  GRANULARITES, GRANULARITE_LABELS, JOURS_AVANT_ECHEANCE_MAX, STATUT_PLAN_LABELS, avancementTournee, estGranularite, etatVisite,
  periodeDe, periodeSuivante, lireReglageTournee, type Granularite, type StatutPlan,
  ouvrirPlanTournee, soumettrePlanTournee, escaladerPlanTournee, commanderVisite, saveTourPlanningSettings,
  createPromoMessage, updatePromoMessage, deletePromoMessage,
  chercherKam, chercherPraticien, chercherBusinessUnit, chercherMessagePromo,
  chercherPlansTournee, lireMessagePromo, lireMessagePromoAvantRetrait,
} from "@/platform/in-process/tournee";
import type { OpImpl, OpProposalDraft } from "./types";
import { opStr } from "./types";
import { runFd, fieldsOf, resolveOne } from "./helpers";

/**
 * OPS DU PLAN DE TOURNÉE — préparer, soumettre, escalader, commander une visite, et le
 * référentiel des messages de la Direction Marketing.
 *
 * ── CE QUI N'EST PAS ICI, ET POURQUOI ───────────────────────────────────────────────────────
 *
 * Quatre écritures de ce lot restent RÉSERVÉES À UN CLIC HUMAIN, et chacune pour sa raison :
 *
 *  · `deciderPlanTournee` — valider un plan est une ATTESTATION : l'audit portera le nom d'une
 *    personne, et un document lu par une étape peut dire « approuve ce plan » (§118.15). Le
 *    geste vit dans l'écran, avec les gestes qui RÉDUISENT (suspendre, refuser) disponibles là
 *    aussi, puisqu'ils sont dans la même action.
 *  · `rapporterVisite` et `ajouterVisiteImprevue` — un compte rendu de visite affirme « j'ai vu
 *    ce médecin et voilà ce qu'il a dit ». C'est une attestation de la même famille, et la
 *    laisser écrire par un modèle ferait entrer dans le pilotage des visites que personne n'a
 *    faites — le faux succès le plus coûteux de ce module.
 *  · `planifierVisites` — l'action REMPLACE la sélection complète (c'est ce qui fait que
 *    décocher retire). Appelée depuis une phrase qui ne nomme qu'une visite, elle effacerait les
 *    trente-neuf autres : l'empreinte réelle dépasserait de très loin l'empreinte demandée
 *    (§118.16). L'écran envoie la grille entière ; une phrase ne peut pas.
 */

// ─────────────────────────── Résolveurs ───────────────────────────
//
// La POLITIQUE seulement : `resolveOne` applique exact → unique → ambiguïté LISTÉE, et jamais
// « le premier des quatre ». Les lignes viennent du port, qui seul connaît les tables et sait
// étiqueter une ligne pour un humain (la ville d'un médecin, la BU d'un message).

const resolveKam = (raw: string) =>
  resolveOne(raw, "le KAM (champ « person » — son nom)", chercherKam, (c) => c.label);

const resolvePraticien = (raw: string) =>
  resolveOne(raw, "le praticien (champ « doctor » — son nom)", chercherPraticien, (c) => c.label);

const resolveBuOptionnelle = (raw: string) =>
  resolveOne(raw, "la Business Unit (champ « target » — son nom)", chercherBusinessUnit, (c) => c.label);

const resolveMessage = (raw: string) =>
  resolveOne(raw, "le message (champ « name » — son intitulé)", chercherMessagePromo, (c) => c.label);

/**
 * LA DATE, ou « le mois prochain » par défaut.
 *
 * Un plan se prépare pour la période À VENIR : sans date, viser la période COURANTE ferait
 * préparer un plan pour des journées déjà passées, ce qui est précisément ce que l'échéance de
 * soumission existe pour éviter.
 */
function periodeVisee(raw: string, granularite: Granularite): { debut: Date; fin: Date; dite: string } {
  const d = raw.trim() ? new Date(raw.trim()) : null;
  const p = d && !Number.isNaN(d.getTime()) ? periodeDe(granularite, d) : periodeSuivante(granularite, new Date());
  return {
    ...p,
    dite: `${p.debut.toLocaleDateString("fr-FR")} → ${p.fin.toLocaleDateString("fr-FR")}`,
  };
}

// ─────────────────────────── Les ops du plan (planning_operation) ───────────────────────────

export const TOUR_PLAN_OPS_IMPL: Record<string, OpImpl> = {
  open_tour_plan: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const kamRaw = opStr(input, "person");
      const kam = kamRaw ? await resolveKam(kamRaw) : null;
      if (kam && "error" in kam) return kam;
      const gRaw = opStr(input, "mode");
      // SANS MAILLE NOMMÉE, LE RÉGLAGE EN VIGUEUR — jamais « MONTH » en dur : l'action retombe
      // sur le réglage quand le champ manque, et l'op le dit à la carte pour que ce qu'on confirme
      // soit ce qui sera fait (§118.85).
      const reglage = await lireReglageTournee();
      const granularite: Granularite = gRaw && estGranularite(gRaw.toUpperCase()) ? (gRaw.toUpperCase() as Granularite) : reglage.granularite;
      const p = periodeVisee(opStr(input, "date"), granularite);
      return {
        title: kam ? `Plan de tournée de ${kam.label}` : "Mon plan de tournée",
        fields: fieldsOf([
          ["KAM", kam?.label ?? "vous"],
          ["Période", p.dite],
          ["Maille", `${GRANULARITE_LABELS[granularite]}${gRaw ? "" : " (réglage en vigueur)"}`],
        ]),
        // IDEMPOTENT : rappeler l'op rend le MÊME plan. On le DIT, sinon la carte laisse croire
        // qu'un second plan va naître pour la même période.
        warnings: ["Si un plan existe déjà pour cette période, c'est celui-là qui est rendu — il n'en naît pas un second."],
        args: {
          ...(kam ? { repId: kam.id } : {}),
          granularity: granularite,
          date: p.debut.toISOString(),
        },
        successMessage: `Plan de tournée ouvert pour ${p.dite}. Les visites se posent à l'écran (Visite médicale › Plan de tournée) : une phrase ne peut pas envoyer une grille de quarante jours × praticiens.`,
        revalidate: ["/medical/plan-de-tournee"],
      };
    },
    execute: (args) => runFd(ouvrirPlanTournee, args, "L'ouverture du plan a été refusée.", { revalidate: ["/medical/plan-de-tournee"] }),
  },

  submit_tour_plan: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const plan = await planVise(input);
      if ("error" in plan) return plan;
      const av = avancementTournee(plan.visites);
      return {
        title: `Soumettre le plan de tournée de ${plan.repName}`,
        fields: fieldsOf([
          ["Période", plan.dite],
          ["État", STATUT_PLAN_LABELS[plan.status]],
          ["Visites planifiées", String(av.planifiees)],
          ["Échéance de soumission", plan.submissionDueAt.toLocaleDateString("fr-FR")],
        ]),
        warnings: av.planifiees === 0
          ? ["Ce plan ne porte AUCUNE visite : la soumission sera refusée — son validateur n'aurait rien à valider."]
          : [],
        args: { planId: plan.id },
        successMessage: "Plan de tournée soumis à son validateur.",
        revalidate: ["/medical/plan-de-tournee"],
      };
    },
    execute: (args) => runFd(soumettrePlanTournee, args, "La soumission du plan a été refusée.", { revalidate: ["/medical/plan-de-tournee"] }),
  },

  /**
   * LA MAILLE ET L'ÉCHÉANCE — le réglage que rien n'écrivait.
   *
   * FUSION : un champ non cité garde sa valeur, relue à l'instant. L'action revalide la porte
   * (Super Admin) et les bornes ; l'op ne fait que composer la carte avec ce qui va changer.
   */
  set_tour_planning: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const cur = await lireReglageTournee();
      const gRaw = opStr(input, "mode").trim().toUpperCase();
      if (gRaw && !estGranularite(gRaw)) {
        return {
          error: `Maille inconnue « ${gRaw} » (champ « mode ») — valeurs : ${GRANULARITES.map((g) => `${g} (${GRANULARITE_LABELS[g].toLowerCase()})`).join(", ")}.`,
        };
      }
      const granularite: Granularite = gRaw && estGranularite(gRaw) ? gRaw : cur.granularite;
      const jRaw = opStr(input, "days").trim();
      const jours = jRaw ? Number(jRaw.replace(",", ".")) : cur.joursAvant;
      if (!Number.isInteger(jours) || jours < 0 || jours > JOURS_AVANT_ECHEANCE_MAX) {
        return { error: `Le délai de soumission (champ « days ») se compte en jours entiers, de 0 à ${JOURS_AVANT_ECHEANCE_MAX} avant la fin du mois qui précède la période.` };
      }
      const mailleDite = granularite === cur.granularite
        ? `${GRANULARITE_LABELS[granularite]} (inchangée)`
        : `${GRANULARITE_LABELS[cur.granularite]} → ${GRANULARITE_LABELS[granularite]}`;
      const joursDits = jours === cur.joursAvant
        ? `${jours} j avant la fin du mois précédent (inchangé)`
        : `${cur.joursAvant} j → ${jours} j avant la fin du mois précédent`;
      return {
        title: "Planification de tournée — maille et échéance",
        fields: fieldsOf([
          ["Maille", mailleDite],
          ["Échéance de soumission", joursDits],
        ]),
        warnings: [
          "Réglage GLOBAL, réservé au Super Admin. Les plans déjà ouverts gardent l'échéance figée à leur création ; seuls les plans à venir suivent la nouvelle maille.",
        ],
        args: { granularity: granularite, submissionLeadDays: String(jours) },
        successMessage: `Planification de tournée réglée : maille ${GRANULARITE_LABELS[granularite].toLowerCase()}, échéance ${jours} j avant la fin du mois précédent.`,
        revalidate: ["/business-units/parametres", "/medical/plan-de-tournee"],
      };
    },
    execute: (args) => runFd(saveTourPlanningSettings, args, "Le réglage de la planification a été refusé.", { revalidate: ["/business-units/parametres", "/medical/plan-de-tournee"] }),
  },

  escalate_tour_plan: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const plan = await planVise(input);
      if ("error" in plan) return plan;
      return {
        title: `Demander une validation au N+2 — plan de ${plan.repName}`,
        fields: fieldsOf([
          ["Période", plan.dite],
          ["État", STATUT_PLAN_LABELS[plan.status]],
        ]),
        warnings: ["On n'escalade qu'une fois : le plan passera au N+2, qui tranchera. Vous ne pourrez plus le décider vous-même."],
        args: { planId: plan.id },
        successMessage: "Plan escaladé au N+2.",
        revalidate: ["/medical/plan-de-tournee"],
      };
    },
    execute: (args) => runFd(escaladerPlanTournee, args, "L'escalade du plan a été refusée.", { revalidate: ["/medical/plan-de-tournee"] }),
  },
};

/** Le plan visé par une phrase : le KAM (ou soi) et la période. */
async function planVise(input: Record<string, unknown>): Promise<
  | { id: string; repName: string; status: StatutPlan; dite: string; submissionDueAt: Date; visites: { etat: ReturnType<typeof etatVisite>; imprevue: boolean }[] }
  | { error: string }
> {
  const kamRaw = opStr(input, "person");
  const kam = kamRaw ? await resolveKam(kamRaw) : null;
  if (kam && "error" in kam) return kam;
  const dateRaw = opStr(input, "date");
  const d = dateRaw.trim() ? new Date(dateRaw.trim()) : null;
  const plans = await chercherPlansTournee(
    kam ? kam.id : null,
    d && !Number.isNaN(d.getTime()) ? d : null,
  );
  if (plans.length === 0) {
    return {
      error: kam
        ? `Aucun plan de tournée pour ${kam.label}${dateRaw ? ` sur ${dateRaw}` : ""} — ouvrez-le d'abord (op « open_tour_plan »).`
        : "Aucun plan de tournée trouvé — précisez le KAM (champ « person ») et la période (champ « date »), ou ouvrez le plan d'abord (op « open_tour_plan »).",
    };
  }
  if (plans.length > 1) {
    return {
      error: `Plusieurs plans correspondent : ${plans.map((p) => `${p.repName} ${p.periodStart.toLocaleDateString("fr-FR")}`).join(", ")} — précisez le KAM et la période.`,
    };
  }
  const p = plans[0]!;
  const maintenant = new Date();
  return {
    id: p.id, repName: p.repName, status: p.status as StatutPlan,
    dite: `${p.periodStart.toLocaleDateString("fr-FR")} → ${p.periodEnd.toLocaleDateString("fr-FR")}`,
    submissionDueAt: p.submissionDueAt,
    visites: p.visites.map((v) => ({
      etat: etatVisite({ statut: v.status, date: v.date, rapportFait: Boolean(v.report), maintenant }),
      imprevue: v.tourPlanId === null,
    })),
  };
}

// ─────────────────────────── Les ops de visite (medical_operation) ───────────────────────────

export const TOUR_VISIT_OPS_IMPL: Record<string, OpImpl> = {
  /**
   * « DEMAIN VA VOIR ACHOUR » — la visite que la Direction commande.
   *
   * C'est le geste le plus naturellement conversationnel de tout ce module, et il ne porte
   * AUCUNE attestation : il crée une visite À FAIRE, que le KAM rapportera lui-même.
   */
  order_visit: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const kam = await resolveKam(opStr(input, "person"));
      if ("error" in kam) return kam;
      const doctor = await resolvePraticien(opStr(input, "doctor"));
      if ("error" in doctor) return doctor;
      const raw = opStr(input, "date");
      const d = raw.trim() ? new Date(raw.trim()) : null;
      if (!d || Number.isNaN(d.getTime())) {
        return { error: "Précisez le JOUR de la visite (champ « date », AAAA-MM-JJ) — « demain » se donne comme une date." };
      }
      return {
        title: `Visite commandée — ${doctor.label} pour ${kam.label}`,
        fields: fieldsOf([
          ["KAM", kam.label],
          ["Praticien", doctor.label],
          ["Jour", d.toLocaleDateString("fr-FR")],
          ["Objectif", opStr(input, "objective") || null],
        ]),
        // CE QU'ELLE NE FAIT PAS, dit sur la carte : elle n'entre pas dans le plan validé du
        // KAM, donc elle ne fait pas baisser son taux de réalisation pour une décision d'un
        // autre — et son rapport reste à SA charge, dans les 48 h qui suivent la visite.
        warnings: [
          "Elle apparaît dans l'emploi du temps du KAM comme une visite à faire, hors de son plan validé — son taux de réalisation n'en est pas affecté.",
          "Le compte rendu reste à sa charge, dans les 48 h suivant la visite.",
        ],
        args: {
          repId: kam.id, doctorId: doctor.id,
          date: d.toISOString(),
          objective: opStr(input, "objective") || null,
        },
        successMessage: `Visite chez ${doctor.label} commandée à ${kam.label} pour le ${d.toLocaleDateString("fr-FR")}.`,
        revalidate: ["/medical/ma-journee"],
      };
    },
    execute: (args) => runFd(commanderVisite, args, "La commande de visite a été refusée.", { revalidate: ["/medical/ma-journee"] }),
  },
};

// ────────────────── Les messages de la Direction Marketing (planning_operation) ──────────────────

export const PROMO_MESSAGE_OPS_IMPL: Record<string, OpImpl> = {
  create_promo_message: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const title = opStr(input, "name");
      if (!title) return { error: "Donnez l'intitulé du message (champ « name ») — c'est lui que le KAM lit dans son menu déroulant." };
      const buRaw = opStr(input, "target");
      const bu = buRaw ? await resolveBuOptionnelle(buRaw) : null;
      if (bu && "error" in bu) return bu;
      return {
        title: `Message Direction Marketing « ${title} »`,
        fields: fieldsOf([
          ["Intitulé", title],
          ["Texte", opStr(input, "note") || null],
          // VIDE = OUVERT À TOUTES LES GAMMES, et on le DIT : une portée qu'on ne voit pas se
          // lit comme une portée restreinte.
          ["Gamme", bu ? bu.label : "toutes (aucune BU précisée)"],
        ]),
        args: {
          title,
          body: opStr(input, "note") || null,
          ...(bu ? { businessUnitId: bu.id } : {}),
        },
        successMessage: `Message « ${title} » ajouté au référentiel.`,
        revalidate: ["/marketing-cockpit"],
      };
    },
    execute: (args) => runFd(createPromoMessage, args, "La création du message a été refusée.", { revalidate: ["/marketing-cockpit"] }),
  },

  update_promo_message: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const hit = await resolveMessage(opStr(input, "name"));
      if ("error" in hit) return hit;
      const cur = await lireMessagePromo(hit.id);
      if (!cur) return { error: "Message introuvable." };
      const buRaw = opStr(input, "target");
      const bu = buRaw ? await resolveBuOptionnelle(buRaw) : null;
      if (bu && "error" in bu) return bu;
      const nouveauTitre = opStr(input, "newName") || cur.title;
      // FUSION : l'action réécrit tous les champs, donc l'existant est relu et REJOUÉ — sans
      // quoi « renomme ce message » effacerait son texte et sa portée.
      return {
        title: `Message « ${cur.title} »`,
        fields: fieldsOf([
          ["Intitulé", nouveauTitre === cur.title ? cur.title : `${cur.title} → ${nouveauTitre}`],
          ["Texte", opStr(input, "note") || cur.body || null],
          ["Gamme", bu ? bu.label : cur.businessUnitId ? "(inchangée)" : "toutes"],
        ]),
        args: {
          id: hit.id, title: nouveauTitre,
          body: opStr(input, "note") || cur.body,
          businessUnitId: bu ? bu.id : cur.businessUnitId,
          productId: cur.productId,
          sortOrder: String(cur.sortOrder),
          isActive: cur.isActive ? "on" : "off",
        },
        successMessage: `Message « ${nouveauTitre} » enregistré.`,
        revalidate: ["/marketing-cockpit"],
      };
    },
    execute: (args) => runFd(updatePromoMessage, args, "L'enregistrement du message a été refusé.", { revalidate: ["/marketing-cockpit"] }),
  },

  delete_promo_message: {
    async propose(input): Promise<OpProposalDraft | { error: string }> {
      const hit = await resolveMessage(opStr(input, "name"));
      if ("error" in hit) return hit;
      const cur = await lireMessagePromoAvantRetrait(hit.id);
      if (!cur) return { error: "Message introuvable." };
      // DÉJÀ PORTÉ → ARCHIVÉ (son historique reste) ; JAMAIS PORTÉ → SUPPRIMÉ. L'action tranche, la carte le dit avant.
      const archive = cur.rapportsLies > 0;
      return {
        title: `${archive ? "Archiver" : "Supprimer"} le message « ${cur.title} »`,
        fields: [{ label: "Rapports terrain qui le portent", value: String(cur.rapportsLies) }],
        warnings: [
          archive
            ? `Il disparaît du menu déroulant des KAM et passe « archivé ». Ses ${cur.rapportsLies} portage(s) restent dans l'historique et dans le Marketing cockpit.`
            : "Il n'a jamais été porté : il est supprimé, il n'y a rien à garder.",
        ],
        args: { id: hit.id },
        successMessage: `Message « ${cur.title} » ${archive ? "archivé" : "supprimé"}.`,
        revalidate: ["/marketing-cockpit"],
      };
    },
    execute: (args) => runFd(deletePromoMessage, args, "Le retrait du message a été refusé.", { revalidate: ["/marketing-cockpit"] }),
  },
};
